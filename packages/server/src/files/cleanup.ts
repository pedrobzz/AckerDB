import { randomUUID } from "node:crypto";
import type { RuntimeFiles } from "./namespace.ts";
import {
  fileDatabase,
  pendingCleanupRow,
  storedFileError,
  type FileDatabase,
} from "./database.ts";
import type { ManagedQuery } from "../database/managed.ts";
import {
  FILE_CLEANUP_TABLE,
  FILE_GRANTS_TABLE,
  FILE_UPLOADS_TABLE,
  FILES_TABLE,
} from "./tables.ts";
import { FileStoreError } from "./store/contract.ts";

export interface FileCleanupRuntimeOptions {
  readonly files: RuntimeFiles;
  readonly now: () => number;
  read<T>(signal: AbortSignal, work: (db: unknown) => T | Promise<T>): Promise<T>;
  write<T>(signal: AbortSignal, work: (db: unknown) => T | Promise<T>): Promise<T>;
}

interface CleanupTask {
  readonly id: bigint;
  readonly objectKey: string;
  readonly fileId: bigint | null;
  readonly attempt: number;
  readonly leaseToken: string;
}

const BATCH_SIZE = 32;
const LEASE_MS = 60_000;
const MAX_TIMER_MS = 2_147_483_647;

function stateAndTime<Row>(
  query: ManagedQuery<Row>,
  state: string,
  field: "expiresAt" | "pendingExpiresAt" | "runAt" | "leaseUntil",
  time: number,
): ManagedQuery<Row> {
  return query.where((value) => {
    const row = value as unknown as Record<string, { eq(value: string): unknown; lte(value: number): unknown }>;
    return (row.state!.eq(state) as { and(value: unknown): unknown }).and(row[field]!.lte(time));
  });
}

function stateOnly<Row>(query: ManagedQuery<Row>, state: string): ManagedQuery<Row> {
  return query.where((value) => {
    const row = value as unknown as { state: { eq(value: string): unknown } };
    return row.state.eq(state);
  });
}

function timeAtMost<Row>(
  query: ManagedQuery<Row>,
  field: "expiresAt",
  time: number,
): ManagedQuery<Row> {
  return query.where((value) => {
    const row = value as unknown as Record<string, { lte(value: number): unknown }>;
    return row[field]!.lte(time);
  });
}

function notNull<Row>(query: ManagedQuery<Row>, field: "expiresAt"): ManagedQuery<Row> {
  return query.where((value) => {
    const row = value as unknown as Record<string, { isNotNull(): unknown }>;
    return row[field]!.isNotNull();
  });
}

function orderedFirst<Row>(
  query: ManagedQuery<Row>,
  field: "expiresAt" | "pendingExpiresAt" | "runAt" | "leaseUntil",
): Promise<Row | null> {
  return query.orderBy((value) => {
    const row = value as unknown as Record<string, { asc(): unknown }>;
    return row[field]!.asc();
  }).first();
}

async function firstTime<Row extends object, Field extends keyof Row>(
  query: ManagedQuery<Row>,
  field: Field & ("expiresAt" | "pendingExpiresAt" | "runAt" | "leaseUntil"),
): Promise<number | null> {
  const row = await orderedFirst(query, field);
  if (row === null) return null;
  const at = row[field];
  return typeof at === "number" ? at : null;
}

async function nextCleanupAt(db: FileDatabase): Promise<number | null> {
  const candidates = await Promise.all([
    firstTime(stateOnly(db[FILES_TABLE].query(), "pending"), "pendingExpiresAt"),
    firstTime(stateOnly(db[FILE_UPLOADS_TABLE].query(), "open"), "expiresAt"),
    firstTime(stateOnly(db[FILE_UPLOADS_TABLE].query(), "committed"), "expiresAt"),
    firstTime(notNull(db[FILE_GRANTS_TABLE].query(), "expiresAt"), "expiresAt"),
    firstTime(stateOnly(db[FILE_CLEANUP_TABLE].query(), "pending"), "runAt"),
    firstTime(stateOnly(db[FILE_CLEANUP_TABLE].query(), "running"), "leaseUntil"),
  ]);
  return candidates.reduce<number | null>((earliest, at) => {
    return at !== null && (earliest === null || at < earliest) ? at : earliest;
  }, null);
}

/** Durable, idle-until-armed cleanup for pending uploads, Files, and object deletion. */
export class FileCleanupRuntime {
  private readonly controller = new AbortController();
  private readonly recoveryReady: Promise<void>;
  private resolveRecoveryReady!: () => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private recovering = true;
  private armedAt: number | null = null;
  private rerun = false;
  private recoveryReadyResolved = false;
  lastFailure: unknown = null;

