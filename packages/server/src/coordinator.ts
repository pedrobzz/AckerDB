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
import type { Engine } from "./engine.ts";
import { DbzzError, throwIfAborted } from "./errors.ts";
import { BoundedExecutor, type ExecutorSnapshot } from "./executor.ts";
import type { ServiceLimits } from "./limits.ts";
import {
  mutationReplayOwner,
  type StagedMutation,
  type StoredMutation,
} from "./mutation-replay.ts";
import { outcomeFromError } from "./outcome.ts";
import { isOneTimeResult } from "./one-time-result.ts";
import type { PublicationReservation } from "./publication.ts";
import type { Schema } from "./schema.ts";

const transaction = new AsyncLocalStorage<true>();
const fetchInstrumentation = new AsyncLocalStorage<FetchObserver>();
const MAX_MUTATION_CLOCK_SKEW_MS = 5 * 60_000;
let fetchGuardInstalled = false;

export interface FetchObservation {
  readonly durationMs: number;
  readonly outcome: OutcomeCode | "ok";
}

export type FetchObserver = (observation: Readonly<FetchObservation>) => unknown;

function observeFetch(
  observer: FetchObserver | undefined,
  startedAt: number,
  outcome: FetchObservation["outcome"],
): void {
  if (observer === undefined) return;
  try {
    const result = fetchInstrumentation.exit(() => observer(Object.freeze({
      durationMs: Math.max(0, performance.now() - startedAt),
      outcome,
    })));
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      typeof (result as PromiseLike<unknown>).then === "function"
    ) {
      void Promise.resolve(result).catch(() => {});
    }
  } catch {
    // Fetch telemetry is diagnostic and never owns application work.
  }
}

function installFetchGuard(): void {
  if (fetchGuardInstalled) return;
  fetchGuardInstalled = true;
  const original = globalThis.fetch;
  const guarded = ((...args: Parameters<typeof fetch>) => {
    const observer = fetchInstrumentation.getStore();
    const startedAt = observer === undefined ? 0 : performance.now();
    if (transaction.getStore()) {
      const error = new DbzzError(
        "validation",
        "fetch is not allowed inside a transaction; use a procedure outside ctx.tx",
      );
      observeFetch(observer, startedAt, error.code);
      throw error;
    }
    const request = original(...args);
    if (observer === undefined) return request;
    return request.then(
      (response) => {
        observeFetch(observer, startedAt, "ok");
        return response;
      },
      (error) => {
        observeFetch(observer, startedAt, telemetryOutcome(error));
        throw error;
      },
    );
  }) as typeof fetch;
  Object.assign(guarded, original);
  globalThis.fetch = guarded;
}

