import { AsyncLocalStorage } from "node:async_hooks";
import {
  decode,
  encode,
  uuidV7Timestamp,
  type DurabilityPolicy,
  type OutcomeCode,
} from "@dbzz/core";
import {
  makeDbWriter,
  newWriteCollector,
  type DbStatementObserver,
  type WriteCollector,
} from "./db.ts";
import type { DbWriter } from "./dbtypes.ts";
import type { Engine, StoredMutation } from "./engine.ts";
import { DbzzError } from "./errors.ts";
import { BoundedExecutor, type ExecutorSnapshot } from "./executor.ts";
import type { ServiceLimits } from "./limits.ts";
import { outcomeFromError } from "./outcome.ts";
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
  readonly telemetry?: CommitTelemetryObserver;
  readonly statementTelemetry?: DbStatementObserver;
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

export interface CommitTelemetryEvent {
  readonly operation: "mutation" | "transaction" | "scheduled";
  readonly stage: "queue" | "storage" | "encoding" | "commit" | "rollback" | "publication";
  readonly outcome: "ok" | OutcomeCode;
  readonly durationMs: number;
  readonly sizeBytes?: number;
  readonly resultCount?: number;
  readonly dependencyCount?: number;
  readonly replayed?: boolean;
  readonly commitVersion?: bigint;
  readonly postCommit?: boolean;
}

export type CommitTelemetryObserver = (
  event: Readonly<CommitTelemetryEvent>,
) => void | PromiseLike<void>;

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

type PublicationCompletion =
  | { readonly ok: true }
  | { readonly ok: false; readonly cause: unknown };

interface CommitHandoff<T, Publication> {
  readonly result: CommitResult<T, Publication>;
  readonly completion?: Promise<PublicationCompletion>;
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

function observeCommit(
  request: Pick<CommitRequest<unknown, unknown>, "operation" | "telemetry">,
  event: Omit<CommitTelemetryEvent, "operation">,
): void {
  if (request.telemetry === undefined) return;
  try {
    const result = request.telemetry(Object.freeze({ operation: request.operation, ...event }));
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      Promise.resolve(result).catch(() => {});
    }
  } catch {
    // Telemetry is diagnostic and never owns transaction correctness.
  }
}

