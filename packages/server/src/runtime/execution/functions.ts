import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "bun:sqlite";
import {
  Failure,
  Ok,
  isApplicationError,
  isResult,
  type Result,
  type Identity,
} from "@ackerdb/core";
import {
  SYSTEM_PRINCIPAL,
  verifyUserBearerCredential,
  type CredentialVerifier,
  type ExternalAccount,
  type Principal,
} from "../../auth/credentials.ts";
import {
  checkpointWriteCollector,
  makeDbReader,
  rollbackWriteCollector,
  type ReadRecorder,
  type WriteCollector,
} from "../../database/access.ts";
import type { Engine } from "../../database/engine.ts";
import {
  invokeFunction,
  poisonCurrentInvocation,
} from "../../app/invocation.ts";
import type {
  AnyRegistered,
  MutationCtx,
  OwnedProcedureContext,
  ProcedureCtx,
  QueryCtx,
  TxCtx,
} from "../../app/functions.ts";
import type { OwnedHttpHandlerContext } from "../../app/http-handler.ts";
import type { Registry } from "../../app/registry.ts";
import type { McpAiContext } from "../../mcp/ai.ts";
import { Identities } from "../../auth/identities.ts";
import { CREDENTIAL_ISSUER } from "../../auth/credential-token.ts";
import type { IdentityDatabase } from "../../auth/tables.ts";
import {
  credentialMutationCapability,
  credentialQueryCapability,
} from "../../credentials/capability.ts";
import { Credentials, takeCredentialInvalidations } from "../../credentials/module.ts";
import type { CredentialDatabase } from "../../credentials/tables.ts";
import {
  applicationDatabase,
  internalDatabase,
} from "../../database/framework-schema.ts";
import {
  ReactiveCommit,
  type Subscriber,
} from "../../subscriptions/reactive/contract.ts";
import type { OrderedReactive } from "../../subscriptions/reactive/ordered.ts";
import { AckerDBError, throwIfAborted } from "../../shared/errors.ts";
import {
  CommitCoordinator,
  type CommitRequest,
  type CommitResult,
  type IdempotencyIdentity,
} from "../coordinator.ts";
import {
  assertWriterAvailable,
  runInInvocationRoot,
  withMutationAccess,
} from "../invocation-state.ts";
import { createMutationInvocationScope } from "../mutation-scope.ts";
import type { ServiceLimits } from "../limits.ts";
import type { RuntimeHooks } from "../contracts/lifecycle.ts";
import {
  JobRunsStore,
  JobsStore,
  nextDueJobAt,
  readJobRow,
  readJobRunRow,
} from "../jobs/store.ts";
import {
  mutationJobsNamespace,
  procedureJobsNamespace,
  queryJobsNamespace,
} from "../jobs/namespace.ts";
import type { RuntimeJobs } from "../jobs/runtime.ts";
import { RuntimeReadExecutor, type ReadExecution } from "./read.ts";
import { RuntimeFiles } from "../../files/namespace.ts";
import { FileProcedureRuntime } from "../../files/procedure.ts";
import { markOneTimeResult } from "../one-time-result.ts";
import { settleOnAbort } from "../abort.ts";

const releaseNothing = (): void => {};

/** What one runner transaction can reach; see `jobsWrite`. */
export interface JobsWriteSurface {
  readonly jobs: JobsStore;
  readonly runs: JobRunsStore;
  /**
   * A savepoint over the open transaction plus its write collector: the
   * mutation-kind envelope runs the handler inside one, so a failed handler
   * rolls back its writes while the same transaction still records the
   * failed run.
   */
  savepoint(): { rollback(): void; release(): void };
  /**
   * Run a mutation-kind job handler under the same system-principal mutation
   * context bindings a registered mutation would have.
   */
  runMutationHandler<T>(
    runNumber: number,
    run: (ctx: MutationCtx & { readonly runNumber: number }) => T | Promise<T>,
  ): Promise<T>;
}

