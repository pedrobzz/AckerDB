import {
  decode,
  encode,
  uuidV7Timestamp,
  type DurabilityPolicy,
} from "@ackerdb/core";
import {
  makeDbWriter,
  newWriteCollector,
  type WriteCollector,
} from "../database/access.ts";
import type { DbWriter } from "../database/query/types.ts";
import type { Engine } from "../database/engine.ts";
import { AckerDBError, throwIfAborted } from "../shared/errors.ts";
import { BoundedExecutor, type ExecutorSnapshot } from "./executor.ts";
import type { ServiceLimits } from "./limits.ts";
import {
  mutationReplayOwner,
  type StagedMutation,
  type StoredMutation,
} from "../database/mutation-replay.ts";
import { isOneTimeResult } from "./one-time-result.ts";
import type { RuntimeOperationOutcome } from "./execution/operation-runner.ts";
import type { PublicationReservation } from "../subscriptions/publication.ts";
import type { Schema } from "../schema/definition.ts";
import { utf8ByteLength, wireByteLength } from "../shared/bytes.ts";
import {
  assertTransactionHealthy,
  inTransaction,
  poisonTransaction,
  runInTransaction,
} from "./transaction-context.ts";
import { finiteMillis } from "../shared/clock.ts";

const MAX_MUTATION_CLOCK_SKEW_MS = 5 * 60_000;
let fetchGuardInstalled = false;