function telemetryOutcome(error: unknown): OutcomeCode {
  return outcomeFromError(error).code;
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
      discipline: "round-robin",
      limits: options.limits.writeQueue,
      resource: "writer",
      retryAfterMs: 1,
      now: options.now,
    });
  }

  async execute<T>(request: CommitRequest<T, Publication>): Promise<CommitResult<T, Publication>> {
    if (transaction.getStore()) {
      throw new DbzzError(
        "validation",
        "cannot open a transaction inside a transaction; compose calls in the current ctx.tx",
      );
    }
    const queuedAt = performance.now();
    let admitted = false;
    let handoff: CommitHandoff<T, Publication>;
    try {
      handoff = await this.writer.submit(() => {
        admitted = true;
        observeCommit(request, {
          stage: "queue",
          outcome: "ok",
          durationMs: Math.max(0, performance.now() - queuedAt),
          sizeBytes: request.requestBytes,
        });
        return this.commit(request);
      }, {
        operation: request.operation,
        bytes: request.requestBytes,
        fairnessKey: request.fairnessKey,
        ...(request.deadlineMs === undefined ? {} : { deadlineMs: request.deadlineMs }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error) {
      if (!admitted) {
        observeCommit(request, {
          stage: "queue",
          outcome: telemetryOutcome(error),
          durationMs: Math.max(0, performance.now() - queuedAt),
          sizeBytes: request.requestBytes,
        });
      }
      throw error;
    }
    if (handoff.completion !== undefined) {
      const publicationAt = performance.now();
      const completion = await handoff.completion;
      if (!completion.ok) {
        observeCommit(request, {
          stage: "publication",
          outcome: "convergence_unavailable",
          durationMs: Math.max(0, performance.now() - publicationAt),
          commitVersion: handoff.result.commitVersion,
          postCommit: true,
        });
        throw new DbzzError(
          "convergence_unavailable",
          "the transaction committed but ordered publication failed",
          { committed: true, cause: completion.cause },
        );
      }
      observeCommit(request, {
        stage: "publication",
        outcome: "ok",
        durationMs: Math.max(0, performance.now() - publicationAt),
        commitVersion: handoff.result.commitVersion,
        postCommit: true,
      });
    }
    return handoff.result;
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
  ): Promise<CommitHandoff<T, Publication>> {
    const idempotency = request.idempotency;
    if (idempotency) {
      const replayAt = performance.now();
      let replayObserved = false;
      try {
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
          observeCommit(request, {
            stage: "storage",
            outcome: "ok",
            durationMs: Math.max(0, performance.now() - replayAt),
            sizeBytes: stored.resultBytes,
            replayed: true,
            commitVersion: stored.commitVersion,
          });
          replayObserved = true;
          return {
            result: {
              value: decode(stored.result) as T,
              commitVersion: stored.commitVersion,
              durability: stored.durability,
              replay: "replayed",
            },
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
        observeCommit(request, {
          stage: "storage",
          outcome: "ok",
          durationMs: Math.max(0, performance.now() - replayAt),
          replayed: false,
        });
        replayObserved = true;
      } catch (error) {
        if (!replayObserved) {
          observeCommit(request, {
            stage: "storage",
            outcome: telemetryOutcome(error),
            durationMs: Math.max(0, performance.now() - replayAt),
            replayed: false,
          });
        }
        throw error;
      }
    }

    const reservation = this.reservePublication(0);
    const writes = newWriteCollector();
    const db = makeDbWriter(
      this.engine,
      writes,
      (table) => this.nextEventSequence(table),
      request.statementTelemetry,
    ) as DbWriter<Schema>;
    let committed = false;
    let transactionOpen = false;
    let storageObserved = false;
    let publication: Publication | undefined;
    const storageAt = performance.now();
    try {
      this.engine.writer.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const value = await transaction.run(true, async () => {
        const result = await request.work(db);
        await request.finalize?.(writes);
        return result;
      });
      const publicationAt = performance.now();
      let publicationBytes: number;
      try {
        publicationBytes = this.publicationBytes(writes);
        reservation.resize(publicationBytes);
        observeCommit(request, {
          stage: "publication",
          outcome: "ok",
          durationMs: Math.max(0, performance.now() - publicationAt),
          sizeBytes: publicationBytes,
          dependencyCount: writes.keys.size,
          postCommit: false,
        });
      } catch (error) {
        observeCommit(request, {
          stage: "publication",
          outcome: telemetryOutcome(error),
          durationMs: Math.max(0, performance.now() - publicationAt),
          dependencyCount: writes.keys.size,
          postCommit: false,
        });
        throw error;
      }
      const encodingAt = performance.now();
      let result: string | undefined;
      if (idempotency) {
        try {
          result = encode(value);
        } catch (error) {
          observeCommit(request, {
            stage: "encoding",
            outcome: telemetryOutcome(error),
            durationMs: Math.max(0, performance.now() - encodingAt),
          });
          throw error;
        }
      }
      const resultBytes = result === undefined ? 0 : this.encoder.encode(result).byteLength;
      if (idempotency) {
        observeCommit(request, {
          stage: "encoding",
          outcome: "ok",
          durationMs: Math.max(0, performance.now() - encodingAt),
          sizeBytes: resultBytes,
        });
      }
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
      const descriptorAt = performance.now();
      try {
        publication = request.publication(commitVersion, writes);
        request.validate?.(value, commitVersion, writes, publication);
        observeCommit(request, {
          stage: "publication",
          outcome: "ok",
          durationMs: Math.max(0, performance.now() - descriptorAt),
          sizeBytes: publicationBytes,
          dependencyCount: writes.keys.size,
          commitVersion,
          postCommit: false,
        });
      } catch (error) {
        observeCommit(request, {
          stage: "publication",
          outcome: telemetryOutcome(error),
          durationMs: Math.max(0, performance.now() - descriptorAt),
          sizeBytes: publicationBytes,
          dependencyCount: writes.keys.size,
          commitVersion,
          postCommit: false,
        });
        throw error;
      }
      if (idempotency && result !== undefined) {
        this.engine.insertStoredMutation({
          ...idempotency,
          result,
          resultBytes,
          commitVersion,
          durability: this.engine.durability,
        });
      }
      observeCommit(request, {
        stage: "storage",
        outcome: "ok",
        durationMs: Math.max(0, performance.now() - storageAt),
        sizeBytes: resultBytes,
        dependencyCount: writes.keys.size,
        commitVersion,
        replayed: false,
      });
      storageObserved = true;
      const commitAt = performance.now();
      try {
        this.engine.writer.exec("COMMIT");
        transactionOpen = false;
        observeCommit(request, {
          stage: "commit",
          outcome: "ok",
          durationMs: Math.max(0, performance.now() - commitAt),
          sizeBytes: resultBytes,
          dependencyCount: writes.keys.size,
          commitVersion,
        });
      } catch (error) {
        observeCommit(request, {
          stage: "commit",
          outcome: telemetryOutcome(error),
          durationMs: Math.max(0, performance.now() - commitAt),
          sizeBytes: resultBytes,
          dependencyCount: writes.keys.size,
          commitVersion,
        });
        throw error;
      }
      committed = true;
      if (idempotency) {
        this.mutationRecords++;
        this.mutationResultBytes += resultBytes;
      }
      reservation.commit(publication);
      return {
        result: {
          value,
          commitVersion,
          durability: this.engine.durability,
          replay: "executed",
          publication,
        },
        completion: reservation.completion.then(
          (): PublicationCompletion => ({ ok: true }),
          (cause): PublicationCompletion => ({ ok: false, cause }),
        ),
      };
    } catch (error) {
      if (!storageObserved) {
        observeCommit(request, {
          stage: "storage",
          outcome: telemetryOutcome(error),
          durationMs: Math.max(0, performance.now() - storageAt),
          dependencyCount: writes.keys.size,
          replayed: false,
        });
      }
      if (!committed) {
        let rollbackFailed = false;
        const shouldRollback = transactionOpen;
        const rollbackAt = performance.now();
        try {
          if (transactionOpen) {
            this.engine.writer.exec("ROLLBACK");
            transactionOpen = false;
          }
        } catch {
          rollbackFailed = true;
        }
        if (shouldRollback) {
          observeCommit(request, {
            stage: "rollback",
            outcome: rollbackFailed ? "indeterminate" : "ok",
            durationMs: Math.max(0, performance.now() - rollbackAt),
            dependencyCount: writes.keys.size,
          });
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
