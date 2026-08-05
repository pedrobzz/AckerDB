import { OUTCOME_CODES, type OutcomeCode } from "@ackerdb/core";
import type { Engine } from "../database/engine.ts";
import {
  FILE_CLEANUP_TABLE,
  FILES_TABLE,
} from "./tables.ts";
import type { FileStoreOperation } from "./store/contract.ts";

export const FILE_LIFECYCLE_STATES = ["pending", "active", "deleting"] as const;
export type FileLifecycleState = (typeof FILE_LIFECYCLE_STATES)[number];
export type FileTransferKind = "upload" | "download";
export type FileTransferOutcome = "ok" | OutcomeCode;

const FILE_TRANSFER_OUTCOMES = ["ok", ...OUTCOME_CODES] as const;

export interface FileUsageSnapshot {
  readonly count: number;
  readonly bytes: number;
}

export interface FileTransferSnapshot {
  readonly operations: number;
  readonly bytes: number;
  readonly latencyMs: Readonly<{
    total: number;
    average: number;
    max: number;
  }>;
  readonly outcomes: Readonly<Record<FileTransferOutcome, number>>;
}

export interface FileObservabilitySnapshot {
  readonly pending: FileUsageSnapshot;
  readonly active: FileUsageSnapshot;
  readonly deleting: FileUsageSnapshot;
  readonly cleanup: Readonly<{
    backlog: number;
    oldestAgeMs: number;
    failures: number;
  }>;
  readonly upload: FileTransferSnapshot;
  readonly download: FileTransferSnapshot;
  readonly providerErrors: Readonly<
    { readonly total: number } & Record<FileStoreOperation, number>
  >;
}

interface MutableUsage {
  count: number;
  bytes: number;
}

interface MutableTransfer {
  operations: number;
  bytes: number;
  latencyTotalMs: number;
  latencyMaxMs: number;
  outcomes: Record<FileTransferOutcome, number>;
}

export interface FileObservabilityDelta {
  readonly usage: Record<FileLifecycleState, MutableUsage>;
  cleanupCount: number;
  cleanupEarliestAddedAt: number | null;
  cleanupEarliestRemovedAt: number | null;
}

export interface FileObservabilityCheckpoint {
  readonly usage: Record<FileLifecycleState, FileUsageSnapshot>;
  readonly cleanupCount: number;
  readonly cleanupEarliestAddedAt: number | null;
  readonly cleanupEarliestRemovedAt: number | null;
}

interface DurableHydration {
  readonly usage: Record<FileLifecycleState, MutableUsage>;
  readonly cleanupCount: number;
  readonly cleanupOldestCreatedAt: number | null;
  readonly cleanupFailures: number;
}

function emptyUsage(): Record<FileLifecycleState, MutableUsage> {
  return {
    pending: { count: 0, bytes: 0 },
    active: { count: 0, bytes: 0 },
    deleting: { count: 0, bytes: 0 },
  };
}

function emptyOutcomes(): Record<FileTransferOutcome, number> {
  return Object.fromEntries(FILE_TRANSFER_OUTCOMES.map((outcome) => [outcome, 0])) as
    Record<FileTransferOutcome, number>;
}

function emptyTransfer(): MutableTransfer {
  return {
    operations: 0,
    bytes: 0,
    latencyTotalMs: 0,
    latencyMaxMs: 0,
    outcomes: emptyOutcomes(),
  };
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function numeric(value: unknown, name: string): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
    throw new Error(`File observability ${name} exceeds the supported numeric range`);
  }
  return number;
}

const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;

function hydrateUsage(engine: Engine): Record<FileLifecycleState, MutableUsage> {
  const usage = emptyUsage();
  const plan = engine.rootScope.plan(FILES_TABLE);
  const state = plan.columns.get("state")!.phys[0]!.name;
  const size = plan.columns.get("size")!.phys[0]!.name;
  const rows = engine.statement(
    engine.writer,
    `SELECT ${quote(state)} AS state, COUNT(*) AS count, COALESCE(SUM(${quote(size)}), 0) AS bytes
       FROM ${quote(plan.name)} GROUP BY ${quote(state)}`,
  ).all() as readonly Record<string, unknown>[];
  for (const row of rows) {
    const lifecycle = row.state;
    if (lifecycle !== "pending" && lifecycle !== "active" && lifecycle !== "deleting") continue;
    usage[lifecycle] = {
      count: numeric(row.count, `${lifecycle} count`),
      bytes: numeric(row.bytes, `${lifecycle} bytes`),
    };
  }
  return usage;
}

