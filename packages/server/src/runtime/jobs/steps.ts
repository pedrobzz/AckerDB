/**
 * Durable steps (ADR-0022): the per-run `ctx.step` surface of a
 * procedure-kind job. Completed steps are recorded in the row's `stepsJson`
 * journal; a resumed attempt replays the handler, and a recorded entry
 * answers instead of executing.
 *
 * Step identity is the name, and the name is a contract: same name, same
 * meaning. Strictness is applied exactly where it is free of false
 * positives — a duplicate name in one run, a kind change under a name, or a
 * changed args hash under a `step.run` name refuses with a typed mismatch
 * that discards the run without consulting the retry policy, because
 * retrying into unchanged code cannot fix code.
 */
import {
  Failure,
  Ok,
  getRef,
  decode,
  isApplicationError,
  isResult,
  stableEncode,
  type Result,
} from "@ackerdb/core";
import { AckerDBError } from "../../shared/errors.ts";
import { hashJobArgs } from "../../jobs/identity.ts";
import type { AnyRegistered } from "../../app/functions.ts";
import type { Registry } from "../../app/registry.ts";
import type { JobStep } from "../../jobs/definition.ts";
import type { JobsExecutor, JobRow } from "./runtime.ts";

/** One journaled step: identity, what recorded it, and the recorded outcome. */
interface StepJournalEntry {
  readonly name: string;
  readonly kind: "run" | "query" | "mutation" | "procedure" | "sleep";
  /** `run` only: the callee's address and registered kind at record time. */
  readonly ref?: string;
  readonly calleeKind?: string;
  /** `run` only: hash of the canonical args encoding — the determinism tripwire. */
  readonly argsHash?: string;
  /** Canonical-encoded recorded outcome; absent for sleep. */
  readonly result?: string;
  /** `sleep` only: the absolute wake time scheduled at first encounter. */
  readonly wakeAt?: number;
  readonly completedAt: number;
}

/**
 * A journal/code mismatch: settles the run as discarded with this typed
 * error in its attempt history. The retry policy is never consulted.
 */
export class StepMismatchError extends AckerDBError {
  constructor(step: string, detail: string) {
    super("conflict", `step "${step}": ${detail}`);
    this.name = "StepMismatchError";
  }
}

/** Thrown by `step.sleep`: the runner settles the attempt back to pending. */
export class JobSleepSignal {
  constructor(readonly wakeAt: number) {}
}

export function parseStepJournal(stepsJson: string | null): StepJournalEntry[] {
  if (stepsJson === null) return [];
  try {
    const parsed = JSON.parse(stepsJson) as unknown;
    return Array.isArray(parsed) ? (parsed as StepJournalEntry[]) : [];
  } catch {
    return [];
  }
}

/** Encode a step's Result for the journal; wire representability is enforced here. */
function encodeResult(value: Result<unknown, unknown>): string {
  return value.ok
    ? stableEncode({ ok: true, data: value.data })
    : stableEncode({ ok: false, error: value.error });
}

function restoreResult(encoded: string): Result<unknown, unknown> {
  const raw = decode(encoded) as { ok: boolean; data?: unknown; error?: unknown };
  if (raw.ok === true) return Ok(raw.data);
  if (isApplicationError(raw.error)) return Failure(raw.error);
  throw new AckerDBError("internal", "journaled step Result is invalid");
}

export interface JobStepsOptions {
  readonly id: bigint;
  readonly jobName: string;
  readonly attempt: number;
  readonly leaseToken: string;
  readonly stepsJson: string | null;
  readonly executor: JobsExecutor;
  readonly registry: Pick<Registry, "get">;
  readonly signal: AbortSignal;
  readonly now: () => number;
}

/** The `ctx.step` implementation for one dispatched attempt. */
export class JobSteps {
  private readonly entries = new Map<string, StepJournalEntry>();
  private readonly seen = new Set<string>();