export function restoreMutationResult(value: unknown): Result<unknown, unknown> {
  if (isResult(value)) return value;
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    throw new AckerDBError("internal", "stored mutation result has no Result shape");
  }
  if (value.ok === true && "data" in value) return Ok(value.data);
  if (value.ok === false && "error" in value && isApplicationError(value.error)) {
    return Failure(value.error);
  }
  throw new AckerDBError("internal", "stored mutation Result is invalid");
}

export interface RuntimeMutationCommitRequest {
  readonly fairnessKey: string;
  readonly requestBytes: number;
  readonly admissionSignal: AbortSignal;
  readonly transactionSignal?: AbortSignal;
  readonly idempotency?: IdempotencyIdentity;
  readonly subscriber?: Subscriber;
  readonly fn: AnyRegistered;
  readonly principal: Principal;
  readonly args: unknown;
  readonly validate?: CommitRequest<unknown, ReactiveCommit>["validate"];
  readonly publishAuthInvalidation?: (account: ExternalAccount) => void;
}

export interface RuntimeFunctionMcpCapabilities {
  bindAiContext(
    context: McpAiContext & Pick<ProcedureCtx, "timestamp">,
    fairnessKey: string,
    requestBytes: number,
  ): () => void;
}

interface RuntimeCommitRequest<T> {
  readonly operation: "mutation" | "transaction";
  readonly fairnessKey: string;
  readonly requestBytes: number;
  readonly admissionSignal: AbortSignal;
  readonly transactionSignal?: AbortSignal;
  readonly idempotency?: IdempotencyIdentity;
  readonly subscriber?: Subscriber;
  readonly work: (db: MutationCtx["db"], writes: WriteCollector) => T | Promise<T>;
  readonly validate?: CommitRequest<T, ReactiveCommit>["validate"];
  /**
   * The originating caller's own auth-invalidation channel, when the caller
   * owns a response this commit's revocations could destroy. Absent means the
   * Runtime's immediate fan-out, which is right for every commit whose origin
   * is the framework itself.
   */
  readonly publishAuthInvalidation?: (account: ExternalAccount) => void;
}

export interface RuntimeFunctionExecutorOptions<C> {
  readonly engine: Engine;
  readonly registry: Registry;
  readonly limits: ServiceLimits;
  readonly reads: RuntimeReadExecutor;
  readonly reactive: OrderedReactive<C>;
  readonly credentialVerifier?: CredentialVerifier;
  /** Application scopes plus the framework's: what a credential grant expands against. */
  readonly vocabulary: readonly string[];
  /**
   * Committed revocations and grant changes, onto the generic auth-invalidation
   * path, for a commit whose origin holds no response of its own.
   */
  readonly publishAuthInvalidation: (account: ExternalAccount) => void;
  readonly mcp?: RuntimeFunctionMcpCapabilities;
  /** Commit-wake: fired when a transaction touched the jobs table. */
  readonly armJobs: () => void;
  /** Lazy: the jobs runner is constructed after this executor. */
  readonly jobs: () => RuntimeJobs;
  readonly files: RuntimeFiles;
  readonly fileLifecycleSignal: () => AbortSignal;
  readonly now: () => number;
  readonly hooks?: Pick<RuntimeHooks, "wait">;
}

/**
 * Owns registered function contexts, the single writer, and the synchronous
 * commit-to-publication handoff. A WriteCollector never crosses this module's
 * commit interface; it stays inside the coordinator turn that created it.
 */
export class RuntimeFunctionExecutor<C> {
  private readonly coordinator: CommitCoordinator<ReactiveCommit>;
  private readonly fileProcedures: FileProcedureRuntime;
  /**
   * Where one commit's committed authority changes are published. The commit
   * request knows its origin and the post-commit handoff only sees the write
   * set, so the two meet on the collector the turn already owns.
   */
  private readonly authInvalidationByWrites =
    new WeakMap<WriteCollector, (account: ExternalAccount) => void>();
  private fileRecoveryBarrier: Promise<void> = Promise.resolve();

