/**
 * Durable jobs: background work an application enqueues from its own
 * functions and AckerDB executes, retries, repeats, and retains — as one Job
 * row in `_ackerdb_jobs` plus one `_ackerdb_job_runs` row per handler
 * execution.
 *
 * A Job is a unit of work with a durable row, an envelope (claim → run →
 * settle), and a policy. It is not a function
 * module export: no client can address a job, and jobs reach clients only
 * through user-authored functions over the jobs tables.
 */
import type { FunctionReference, Result } from "@ackerdb/core";
import { brand, hasBrand } from "../shared/identity.ts";
import type { Schema } from "../schema/definition.ts";
import type { DbReader } from "../database/query/types.ts";
import type { ObjectShape, InferShape, InferInputShape } from "../validation/composites.ts";
import type { Expand } from "../validation/validator.ts";
import { validateArgsShape } from "../validation/declarations.ts";
import type { MutationCtx, ProcedureCtx, FunctionResult } from "../app/functions.ts";
import type { AnyJobsNamespace } from "./api.ts";
import type { SystemPrincipal } from "../auth/credentials.ts";
import { cronNext, parseCronExpression } from "./cron.ts";

const JOB_IDENTITY = Symbol.for("@ackerdb/server/Job/v1");

function assertOnlyKeys(
  value: object,
  allowed: readonly string[],
  what: string,
): void {
  for (const option of Object.keys(value)) {
    if (!allowed.includes(option)) {
      throw new TypeError(`unknown ${what} option "${option}"`);
    }
  }
}

type EmptyContextCapabilities = Readonly<Record<never, never>>;

/** A Job's own state. `retrying` is non-terminal: its next run is scheduled. */
export const JOB_STATES = [
  "pending",
  "running",
  "retrying",
  "completed",
  "failed",
  "canceled",
] as const;
export type JobState = (typeof JOB_STATES)[number];

/** What admitted a Job. */
export const JOB_TRIGGERS = ["enqueue", "repeat", "run_again"] as const;
export type JobTrigger = (typeof JOB_TRIGGERS)[number];

/** One Job run's state; `running` is the only non-terminal one. */
export const JOB_RUN_STATES = ["running", "completed", "failed", "canceled"] as const;
export type JobRunState = (typeof JOB_RUN_STATES)[number];

/** Why a Job run exists. */
export const JOB_RUN_TRIGGERS = [
  "initial",
  "automatic_retry",
  "manual_retry",
  "force",
] as const;
export type JobRunTrigger = (typeof JOB_RUN_TRIGGERS)[number];

/** Milliseconds to wait before run `runNumber + 1`, or null to fail the Job. */
export type JobRetry = (runNumber: number, error: unknown) => number | null;

/** The next occurrence after `lastScheduledAt`, or null to end the recurrence. */
export type JobRepeat = (lastScheduledAt: number, now: number) => number | null;

export interface JobRetryConfig {
  readonly attempts: number;
  readonly backoff?: "exponential" | "fixed";
  readonly delayMs?: number;
}

export type JobRepeatConfig =
  | { readonly cron: string; readonly tz: string }
  | { readonly everyMs: number };

/** A duration in milliseconds, or "forever" for unbounded retention/dedup. */
export type JobWindow = number | "forever";

export interface JobDedupe {
  /** Extend dedupe past success: calls inside the window return the recorded result. */
  readonly completed?: JobWindow;
  /** Extend dedupe past exhaustion: calls inside the window return the recorded failure. */
  readonly failed?: JobWindow;
}

/** The transaction powers of a mutation-kind job handler. */
export type JobTxCtx<
  S extends Schema = Schema,
  Capabilities extends object = EmptyContextCapabilities,
  TxJobs extends object = AnyJobsNamespace,
> = Omit<MutationCtx<S, Capabilities, TxJobs>, "auth"> & {
  readonly auth: SystemPrincipal;
  /** 1-based number of this Job run. */
  readonly runNumber: number;
};

/** Per-step options on `step.run`; the default journal identity is the callee's address. */
export interface JobStepOptions {
  /** Overrides the journal identity — required when one run calls a ref twice. */
  readonly name?: string;
}

/** The read powers of an inline `step.query` closure: the snapshot, read-only. */
export type JobStepQueryCtx<
  S extends Schema = Schema,
  TxJobs extends object = AnyJobsNamespace,
