/**
 * The typed `ctx.jobs` surface, computed by code generation from the jobs
 * directory: each declared job appears at its address with exactly the powers
 * the surrounding context has. Wrong names and wrong argument shapes are
 * compile errors; awaiting from a mutation is unrepresentable.
 */
import type { TableColumns } from "../schema/definition.ts";
import type { TableQuery } from "../database/query/types.ts";
import type { AnyJob } from "./definition.ts";
import type { buildJobsTable } from "./table.ts";
import type {
  JobEnqueueOptions,
  JobHandle,
  JobAttemptOutcome,
} from "../runtime/jobs/runtime.ts";

type JobsTableColumns = TableColumns<ReturnType<typeof buildJobsTable>>;

/** One settled attempt, typed by the job's declared result. */
export type TypedJobOutcome<R> =
  | { readonly ok: true; readonly value: R }
  | {
      readonly ok: false;
      readonly state: "pending" | "discarded" | "canceled";
      readonly error: unknown;
      readonly nextRetryAt: number | null;
    };

/** The read surface: the reactive query builder scoped to this definition. */
export interface JobQuerySurface {
  query(): TableQuery<JobsTableColumns>;
}

/** The mutation surface: transactional enqueue plus visibility. */
export interface JobMutationSurface<Args> extends JobQuerySurface {
  enqueue(args: Args, options?: JobEnqueueOptions): Promise<JobHandle>;
}

/** The procedure surface: enqueue, await, and sanctioned transitions. */
export interface JobControlSurface<Args, R> {
  enqueue(args: Args, options?: JobEnqueueOptions): Promise<JobHandle>;
  /** Enqueue and resolve at the current attempt's settle. */
  run(args: Args, options?: JobEnqueueOptions): Promise<TypedJobOutcome<R>>;
  wait(handle: JobHandle | bigint): Promise<TypedJobOutcome<R>>;
  cancel(handle: JobHandle | bigint): Promise<string>;
  /** Re-run a settled row now, keeping identity and history. */
  retry(handle: JobHandle | bigint): Promise<void>;
  reschedule(handle: JobHandle | bigint, at: number): Promise<void>;
}

type ArgsOf<J> = J extends { _argsType?: infer I } ? Exclude<I, undefined> : never;
type ResultOf<J> = J extends { _retType?: infer R } ? R : never;

type JobExports<M> = {
  [Exp in keyof M as M[Exp] extends AnyJob ? Exp : never]: M[Exp];
};

/** ctx.jobs in queries, from the jobs-directory module map. */
export type QueryJobsApi<Modules> = {
  readonly [Mod in keyof Modules as keyof JobExports<Modules[Mod]> extends never
    ? never
    : Mod]: {
    readonly [Exp in keyof JobExports<Modules[Mod]>]: JobQuerySurface;
  };
};

/** ctx.jobs in mutations and transactions. */
export type MutationJobsApi<Modules> = {
  readonly [Mod in keyof Modules as keyof JobExports<Modules[Mod]> extends never
    ? never
    : Mod]: {
    readonly [Exp in keyof JobExports<Modules[Mod]>]: JobMutationSurface<
      ArgsOf<JobExports<Modules[Mod]>[Exp]>
    >;
  };
};

/** ctx.jobs in procedures, system runs, services, and job handlers. */
export type ProcedureJobsApi<Modules> = {
  readonly [Mod in keyof Modules as keyof JobExports<Modules[Mod]> extends never
    ? never
    : Mod]: {
    readonly [Exp in keyof JobExports<Modules[Mod]>]: JobControlSurface<
      ArgsOf<JobExports<Modules[Mod]>[Exp]>,
      ResultOf<JobExports<Modules[Mod]>[Exp]>
    >;
  };
};

// Untyped fallbacks: base contexts outside generated code stay usable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyJobsNamespace = Readonly<Record<string, any>>;