  constructor(private readonly options: FileCleanupRuntimeOptions) {
    this.recoveryReady = new Promise((resolve) => {
      this.resolveRecoveryReady = resolve;
    });
    options.files.bindCleanupScheduler((at) => this.arm(at));
  }

  /** Starts with a read-only inspection and resolves once restart recovery commits. */
  activate(): Promise<void> {
    this.run();
    return this.recoveryReady;
  }

  arm(at: number): void {
    if (this.stopped || !Number.isFinite(at)) return;
    if (this.armedAt !== null && this.armedAt <= at) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.armedAt = at;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, at - this.options.now()));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.armedAt = null;
      this.run();
    }, delay);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.armedAt = null;
    this.controller.abort(new Error("File cleanup is stopping"));
  }

  async drain(): Promise<void> {
    await this.running?.catch(() => {});
  }

  private run(): void {
    if (this.stopped) return;
    if (this.running !== null) {
      this.rerun = true;
      return;
    }
    this.running = this.cycle().then(() => {
      this.lastFailure = null;
    }).catch((error) => {
      this.lastFailure = error;
      if (!this.stopped) this.arm(this.options.now() + 1_000);
    }).finally(() => {
      this.running = null;
      if (this.rerun && !this.stopped) {
        this.rerun = false;
        this.arm(this.options.now());
      }
    });
  }

  private async cycle(): Promise<void> {
    const now = this.options.now();
    const recovering = this.recovering;
    const inspection = await this.options.read(this.controller.signal, async (value) => {
      const db = fileDatabase(value);
      const nextAt = await nextCleanupAt(db);
      if (!recovering) {
        return { needsWrite: nextAt !== null && nextAt <= now, nextAt };
      }
      const [running, staging, uploading] = await Promise.all([
        stateOnly(db[FILE_CLEANUP_TABLE]!.query(), "running").first(),
        stateOnly(db[FILE_CLEANUP_TABLE]!.query(), "staging").first(),
        stateOnly(db[FILE_UPLOADS_TABLE]!.query(), "uploading").first(),
      ]);
      return {
        needsWrite: running !== null || staging !== null || uploading !== null ||
          (nextAt !== null && nextAt <= now),
        nextAt,
      };
    });
    if (!inspection.needsWrite) {
      if (recovering) {
        this.recovering = false;
        this.completeRecovery();
      }
      if (inspection.nextAt !== null) this.arm(inspection.nextAt);
      return;
    }
    const cycle = await this.options.write(this.controller.signal, async (value) => {
      const db = fileDatabase(value);
      const files = db[FILES_TABLE]!;
      const uploads = db[FILE_UPLOADS_TABLE]!;
      const grants = db[FILE_GRANTS_TABLE]!;
      const cleanup = db[FILE_CLEANUP_TABLE]!;
      let recoveryBatchFull = false;
      let expiredLeaseBatchFull = false;

      if (recovering) {
        // This Runtime owns the deployment exclusively, so every row left in an
        // in-progress state belongs to a process that no longer exists. Waiting
        // for its old wall-clock lease would strand work across a clock change.
        const interruptedCleanup = await stateOnly(cleanup.query(), "running").take(BATCH_SIZE);
        for (const task of interruptedCleanup) {
          await cleanup.patch(task.id, {
            state: "pending",
            runAt: now,
            leaseToken: null,
            leaseUntil: null,
            lastError: "recovering an interrupted cleanup attempt",
          });
        }
        const interruptedStaging = await stateOnly(cleanup.query(), "staging").take(BATCH_SIZE);
        for (const task of interruptedStaging) {
          await cleanup.patch(task.id, {
            state: "pending",
            runAt: now,
            lastError: "recovering an interrupted backend File store",
          });
        }
        const interruptedUploads = await stateOnly(uploads.query(), "uploading").take(BATCH_SIZE);
        for (const upload of interruptedUploads) {
          await cleanup.insert(pendingCleanupRow({
            objectKey: upload.objectKey,
            fileId: null,
            now,
            lastError: "recovering an interrupted upload attempt",
          }));
          if (typeof upload.expiresAt === "number" && upload.expiresAt > now) {
            await uploads.patch(upload.id, {
              state: "open",
              objectKey: `files/${randomUUID()}`,
              attemptToken: null,
            });
          } else {
            await uploads.delete(upload.id);
          }
        }
        recoveryBatchFull = interruptedCleanup.length === BATCH_SIZE ||
          interruptedStaging.length === BATCH_SIZE ||
          interruptedUploads.length === BATCH_SIZE;
      } else {
        const expiredLeases = await stateAndTime(
          cleanup.query(),
          "running",
          "leaseUntil",
          now,
        ).take(BATCH_SIZE);
        for (const task of expiredLeases) {
          await cleanup.patch(task.id, {
            state: "pending",
            runAt: now,
            leaseToken: null,
            leaseUntil: null,
            lastError: "recovering an expired cleanup lease",
          });
        }
        expiredLeaseBatchFull = expiredLeases.length === BATCH_SIZE;
      }

      const pendingFiles = await stateAndTime(
        files.query(),
        "pending",
        "pendingExpiresAt",
        now,
      ).take(BATCH_SIZE);
      for (const file of pendingFiles) {
        const fileId = file.id;
        await files.patch(fileId, { state: "deleting", pendingExpiresAt: null });
        await cleanup.insert(pendingCleanupRow({
          objectKey: file.objectKey,
          fileId,
          now,
          lastError: null,
        }));
      }

      for (const state of ["open", "committed"]) {
        const expired = await stateAndTime(uploads.query(), state, "expiresAt", now).take(BATCH_SIZE);
        for (const upload of expired) {
          await uploads.delete(upload.id);
        }
      }

      const expiredGrants = await timeAtMost(grants.query(), "expiresAt", now).take(BATCH_SIZE);
      for (const grant of expiredGrants) await grants.delete(grant.id);

      const due = await stateAndTime(cleanup.query(), "pending", "runAt", now).take(BATCH_SIZE);
      const claimed: CleanupTask[] = [];
      for (const task of due) {
        const leaseToken = randomUUID();
        await cleanup.patch(task.id, {
          state: "running",
          leaseToken,
          leaseUntil: now + LEASE_MS,
        });
        claimed.push({
          id: task.id,
          objectKey: task.objectKey,
          fileId: task.fileId,
          attempt: task.attempt,
          leaseToken,
        });
      }
      return { tasks: claimed, recoveryBatchFull, expiredLeaseBatchFull };
    });

    this.recovering = cycle.recoveryBatchFull;
    if (!this.recovering) this.completeRecovery();
    for (const task of cycle.tasks) await this.deleteObject(task);
    await this.scheduleNext(
      cycle.tasks.length === BATCH_SIZE || cycle.recoveryBatchFull || cycle.expiredLeaseBatchFull,
    );
  }

  private async deleteObject(task: CleanupTask): Promise<void> {
    const store = this.options.files.store;
    if (store === undefined) {
      await this.retry(task, new Error("file storage is not configured"));
      return;
    }
    try {
      await store.delete(task.objectKey, { signal: this.controller.signal });
    } catch (error) {
      if (!this.stopped) await this.retry(task, error);
      return;
    }
    try {
      await this.options.write(this.controller.signal, async (value) => {
        const db = fileDatabase(value);
        const row = await db[FILE_CLEANUP_TABLE]!.get(task.id);
        if (row?.state !== "running" || row.leaseToken !== task.leaseToken) return;
        if (task.fileId !== null) await db[FILES_TABLE]!.delete(task.fileId);
        await db[FILE_CLEANUP_TABLE]!.delete(task.id);
      });
    } catch (error) {
      if (!this.stopped) await this.retry(task, error);
    }
  }

  private async retry(task: CleanupTask, error: unknown): Promise<void> {
    const attempt = task.attempt + 1;
    const delay = Math.min(60 * 60_000, 1_000 * 2 ** Math.min(attempt, 12));
    const runAt = this.options.now() + delay;
    await this.options.write(this.controller.signal, async (value) => {
      const table = (fileDatabase(value))[FILE_CLEANUP_TABLE]!;
      const row = await table.get(task.id);
      if (row?.state !== "running" || row.leaseToken !== task.leaseToken) return;
      await table.patch(task.id, {
        state: "pending",
        attempt,
        runAt,
        leaseToken: null,
        leaseUntil: null,
        lastError: storedFileError(error),
      });
    });
    this.arm(runAt);
  }

  private async scheduleNext(immediate: boolean): Promise<void> {
    if (immediate) {
      this.arm(this.options.now());
      return;
    }
    const next = await this.options.read(this.controller.signal, (value) =>
      nextCleanupAt(fileDatabase(value)));
    if (next !== null) this.arm(next);
  }

  private completeRecovery(): void {
    if (this.recoveryReadyResolved) return;
    this.recoveryReadyResolved = true;
    this.resolveRecoveryReady();
  }
}
