/**
 * Durable steps (ADR-0022): the per-run `ctx.step` surface of a
 * procedure-kind job. Completed steps are recorded in the row's `stepsJson`
 * journal; a resumed attempt replays the handler, and a recorded entry
 * answers instead of executing.
 *
 * Step identity is the name, and the name is a contract: same name, same
 * meaning. Strictness is applied exactly where it is free of false
 * positives — a duplicate name in one run, a kind change under a name, a
 * changed args hash under a `step.run` name, an unreadable journal, or a
 * journal past its finite bounds refuses with a typed error that discards
 * the run without consulting the retry policy, because retrying into
 * unchanged code cannot fix code.
 *
 * `step.sleep` settles the attempt in ONE writer transaction — journal
 * entry, pending state, wake time, attempt decrement, and lease release
 * commit together, so no crash window can turn a suspension into a failed
 * attempt. The thrown signal only unwinds the handler: a handler that
 * catches it is a stale attempt with cancel's semantics — its later step
 * calls refuse on the lease check and its late settle is discarded.
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

/**
 * Finite journal bounds, per the everything-finite contract: a run may not
 * grow its journal without limit inside the serialized writer. Exceeding
 * either refuses the run; the remedy is fewer/smaller steps or child jobs.
 */
export const MAX_JOURNAL_STEPS = 1_000;
export const MAX_JOURNAL_BYTES = 1_048_576;

const STEP_KINDS = ["run", "query", "mutation", "procedure", "sleep"] as const;
type StepKind = (typeof STEP_KINDS)[number];
const CALLEE_KINDS = ["query", "mutation", "procedure"] as const;

interface StepEntryBase {
  readonly name: string;
  readonly completedAt: number;
}

/** A `step.run` record: the callee's identity pins replay to unchanged code. */
interface RunStepEntry extends StepEntryBase {
  readonly kind: "run";
  readonly ref: string;
  readonly calleeKind: (typeof CALLEE_KINDS)[number];
  /** Hash of the canonical args encoding — the determinism tripwire. */
  readonly argsHash: string;
  readonly result: string;
}

/** An inline closure's record: the canonical-encoded return value. */
interface InlineStepEntry extends StepEntryBase {
  readonly kind: "query" | "mutation" | "procedure";
  readonly result: string;
}

/** A sleep's record: the wake scheduled at first encounter (observability). */
interface SleepStepEntry extends StepEntryBase {
  readonly kind: "sleep";
  readonly wakeAt: number;
}

/** One journaled step, discriminated by kind: no field is ever optional. */
type StepJournalEntry = RunStepEntry | InlineStepEntry | SleepStepEntry;

/** The entry shape a step kind claims from the journal. */
type EntryOf<K extends StepKind> = K extends "run"
  ? RunStepEntry
  : K extends "sleep"
    ? SleepStepEntry
    : InlineStepEntry;

/**
 * A typed step refusal: the run settles as discarded with this error in its
 * attempt history, and the retry policy is never consulted.
 */
export class StepRefusalError extends AckerDBError {
  constructor(step: string, detail: string) {
    super("conflict", `step "${step}": ${detail}`);
    this.name = "StepRefusalError";
  }
}

/** Thrown by `step.sleep` after its atomic settle, purely to unwind the handler. */
export class JobSleepSignal {
  constructor(readonly wakeAt: number) {}
}

function isStepJournalEntry(value: unknown): value is StepJournalEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.name !== "string" || entry.name.length === 0) return false;
  if (typeof entry.completedAt !== "number" || !Number.isFinite(entry.completedAt)) return false;
  switch (entry.kind) {
    case "run":
      return (
        typeof entry.ref === "string" &&
        entry.ref.length > 0 &&
        CALLEE_KINDS.includes(entry.calleeKind as never) &&
        typeof entry.argsHash === "string" &&
        entry.argsHash.length > 0 &&
        typeof entry.result === "string"
      );
    case "query":
    case "mutation":
    case "procedure":
      return typeof entry.result === "string";
    case "sleep":
      return typeof entry.wakeAt === "number" && Number.isFinite(entry.wakeAt);
    default:
      return false;
  }
}

/**
 * Parse a journal, failing CLOSED: an unreadable, malformed, or ambiguous
 * journal is preserved evidence of corruption, never an empty journal —
 * replaying "unrecorded" steps against durable state that said otherwise is
 * exactly the silent duplication the corruption rules forbid.
 */
export function parseStepJournal(stepsJson: string | null): StepJournalEntry[] {
  if (stepsJson === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stepsJson);
  } catch {
    throw new StepRefusalError("journal", "stepsJson is not readable JSON; the bytes are preserved on the row");
  }
  if (!Array.isArray(parsed) || !parsed.every(isStepJournalEntry)) {
    throw new StepRefusalError("journal", "stepsJson is not a valid step journal; the bytes are preserved on the row");
  }
  const names = new Set<string>();
  for (const entry of parsed) {
    if (names.has(entry.name)) {
      throw new StepRefusalError(entry.name, "the journal records this name twice; an ambiguous entry must not replay");
    }
    names.add(entry.name);
  }
  return parsed;
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
  /** Post-commit notification that this run suspended until `wakeAt`. */
  readonly onSlept: (wakeAt: number) => void;
}

