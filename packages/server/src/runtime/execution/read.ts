import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "bun:sqlite";
import type { ReadRecorder } from "../../database/access.ts";
import type { Engine } from "../../database/engine.ts";
import type { PluginReadExecution } from "../../plugins/runtime.ts";
import { AckerDBError, throwIfAborted } from "../../shared/errors.ts";
import {
  BoundedExecutor,
  type ExecutorSnapshot,
  type ExecutorTaskOptions,
} from "../executor.ts";
import type { ServiceLimits } from "../limits.ts";
import { outcomeFromError } from "../outcome.ts";
import { transportError } from "./operation-runner.ts";
import type { RuntimeTraceBridge } from "../telemetry/trace-bridge.ts";

type ReadEngine = Pick<Engine, "reader" | "createReader" | "commitVersion">;
type ReadLimits = Pick<ServiceLimits, "revalidationConcurrency" | "readQueue">;
type ReadTracing = Pick<
  RuntimeTraceBridge,
  "currentScope" | "runScope" | "span" | "observeStatement"
>;

export interface RuntimeReadExecutorOptions {
  readonly engine: ReadEngine;
  readonly limits: ReadLimits;
  readonly now: () => number;
  readonly telemetryEnabled: boolean;
  readonly tracing: ReadTracing;
}

/** Owns the bounded reader pool and every snapshot transaction boundary. */
export class RuntimeReadExecutor {
  private readonly engine: ReadEngine;
  private readonly telemetryEnabled: boolean;
  private readonly tracing: ReadTracing;
  private readonly executor: BoundedExecutor;
  private readonly available: Database[];

  constructor(options: RuntimeReadExecutorOptions) {
    this.engine = options.engine;
    this.telemetryEnabled = options.telemetryEnabled;
    this.tracing = options.tracing;
    this.available = [options.engine.reader];
    this.executor = new BoundedExecutor({
      concurrency: options.limits.revalidationConcurrency,
      discipline: "round-robin",
      limits: options.limits.readQueue,
      resource: "reader",
      retryAfterMs: 0,
      now: options.now,
    });
  }

  execute<T>(
    operation: "query" | "subscription",
    fairnessKey: string,
    signal: AbortSignal | undefined,
    requestBytes: number,
    reads: ReadRecorder | null,
    work: (
      execution: Readonly<PluginReadExecution>,
      commitVersion: bigint,
    ) => T | Promise<T>,
  ): Promise<T> {
    return this.submit(async (connection) => {
      throwIfAborted(signal);
      let transactionOpen = false;
      const beginAt = this.telemetryEnabled ? performance.now() : 0;
      try {
        connection.exec("BEGIN DEFERRED");
        transactionOpen = true;
        if (this.telemetryEnabled) {
          this.tracing.span({
            stage: "storage",
            outcome: "ok",
            resource: "reader",
            durationMs: Math.max(0, performance.now() - beginAt),
          }, "query");
        }
        // A deferred reader pins its snapshot on this first SELECT.
        const commitVersion = this.engine.commitVersion(connection);
        const value = await work(Object.freeze({
          connection,
          reads,
          ...(this.telemetryEnabled
            ? { statementObserver: this.tracing.observeStatement }
            : {}),
        }), commitVersion);
        throwIfAborted(signal);
        const commitAt = this.telemetryEnabled ? performance.now() : 0;
        try {
          connection.exec("COMMIT");
          transactionOpen = false;
          if (this.telemetryEnabled) {
            this.tracing.span({
              stage: "commit",
              outcome: "ok",
              resource: "reader",
              durationMs: Math.max(0, performance.now() - commitAt),
            }, "query");
          }
        } catch (error) {
          if (this.telemetryEnabled) {
            this.tracing.span({
              stage: "commit",
              outcome: outcomeFromError(transportError(error)).code,
              resource: "reader",
              durationMs: Math.max(0, performance.now() - commitAt),
            }, "query");
          }
          throw error;
        }
        return value;
      } catch (error) {
        if (transactionOpen) {
          const rollbackAt = this.telemetryEnabled ? performance.now() : 0;
          try {
            connection.exec("ROLLBACK");
            if (this.telemetryEnabled) {
              this.tracing.span({
                stage: "rollback",
                outcome: "ok",
                resource: "reader",
                durationMs: Math.max(0, performance.now() - rollbackAt),
              }, "query");
            }
          } catch (rollbackError) {
            if (this.telemetryEnabled) {
              this.tracing.span({
                stage: "rollback",
                outcome: "unavailable",
                resource: "reader",
                durationMs: Math.max(0, performance.now() - rollbackAt),
              }, "query");
            }
            throw new AckerDBError(
              "unavailable",
              "reader snapshot could not be closed",
              { resource: "reader", cause: rollbackError },
            );
          }
        } else if (this.telemetryEnabled && beginAt > 0) {
          this.tracing.span({
            stage: "storage",
            outcome: outcomeFromError(transportError(error)).code,
            resource: "reader",
            durationMs: Math.max(0, performance.now() - beginAt),
          }, "query");
        }
        throw error;
      }
    }, {
      operation,
      bytes: requestBytes,
      fairnessKey,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  submit<T>(
    work: (connection: Database) => T | Promise<T>,
    options: ExecutorTaskOptions,
    observed = this.telemetryEnabled,
  ): Promise<T> {
    const run = async () => {
      const connection = this.available.pop() ?? this.engine.createReader();
      try {
        return await work(connection);
      } finally {
        this.available.push(connection);
      }
    };
    const restore = AsyncLocalStorage.snapshot();
    if (!observed) return this.executor.submit(() => restore(run), options);
    const scope = this.tracing.currentScope();
    const queuedAt = performance.now();
    let started = false;
    return this.executor.submit(() => restore(() => {
      started = true;
      const admitted = () => {
        this.tracing.span({
          operation: options.operation,
          stage: "queue",
          outcome: "ok",
          resource: "reader",
          durationMs: Math.max(0, performance.now() - queuedAt),
          sizeBytes: options.bytes,
        }, options.operation);
        return run();
      };
      return scope === undefined
        ? admitted()
        : this.tracing.runScope(scope, admitted);
    }), options).catch((error) => {
      if (!started) {
        const rejected = () => this.tracing.span({
          operation: options.operation,
          stage: "queue",
          outcome: outcomeFromError(transportError(error)).code,
          resource: "reader",
          durationMs: Math.max(0, performance.now() - queuedAt),
          sizeBytes: options.bytes,
        }, options.operation);
        if (scope === undefined) rejected();
        else this.tracing.runScope(scope, rejected);
      }
      throw error;
    });
  }

  snapshot(): ExecutorSnapshot {
    return this.executor.snapshot();
  }

  close(): void {
    this.executor.close();
  }

  drain(): Promise<void> {
    return this.executor.drain();
  }
}
