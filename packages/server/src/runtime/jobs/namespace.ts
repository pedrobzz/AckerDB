/**
 * The `ctx.jobs` namespace: one nested object per invocation, mirroring job
 * addresses (`ctx.jobs.emails.sendReceipt`), with the leaf surface matched to
 * the context's powers:
 *
 * - queries: `query()` — the reactive builder over `_ackerdb_jobs`, scoped to
 *   the definition.
 * - mutations: `enqueue` (a same-transaction row insert: the job exists iff
 *   the mutation commits) and `query()`. Awaiting and transitions are absent
 *   by construction — a mutation holds the writer and cannot wait on it.
 * - procedures, system runs, services, and job handlers: `enqueue`, `run`,
 *   `wait`, `cancel`, `retry`, `reschedule` — each transition in its own
 *   transaction. Row surgery beyond that is ordinary `_ackerdb_jobs` CRUD.
 */
import { JOBS_TABLE } from "../../jobs/table.ts";
import type {
  JobAttemptOutcome,
  JobEnqueueOptions,
  JobHandle,
  RuntimeJobs,
} from "./runtime.ts";
import type { JobsStore } from "./store.ts";

interface QueryableDb {
  readonly [JOBS_TABLE]: {
    query(): { where(predicate: (row: never) => unknown): unknown };
  };
}

type Leaf = Record<string, unknown>;

function assignLeaf(root: Record<string, unknown>, name: string, leaf: Leaf): void {
  const segments = name.split(".");
  let node = root;
  for (const segment of segments.slice(0, -1)) {
    node = (node[segment] ??= Object.create(null)) as Record<string, unknown>;
  }
  node[segments[segments.length - 1]!] = Object.freeze(leaf);
}

function queryLeaf(db: QueryableDb, name: string): Leaf {
  return {
    query: () =>
      db[JOBS_TABLE].query().where((row) =>
        (row as { name: { eq(value: string): unknown } }).name.eq(name)),
  };
}

/** ctx.jobs for queries: read-only visibility. */
export function queryJobsNamespace(jobs: RuntimeJobs, db: unknown): unknown {
  const root: Record<string, unknown> = Object.create(null);
  for (const name of jobs.declaredNames) {
    assignLeaf(root, name, queryLeaf(db as QueryableDb, name));
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
      ...queryLeaf(db as QueryableDb, name),
      enqueue: (args: unknown, options?: JobEnqueueOptions): Promise<JobHandle> => {
        try {
          return Promise.resolve(jobs.enqueueWith(store, name, args, options));
        } catch (error) {
          return Promise.reject(error);
        }
      },
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
      run: async (args: unknown, options?: JobEnqueueOptions): Promise<JobAttemptOutcome> => {
        const handle = await jobs.enqueue(name, args, options);
        return await jobs.wait(handle.id);
      },
      wait: (handle: JobHandle | bigint): Promise<JobAttemptOutcome> =>
        jobs.wait(typeof handle === "bigint" ? handle : handle.id),
      cancel: (handle: JobHandle | bigint) =>
        jobs.cancel(typeof handle === "bigint" ? handle : handle.id),
      retry: (handle: JobHandle | bigint) =>
        jobs.retryNow(typeof handle === "bigint" ? handle : handle.id),
      reschedule: (handle: JobHandle | bigint, at: number) =>
        jobs.reschedule(typeof handle === "bigint" ? handle : handle.id, at),
    });
  }
  return Object.freeze(root);
}