/** Correlate outbound fetch work without capturing URLs, headers, or bodies. */
export function withFetchObserver<T>(observer: FetchObserver, work: () => T): T {
  installFetchGuard();
  return fetchInstrumentation.run(observer, work);
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
  /** Restore the request owner's async instrumentation while its writer turn runs. */
  readonly run?: <R>(work: () => R) => R;
  readonly idempotency?: IdempotencyIdentity;
  readonly work: (db: DbWriter<Schema>, writes: WriteCollector) => T | Promise<T>;
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

export interface FrameworkTransactionRequest<T> {
  readonly fairnessKey: string;
  readonly requestBytes: number;
  readonly signal?: AbortSignal;
  readonly work: () => T | Promise<T>;
  /** Synchronous committed-state handoff before the single writer admits its next turn. */
  readonly afterCommit?: (value: T) => void;
}

export interface CommitTelemetryEvent {
  readonly operation: "mutation" | "transaction" | "scheduled";
  readonly stage:
    | "queue"
    | "execution"
    | "storage"
    | "encoding"
    | "commit"
    | "rollback"
    | "publication";
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

export type CommitHookStage = "commit";

export interface CommitHookContext {
  readonly operation: CommitTelemetryEvent["operation"];
  readonly commitVersion: bigint;
  readonly postCommit: true;
}

export type CommitWaitHook = (
  stage: CommitHookStage,
  context: Readonly<CommitHookContext>,
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
  /** Synchronous Runtime-owned state handoff after COMMIT and before the writer turn releases. */
  readonly afterCommit?: (writes: WriteCollector) => void;
  readonly now?: () => number;
  readonly wait?: CommitWaitHook;
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
  private readonly afterCommit: CommitCoordinatorOptions<Publication>["afterCommit"];
  private readonly now: () => number;
  private readonly wait: CommitWaitHook | undefined;
  private readonly eventSequences = new Map<string, bigint>();
  private readonly encoder = new TextEncoder();
  private nextPruneAtMs = 0;

  constructor(options: CommitCoordinatorOptions<Publication>) {
    installFetchGuard();
    this.engine = options.engine;
    this.limits = options.limits;
    this.reservePublication = options.reservePublication;
    this.afterCommit = options.afterCommit;
    this.now = options.now ?? Date.now;
    this.wait = options.wait;
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
      const admittedWork = () => {
        admitted = true;
        observeCommit(request, {
          stage: "queue",
          outcome: "ok",
          durationMs: Math.max(0, performance.now() - queuedAt),
          sizeBytes: request.requestBytes,
        });
        return this.commit(request);
      };
      const run = request.run;
      handoff = await this.writer.submit(
        run === undefined ? admittedWork : () => run(admittedWork),
        {
          operation: request.operation,
          bytes: request.requestBytes,
          fairnessKey: request.fairnessKey,
          ...(request.deadlineMs === undefined ? {} : { deadlineMs: request.deadlineMs }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        },
      );
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

  /** Serialize framework-owned storage through the same bounded writer without publishing app state. */
  async transactFramework<T>(request: FrameworkTransactionRequest<T>): Promise<T> {
    if (transaction.getStore()) {
      throw new DbzzError("validation", "cannot open a framework transaction inside a transaction");
    }
    return this.writer.submit(async () => {
      let open = false;
      try {
        this.engine.writer.exec("BEGIN IMMEDIATE");
        open = true;
        const value = await transaction.run(true, request.work);
        this.engine.writer.exec("COMMIT");
        open = false;
        try {
          request.afterCommit?.(value);
        } catch (cause) {
          throw new DbzzError(
            "convergence_unavailable",
            "framework transaction committed but its post-commit handoff failed",
            { committed: true, cause },
          );
        }
        return value;
      } catch (error) {
        if (open) {
          try {
            this.engine.writer.exec("ROLLBACK");
          } catch (rollbackError) {
            throw new DbzzError("indeterminate", "framework transaction outcome could not be determined", {
              cause: new AggregateError([error, rollbackError]),
            });
          }
        }
        throw error;
      }
    }, {
      operation: "transaction",
      bytes: request.requestBytes,
      fairnessKey: request.fairnessKey,
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
        const stored = this.engine[mutationReplayOwner].lookup(
          idempotency.sessionId,
          idempotency.requestId,
        );
        if (stored) {
          if (!sameIdentity(stored, idempotency)) {
            throw conflict("mutation request ID was already used with different semantics");
          }
          if (stored.resultDisposition === "one-time") {
            throw conflict("mutation committed, but its one-time result is no longer available");
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
              value: decode(stored.result!) as T,
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
        if (this.engine[mutationReplayOwner].records >= this.limits.mutationReplay.maxRecords) {
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
      const executionAt = request.telemetry === undefined ? undefined : performance.now();
      let value: T;
      try {
        value = await transaction.run(true, async () => {
          const result = await request.work(db, writes);
          await request.finalize?.(writes);
          return result;
        });
        if (executionAt !== undefined) {
          observeCommit(request, {
            stage: "execution",
            outcome: "ok",
            durationMs: Math.max(0, performance.now() - executionAt),
            dependencyCount: writes.keys.size,
          });
        }
      } catch (error) {
        if (executionAt !== undefined) {
          observeCommit(request, {
            stage: "execution",
            outcome: telemetryOutcome(error),
            durationMs: Math.max(0, performance.now() - executionAt),
            dependencyCount: writes.keys.size,
          });
        }
        throw error;
      }
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
      const resultDisposition = isOneTimeResult(writes) ? "one-time" : "replayable";
      if (idempotency && resultDisposition === "replayable") {
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
        const available = this.limits.mutationReplay.maxBytes -
          this.engine[mutationReplayOwner].resultBytes;
        if (resultBytes > available) {
          throw new DbzzError("overloaded", "mutation replay capacity is full", {
            retryable: true,
            retryAfterMs: 1_000,
            resource: "idempotency",
          });
        }
      }
      let stagedMutation: StagedMutation | undefined;
      let commitVersion: bigint;
      if (idempotency) {
        stagedMutation = this.engine[mutationReplayOwner].stage({
          ...idempotency,
          resultDisposition,
          result: result ?? null,
          resultBytes,
          durability: this.engine.durability,
        }, this.readNow());
        commitVersion = stagedMutation.commitVersion;
      } else {
        commitVersion = this.engine.allocateCommitVersion();
      }
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
        throwIfAborted(request.signal);
        this.engine.writer.exec("COMMIT");
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
      transactionOpen = false;
      committed = true;
      this.afterCommit?.(writes);
      if (stagedMutation !== undefined) {
        this.engine[mutationReplayOwner].committed(stagedMutation);
      }
      observeCommit(request, {
        stage: "commit",
        outcome: "ok",
        durationMs: Math.max(0, performance.now() - commitAt),
        sizeBytes: resultBytes,
        dependencyCount: writes.keys.size,
        commitVersion,
      });
      if (this.wait !== undefined) {
        try {
          await this.wait("commit", Object.freeze({
            operation: request.operation,
            commitVersion,
            postCommit: true,
          }));
        } catch {
          // Fault gates are diagnostic and never own committed publication.
        }
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
      const removed = this.engine[mutationReplayOwner].prune(before, 1_000);
      if (removed < 1_000) break;
    }
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