  constructor(private readonly options: RuntimeFunctionExecutorOptions<C>) {
    this.coordinator = new CommitCoordinator({
      engine: options.engine,
      limits: options.limits,
      reservePublication: (bytes) => options.reactive.publication.reserve(bytes),
      afterCommit: (writes) => {
        if (writes.fileCleanupAt !== null) options.files.scheduleCleanupAt(writes.fileCleanupAt);
        const credentialInvalidations = takeCredentialInvalidations(writes);
        if (credentialInvalidations.length > 0) {
          const publish = this.authInvalidationByWrites.get(writes)
            ?? options.publishAuthInvalidation;
          for (const account of credentialInvalidations) publish(account);
        }
      },
      ...(options.hooks?.wait === undefined ? {} : { wait: options.hooks.wait }),
      now: options.now,
    });
    this.fileProcedures = new FileProcedureRuntime({
      files: options.files,
      now: options.now,
      lifecycleSignal: options.fileLifecycleSignal,
      read: (signal, work) => this.filesRead(signal, work),
      write: (signal, work) => this.filesWrite(signal, work),
    });
  }

  snapshot() {
    return this.coordinator.snapshot();
  }

  /**
   * The Credentials module bound to one invocation's own database handle.
   *
   * It is built from the same managed reader or writer `ctx.db` is, so a
   * credential read records the invocation's ordinary predicate dependencies
   * and a credential write emits the ordinary write keys and joins the
   * transaction. `writes` is the transaction's collector when there is one, and
   * null on a query, which is the whole of what makes credential writes exist
   * only on a mutation or transaction context.
   */
  private credentialsFor(db: unknown, writes: WriteCollector | null): Credentials {
    return new Credentials({
      db: internalDatabase(db) as CredentialDatabase,
      vocabulary: this.options.vocabulary,
      limits: this.options.limits.credentials,
      now: this.options.now,
      writes,
    });
  }

  close(): void {
    this.coordinator.close();
  }

  drain(): Promise<void> {
    return this.coordinator.drain();
  }

  bindFileRecoveryBarrier(barrier: Promise<void>): void {
    this.fileRecoveryBarrier = barrier;
  }

  /** One bounded reader snapshot for the framework-owned File HTTP surface. */
  filesRead<T>(
    signal: AbortSignal,
    work: (db: unknown) => T | Promise<T>,
  ): Promise<T> {
    return this.options.reads.execute(
      "system:files",
      signal,
      1,
      null,
      (execution) => work(makeDbReader(
        this.options.engine,
        execution.connection,
        null,
      )),
    );
  }

  /** One ordinary coordinated writer transaction for framework File state. */
  filesWrite<T>(
    signal: AbortSignal,
    work: (db: unknown) => T | Promise<T>,
    options: { readonly waitForRecovery?: boolean } = {},
  ): Promise<T> {
    return runInInvocationRoot(SYSTEM_PRINCIPAL, () => this.executeWrite(
      "transaction",
      "system:files",
      signal,
      1,
      (db, writes) => {
        const scope = createMutationInvocationScope(this.options.engine.writer, writes);
        return scope.runRoot((mutationAccess) =>
          withMutationAccess(mutationAccess, () => work(db)));
      },
      options.waitForRecovery ?? true,
    ));
  }

  /**
   * The Identity tables under one snapshot read, with no ReadRecorder: an
   * account lookup during authentication has no subscription to invalidate.
   */
  private identitiesReading(connection: Database): Identities {
    return new Identities(
      internalDatabase(makeDbReader(this.options.engine, connection, null)) as IdentityDatabase,
    );
  }