> = {
  readonly db: DbReader<S>;
  readonly auth: SystemPrincipal;
  readonly timestamp: number;
  readonly runNumber: number;
  /** Declared jobs, read-only: the reactive builder scoped per definition. */
  readonly jobs: TxJobs;
};

/**
 * Durable steps (ADR-0022): named, journaled units of work inside a
 * procedure-kind job handler. A completed step's recorded result stands in
 * for re-execution when the run resumes. The name is a contract — same name,
 * same meaning — and everything effectful in a step-using handler belongs
 * inside a step.
 */
export interface JobStep<
  S extends Schema = Schema,
  TransactionCapabilities extends object = EmptyContextCapabilities,
  TxJobs extends object = AnyJobsNamespace,
> {
  /**
   * The journaled variant of server-side composition: invoke a registered
   * query, mutation, or procedure and record its typed Result. A mutation
   * callee commits atomically with its journal entry; a returned `Err` is a
   * recorded value, and only a throw fails the run.
   */
  run<K extends "query" | "mutation" | "procedure", A, D, E>(
    ref: FunctionReference<K, A, D, E>,
    args: A,
    options?: JobStepOptions,
  ): Promise<Result<D, E>>;
  /** An inline read step: the closure's return value is the journaled result. */
  query<R>(
    name: string,
    fn: (tx: JobStepQueryCtx<S, TxJobs>) => R | PromiseLike<R>,
  ): Promise<Awaited<R>>;
  /** An inline write step: one writer transaction, journal entry included — exactly-once. */
  mutation<R>(
    name: string,
    fn: (tx: JobTxCtx<S, TransactionCapabilities, TxJobs>) => R | PromiseLike<R>,
  ): Promise<Awaited<R>>;
  /** An inline external-work step: at-least-once, journaled on completion. */
  procedure<R>(name: string, fn: () => R | PromiseLike<R>): Promise<Awaited<R>>;
  /**
   * Suspend the run until `durationMs` from first encounter: the Job goes back
   * to pending with a future due time and the run stays open, so the same run
   * resumes — sleeping is not failing, and the retry budget stays untouched.
   */
  sleep(name: string, durationMs: number): Promise<void>;
}

/** The powers of a procedure-kind job handler: external work plus explicit tx. */
export type JobCtx<
  S extends Schema = Schema,
  Capabilities extends object = EmptyContextCapabilities,
  TransactionCapabilities extends object = EmptyContextCapabilities,
  Jobs extends object = AnyJobsNamespace,
  TxJobs extends object = AnyJobsNamespace,
> = Omit<
  ProcedureCtx<S, Capabilities, TransactionCapabilities, Jobs>,
  "auth" | "tx" | "linkAccount" | "unlinkAccount"
> & {
  readonly auth: SystemPrincipal;
  /** 1-based number of this Job run. */
  readonly runNumber: number;
  /** Fires on cancel, shutdown, or lease expiry: stop cooperatively. */
  readonly abortSignal: AbortSignal;
  /** Durable steps: using them is the opt-in; a handler with no steps is untouched. */
  readonly step: JobStep<S, TransactionCapabilities, TxJobs>;
  tx<R>(
    fn: (tx: JobTxCtx<S, TransactionCapabilities, TxJobs>) => R,
  ): Promise<FunctionResult<R>>;
};

/**
 * The exact builder code generation publishes, bound to one application's
 * schema and jobs directory.
 */
export interface JobBuilder<
  S extends Schema,
  Capabilities extends object = EmptyContextCapabilities,
  TransactionCapabilities extends object = EmptyContextCapabilities,
  Jobs extends object = AnyJobsNamespace,
  TxJobs extends object = AnyJobsNamespace,
> {
  <A extends ObjectShape, R>(
    definition: MutationJobDefinition<
      A,
      JobTxCtx<S, TransactionCapabilities, TxJobs>,
      R
    >,
  ): Job<A, Awaited<R>>;
  <A extends ObjectShape, R>(
    definition: ProcedureJobDefinition<
      A,
      JobCtx<S, Capabilities, TransactionCapabilities, Jobs, TxJobs>,
      R
    >,
  ): Job<A, Awaited<R>>;
}

