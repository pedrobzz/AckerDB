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
import { emitWriteKeys } from "../../database/keys.ts";
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
import {
  takeCredentialInvalidations,
  withCredentialContext,
} from "../../auth/credential-context.ts";
import { CREDENTIAL_ISSUER } from "../../auth/credential-token.ts";
import {
  PluginRuntime,
  type PluginInvocationCapabilities,
  type PluginReadExecution,
  type PluginWriteExecution,
} from "../../plugins/runtime.ts";
import {
  ReactiveCommit,
  type Subscriber,
} from "../../subscriptions/reactive/contract.ts";
import type { OrderedReactive } from "../../subscriptions/reactive/ordered.ts";
import type { ApplicationSignals } from "../../telemetry/application-signals/application-signals.ts";
import type {
  AnalyticsEventRecord,
  ApplicationLogger,
} from "../../telemetry/application-signals/types.ts";
import type { Telemetry } from "../../telemetry/telemetry.ts";
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
  withTransactionAnalytics,
} from "../invocation-state.ts";
import { createMutationInvocationScope } from "../mutation-scope.ts";
import type { ServiceLimits } from "../limits.ts";
import type { RuntimeHooks } from "../contracts/lifecycle.ts";
import type { RuntimeTraceBridge } from "../telemetry/trace-bridge.ts";
import {
  JobRunsStore,
  JobsStore,
  dueJobStats,
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
import { RuntimeReadExecutor } from "./read.ts";
import { applicationDatabase, RuntimeFiles } from "../../files/namespace.ts";
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
   * Run a mutation-kind job handler under a system-principal mutation context
   * with the same bindings (credential vault, analytics attribution) a
   * registered mutation would have.
   */
  runMutationHandler<T>(
    jobAddress: string,
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
}

export interface RuntimeFunctionExecutorOptions<C> {
  readonly engine: Engine;
  readonly registry: Registry;
  readonly limits: ServiceLimits;
  readonly reads: RuntimeReadExecutor;
  readonly reactive: OrderedReactive<C>;
  readonly telemetry: Telemetry;
  readonly tracing: RuntimeTraceBridge;
  readonly applicationSignals: ApplicationSignals;
  readonly log: ApplicationLogger;
  readonly pluginRuntime?: PluginRuntime;
  readonly credentialVerifier?: CredentialVerifier;
  /** Application scopes plus the framework's: what a credential grant expands against. */
  readonly vocabulary: readonly string[];
  /** Committed revocations and grant changes, onto the generic auth-invalidation path. */
  readonly publishCredentialInvalidations: (accounts: readonly ExternalAccount[]) => void;
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
  private readonly analyticsByWrites = new WeakMap<WriteCollector, AnalyticsEventRecord[]>();
  private fileRecoveryBarrier: Promise<void> = Promise.resolve();

  constructor(private readonly options: RuntimeFunctionExecutorOptions<C>) {
    this.coordinator = new CommitCoordinator({
      engine: options.engine,
      limits: options.limits,
      reservePublication: (bytes) => options.reactive.publication.reserve(bytes),
      afterCommit: (writes, commitVersion) => {
        options.files.observability.committed(writes.fileObservability);
        if (writes.fileCleanupAt !== null) options.files.scheduleCleanupAt(writes.fileCleanupAt);
        const credentialInvalidations = takeCredentialInvalidations(writes);
        if (credentialInvalidations.length > 0) {
          options.publishCredentialInvalidations(credentialInvalidations);
        }
        const analytics = this.analyticsByWrites.get(writes);
        if (analytics !== undefined) {
          this.analyticsByWrites.delete(writes);
          options.applicationSignals.commitAnalytics(analytics, commitVersion);
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

  /** Expose `credentials` operations to exactly one active invocation context. */
  private bindCredentialContext<T extends object, R>(
    context: T,
    principal: Principal,
    connection: Database,
    reads: ReadRecorder | null,
    writes: WriteCollector | null,
    work: (ctx: T) => R | Promise<R>,
  ): Promise<Awaited<R>> {
    return withCredentialContext(context, {
      engine: this.options.engine,
      connection,
      principal,
      reads,
      writes,
      limits: this.options.limits.credentials,
      vocabulary: this.options.vocabulary,
      now: this.options.now,
    }, work);
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
      "query",
      "system:files",
      signal,
      1,
      null,
      (execution) => work(makeDbReader(
        this.options.engine,
        execution.connection,
        null,
        execution.statementObserver,
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

  async resolveIdentity(
    account: ExternalAccount,
    fairnessKey: string,
    signal: AbortSignal,
    requestBytes: number,
  ): Promise<Identity> {
    const existing = await this.options.reads.submit(
      (connection) => this.options.engine.identityForAccount(
        connection,
        account.issuer,
        account.subject,
      ),
      {
        operation: "transaction",
        bytes: requestBytes,
        fairnessKey,
        signal,
      },
      false,
    );
    if (existing !== null) return existing;
    return this.coordinator.transactFramework({
      fairnessKey,
      requestBytes,
      admissionSignal: signal,
      transactionSignal: signal,
      work: () => this.options.engine.resolveIdentity(account.issuer, account.subject),
    });
  }

  invokeQuery(
    fn: AnyRegistered,
    args: unknown,
    principal: Principal,
    execution: Readonly<PluginReadExecution>,
  ): Promise<unknown> {
    const db = makeDbReader(
      this.options.engine,
      execution.connection,
      execution.reads,
      execution.statementObserver,
    );
    const timestamp = this.readNow();
    const context = this.hostQueryContext(db, principal, timestamp, execution);
    return this.bindCredentialContext(
      context,
      principal,
      execution.connection,
      execution.reads,
      null,
      (ctx) => invokeFunction(fn, ctx, args),
    );
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
        await this.inTransactionTrace(() => this.executeWrite(
          "transaction",
          fairnessKey,
          signal,
          requestBytes,
          async (db, writes) => {
            const context = Object.freeze({
              db,
              auth: principal,
              analytics: this.options.applicationSignals.analyticsFor(principal),
              log: this.options.log,
              timestamp,
            }) as TxCtx;
            try {
              return await this.bindCredentialContext(
                context,
                principal,
                this.options.engine.writer,
                null,
                writes,
                work,
              );
            } catch (error) {
              return poisonCurrentInvocation(error);
            }
          },
        )) as Awaited<R>,
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
    const initialTimestamp = currentTimestamp();
    const plugins = this.options.pluginRuntime?.bindProcedure({
      invocation: this.pluginInvocationCapabilities(principal, initialTimestamp),
      abortSignal: signal,
      runQuery: (work) => this.executePluginQuery(fairnessKey, signal, requestBytes, work),
      runMutation: (work) => this.executePluginWrite(
        "mutation",
        fairnessKey,
        signal,
        requestBytes,
        work,
      ),
      runTransaction: (work) => this.executePluginWrite(
        "transaction",
        fairnessKey,
        signal,
        requestBytes,
        work,
      ),
    }) ?? {};
    const value = Object.freeze({
      ...(surface === "http" ? {} : { auth: principal }),
      abortSignal: signal,
      log: this.options.log,
      get timestamp(): number {
        return currentTimestamp();
      },
      jobs: procedureJobsNamespace(this.options.jobs()),
      files: this.fileProcedures.capability(principal, signal),
      ...plugins,
      tx: <R>(work: (ctx: TxCtx) => R) =>
        this.inTransactionTrace(() => this.executeWrite(
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
                  const value = await this.bindCredentialContext(
                    context,
                    principal,
                    this.options.engine.writer,
                    null,
                    writes,
                    work,
                  );
                  return isResult(value) ? value : Ok(value);
                } catch (error) {
                  return poisonCurrentInvocation(error);
                }
              }));
          },
        )),
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

  private hostQueryContext(
    db: unknown,
    principal: Principal,
    timestamp: number,
    execution: Readonly<PluginReadExecution>,
  ): QueryCtx {
    const plugins = this.options.pluginRuntime?.bindQuery({
      ...execution,
      invocation: this.pluginInvocationCapabilities(principal, timestamp),
    }) ?? {};
    return Object.freeze({
      db: applicationDatabase(db),
      auth: principal,
      log: this.options.log,
      timestamp,
      jobs: queryJobsNamespace(this.options.jobs(), db),
      files: this.options.files.query(db),
      ...plugins,
    }) as QueryCtx;
  }

  private hostMutationContext(
    db: unknown,
    principal: Principal,
    timestamp: number,
    writes: WriteCollector,
    attribution?: { functionAddress: string; functionKind: string },
    extras?: Record<string, unknown>,
  ): MutationCtx {
    const analytics = this.options.applicationSignals.analyticsFor(principal, attribution);
    const plugins = this.options.pluginRuntime?.bindMutation({
      writes,
      invocation: this.pluginInvocationCapabilities(principal, timestamp),
      ...(this.options.telemetry.enabled
        ? { statementObserver: this.options.tracing.observeStatement }
        : {}),
    }) ?? {};
    return Object.freeze({
      ...extras,
      db: applicationDatabase(db),
      auth: principal,
      analytics,
      log: this.options.log,
      timestamp,
      jobs: mutationJobsNamespace(
        this.options.jobs(),
        db,
        new JobsStore(
          this.options.engine,
          writes,
          this.options.telemetry.enabled ? this.options.tracing.observeStatement : undefined,
        ),
      ),
      files: this.options.files.mutation(db, principal, timestamp, (at) => {
        writes.fileCleanupAt = writes.fileCleanupAt === null
          ? at
          : Math.min(writes.fileCleanupAt, at);
      }, () => markOneTimeResult(writes)),
      ...plugins,
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
        this.bindCredentialContext(
          invocation,
          principal,
          this.options.engine.writer,
          null,
          writes,
          (ctx) => invokeFunction(fn, ctx, args, { mutationAccess }),
        ));
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
      ...(this.options.telemetry.enabled
        ? {
            telemetry: this.options.tracing.observeCommit,
            statementTelemetry: this.options.tracing.observeStatement,
          }
        : {}),
      run: AsyncLocalStorage.snapshot(),
      work: (db, writes) => this.withStagedAnalytics(
        writes,
        () => request.work(db, writes),
      ),
      rollbackWhen: (value) => isResult(value) && !value.ok,
      publication: (_version, writes) => {
        scheduledTables = new Set(writes.scheduledTables);
        return this.publicationFor(writes, request.subscriber);
      },
    });
    if (scheduledTables.size > 0) this.options.armJobs();
    return result;
  }

  private withStagedAnalytics<T>(
    writes: WriteCollector,
    work: () => T | Promise<T>,
  ): Promise<T> {
    const analytics: AnalyticsEventRecord[] = [];
    this.analyticsByWrites.set(writes, analytics);
    return withTransactionAnalytics(analytics, async () => {
      try {
        const value = await work();
        if (isResult(value) && !value.ok) analytics.length = 0;
        return value;
      } catch (error) {
        analytics.length = 0;
        throw error;
      }
    });
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
        const observer = this.options.telemetry.enabled
          ? this.options.tracing.observeStatement
          : undefined;
        const surface: JobsWriteSurface = {
          jobs: new JobsStore(this.options.engine, writes, observer),
          runs: new JobRunsStore(this.options.engine, writes, observer),
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
          runMutationHandler: async (jobAddress, runNumber, run) => {
            // The run number is part of the context object itself: capability
            // bindings key off the exact frozen identity, so no caller may
            // spread a bound context into a copy.
            const context = this.hostMutationContext(
              db,
              SYSTEM_PRINCIPAL,
              this.readNow(),
              writes,
              { functionAddress: jobAddress, functionKind: "job" },
              { runNumber },
            ) as MutationCtx & { readonly runNumber: number };
            return await this.bindCredentialContext(
              context,
              SYSTEM_PRINCIPAL,
              this.options.engine.writer,
              null,
              writes,
              run,
            );
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

  dueJobStats(connection: Database, now: number) {
    return dueJobStats(this.options.engine, connection, now);
  }

  private inTransactionTrace<T>(work: () => Promise<T>): Promise<T> {
    const scope = this.options.tracing.currentScope();
    return scope === undefined
      ? work()
      : this.options.tracing.runScope({ ...scope, operation: "transaction" }, work);
  }

  private executePluginQuery<T>(
    fairnessKey: string,
    signal: AbortSignal,
    requestBytes: number,
    work: (execution: Readonly<PluginReadExecution>) => T | Promise<T>,
  ): Promise<T> {
    return this.options.reads.execute("query", fairnessKey, signal, requestBytes, null, work);
  }

  private executePluginWrite<T>(
    operation: "mutation" | "transaction",
    fairnessKey: string,
    signal: AbortSignal,
    requestBytes: number,
    work: (execution: Readonly<PluginWriteExecution>) => T | Promise<T>,
  ): Promise<T> {
    const execute = () => this.executeWrite(
      operation,
      fairnessKey,
      signal,
      requestBytes,
      (_db, writes) => work(Object.freeze({
        writes,
        ...(this.options.telemetry.enabled
          ? { statementObserver: this.options.tracing.observeStatement }
          : {}),
      })),
    );
    return operation === "transaction" ? this.inTransactionTrace(execute) : execute();
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
      // A vault credential is already a first-class Identity; aliasing it onto
      // another Identity would give one credential two authorities.
      throw new AckerDBError(
        "validation",
        "credential tokens cannot be linked as external accounts",
      );
    }
    throwIfAborted(signal);
    await this.coordinator.transactFramework({
      fairnessKey,
      requestBytes,
      admissionSignal: signal,
      transactionSignal: signal,
      work: () => {
        if (account.expiresAt <= this.readNow()) {
          throw new AckerDBError("unauthenticated", "invalid credential");
        }
        if (!this.options.engine.attachIdentityAccount(
          principal.identity,
          account.issuer,
          account.subject,
        )) {
          throw new AckerDBError("conflict", "external account is already linked");
        }
      },
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
    const result = await this.coordinator.transactFramework({
      fairnessKey,
      requestBytes,
      admissionSignal: signal,
      transactionSignal: signal,
      work: () => this.options.engine.detachIdentityAccount(
        principal.identity,
        account.issuer,
        account.subject,
      ),
      afterCommit: (committed) => {
        if (committed === "removed") accountUnlinked(account);
      },
    });
    if (result === "not_owned") {
      throw new AckerDBError("unauthorized", "account unlinking requires ownership");
    }
    if (result === "last_account") {
      throw new AckerDBError("conflict", "cannot unlink the final external account");
    }
  }

  private pluginInvocationCapabilities(
    principal: Principal,
    timestamp: number,
  ): Readonly<PluginInvocationCapabilities> {
    return Object.freeze({
      timestamp,
      log: (functionAddress, functionKind) =>
        this.options.applicationSignals.forFunction(functionAddress, functionKind),
      analytics: (functionAddress, functionKind) =>
        this.options.applicationSignals.analyticsFor(principal, {
          functionAddress,
          functionKind,
        }),
    } satisfies PluginInvocationCapabilities);
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

  private expectMutation(address: string): AnyRegistered {
    const fn = this.options.registry.get(address);
    if (fn === undefined) {
      throw new AckerDBError("not_found", `unknown function "${address}"`);
    }
    if (fn.kind !== "mutation") {
      throw new AckerDBError(
        "validation",
        `"${address}" is a ${fn.kind}, expected a mutation`,
      );
    }
    return fn;
  }

  private readNow(): number {
    return this.options.now();
  }
}