  constructor(private readonly options: JobStepsOptions) {
    for (const entry of parseStepJournal(options.stepsJson)) {
      this.entries.set(entry.name, entry);
    }
  }

  /** The typed surface handed to the handler; `calleeCtx` powers `step.run` procedures. */
  surface(calleeCtx: object): JobStep {
    const steps = this;
    return Object.freeze({
      run: (ref: unknown, args: unknown, options?: { readonly name?: string }) =>
        steps.run(ref, args, options?.name, calleeCtx),
      query: (name: string, fn: (tx: never) => unknown) =>
        steps.inlineTransactional("query", name, fn),
      mutation: (name: string, fn: (tx: never) => unknown) =>
        steps.inlineTransactional("mutation", name, fn),
      procedure: (name: string, fn: () => unknown) => steps.inlineProcedure(name, fn),
      sleep: (name: string, durationMs: number) => steps.sleep(name, durationMs),
    }) as unknown as JobStep;
  }

  // -- step.run --------------------------------------------------------------

  private async run(
    ref: unknown,
    args: unknown,
    nameOverride: string | undefined,
    calleeCtx: object,
  ): Promise<Result<unknown, unknown>> {
    const address = getRef(ref as never);
    const fn = this.options.registry.get(address);
    if (fn === undefined) {
      throw new AckerDBError("not_found", `step.run: unknown function "${address}"`);
    }
    if (fn.kind !== "query" && fn.kind !== "mutation" && fn.kind !== "procedure") {
      throw new AckerDBError(
        "validation",
        `step.run: "${address}" is a ${fn.kind}; only queries, mutations, and procedures are steps`,
      );
    }
    const name = nameOverride ?? address;
    const argsHash = hashJobArgs(stableEncode(args ?? {}));
    const prior = this.claim(name, "run", (entry) => {
      if (entry.ref !== address) return `journaled ref "${entry.ref}", code names "${address}"`;
      if (entry.calleeKind !== fn.kind) {
        return `journaled a ${entry.calleeKind}, "${address}" is now a ${fn.kind}`;
      }
      if (entry.argsHash !== argsHash) {
        return "journaled args differ — replay must be deterministic, so this proves code drift or nondeterminism outside steps";
      }
      return null;
    });
    if (prior !== null) return restoreResult(prior.result!);

    const record = (value: Result<unknown, unknown>): StepJournalEntry => ({
      name,
      kind: "run",
      ref: address,
      calleeKind: fn.kind,
      argsHash,
      result: encodeResult(value),
      completedAt: this.options.now(),
    });
    if (fn.kind === "procedure") {
      const value = await this.invoke(fn, calleeCtx, args);
      await this.append(record(value));
      return value;
    }
    // Query/mutation callees run inside one writer transaction with their
    // journal entry: a mutation step commits atomically with its record.
    return await this.options.executor.jobsWrite(this.options.signal, async (surface) => {
      this.assertOwned(surface.jobs.byId(this.options.id));
      const value = await surface.runMutationHandler(
        `jobs.${this.options.jobName}`,
        this.options.attempt,
        (ctx) => this.invoke(fn, ctx, args),
      );
      await this.appendIn(surface, record(value));
      return value;
    });
  }

  private invoke(
    fn: AnyRegistered,
    ctx: object,
    args: unknown,
  ): Promise<Result<unknown, unknown>> {
    const callee = fn as unknown as (ctx: object, args: unknown) => Promise<unknown>;
    return callee(ctx, args).then((value) => {
      if (!isResult(value)) {
        throw new AckerDBError("internal", "registered step callee returned a non-Result");
      }
      return value;
    });
  }

  // -- Inline steps ----------------------------------------------------------

