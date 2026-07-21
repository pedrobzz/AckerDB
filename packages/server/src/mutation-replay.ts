import { type Database, type Statement } from "bun:sqlite";
import type { DurabilityPolicy } from "@dbzz/core";
import { CorruptDatabaseError } from "./errors.ts";

/** Package-internal capability for the Engine-owned replay ledger. */
export const mutationReplayOwner = Symbol("dbzz.mutationReplay");

export interface StoredMutation {
  sessionId: string;
  requestId: string;
  issuedAt: number;
  principalFingerprint: string;
  functionRef: string;
  argsFingerprint: string;
  resultDisposition: "replayable" | "one-time";
  result: string | null;
  resultBytes: number;
  commitVersion: bigint;
  durability: DurabilityPolicy;
  completedAt: number;
}

export type NewStoredMutation = Omit<StoredMutation, "commitVersion" | "completedAt">;

export type StagedMutation = Readonly<StoredMutation>;

export interface MutationReplaySnapshot {
  readonly commitVersion: bigint;
  readonly index: Map<string, Map<string, bigint>>;
  readonly records: number;
  readonly resultBytes: number;
  readonly lastCompletedAt: number;
}

interface IndexRow {
  session_id: string;
  request_id: string;
  result_bytes: bigint;
  commit_version: bigint;
  completed_at: number;
}

interface StoredRow extends IndexRow {
  issued_at: number;
  principal_fingerprint: string;
  function_ref: string;
  args_fingerprint: string;
  result_disposition: "replayable" | "one-time";
  result: string | null;
  durability: DurabilityPolicy;
}

function toStoredMutation(row: StoredRow): StoredMutation {
  return {
    sessionId: row.session_id,
    requestId: row.request_id,
    issuedAt: row.issued_at,
    principalFingerprint: row.principal_fingerprint,
    functionRef: row.function_ref,
    argsFingerprint: row.args_fingerprint,
    resultDisposition: row.result_disposition,
    result: row.result,
    resultBytes: Number(row.result_bytes),
    commitVersion: row.commit_version,
    durability: row.durability,
    completedAt: row.completed_at,
  };
}

export function scanMutationReplay(connection: Database): MutationReplaySnapshot {
  const state = connection
    .query("SELECT commit_version, mutation_records, mutation_result_bytes FROM _dbzz_state WHERE singleton = 1")
    .get() as
    | { commit_version: bigint; mutation_records: bigint; mutation_result_bytes: bigint }
    | null;
  if (state === null) throw new CorruptDatabaseError("missing DBZZ state singleton");

  const index = new Map<string, Map<string, bigint>>();
  const rows = connection.query(
    "SELECT session_id, request_id, result_bytes, commit_version, completed_at FROM _dbzz_mutations ORDER BY commit_version",
  );
  let records = 0;
  let resultBytes = 0n;
  let previousVersion = 0n;
  let lastCompletedAt = Number.NEGATIVE_INFINITY;
  for (const row of rows.iterate() as IterableIterator<IndexRow>) {
    if (
      row.commit_version <= previousVersion ||
      row.commit_version > state.commit_version
    ) {
      throw new CorruptDatabaseError("mutation replay ledger has an invalid commit order");
    }
    if (!Number.isFinite(row.completed_at) || row.completed_at < lastCompletedAt) {
      throw new CorruptDatabaseError("mutation replay ledger completion time is not monotonic");
    }
    let session = index.get(row.session_id);
    if (session === undefined) {
      session = new Map();
      index.set(row.session_id, session);
    }
    if (session.has(row.request_id)) {
      throw new CorruptDatabaseError("mutation replay ledger contains a duplicate scoped request");
    }
    session.set(row.request_id, row.commit_version);
    previousVersion = row.commit_version;
    lastCompletedAt = row.completed_at;
    resultBytes += row.result_bytes;
    records++;
  }
  if (BigInt(records) !== state.mutation_records || resultBytes !== state.mutation_result_bytes) {
    throw new CorruptDatabaseError("mutation replay ledger counters do not match stored records");
  }
  const numericBytes = Number(resultBytes);
  if (!Number.isSafeInteger(numericBytes)) {
    throw new CorruptDatabaseError("mutation replay ledger byte count exceeds the supported range");
  }
  return {
    commitVersion: state.commit_version,
    index,
    records,
    resultBytes: numericBytes,
    lastCompletedAt,
  };
}

/** Owns the durable append ledger and its exact in-memory replay index. */
export class MutationReplayLedger {
  private readonly index: Map<string, Map<string, bigint>>;
  private readonly allocate: Statement<{ commit_version: bigint }, [number]>;
  private readonly append: Statement<unknown, [
    bigint,
    string,
    string,
    number,
    string,
    string,
    string,
    "replayable" | "one-time",
    string | null,
    number,
    DurabilityPolicy,
    number,
  ]>;
  private recordCount: number;
  private byteCount: number;
  private lastCompletedAt: number;