  async resolveIdentity(
    account: ExternalAccount,
    fairnessKey: string,
    signal: AbortSignal,
    requestBytes: number,
  ): Promise<Identity> {
    const existing = await this.options.reads.submit(
      (connection) => this.identitiesReading(connection)
        .forAccount(account.issuer, account.subject),
      {
        bytes: requestBytes,
        fairnessKey,
        signal,
      },
    );
    if (existing !== null) return existing;
    // Provisioning is an ordinary managed write, so it takes the ordinary
    // coordinated writer: the account row lands with the write keys and the
    // publication every other insert produces.
    return this.identityWrite(
      fairnessKey,
      signal,
      requestBytes,
      (identities) => identities.resolve(account.issuer, account.subject),
    );
  }

  /** One coordinated writer transaction over the framework Identity tables. */
  private identityWrite<T>(
    fairnessKey: string,
    signal: AbortSignal,
    requestBytes: number,
    work: (identities: Identities) => Promise<T>,
  ): Promise<T> {
    return runInInvocationRoot(SYSTEM_PRINCIPAL, () => this.executeWrite(
      "transaction",
      fairnessKey,
      signal,
      requestBytes,
      (db, writes) => {
        const scope = createMutationInvocationScope(this.options.engine.writer, writes);
        return scope.runRoot((mutationAccess) =>
          withMutationAccess(mutationAccess, () =>
            work(new Identities(internalDatabase(db) as IdentityDatabase))));
      },
    ));
  }

  invokeQuery(
    fn: AnyRegistered,
    args: unknown,
    principal: Principal,
    execution: Readonly<ReadExecution>,
  ): Promise<unknown> {
    const db = makeDbReader(
      this.options.engine,
      execution.connection,
      execution.reads,
    );
    const timestamp = this.readNow();
    return invokeFunction(fn, this.hostQueryContext(db, principal, timestamp), args);
  }

  commitMutation(
    request: RuntimeMutationCommitRequest,
  ): Promise<CommitResult<unknown, ReactiveCommit>> {
    return this.commitWrite({
      operation: "mutation",
      fairnessKey: request.fairnessKey,
      requestBytes: request.requestBytes,
      admissionSignal: request.admissionSignal,
      transactionSignal: request.transactionSignal,
      idempotency: request.idempotency,
      subscriber: request.subscriber,
      validate: request.validate,
      ...(request.publishAuthInvalidation === undefined
        ? {}
        : { publishAuthInvalidation: request.publishAuthInvalidation }),
      work: this.mutationWork(request.fn, request.principal, request.args),
    });
  }

  createMcpTransactionContext(
    principal: Principal,
    fairnessKey: string,
    signal: AbortSignal,
    requestBytes: number,
    timestamp: number,
  ): McpAiContext & Pick<ProcedureCtx, "timestamp"> {
    return Object.freeze({
      auth: principal,
      abortSignal: signal,
      timestamp,
      tx: async <R>(work: (ctx: TxCtx) => R): Promise<Awaited<R>> =>
        await this.executeWrite(
          "transaction",
          fairnessKey,
          signal,
          requestBytes,
          async (db, writes) => {
            const context = this.hostMutationContext(db, principal, timestamp, writes) as TxCtx;
            try {
              return await work(context);
            } catch (error) {
              return poisonCurrentInvocation(error);
            }
          },
        ) as Awaited<R>,
    });
  }