function hydrateCleanup(engine: Engine): Pick<
  DurableHydration,
  "cleanupCount" | "cleanupOldestCreatedAt" | "cleanupFailures"
> {
  const plan = engine.rootScope.plan(FILE_CLEANUP_TABLE);
  const createdAt = plan.columns.get("createdAt")!.phys[0]!.name;
  const attempt = plan.columns.get("attempt")!.phys[0]!.name;
  const row = engine.statement(
    engine.writer,
    `SELECT COUNT(*) AS count, MIN(${quote(createdAt)}) AS oldest,
            COALESCE(SUM(${quote(attempt)}), 0) AS failures
       FROM ${quote(plan.name)}`,
  ).get() as Record<string, unknown>;
  return {
    cleanupCount: numeric(row.count, "cleanup backlog"),
    cleanupOldestCreatedAt: typeof row.oldest === "number" ? row.oldest : null,
    cleanupFailures: numeric(row.failures, "cleanup failures"),
  };
}

function cleanupOldest(engine: Engine): number | null {
  const plan = engine.rootScope.plan(FILE_CLEANUP_TABLE);
  const createdAt = plan.columns.get("createdAt")!.phys[0]!.name;
  const row = engine.statement(
    engine.writer,
    `SELECT MIN(${quote(createdAt)}) AS oldest FROM ${quote(plan.name)}`,
  ).get() as Record<string, unknown>;
  return typeof row.oldest === "number" ? row.oldest : null;
}

function hydrate(engine: Engine): DurableHydration {
  return { usage: hydrateUsage(engine), ...hydrateCleanup(engine) };
}

export function newFileObservabilityDelta(): FileObservabilityDelta {
  return {
    usage: emptyUsage(),
    cleanupCount: 0,
    cleanupEarliestAddedAt: null,
    cleanupEarliestRemovedAt: null,
  };
}

export function checkpointFileObservability(
  delta: FileObservabilityDelta,
): FileObservabilityCheckpoint {
  return {
    usage: {
      pending: { ...delta.usage.pending },
      active: { ...delta.usage.active },
      deleting: { ...delta.usage.deleting },
    },
    cleanupCount: delta.cleanupCount,
    cleanupEarliestAddedAt: delta.cleanupEarliestAddedAt,
    cleanupEarliestRemovedAt: delta.cleanupEarliestRemovedAt,
  };
}

export function rollbackFileObservability(
  delta: FileObservabilityDelta,
  checkpoint: FileObservabilityCheckpoint,
): void {
  for (const state of FILE_LIFECYCLE_STATES) {
    delta.usage[state].count = checkpoint.usage[state].count;
    delta.usage[state].bytes = checkpoint.usage[state].bytes;
  }
  delta.cleanupCount = checkpoint.cleanupCount;
  delta.cleanupEarliestAddedAt = checkpoint.cleanupEarliestAddedAt;
  delta.cleanupEarliestRemovedAt = checkpoint.cleanupEarliestRemovedAt;
}

function lifecycle(row: Record<string, unknown> | null): FileLifecycleState | null {
  const state = row?.state;
  return state === "pending" || state === "active" || state === "deleting" ? state : null;
}

function stageUsage(
  delta: FileObservabilityDelta,
  row: Record<string, unknown> | null,
  direction: -1 | 1,
): void {
  const state = lifecycle(row);
  if (state === null) return;
  const size = row!.size;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return;
  delta.usage[state].count += direction;
  delta.usage[state].bytes += direction * size;
}

function earliest(current: number | null, candidate: unknown): number | null {
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? current === null ? candidate : Math.min(current, candidate)
    : current;
}

/** Stage only committed-shape deltas; the coordinator applies them after COMMIT. */
export function stageFileObservability(
  delta: FileObservabilityDelta,
  table: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): void {
  if (table === FILES_TABLE) {
    stageUsage(delta, before, -1);
    stageUsage(delta, after, 1);
    return;
  }
  if (table !== FILE_CLEANUP_TABLE) return;
  if (before === null && after !== null) {
    delta.cleanupCount++;
    delta.cleanupEarliestAddedAt = earliest(delta.cleanupEarliestAddedAt, after.createdAt);
  } else if (before !== null && after === null) {
    delta.cleanupCount--;
    delta.cleanupEarliestRemovedAt = earliest(delta.cleanupEarliestRemovedAt, before.createdAt);
  }
}