interface JobDefinitionBase<A extends ObjectShape> {
  readonly args: A;
  /** Max simultaneous runs; applies per key when `key` is declared. */
  readonly concurrency?: number;
  /** Partition key derived from args; concurrency then applies per (job, key). */
  readonly key?: (args: Expand<InferShape<A>>) => string | number | bigint;
  /** Retry policy: config sugar or (runNumber, error) => delayMs | null. */
  readonly retry?: JobRetry | JobRetryConfig;
  /** Recurrence: config sugar or (lastScheduledAt, now) => timestamp | null. */
  readonly repeat?: JobRepeat | JobRepeatConfig;
  /** Deduplicate live Jobs by canonical args; windows extend past settle. */
  readonly dedupe?: JobDedupe | "inflight";
  /** How long a terminal Job and its runs stay queryable. Default: 7 days. */
  readonly retention?: JobWindow;
}

export interface ProcedureJobDefinition<
  A extends ObjectShape,
  Ctx,
  R,
> extends JobDefinitionBase<A> {
  readonly kind?: "procedure";
  readonly handler: (ctx: Ctx, args: Expand<InferShape<A>>) => R | Promise<R>;
}

export interface MutationJobDefinition<
  A extends ObjectShape,
  TxCtx,
  R,
> extends JobDefinitionBase<A> {
  readonly kind: "mutation";
  readonly handler: (tx: TxCtx, args: Expand<InferShape<A>>) => R | Promise<R>;
}

/** One registered job: normalized policy plus the handler, frozen. */
export interface Job<A extends ObjectShape = ObjectShape, R = unknown> {
  readonly kind: "procedure" | "mutation";
  readonly args: A;
  readonly concurrency: number;
  readonly key: ((args: never) => string | number | bigint) | null;
  readonly retry: JobRetry;
  readonly repeat: JobRepeat | null;
  readonly dedupe: { readonly completed: JobWindow; readonly failed: JobWindow } | null;
  readonly retention: JobWindow;
  readonly handler: (ctx: never, args: never) => unknown;
  /** Phantom carriers for generated typing. */
  readonly _argsType?: InferInputShape<A>;
  readonly _retType?: R;
}

// Job registries deliberately erase each job's concrete context and args.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyJob = Job<any, any>;

export const DEFAULT_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

/** No retries unless declared: the first failed run fails the Job. */
const NO_RETRY: JobRetry = () => null;

function normalizeWindow(value: unknown, where: string): JobWindow {
  if (value === "forever") return "forever";
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  throw new TypeError(`${where} must be a non-negative number of milliseconds or "forever"`);
}

function normalizeRetry(retry: JobRetry | JobRetryConfig | undefined): JobRetry {
  if (retry === undefined) return NO_RETRY;
  if (typeof retry === "function") return retry;
  if (typeof retry !== "object" || retry === null) {
    throw new TypeError("job retry must be a function or { attempts, backoff?, delayMs? }");
  }
  assertOnlyKeys(retry, ["attempts", "backoff", "delayMs"], "job retry");
  const { attempts, backoff = "exponential", delayMs = 1_000 } = retry;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new TypeError("job retry attempts must be a positive integer");
  }
  if (backoff !== "exponential" && backoff !== "fixed") {
    throw new TypeError('job retry backoff must be "exponential" or "fixed"');
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new TypeError("job retry delayMs must be a non-negative number");
  }
  return (runNumber) => {
    if (runNumber >= attempts) return null;
    return backoff === "fixed" ? delayMs : delayMs * 2 ** (runNumber - 1);
  };
}

function normalizeRepeat(repeat: JobRepeat | JobRepeatConfig | undefined): JobRepeat | null {
  if (repeat === undefined) return null;
  if (typeof repeat === "function") return repeat;
  if (typeof repeat !== "object" || repeat === null) {
    throw new TypeError("job repeat must be a function, { cron, tz }, or { everyMs }");
  }
  if ("everyMs" in repeat) {
    assertOnlyKeys(repeat, ["everyMs"], "job repeat");
    const { everyMs } = repeat;
    if (!Number.isFinite(everyMs) || everyMs <= 0) {
      throw new TypeError("job repeat everyMs must be a positive number");
    }
    // Coalesce misses to one: the next occurrence is always in the future.
    return (lastScheduledAt, now) => {
      const base = Math.max(lastScheduledAt, now);
      return base + everyMs - ((base - lastScheduledAt) % everyMs);
    };
  }
  if ("cron" in repeat) {
    assertOnlyKeys(repeat, ["cron", "tz"], "job repeat");
    const { cron, tz } = repeat as { cron: string; tz: string };
    if (typeof tz !== "string" || tz.length === 0) {
      throw new TypeError("job repeat cron requires an IANA tz");
    }
    parseCronExpression(cron);
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
    } catch {
      throw new TypeError(`job repeat tz "${tz}" is not a valid IANA timezone`);
    }
    // Coalesce misses to one: search forward from whichever is later.
    return (lastScheduledAt, now) => cronNext(cron, tz, Math.max(lastScheduledAt, now));
  }
  throw new TypeError("job repeat must be a function, { cron, tz }, or { everyMs }");
}