  createProcedureContext(
    principal: Principal,
    fairnessKey: string,
    signal: AbortSignal,
    requestBytes: number,
    timestamp: number | (() => number),
    accountUnlinked: (account: ExternalAccount) => void,
    surface?: "procedure",
  ): OwnedProcedureContext;
  createProcedureContext(
    principal: Principal,
    fairnessKey: string,
    signal: AbortSignal,
    requestBytes: number,
    timestamp: number | (() => number),
    accountUnlinked: (account: ExternalAccount) => void,
    surface: "http",
  ): OwnedHttpHandlerContext;
  createProcedureContext(
    principal: Principal,
    fairnessKey: string,
    signal: AbortSignal,
    requestBytes: number,
    timestamp: number | (() => number),
    accountUnlinked: (account: ExternalAccount) => void,
    /** "http" omits the auth members: raw routes resolve no credential. */
    surface: "procedure" | "http" = "procedure",
  ): OwnedProcedureContext | OwnedHttpHandlerContext {
    const currentTimestamp = typeof timestamp === "function"
      ? timestamp
      : () => timestamp;
    const value = Object.freeze({
      ...(surface === "http" ? {} : { auth: principal }),
      abortSignal: signal,
      get timestamp(): number {
        return currentTimestamp();
      },
      jobs: procedureJobsNamespace(this.options.jobs()),
      files: this.fileProcedures.capability(principal, signal),
      tx: <R>(work: (ctx: TxCtx) => R) =>
        this.executeWrite(
          "transaction",
          fairnessKey,
          signal,
          requestBytes,
          (db, writes) => {
            const context = this.hostMutationContext(
              db,
              principal,
              currentTimestamp(),
              writes,
            ) as TxCtx;
            const scope = createMutationInvocationScope(this.options.engine.writer, writes);
            return scope.runRoot((mutationAccess) =>
              withMutationAccess(mutationAccess, async () => {
                try {
                  const value = await work(context);
                  return isResult(value) ? value : Ok(value);
                } catch (error) {
                  return poisonCurrentInvocation(error);
                }
              }));
          },
        ),
      ...(surface === "http" ? {} : {
        linkAccount: (rawBearerToken: string) => this.linkAccount(
          principal,
          rawBearerToken,
          fairnessKey,
          signal,
          requestBytes,
        ),
        unlinkAccount: (account: ExternalAccount) => this.unlinkAccount(
          principal,
          account,
          fairnessKey,
          signal,
          requestBytes,
          accountUnlinked,
        ),
      }),
    }) as ProcedureCtx;
    // The MCP AI capability authenticates as the calling principal; the http
    // surface has none, so binding it there would carry an absent identity.
    const release = surface !== "http"
      ? this.options.mcp?.bindAiContext(value, fairnessKey, requestBytes) ?? releaseNothing
      : releaseNothing;
    return Object.freeze({ value, release });
  }

  /**
   * `internal.db` is on the context rather than handed to each capability
   * because it is the same handle every framework implementation wants and the
   * same one the caller must not see: the application-facing types omit it, so
   * a handler that never casts cannot reach a framework table its capability
   * exists to protect.
   */
  private hostQueryContext(
    db: unknown,
    principal: Principal,
    timestamp: number,
  ): QueryCtx {
    return Object.freeze({
      db: applicationDatabase(db),
      auth: principal,
      timestamp,
      internal: Object.freeze({ db: internalDatabase(db) }),
      jobs: queryJobsNamespace(this.options.jobs(), db),
      files: this.options.files.query(db),
      credentials: credentialQueryCapability(this.credentialsFor(db, null), principal),
    }) as QueryCtx;
  }

  private hostMutationContext(
    db: unknown,
    principal: Principal,
    timestamp: number,
    writes: WriteCollector,
    extras?: Record<string, unknown>,
  ): MutationCtx {
    return Object.freeze({
      ...extras,
      db: applicationDatabase(db),
      auth: principal,
      timestamp,
      internal: Object.freeze({ db: internalDatabase(db) }),
      jobs: mutationJobsNamespace(
        this.options.jobs(),
        db,
        new JobsStore(this.options.engine, writes),
      ),
      files: this.options.files.mutation(db, principal, timestamp, (at) => {
        writes.fileCleanupAt = writes.fileCleanupAt === null
          ? at
          : Math.min(writes.fileCleanupAt, at);
      }, () => markOneTimeResult(writes)),
      credentials: credentialMutationCapability(this.credentialsFor(db, writes), principal),
    }) as MutationCtx;
  }