function installFetchGuard(): void {
  if (fetchGuardInstalled) return;
  fetchGuardInstalled = true;
  const original = globalThis.fetch;
  const guarded = ((...args: Parameters<typeof fetch>) => {
    if (inTransaction()) {
      const error = new AckerDBError(
        "validation",
        "fetch is not allowed inside a transaction; use a procedure outside ctx.tx",
      );
      return poisonTransaction(error);
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
  readonly operation: CommitOperation;
  readonly fairnessKey: string;
  readonly requestBytes: number;
  readonly deadlineMs?: number;
  /** Cancels this work only while it is waiting for the single writer. */
  readonly admissionSignal?: AbortSignal;
  /** Cancels a request-owned transaction before BEGIN or COMMIT. */
  readonly transactionSignal?: AbortSignal;
  /** Restore the request owner's async context while its writer turn runs. */
  readonly run?: <R>(work: () => R) => R;
  readonly idempotency?: IdempotencyIdentity;
  readonly work: (db: DbWriter<Schema>, writes: WriteCollector) => T | Promise<T>;
  /**
   * A handled application outcome that must close the transaction without a
   * commit, publication, or data-version allocation.
   */
  readonly rollbackWhen?: (value: T) => boolean;
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

export type CommitOperation = "mutation" | "transaction" | "scheduled";

export type CommitHookStage = "commit";

export interface CommitHookContext {
  readonly operation: CommitOperation;
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
  readonly afterCommit?: (writes: WriteCollector, commitVersion: bigint) => void;
  readonly now?: () => number;
  readonly wait?: CommitWaitHook;
}

interface CommitHandoff<T, Publication> {
  readonly result: CommitResult<T, Publication>;
  readonly completion?: Promise<RuntimeOperationOutcome<void>>;
}

function conflict(message: string): AckerDBError {
  return new AckerDBError("conflict", message, { resource: "idempotency" });
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
  private readonly afterCommit: CommitCoordinatorOptions<Publication>["afterCommit"];
  private readonly now: () => number;
  private readonly wait: CommitWaitHook | undefined;
  private readonly eventSequences = new Map<string, bigint>();
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
    if (inTransaction()) {
      throw new AckerDBError(
        "validation",
        "cannot open a transaction inside a transaction; compose calls in the current ctx.tx",
      );
    }
    const work = () => this.commit(request);
    const run = request.run;
    const handoff = await this.writer.submit(
      run === undefined ? work : () => run(work),
      {
        bytes: request.requestBytes,
        fairnessKey: request.fairnessKey,
        ...(request.deadlineMs === undefined ? {} : { deadlineMs: request.deadlineMs }),
        ...(request.admissionSignal === undefined
          ? {}
          : { signal: request.admissionSignal }),
      },
    );
    if (handoff.completion !== undefined) {
      const completion = await handoff.completion;
      if (!completion.ok) {
        throw new AckerDBError(
          "convergence_unavailable",
          "the transaction committed but ordered publication failed",
          { committed: true, cause: completion.error },
        );
      }
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
      if (!Number.isSafeInteger(idempotency.issuedAt) || idempotency.issuedAt < 0) {
        throw new AckerDBError("validation", "mutation issuedAt must be a non-negative safe integer", {
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
        return {
          result: {
            value: decode(stored.result!) as T,
            commitVersion: stored.commitVersion,
            durability: stored.durability,
            replay: "replayed",
          },
        };
      }
      const now = finiteMillis(this.now(), "coordinator clock");
      const requestCreatedAt = uuidV7Timestamp(idempotency.requestId);
      if (requestCreatedAt > now + MAX_MUTATION_CLOCK_SKEW_MS) {
        throw new AckerDBError("validation", "mutation request ID timestamp is in the future", {
          resource: "idempotency",
        });
      }
      if (requestCreatedAt < now - this.limits.mutationReplay.maxAgeMs) {
        throw conflict("mutation request is outside the retained replay window");
      }
      if (this.engine[mutationReplayOwner].records >= this.limits.mutationReplay.maxRecords) {
        throw new AckerDBError("overloaded", "mutation replay capacity is full", {
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
    let transactionOpen = false;
    let publication: Publication | undefined;
    try {
      throwIfAborted(request.transactionSignal);
      // Not a `transaction()` site: the publication reservation strictly contains
      // this transaction, and the rollback path continues with more work inside
      // the same frame. Bracketing it is a coordinator redesign, not a dedupe.
      this.engine.writer.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      let value: T;
      value = await runInTransaction(async () => {
        const settled = await request.work(db, writes);
        assertTransactionHealthy();
        return settled;
      });
      throwIfAborted(request.transactionSignal);
      if (request.rollbackWhen?.(value) === true) {
        this.engine.writer.exec("ROLLBACK");
        transactionOpen = false;
        reservation.cancel();
        let commitVersion = this.engine.commitVersion();
        if (idempotency !== undefined) {
          const resultDisposition = isOneTimeResult(writes)
            ? "one-time"
            : "replayable";
          const result = resultDisposition === "replayable" ? encode(value) : undefined;
            const resultBytes = result === undefined
              ? 0
              : utf8ByteLength(result);
            if (resultBytes > this.limits.mutationReplay.maxResultBytes) {
              throw new AckerDBError("overloaded", "mutation result exceeds replay capacity", {
                retryable: false,
                resource: "idempotency",
              });
            }
            const available = this.limits.mutationReplay.maxBytes -
              this.engine[mutationReplayOwner].resultBytes;
            if (resultBytes > available) {
              throw new AckerDBError("overloaded", "mutation replay capacity is full", {
                retryable: true,
                retryAfterMs: 1_000,
                resource: "idempotency",
              });
            }
            let staged: StagedMutation;
            try {
              // Not a `transaction()` site: `transactionOpen` is the frame-wide
              // flag the surrounding coordinator path also reads.
              this.engine.writer.exec("BEGIN IMMEDIATE");
              transactionOpen = true;
              staged = this.engine[mutationReplayOwner].stage({
                ...idempotency,
                resultDisposition,
                result: result ?? null,
                resultBytes,
                durability: this.engine.durability,
              }, finiteMillis(this.now(), "coordinator clock"), "replay");
              this.engine.writer.exec("COMMIT");
              transactionOpen = false;
              this.engine[mutationReplayOwner].committed(staged);
            } catch (error) {
              if (transactionOpen) {
                this.engine.writer.exec("ROLLBACK");
                transactionOpen = false;
              }
              throw error;
            }
          commitVersion = staged.commitVersion;
        }
        return {
          result: {
            value,
            commitVersion,
            durability: this.engine.durability,
            replay: "executed",
          },
        };
      }
      await request.finalize?.(writes);
      reservation.resize(this.publicationBytes(writes));
      let result: string | undefined;
      const resultDisposition = isOneTimeResult(writes) ? "one-time" : "replayable";
      if (idempotency && resultDisposition === "replayable") {
        result = encode(value);
      }
      const resultBytes = result === undefined ? 0 : utf8ByteLength(result);
      if (resultBytes > this.limits.mutationReplay.maxResultBytes) {
        throw new AckerDBError("overloaded", "mutation result exceeds replay capacity", {
          retryable: false,
          resource: "idempotency",
        });
      }
      if (idempotency) {
        const available = this.limits.mutationReplay.maxBytes -
          this.engine[mutationReplayOwner].resultBytes;
        if (resultBytes > available) {
          throw new AckerDBError("overloaded", "mutation replay capacity is full", {
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
        }, finiteMillis(this.now(), "coordinator clock"));
        commitVersion = stagedMutation.commitVersion;
      } else {
        commitVersion = this.engine.allocateCommitVersion();
      }
      if (commitVersion !== reservation.version) {
        throw new AckerDBError("internal", "storage and publication versions diverged");
      }
      publication = request.publication(commitVersion, writes);
      request.validate?.(value, commitVersion, writes, publication);
      throwIfAborted(request.transactionSignal);
      this.engine.writer.exec("COMMIT");
      transactionOpen = false;
      committed = true;
      this.afterCommit?.(writes, commitVersion);
      if (stagedMutation !== undefined) {
        this.engine[mutationReplayOwner].committed(stagedMutation);
      }
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
          (): RuntimeOperationOutcome<void> => ({ ok: true, value: undefined }),
          (error): RuntimeOperationOutcome<void> => ({ ok: false, error }),
        ),
      };
    } catch (error) {
      if (!committed) {
        let rollbackFailed = false;
        try {
          if (transactionOpen) {
            this.engine.writer.exec("ROLLBACK");
            transactionOpen = false;
          }
        } catch {
          rollbackFailed = true;
        }
        reservation.cancel();
        if (rollbackFailed) {
          throw new AckerDBError("indeterminate", "transaction outcome could not be determined", {
            cause: error,
          });
        }
      }
      throw error;
    }
  }

  private pruneExpiredMutations(): void {
    const now = finiteMillis(this.now(), "coordinator clock");
    if (now < this.nextPruneAtMs) return;
    this.nextPruneAtMs = now + 60_000;
    const before = now - this.limits.mutationReplay.maxAgeMs;
    for (;;) {
      const removed = this.engine[mutationReplayOwner].prune(before, 1_000);
      if (removed < 1_000) break;
    }
  }

  private publicationBytes(writes: WriteCollector): number {
    return wireByteLength({
      keys: [...writes.keys],
      events: writes.events,
    });
  }

  private nextEventSequence(table: string): bigint {
    const sequence = (this.eventSequences.get(table) ?? 0n) + 1n;
    this.eventSequences.set(table, sequence);
    return sequence;
  }

}
