import { AsyncLocalStorage } from "node:async_hooks";
import { decode, encode, uuidV7Timestamp, type DurabilityPolicy } from "@dbzz/core";
import { makeDbWriter, newWriteCollector, type WriteCollector } from "./db.ts";
import type { DbWriter } from "./dbtypes.ts";
import type { Engine, StoredMutation } from "./engine.ts";
import { DbzzError } from "./errors.ts";
import { BoundedExecutor, type ExecutorSnapshot } from "./executor.ts";
import type { ServiceLimits } from "./limits.ts";
import type { PublicationReservation } from "./publication.ts";
import type { Schema } from "./schema.ts";

const transaction = new AsyncLocalStorage<true>();
const MAX_MUTATION_CLOCK_SKEW_MS = 5 * 60_000;
let fetchGuardInstalled = false;

function installFetchGuard(): void {
  if (fetchGuardInstalled) return;
  fetchGuardInstalled = true;
  const original = globalThis.fetch;
  const guarded = ((...args: Parameters<typeof fetch>) => {
    if (transaction.getStore()) {
      throw new DbzzError(
        "validation",
        "fetch is not allowed inside a transaction; use a procedure outside ctx.tx",
      );
    }
    return original(...args);
  }) as typeof fetch;
  Object.assign(guarded, original);
  globalThis.fetch = guarded;
}

export interface IdempotencyIdentity {
  readonly sessionId: string;
  readonly requestId: string;
  readonly issuedAt: number;
  readonly principalFingerprint: string;
  readonly functionRef: string;
  readonly argsFingerprint: string;
}

export interface CommitRequest<T, Publication> {
  readonly operation: "mutation" | "transaction" | "scheduled";
  readonly fairnessKey: string;
  readonly requestBytes: number;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
  readonly idempotency?: IdempotencyIdentity;
  readonly work: (db: DbWriter<Schema>) => T | Promise<T>;
  /** Additional storage work, such as deleting a due row, in the same transaction. */
  readonly finalize?: (writes: WriteCollector) => void | Promise<void>;
  readonly publication: (version: bigint, writes: WriteCollector) => Publication;
  /** Last fallible response-shape check, still inside the transaction. */
  readonly validate?: (
    value: T,
    version: bigint,
    writes: WriteCollector,
    publication: Publication,
  ) => void;
}

export interface CommitResult<T, Publication> {
  readonly value: T;
  readonly commitVersion: bigint;
  readonly durability: DurabilityPolicy;
  readonly replay: "executed" | "replayed";
  readonly publication?: Publication;
}

export interface CommitCoordinatorOptions<Publication> {
  readonly engine: Engine;
  readonly limits: ServiceLimits;
  readonly reservePublication: (bytes: number) => PublicationReservation<Publication>;
  readonly now?: () => number;
}

function conflict(message: string): DbzzError {
  return new DbzzError("conflict", message, { resource: "idempotency" });
}

function sameIdentity(stored: StoredMutation, incoming: IdempotencyIdentity): boolean {
  return (
    stored.issuedAt === incoming.issuedAt &&
    stored.principalFingerprint === incoming.principalFingerprint &&
    stored.functionRef === incoming.functionRef &&
    stored.argsFingerprint === incoming.argsFingerprint
  );
}

/** Owns the only writer turn, transaction boundary, durable version, and publication handoff. */
export class CommitCoordinator<Publication> {
  readonly engine: Engine;
  private readonly limits: ServiceLimits;
  private readonly writer: BoundedExecutor;
  private readonly reservePublication: CommitCoordinatorOptions<Publication>["reservePublication"];
  private readonly now: () => number;
  private readonly eventSequences = new Map<string, bigint>();
  private readonly encoder = new TextEncoder();
  private mutationRecords: number;
  private mutationResultBytes: number;
  private nextPruneAtMs = 0;

  constructor(options: CommitCoordinatorOptions<Publication>) {
    installFetchGuard();
    this.engine = options.engine;
    this.limits = options.limits;
    this.reservePublication = options.reservePublication;
    this.now = options.now ?? Date.now;
    const storage = options.engine.status();
    this.mutationRecords = storage.mutationRecords;
    this.mutationResultBytes = storage.mutationResultBytes;
    this.writer = new BoundedExecutor({
      concurrency: 1,
      discipline: "fifo",
      limits: options.limits.writeQueue,
      resource: "writer",
      retryAfterMs: 1,
      now: options.now,
    });
  }