  private mutationWork(
    fn: AnyRegistered,
    principal: Principal,
    args: unknown,
  ): (db: MutationCtx["db"], writes: WriteCollector) => unknown {
    return (db, writes) => {
      const invocation = this.hostMutationContext(db, principal, this.readNow(), writes);
      const scope = createMutationInvocationScope(this.options.engine.writer, writes);
      return scope.runRoot((mutationAccess) =>
        invokeFunction(fn, invocation, args, { mutationAccess }));
    };
  }

  private async commitWrite<T>(
    request: RuntimeCommitRequest<T>,
    waitForFileRecovery = true,
  ): Promise<CommitResult<T, ReactiveCommit>> {
    if (waitForFileRecovery) {
      await settleOnAbort(this.fileRecoveryBarrier, request.admissionSignal);
    }
    let scheduledTables: ReadonlySet<string> = new Set();
    const result = await this.coordinator.execute({
      operation: request.operation,
      fairnessKey: request.fairnessKey,
      requestBytes: request.requestBytes,
      admissionSignal: request.admissionSignal,
      transactionSignal: request.transactionSignal,
      idempotency: request.idempotency,
      validate: request.validate,
      run: AsyncLocalStorage.snapshot(),
      work: (db, writes) => {
        if (request.publishAuthInvalidation !== undefined) {
          this.authInvalidationByWrites.set(writes, request.publishAuthInvalidation);
        }
        return request.work(db, writes);
      },
      rollbackWhen: (value) => isResult(value) && !value.ok,
      publication: (_version, writes) => {
        scheduledTables = new Set(writes.scheduledTables);
        return this.publicationFor(writes, request.subscriber);
      },
    });
    if (scheduledTables.size > 0) this.options.armJobs();
    return result;
  }

  private async executeWrite<T>(
    operation: "mutation" | "transaction",
    fairnessKey: string,
    signal: AbortSignal,
    requestBytes: number,
    work: (db: MutationCtx["db"], writes: WriteCollector) => T | Promise<T>,
    waitForFileRecovery = true,
  ): Promise<T> {
    throwIfAborted(signal);
    assertWriterAvailable();
    const result = await this.commitWrite({
      operation,
      fairnessKey,
      requestBytes,
      admissionSignal: signal,
      transactionSignal: signal,
      work,
    }, waitForFileRecovery);
    return result.value;
  }

  /**
   * One coordinated writer transaction for the job runner: the jobs store
   * (unguarded framework writes over `_ackerdb_jobs`) plus a system-principal
   * mutation context for mutation-kind handlers, all inside the ordinary
   * mutation access scope so table methods, write keys, publication, and
   * commit-wake behave exactly as they do for any mutation.
   */
  async jobsWrite<T>(
    signal: AbortSignal,
    work: (surface: JobsWriteSurface) => T | Promise<T>,
  ): Promise<T> {
    return await this.executeWrite(
      "transaction",
      "system:jobs",
      signal,
      1,
      (db, writes) => {
        const surface: JobsWriteSurface = {
          jobs: new JobsStore(this.options.engine, writes),
          runs: new JobRunsStore(this.options.engine, writes),
          savepoint: () => {
            const checkpoint = checkpointWriteCollector(writes);
            this.options.engine.writer.exec("SAVEPOINT ackerdb_job_handler");
            let settled = false;
            return {
              rollback: () => {
                if (settled) return;
                settled = true;
                this.options.engine.writer.exec("ROLLBACK TO ackerdb_job_handler");
                this.options.engine.writer.exec("RELEASE ackerdb_job_handler");
                rollbackWriteCollector(writes, checkpoint);
              },
              release: () => {
                if (settled) return;
                settled = true;
                this.options.engine.writer.exec("RELEASE ackerdb_job_handler");
              },
            };
          },
          runMutationHandler: async (runNumber, run) => {
            // The run number is part of the context object itself: capability
            // bindings key off the exact frozen identity, so no caller may
            // spread a bound context into a copy.
            const context = this.hostMutationContext(
              db,
              SYSTEM_PRINCIPAL,
              this.readNow(),
              writes,
              { runNumber },
            ) as MutationCtx & { readonly runNumber: number };
            return await run(context);
          },
        };
        const scope = createMutationInvocationScope(this.options.engine.writer, writes);
        // Runner transactions start from timers, not requests: they own their
        // invocation root, exactly as system.run owns one for its callback.
        return runInInvocationRoot(SYSTEM_PRINCIPAL, () =>
          scope.runRoot((mutationAccess) =>
            withMutationAccess(mutationAccess, async () => await work(surface))));
      },
    );
  }

