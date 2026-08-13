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

type ReadEngine = Pick<Engine, "reader" | "createReader" | "commitVersion">;
type ReadLimits = Pick<ServiceLimits, "revalidationConcurrency" | "readQueue">;

export interface RuntimeReadExecutorOptions {
  readonly engine: ReadEngine;
  readonly limits: ReadLimits;
  readonly now: () => number;
}

/** Owns the bounded reader pool and every snapshot transaction boundary. */
export class RuntimeReadExecutor {
  private readonly engine: ReadEngine;
  private readonly executor: BoundedExecutor;
  private readonly available: Database[];

  constructor(options: RuntimeReadExecutorOptions) {
    this.engine = options.engine;
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
      try {
        connection.exec("BEGIN DEFERRED");
        transactionOpen = true;
        const commitVersion = this.engine.commitVersion(connection);
        const value = await work(Object.freeze({ connection, reads }), commitVersion);
        throwIfAborted(signal);
        connection.exec("COMMIT");
        transactionOpen = false;
        return value;
      } catch (error) {
        if (transactionOpen) {
          try {
            connection.exec("ROLLBACK");
          } catch (rollbackError) {
            throw new AckerDBError(
              "unavailable",
              "reader snapshot could not be closed",
              { resource: "reader", cause: rollbackError },
            );
          }
        }
        throw error;
      }
    }, {
      bytes: requestBytes,
      fairnessKey,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  submit<T>(
    work: (connection: Database) => T | Promise<T>,
    options: ExecutorTaskOptions,
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
    return this.executor.submit(() => restore(run), options);
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