function frozenUsage(value: MutableUsage): FileUsageSnapshot {
  return Object.freeze({ count: value.count, bytes: value.bytes });
}

function frozenTransfer(value: MutableTransfer): FileTransferSnapshot {
  return Object.freeze({
    operations: value.operations,
    bytes: value.bytes,
    latencyMs: Object.freeze({
      total: value.latencyTotalMs,
      average: value.operations === 0 ? 0 : value.latencyTotalMs / value.operations,
      max: value.latencyMaxMs,
    }),
    outcomes: Object.freeze({ ...value.outcomes }),
  });
}

/** O(1) Runtime File status, hydrated once from SQL and advanced after commits. */
export class FileObservability {
  private readonly usage: Record<FileLifecycleState, MutableUsage>;
  private cleanupCount: number;
  private cleanupOldestCreatedAt: number | null;
  private cleanupFailures: number;
  private readonly upload = emptyTransfer();
  private readonly download = emptyTransfer();
  private readonly providerErrors: { total: number } & Record<FileStoreOperation, number> = {
    total: 0,
    probe: 0,
    put: 0,
    open: 0,
    attributes: 0,
    delete: 0,
  };

  constructor(
    private readonly engine: Engine,
    private readonly now: () => number,
  ) {
    const initial = hydrate(engine);
    this.usage = initial.usage;
    this.cleanupCount = initial.cleanupCount;
    this.cleanupOldestCreatedAt = initial.cleanupOldestCreatedAt;
    this.cleanupFailures = initial.cleanupFailures;
  }

  committed(delta: FileObservabilityDelta): void {
    for (const state of FILE_LIFECYCLE_STATES) {
      this.usage[state].count += delta.usage[state].count;
      this.usage[state].bytes += delta.usage[state].bytes;
    }
    this.cleanupCount += delta.cleanupCount;
    if (this.cleanupCount <= 0) {
      this.cleanupCount = 0;
      this.cleanupOldestCreatedAt = null;
      return;
    }
    this.cleanupOldestCreatedAt = earliest(
      this.cleanupOldestCreatedAt,
      delta.cleanupEarliestAddedAt,
    );
    if (
      this.cleanupOldestCreatedAt === null ||
      (delta.cleanupEarliestRemovedAt !== null &&
        delta.cleanupEarliestRemovedAt <= this.cleanupOldestCreatedAt)
    ) {
      try {
        this.cleanupOldestCreatedAt = cleanupOldest(this.engine);
      } catch {
        // Observability runs after COMMIT and can never turn durable success
        // into a reported operation failure. The next Runtime hydration
        // restores the exact aggregate if this diagnostic refresh fails.
      }
    }
  }

  recordTransfer(
    kind: FileTransferKind,
    outcome: FileTransferOutcome,
    bytes: number,
    latencyMs: number,
  ): void {
    const transfer = kind === "upload" ? this.upload : this.download;
    const safeBytes = Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0;
    const safeLatency = finiteNonNegative(latencyMs);
    transfer.operations++;
    transfer.bytes += safeBytes;
    transfer.latencyTotalMs += safeLatency;
    transfer.latencyMaxMs = Math.max(transfer.latencyMaxMs, safeLatency);
    transfer.outcomes[outcome]++;
  }

  recordCleanupFailure(): void {
    this.cleanupFailures++;
  }

  recordProviderError(operation: FileStoreOperation): void {
    this.providerErrors.total++;
    this.providerErrors[operation]++;
  }

  snapshot(): FileObservabilitySnapshot {
    const oldestAgeMs = this.cleanupOldestCreatedAt === null
      ? 0
      : Math.max(0, this.now() - this.cleanupOldestCreatedAt);
    return Object.freeze({
      pending: frozenUsage(this.usage.pending),
      active: frozenUsage(this.usage.active),
      deleting: frozenUsage(this.usage.deleting),
      cleanup: Object.freeze({
        backlog: this.cleanupCount,
        oldestAgeMs,
        failures: this.cleanupFailures,
      }),
      upload: frozenTransfer(this.upload),
      download: frozenTransfer(this.download),
      providerErrors: Object.freeze({ ...this.providerErrors }),
    });
  }
}