  readJobRow(connection: Database, id: bigint) {
    return readJobRow(this.options.engine, connection, id);
  }

  readJobRunRow(connection: Database, jobId: bigint, number: number) {
    return readJobRunRow(this.options.engine, connection, jobId, number);
  }

  nextDueJobAt(connection: Database, inProcessIds: readonly bigint[] = [], notBefore = 0) {
    return nextDueJobAt(this.options.engine, connection, inProcessIds, notBefore);
  }

  private async linkAccount(
    principal: Principal,
    rawBearerToken: string,
    fairnessKey: string,
    signal: AbortSignal,
    requestBytes: number,
  ): Promise<void> {
    if (principal.kind !== "user") {
      throw new AckerDBError("unauthorized", "account linking requires a user identity");
    }
    throwIfAborted(signal);
    const account = await verifyUserBearerCredential(
      rawBearerToken,
      this.options.credentialVerifier,
      this.options.now,
    );
    if (account.issuer === CREDENTIAL_ISSUER) {
      // An AckerDB credential is already a first-class Identity; aliasing it
      // onto another Identity would give one credential two authorities.
      throw new AckerDBError(
        "validation",
        "credential tokens cannot be linked as external accounts",
      );
    }
    throwIfAborted(signal);
    await this.identityWrite(fairnessKey, signal, requestBytes, async (identities) => {
      if (account.expiresAt <= this.readNow()) {
        throw new AckerDBError("unauthenticated", "invalid credential");
      }
      if (!await identities.attach(principal.identity, account.issuer, account.subject)) {
        throw new AckerDBError("conflict", "external account is already linked");
      }
    });
  }

  private async unlinkAccount(
    principal: Principal,
    candidate: ExternalAccount,
    fairnessKey: string,
    signal: AbortSignal,
    requestBytes: number,
    accountUnlinked: (account: ExternalAccount) => void,
  ): Promise<void> {
    if (principal.kind !== "user") {
      throw new AckerDBError("unauthorized", "account unlinking requires ownership");
    }
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      typeof candidate.issuer !== "string" ||
      candidate.issuer.length === 0 ||
      typeof candidate.subject !== "string" ||
      candidate.subject.length === 0
    ) {
      throw new AckerDBError("validation", "external account must have an issuer and subject");
    }
    const account = Object.freeze({ issuer: candidate.issuer, subject: candidate.subject });
    throwIfAborted(signal);
    const result = await this.identityWrite(
      fairnessKey,
      signal,
      requestBytes,
      (identities) => identities.detach(principal.identity, account.issuer, account.subject),
    );
    // Published after the write committed, exactly as before: an unlink that
    // rolled back must not terminate the session it never removed.
    if (result === "removed") accountUnlinked(account);
    if (result === "not_owned") {
      throw new AckerDBError("unauthorized", "account unlinking requires ownership");
    }
    if (result === "last_account") {
      throw new AckerDBError("conflict", "cannot unlink the final external account");
    }
  }

  private publicationFor(writes: WriteCollector, caller?: Subscriber): ReactiveCommit {
    return new ReactiveCommit(
      writes.keys,
      writes.events,
      caller === undefined
        ? []
        : this.options.reactive.affectedQueryIds(caller, writes.keys),
    );
  }

  private readNow(): number {
    return this.options.now();
  }
}