/** The `ctx.step` implementation for one dispatched attempt. */
export class JobSteps {
  private readonly entries = new Map<string, StepJournalEntry>();
  private readonly seen = new Set<string>();
  /** A journal that failed validation; surfaced on first step use, lazily. */
  private corruption: StepRefusalError | null = null;

  constructor(private readonly options: JobStepsOptions) {
    try {
      for (const entry of parseStepJournal(options.stepsJson)) {
        this.entries.set(entry.name, entry);
      }
    } catch (error) {
      // A handler that uses no steps never cares; one that does refuses
      // before executing anything against the unreadable journal.
      this.corruption = error as StepRefusalError;
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
    if (prior !== null) return restoreResult(prior.result);

    const record = (value: Result<unknown, unknown>): StepJournalEntry => ({
      name,
      kind: "run",
      ref: address,
      calleeKind: fn.kind as RunStepEntry["calleeKind"],
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
    if (prior !== null) return decode(prior.result);
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
    if (prior !== null) return decode(prior.result);
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
    // A recorded sleep is satisfied by being claimed at all: a pending row
    // runs only when due, so the row's due time — the journaled wake, or an
    // operator's reschedule/retry — is the single authority. Replay never
    // re-suspends.
    if (prior !== null) return;

    const wakeAt = this.options.now() + durationMs;
    // One writer transaction: journal entry, pending state, wake time,
    // attempt decrement (sleeping is not failing), and lease release commit
    // together — no crash window between "recorded" and "suspended".
    await this.options.executor.jobsWrite(this.options.signal, async (surface) => {
      await this.appendIn(surface, {
        name,
        kind: "sleep",
        wakeAt,
        completedAt: this.options.now(),
      });
      await surface.jobs.patch(this.options.id, {
        state: "pending",
        runAt: wakeAt,
        attempt: this.options.attempt - 1,
        leaseToken: null,
        leaseUntil: null,
      });
    });
    this.options.onSlept(wakeAt);
    throw new JobSleepSignal(wakeAt);
  }

  // -- The journal -----------------------------------------------------------

  /**
   * Resolve one named step against the journal: a recorded entry answers, a
   * mismatch refuses, an unrecorded name executes. Every resolution also
   * guards the in-run duplicate and surfaces a corrupt journal.
   */
  private claim<K extends StepKind>(
    name: string,
    kind: K,
    check: (entry: EntryOf<K>) => string | null,
  ): EntryOf<K> | null {
    if (this.corruption !== null) throw this.corruption;
    if (typeof name !== "string" || name.length === 0) {
      throw new AckerDBError("validation", "step names must be non-empty strings");
    }
    if (this.seen.has(name)) {
      throw new StepRefusalError(name, "duplicate step name in one run — names are identities");
    }
    this.seen.add(name);
    const entry = this.entries.get(name);
    if (entry === undefined) return null;
    if (entry.kind !== kind) {
      throw new StepRefusalError(name, `journaled as ${entry.kind}, code says ${kind}`);
    }
    const narrowed = entry as EntryOf<K>;
    const detail = check(narrowed);
    if (detail !== null) throw new StepRefusalError(name, detail);
    return narrowed;
  }

  /** Append one entry in its own transaction (procedure steps). */
  private async append(entry: StepJournalEntry): Promise<void> {
    await this.options.executor.jobsWrite(this.options.signal, async (surface) => {
      await this.appendIn(surface, entry);
    });
  }

  /** Append one entry inside an already-owned transaction, within finite bounds. */
  private async appendIn(
    surface: {
      readonly jobs: {
        byId(id: bigint): JobRow | null;
        patch(id: bigint, partial: Record<string, unknown>): Promise<void>;
      };
    },
    entry: StepJournalEntry,
  ): Promise<void> {
    const row = surface.jobs.byId(this.options.id);
    this.assertOwned(row);
    const journal = parseStepJournal(row!.stepsJson);
    journal.push(entry);
    if (journal.length > MAX_JOURNAL_STEPS) {
      throw new StepRefusalError(entry.name, `the journal is full (${MAX_JOURNAL_STEPS} steps)`);
    }
    const encoded = JSON.stringify(journal);
    if (encoded.length > MAX_JOURNAL_BYTES) {
      throw new StepRefusalError(
        entry.name,
        `the journal exceeds ${MAX_JOURNAL_BYTES} bytes; record smaller results or use child jobs`,
      );
    }
    await surface.jobs.patch(this.options.id, { stepsJson: encoded });
    this.entries.set(entry.name, entry);
  }

  /** A canceled, reclaimed, deleted, or suspended row must not gain journal entries. */
  private assertOwned(row: JobRow | null): void {
    if (row === null || row.state !== "running" || row.leaseToken !== this.options.leaseToken) {
      throw new AckerDBError("unavailable", "job attempt was superseded; its steps may not record");
    }
  }
}
