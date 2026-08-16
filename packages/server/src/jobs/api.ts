/**
 * The typed `ctx.jobs` surface, computed by code generation from the jobs
 * directory: each declared job appears at its address with exactly the powers
 * the surrounding context has. Wrong names and wrong argument shapes are
 * compile errors; awaiting from a mutation is unrepresentable.
 */
import type { TableColumns } from "../schema/definition.ts";
import type { TableQuery } from "../database/query/types.ts";
import type { AnyJob, JobState } from "./definition.ts";
import type { buildJobRunsTable, buildJobsTable } from "./table.ts";
import type { JobEnqueueOptions, JobHandle, JobRunOutcome } from "../runtime/jobs/runtime.ts";

type JobsTableColumns = TableColumns<ReturnType<typeof buildJobsTable>>;
type JobRunsTableColumns = TableColumns<ReturnType<typeof buildJobRunsTable>>;

/** The read surface: the reactive query builders scoped to this definition. */
export interface JobQuerySurface {
  /** The Jobs of this definition. */
  query(): TableQuery<JobsTableColumns>;
  /** One Job's runs, oldest to newest by `number`. */
  runs(job: JobHandle | bigint): TableQuery<JobRunsTableColumns>;
}

/** The mutation surface: transactional enqueue plus visibility. */
export interface JobMutationSurface<Args> extends JobQuerySurface {
  enqueue(args: Args, options?: JobEnqueueOptions): Promise<JobHandle>;
}

/** The procedure surface: enqueue, await, and every sanctioned transition. */
export interface JobControlSurface<Args, R> {
  enqueue(args: Args, options?: JobEnqueueOptions): Promise<JobHandle>;
  /** Enqueue and resolve at the current run's settle. */
  run(args: Args, options?: JobEnqueueOptions): Promise<JobRunOutcome<R>>;
  wait(handle: JobHandle | bigint): Promise<JobRunOutcome<R>>;
  cancel(handle: JobHandle | bigint): Promise<JobState>;
  /** Manual retry: another run for a Failed Job, keeping identity and journal. */
  retry(handle: JobHandle | bigint): Promise<void>;
  /** Run again: resubmit a terminal Job's arguments through ordinary dedupe. */
  runAgain(handle: JobHandle | bigint): Promise<JobHandle>;
  /** Force run again: another run under the same identity, replacing its outcome. */
  forceRunAgain(handle: JobHandle | bigint): Promise<void>;
  reschedule(handle: JobHandle | bigint, at: number): Promise<void>;
  /** Delete the Job and every run it owns. */
  delete(handle: JobHandle | bigint): Promise<void>;
}

type ArgsOf<J> = J extends { _argsType?: infer I } ? Exclude<I, undefined> : never;
type ResultOf<J> = J extends { _retType?: infer R } ? R : never;

type JobExports<M> = {
  [Exp in keyof M as M[Exp] extends AnyJob ? Exp : never]: M[Exp];
};

/** One job module's ctx.jobs slice in queries; codegen nests these. */
export type QueryJobsOf<M> = {
  readonly [Exp in keyof JobExports<M>]: JobQuerySurface;
};

/** One job module's ctx.jobs slice in mutations and transactions. */
export type MutationJobsOf<M> = {
  readonly [Exp in keyof JobExports<M>]: JobMutationSurface<ArgsOf<JobExports<M>[Exp]>>;
};

/** One job module's ctx.jobs slice in procedures, system runs, and jobs. */
export type ProcedureJobsOf<M> = {
  readonly [Exp in keyof JobExports<M>]: JobControlSurface<
    ArgsOf<JobExports<M>[Exp]>,
    ResultOf<JobExports<M>[Exp]>
  >;
};

// Untyped fallbacks: base contexts outside generated code stay usable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyJobsNamespace = Readonly<Record<string, any>>;