  constructor(
    private readonly connection: Database,
    snapshot: MutationReplaySnapshot = scanMutationReplay(connection),
  ) {
    this.index = snapshot.index;
    this.allocate = connection.query(`UPDATE _dbzz_state SET
      commit_version = commit_version + 1,
      mutation_records = mutation_records + 1,
      mutation_result_bytes = mutation_result_bytes + ?
      WHERE singleton = 1 RETURNING commit_version`);
    this.append = connection.query("INSERT INTO _dbzz_mutations (commit_version, session_id, request_id, issued_at, principal_fingerprint, function_ref, args_fingerprint, result_disposition, result, result_bytes, durability, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    this.recordCount = snapshot.records;
    this.byteCount = snapshot.resultBytes;
    this.lastCompletedAt = snapshot.lastCompletedAt;
  }

  get records(): number {
    return this.recordCount;
  }

  get resultBytes(): number {
    return this.byteCount;
  }

  lookup(sessionId: string, requestId: string): StoredMutation | null {
    const commitVersion = this.index.get(sessionId)?.get(requestId);
    if (commitVersion === undefined) return null;
    const row = this.connection
      .query("SELECT session_id, request_id, issued_at, principal_fingerprint, function_ref, args_fingerprint, result_disposition, result, result_bytes, commit_version, durability, completed_at FROM _dbzz_mutations WHERE commit_version = ?")
      .get(commitVersion) as StoredRow | null;
    if (row === null || row.session_id !== sessionId || row.request_id !== requestId) {
      throw new CorruptDatabaseError("mutation replay index does not match its durable ledger");
    }
    return toStoredMutation(row);
  }

  /** Stage one append and its counters inside the caller-owned writer transaction. */
  stage(record: NewStoredMutation, now = Date.now()): StagedMutation {
    if (!Number.isSafeInteger(record.resultBytes) || record.resultBytes < 0) {
      throw new RangeError("mutation resultBytes must be a non-negative safe integer");
    }
    if (!Number.isFinite(now)) throw new RangeError("mutation completion time must be finite");
    if (
      (record.resultDisposition === "replayable" && typeof record.result !== "string") ||
      (record.resultDisposition === "one-time" && (record.result !== null || record.resultBytes !== 0))
    ) {
      throw new TypeError("mutation result does not match its replay disposition");
    }
    if (this.index.get(record.sessionId)?.has(record.requestId) === true) {
      throw new Error("mutation replay request is already stored");
    }
    const completedAt = Math.max(now, this.lastCompletedAt);
    const state = this.allocate.get(record.resultBytes)!;
    this.append.run(
      state.commit_version,
      record.sessionId,
      record.requestId,
      record.issuedAt,
      record.principalFingerprint,
      record.functionRef,
      record.argsFingerprint,
      record.resultDisposition,
      record.result,
      record.resultBytes,
      record.durability,
      completedAt,
    );
    return Object.freeze({ ...record, commitVersion: state.commit_version, completedAt });
  }

  /** Publish one staged append to the replay index immediately after successful COMMIT. */
  committed(record: StagedMutation): void {
    let session = this.index.get(record.sessionId);
    if (session === undefined) {
      session = new Map();
      this.index.set(record.sessionId, session);
    }
    session.set(record.requestId, record.commitVersion);
    this.recordCount++;
    this.byteCount += record.resultBytes;
    this.lastCompletedAt = record.completedAt;
  }

  /** Remove at most one expired commit-ordered prefix and update the index only after COMMIT. */
  prune(completedBefore: number, limit = 1_000): number {
    if (!Number.isFinite(completedBefore)) throw new RangeError("mutation prune time must be finite");
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError("mutation prune limit must be a positive safe integer");
    }
    const prefix: IndexRow[] = [];
    for (const row of this.connection
      .query("SELECT session_id, request_id, result_bytes, commit_version, completed_at FROM _dbzz_mutations ORDER BY commit_version LIMIT ?")
      .all(limit) as IndexRow[]) {
      if (row.completed_at >= completedBefore) break;
      prefix.push(row);
    }
    if (prefix.length === 0) return 0;
    const bytes = prefix.reduce((sum, row) => sum + row.result_bytes, 0n);
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const removed = this.connection
        .query("DELETE FROM _dbzz_mutations WHERE commit_version <= ?")
        .run(prefix.at(-1)!.commit_version);
      if (removed.changes !== prefix.length) {
        throw new CorruptDatabaseError("mutation replay prefix changed during pruning");
      }
      this.connection
        .query("UPDATE _dbzz_state SET mutation_records = mutation_records - ?, mutation_result_bytes = mutation_result_bytes - ? WHERE singleton = 1")
        .run(prefix.length, bytes);
      this.connection.exec("COMMIT");
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
    for (const row of prefix) {
      const session = this.index.get(row.session_id)!;
      session.delete(row.request_id);
      if (session.size === 0) this.index.delete(row.session_id);
    }
    this.recordCount -= prefix.length;
    this.byteCount -= Number(bytes);
    return prefix.length;
  }
}