  private async inlineTransactional(
    kind: "query" | "mutation",
    name: string,
    fn: (tx: never) => unknown,
  ): Promise<unknown> {
    const prior = this.claim(name, kind, () => null);
    if (prior !== null) return decode(prior.result!);
    return await this.options.executor.jobsWrite(this.options.signal, async (surface) => {
      this.assertOwned(surface.jobs.byId(this.options.id));
      const value = await surface.runMutationHandler(
        `jobs.${this.options.jobName}`,
        this.options.attempt,
        (ctx) => fn(ctx as never),
      );
      await this.appendIn(surface, {
        name,
        kind,
        result: stableEncode(value),
        completedAt: this.options.now(),
      });
      return value;
    });
  }

  private async inlineProcedure(name: string, fn: () => unknown): Promise<unknown> {
    const prior = this.claim(name, "procedure", () => null);
    if (prior !== null) return decode(prior.result!);
    const value = await fn();
    await this.append({
      name,
      kind: "procedure",
      result: stableEncode(value),
      completedAt: this.options.now(),
    });
    return value;
  }

  // -- Sleep -----------------------------------------------------------------

  private async sleep(name: string, durationMs: number): Promise<void> {
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
      throw new AckerDBError(
        "validation",
        `step.sleep "${name}": durationMs must be a non-negative finite number`,
      );
    }
    const prior = this.claim(name, "sleep", () => null);
    if (prior !== null) {
      // Satisfied once its scheduled wake has passed; woken early, the run
      // honestly sleeps the remainder.
      if (prior.wakeAt! <= this.options.now()) return;
      throw new JobSleepSignal(prior.wakeAt!);
    }
    const wakeAt = this.options.now() + durationMs;
    await this.append({ name, kind: "sleep", wakeAt, completedAt: this.options.now() });
    throw new JobSleepSignal(wakeAt);
  }

  // -- The journal -----------------------------------------------------------

  /**
   * Resolve one named step against the journal: a recorded entry answers, a
   * mismatch refuses, an unrecorded name executes. Every resolution also
   * guards the in-run duplicate.
   */
  private claim(
    name: string,
    kind: StepJournalEntry["kind"],
    check: (entry: StepJournalEntry) => string | null,
  ): StepJournalEntry | null {
    if (typeof name !== "string" || name.length === 0) {
      throw new AckerDBError("validation", "step names must be non-empty strings");
    }
    if (this.seen.has(name)) {
      throw new StepMismatchError(name, "duplicate step name in one run — names are identities");
    }
    this.seen.add(name);
    const entry = this.entries.get(name);
    if (entry === undefined) return null;
    if (entry.kind !== kind) {
      throw new StepMismatchError(name, `journaled as ${entry.kind}, code says ${kind}`);
    }
    const detail = check(entry);
    if (detail !== null) throw new StepMismatchError(name, detail);
    return entry;
  }

  /** Append one entry in its own transaction (procedure steps, sleep). */
  private async append(entry: StepJournalEntry): Promise<void> {
    await this.options.executor.jobsWrite(this.options.signal, async (surface) => {
      await this.appendIn(surface, entry);
    });
  }

  /** Append one entry inside an already-owned transaction. */
  private async appendIn(
    surface: { readonly jobs: { byId(id: bigint): JobRow | null; patch(id: bigint, partial: Record<string, unknown>): Promise<void> } },
    entry: StepJournalEntry,
  ): Promise<void> {
    const row = surface.jobs.byId(this.options.id);
    this.assertOwned(row);
    const journal = parseStepJournal(row!.stepsJson);
    journal.push(entry);
    await surface.jobs.patch(this.options.id, { stepsJson: JSON.stringify(journal) });
    this.entries.set(entry.name, entry);
  }

  /** A canceled, reclaimed, or deleted row must not gain journal entries. */
  private assertOwned(row: JobRow | null): void {
    if (row === null || row.state !== "running" || row.leaseToken !== this.options.leaseToken) {
      throw new AckerDBError("unavailable", "job attempt was superseded; its steps may not record");
    }
  }
}