function normalizeDedupe(
  dedupe: JobDedupe | "inflight" | undefined,
): Job["dedupe"] {
  if (dedupe === undefined) return null;
  if (dedupe === "inflight") return Object.freeze({ completed: 0, failed: 0 });
  if (typeof dedupe !== "object" || dedupe === null) {
    throw new TypeError('job dedupe must be "inflight" or { completed?, failed? }');
  }
  assertOnlyKeys(dedupe, ["completed", "failed"], "job dedupe");
  return Object.freeze({
    completed: dedupe.completed === undefined
      ? 0
      : normalizeWindow(dedupe.completed, "job dedupe completed"),
    failed: dedupe.failed === undefined
      ? 0
      : normalizeWindow(dedupe.failed, "job dedupe failed"),
  });
}

const KNOWN_OPTIONS = new Set([
  "kind",
  "args",
  "handler",
  "concurrency",
  "key",
  "retry",
  "repeat",
  "dedupe",
  "retention",
]);

export function job<
  A extends ObjectShape,
  Ctx,
  TxCtx,
  R,
>(
  definition: ProcedureJobDefinition<A, Ctx, R> | MutationJobDefinition<A, TxCtx, R>,
): Job<A, R> {
  if (typeof definition !== "object" || definition === null || Array.isArray(definition)) {
    throw new TypeError("job definition must be a plain object");
  }
  assertOnlyKeys(definition, [...KNOWN_OPTIONS], "job");
  const kind = definition.kind ?? "procedure";
  if (kind !== "procedure" && kind !== "mutation") {
    throw new TypeError('job kind must be "procedure" or "mutation"');
  }
  validateArgsShape(definition.args);
  if (typeof definition.handler !== "function") {
    throw new TypeError("job handler must be a function");
  }
  const concurrency = definition.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError("job concurrency must be a positive integer");
  }
  if (definition.key !== undefined && typeof definition.key !== "function") {
    throw new TypeError("job key must be a function of the args");
  }
  const retention = definition.retention === undefined
    ? DEFAULT_JOB_RETENTION_MS
    : normalizeWindow(definition.retention, "job retention");

  const declared: Job<A, R> = {
    kind,
    args: definition.args,
    concurrency,
    key: (definition.key as Job["key"]) ?? null,
    retry: normalizeRetry(definition.retry),
    repeat: normalizeRepeat(definition.repeat),
    dedupe: normalizeDedupe(definition.dedupe),
    retention,
    handler: definition.handler as Job["handler"],
  };
  brand(declared, JOB_IDENTITY);
  return Object.freeze(declared);
}

/** True for a job created by any compatible @ackerdb/server instance. */
export function isJob(value: unknown): value is AnyJob {
  return hasBrand(value, JOB_IDENTITY);
}

/** One job and the exact name rows and ctx.jobs report. */
export interface DeclaredJob {
  readonly name: string;
  readonly job: AnyJob;
}

/**
 * Resolve job modules to declarations, mirroring the function
 * registry: `jobs/emails.ts` exporting `sendReceipt` is `emails.sendReceipt`,
 * in deterministic module-then-export order. Helpers are ignored; an unbranded
 * export *shaped* like a job is the residue of forgetting `job(...)` and fails
 * loudly instead of never running.
 */
export function declareJobs(
  modules: Record<string, Record<string, unknown>>,
): DeclaredJob[] {
  const declared: DeclaredJob[] = [];
  const names = new Set<string>();
  for (const [modulePath, exports] of Object.entries(modules).sort(([a], [b]) =>
    a.localeCompare(b))) {
    for (const [exportName, value] of Object.entries(exports).sort(([a], [b]) =>
      a.localeCompare(b))) {
      const name = `${modulePath}.${exportName}`;
      if (isJob(value)) {
        if (names.has(name)) throw new TypeError(`duplicate job name "${name}"`);
        names.add(name);
        declared.push({ name, job: value });
        continue;
      }
      if (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { readonly handler?: unknown }).handler === "function" &&
        Object.hasOwn(value, "args")
      ) {
        throw new TypeError(
          `job module export "${name}" has a handler but was not created with job(...)`,
        );
      }
    }
  }
  return declared;
}