  execute<T>(request: CommitRequest<T, Publication>): Promise<CommitResult<T, Publication>> {
    if (transaction.getStore()) {
      return Promise.reject(
        new DbzzError(
          "validation",
          "cannot open a transaction inside a transaction; compose calls in the current ctx.tx",
        ),
      );
    }
    return this.writer.submit(() => this.commit(request), {
      operation: request.operation,
      bytes: request.requestBytes,
      fairnessKey: request.fairnessKey,
      ...(request.deadlineMs === undefined ? {} : { deadlineMs: request.deadlineMs }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  }

  close(): void {
    this.writer.close();
  }

  drain(): Promise<void> {
    return this.writer.drain();
  }

  snapshot(): ExecutorSnapshot {
    return this.writer.snapshot();
  }

  private async commit<T>(
    request: CommitRequest<T, Publication>,
  ): Promise<CommitResult<T, Publication>> {
    const idempotency = request.idempotency;
    if (idempotency) {
      if (!Number.isSafeInteger(idempotency.issuedAt) || idempotency.issuedAt < 0) {
        throw new DbzzError("validation", "mutation issuedAt must be a non-negative safe integer", {
          resource: "idempotency",
        });
      }
      this.pruneExpiredMutations();
      const stored = this.engine.storedMutation(idempotency.sessionId, idempotency.requestId);
      if (stored) {
        if (!sameIdentity(stored, idempotency)) {
          throw conflict("mutation request ID was already used with different semantics");
        }
        return {
          value: decode(stored.result) as T,
          commitVersion: stored.commitVersion,
          durability: stored.durability,
          replay: "replayed",
        };
      }
      const now = this.readNow();
      const requestCreatedAt = uuidV7Timestamp(idempotency.requestId);
      if (requestCreatedAt > now + MAX_MUTATION_CLOCK_SKEW_MS) {
        throw new DbzzError("validation", "mutation request ID timestamp is in the future", {
          resource: "idempotency",
        });
      }
      if (requestCreatedAt < now - this.limits.mutationReplay.maxAgeMs) {
        throw conflict("mutation request is outside the retained replay window");
      }
      if (this.mutationRecords >= this.limits.mutationReplay.maxRecords) {
        throw new DbzzError("overloaded", "mutation replay capacity is full", {
          retryable: true,
          retryAfterMs: 1_000,
          resource: "idempotency",
        });
      }
    }

    const reservation = this.reservePublication(0);
    const writes = newWriteCollector();
    const db = makeDbWriter(
      this.engine,
      writes,
      (table) => this.nextEventSequence(table),
    ) as DbWriter<Schema>;
    let committed = false;
    let publication: Publication | undefined;
    this.engine.writer.exec("BEGIN IMMEDIATE");
    try {
      const value = await transaction.run(true, async () => {
        const result = await request.work(db);
        await request.finalize?.(writes);
        return result;
      });
      const publicationBytes = this.publicationBytes(writes);
      reservation.resize(publicationBytes);
      const result = idempotency ? encode(value) : undefined;
      const resultBytes = result === undefined ? 0 : this.encoder.encode(result).byteLength;
      if (resultBytes > this.limits.mutationReplay.maxResultBytes) {
        throw new DbzzError("overloaded", "mutation result exceeds replay capacity", {
          retryable: false,
          resource: "idempotency",
        });
      }
      if (idempotency) {
        const available = this.limits.mutationReplay.maxBytes - this.mutationResultBytes;
        if (resultBytes > available) {
          throw new DbzzError("overloaded", "mutation replay capacity is full", {
            retryable: true,
            retryAfterMs: 1_000,
            resource: "idempotency",
          });
        }
      }
      const commitVersion = this.engine.allocateCommitVersion();
      if (commitVersion !== reservation.version) {
        throw new DbzzError("internal", "storage and publication versions diverged");
      }
      publication = request.publication(commitVersion, writes);
      request.validate?.(value, commitVersion, writes, publication);
      if (idempotency && result !== undefined) {
        this.engine.insertStoredMutation({
          ...idempotency,
          result,
          resultBytes,
          commitVersion,
          durability: this.engine.durability,
        });
      }
      this.engine.writer.exec("COMMIT");
      committed = true;
      if (idempotency) {
        this.mutationRecords++;
        this.mutationResultBytes += resultBytes;
      }
      reservation.commit(publication);
      try {
        await reservation.completion;
      } catch (cause) {
        throw new DbzzError(
          "convergence_unavailable",
          "the transaction committed but ordered publication failed",
          { committed: true, cause },
        );
      }
      return {
        value,
        commitVersion,
        durability: this.engine.durability,
        replay: "executed",
        publication,
      };
    } catch (error) {
      if (!committed) {
        let rollbackFailed = false;
        try {
          this.engine.writer.exec("ROLLBACK");
        } catch {
          rollbackFailed = true;
        }
        reservation.cancel();
        if (rollbackFailed) {
          throw new DbzzError("indeterminate", "transaction outcome could not be determined", {
            cause: error,
          });
        }
      }
      throw error;
    }
  }

  private pruneExpiredMutations(): void {
    const now = this.readNow();
    if (now < this.nextPruneAtMs) return;
    this.nextPruneAtMs = now + 60_000;
    const before = now - this.limits.mutationReplay.maxAgeMs;
    for (;;) {
      const removed = this.engine.pruneStoredMutations(before, 1_000);
      if (removed < 1_000) break;
    }
    const storage = this.engine.status();
    this.mutationRecords = storage.mutationRecords;
    this.mutationResultBytes = storage.mutationResultBytes;
  }

  private publicationBytes(writes: WriteCollector): number {
    return this.encoder.encode(encode({
      keys: [...writes.keys],
      events: writes.events,
    })).byteLength;
  }

  private nextEventSequence(table: string): bigint {
    const sequence = (this.eventSequences.get(table) ?? 0n) + 1n;
    this.eventSequences.set(table, sequence);
    return sequence;
  }

  private readNow(): number {
    const now = this.now();
    if (!Number.isFinite(now)) throw new RangeError("coordinator clock must return finite milliseconds");
    return now;
  }
}
