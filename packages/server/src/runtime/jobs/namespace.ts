/**
 * The `ctx.jobs` namespace: one nested object per invocation, mirroring job
 * addresses (`ctx.jobs.emails.sendReceipt`), with the leaf surface matched to
 * the context's powers:
 *
 * - queries: `query()` and `runs()` — the reactive builders over `_ackerdb_jobs`
 *   and `_ackerdb_job_runs`, scoped to the definition.
 * - mutations: `enqueue` (a same-transaction Job insert: the Job exists iff the
 *   mutation commits) plus the read builders. Awaiting and transitions are
 *   absent by construction — a mutation holds the writer and cannot wait on it.
 * - procedures, system runs, services, and job handlers: `enqueue`, `run`,
 *   `wait`, `cancel`, `retry`, `runAgain`, `forceRunAgain`, `reschedule`,
 *   `delete` — each transition in its own transaction. This is the whole
 *   administration surface: state and run history move only through it, so no
 *   caller can leave a Job pointing at history it does not own.
 */
import { JOB_RUNS_TABLE, JOBS_TABLE } from "../../jobs/table.ts";
import type {
  JobRunOutcome,
  JobEnqueueOptions,
  JobHandle,
  RuntimeJobs,
} from "./runtime.ts";
import type { JobsStore } from "./store.ts";

interface Filterable {
  query(): { where(predicate: (row: never) => unknown): unknown };
}

type QueryableDb = Record<string, Filterable>;

type Leaf = Record<string, unknown>;

const idOf = (handle: JobHandle | bigint): bigint =>
  typeof handle === "bigint" ? handle : handle.id;

function assignLeaf(root: Record<string, unknown>, name: string, leaf: Leaf): void {
  const segments = name.split(".");
  let node = root;
  for (const segment of segments.slice(0, -1)) {
    node = (node[segment] ??= Object.create(null)) as Record<string, unknown>;
  }
  node[segments[segments.length - 1]!] = Object.freeze(leaf);
}

/**
 * The read builders: Jobs of this definition, and the runs of those Jobs. Runs
 * carry no definition name — they are addressed through their Job — so the run
 * builder is scoped by the Jobs the caller has already found.
 */
function readLeaf(db: QueryableDb, name: string): Leaf {
  return {
    query: () =>
      db[JOBS_TABLE]!.query().where((row) =>
        (row as { name: { eq(value: string): unknown } }).name.eq(name)),
    runs: (job: JobHandle | bigint) =>
      db[JOB_RUNS_TABLE]!.query().where((row) =>
        (row as { jobId: { eq(value: bigint): unknown } }).jobId.eq(idOf(job))),
  };
}

/** ctx.jobs for queries: read-only visibility. */
export function queryJobsNamespace(jobs: RuntimeJobs, db: unknown): unknown {
  const root: Record<string, unknown> = Object.create(null);
  for (const name of jobs.declaredNames) {
    assignLeaf(root, name, readLeaf(db as QueryableDb, name));
  }
  return Object.freeze(root);
}

/** ctx.jobs for mutations: transactional enqueue plus visibility. */
export function mutationJobsNamespace(
  jobs: RuntimeJobs,
  db: unknown,
  store: JobsStore,
): unknown {
  const root: Record<string, unknown> = Object.create(null);
  for (const name of jobs.declaredNames) {
    assignLeaf(root, name, {
      ...readLeaf(db as QueryableDb, name),
      enqueue: (args: unknown, options?: JobEnqueueOptions): Promise<JobHandle> =>
        jobs.enqueueWith(store, name, args, options),
    });
  }
  return Object.freeze(root);
}

/** ctx.jobs for procedures, system runs, services, and job handlers. */
export function procedureJobsNamespace(jobs: RuntimeJobs): unknown {
  const root: Record<string, unknown> = Object.create(null);
  for (const name of jobs.declaredNames) {
    assignLeaf(root, name, {
      enqueue: (args: unknown, options?: JobEnqueueOptions): Promise<JobHandle> =>
        jobs.enqueue(name, args, options),
      run: async (args: unknown, options?: JobEnqueueOptions): Promise<JobRunOutcome> => {
        const handle = await jobs.enqueue(name, args, options);
        return await jobs.wait(handle.id);
      },
      wait: (handle: JobHandle | bigint): Promise<JobRunOutcome> => jobs.wait(idOf(handle)),
      cancel: (handle: JobHandle | bigint) => jobs.cancel(idOf(handle)),
      retry: (handle: JobHandle | bigint) => jobs.retry(idOf(handle)),
      runAgain: (handle: JobHandle | bigint) => jobs.runAgain(idOf(handle)),
      forceRunAgain: (handle: JobHandle | bigint) => jobs.forceRunAgain(idOf(handle)),
      reschedule: (handle: JobHandle | bigint, at: number) => jobs.reschedule(idOf(handle), at),
      delete: (handle: JobHandle | bigint) => jobs.delete(idOf(handle)),
    });
  }
  return Object.freeze(root);
}
