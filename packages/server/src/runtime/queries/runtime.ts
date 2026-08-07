import {
  encode,
  isApplicationError,
  isResult,
} from "@ackerdb/core";
import type { Principal } from "../../auth/credentials.ts";
import type { Registry } from "../../app/registry.ts";
import type { ReadRecorder } from "../../database/access.ts";
import { AckerDBError } from "../../shared/errors.ts";
import type {
  QueryEvaluation,
  QueryEvaluationInput,
} from "../../subscriptions/reactive/contract.ts";
import {
  FINISH_OPERATION_TRACE,
  type Telemetry,
} from "../../telemetry/telemetry.ts";
import type { RuntimeReactiveContext } from "../sessions/store.ts";
import type { RuntimeFunctionExecutor } from "../execution/functions.ts";
import { transportError } from "../execution/operation-runner.ts";
import type { RuntimeReadExecutor } from "../execution/read.ts";
import { outcomeFromError } from "../outcome.ts";
import type { RuntimeTraceBridge } from "../telemetry/trace-bridge.ts";

interface QueryExecution {
  readonly value: unknown;
  readonly readSet: ReadonlySet<string>;
  readonly commitVersion: bigint;
}

export interface RuntimeQueriesOptions {
  readonly registry: Pick<Registry, "get" | "remote">;
  readonly reads: RuntimeReadExecutor;
  readonly functions: RuntimeFunctionExecutor<RuntimeReactiveContext>;
  readonly shutdownSignal: () => AbortSignal;
  readonly telemetry: Telemetry;
  readonly tracing: RuntimeTraceBridge;
}

/** Owns transport-independent query execution and reactive query evaluation. */
export class RuntimeQueries {
  constructor(private readonly options: RuntimeQueriesOptions) {}

  execute(
    address: string,
    args: unknown,
    principal: Principal,
    fairnessKey: string,
    signal: AbortSignal | undefined,
    requestBytes: number,
  ): Promise<unknown> {
    const fn = this.expect(address);
    return this.options.reads.execute(
      "query",
      fairnessKey,
      signal,
      requestBytes,
      null,
      (execution) => this.options.functions.invokeQuery(fn, args, principal, execution),
    );
  }

  evaluate(input: QueryEvaluationInput<RuntimeReactiveContext>): Promise<QueryEvaluation> {
    const execute = () => {
      const fn = this.expect(input.address);
      const readSet = new Set<string>();
      const reads: ReadRecorder = { add: (key) => readSet.add(key) };
      return this.options.reads.execute(
        "subscription",
        input.fairnessKey,
        this.options.shutdownSignal(),
        byteLength(input.args),
        reads,
        async (execution, commitVersion) => {
          const value = await this.options.functions.invokeQuery(
            fn,
            input.args,
            input.context.principal,
            execution,
          );
          return Object.freeze({ value, readSet, commitVersion });
        },
      ).then((execution) => this.encode(execution));
    };
    const scope = this.options.tracing.currentScope();
    if (scope === undefined) {
      const evaluationScope = this.options.tracing.open(
        undefined,
        "subscription",
        input.address,
        {},
      );
      const evaluation = this.options.tracing.runOperation(evaluationScope, execute);
      return evaluation.finally(() => {
        this.options.telemetry[FINISH_OPERATION_TRACE](evaluationScope.trace);
      });
    }
    return this.options.tracing.runScope({
      ...scope,
      operation: "subscription",
      rootFunction: input.address,
    }, execute);
  }

  private encode(execution: QueryExecution): QueryEvaluation {
    const startedAt = this.options.telemetry.enabled ? performance.now() : 0;
    try {
      if (!isResult(execution.value)) {
        throw new AckerDBError("internal", "subscription query boundary returned no Result");
      }
      const wireValue = execution.value.ok
        ? execution.value.data
        : execution.value.error;
      const encoded = encode(wireValue);
      if (this.options.telemetry.enabled) {
        this.options.tracing.span({
          stage: "encoding",
          outcome: "ok",
          resource: "operation",
          durationMs: Math.max(0, performance.now() - startedAt),
          sizeBytes: Buffer.byteLength(encoded),
          resultCount: Array.isArray(wireValue)
            ? wireValue.length
            : wireValue === null
              ? 0
              : 1,
        }, "subscription");
      }
      return Object.freeze({
        ...execution,
        value: execution.value.ok ? execution.value.data : undefined,
        ...(execution.value.ok
          ? {}
          : { applicationError: applicationError(execution.value.error) }),
        encoded,
      });
    } catch (error) {
      if (this.options.telemetry.enabled) {
        this.options.tracing.span({
          stage: "encoding",
          outcome: outcomeFromError(transportError(error)).code,
          resource: "operation",
          durationMs: Math.max(0, performance.now() - startedAt),
        }, "subscription");
      }
      throw error;
    }
  }

  private expect(address: string) {
    const fn = this.options.registry.remote(address);
    if (fn === undefined) throw new AckerDBError("not_found", `unknown function "${address}"`);
    if (fn.kind !== "query") {
      throw new AckerDBError("validation", `"${address}" is a ${fn.kind}, expected a query`);
    }
    return fn;
  }
}

function applicationError(value: unknown) {
  if (!isApplicationError(value)) {
    throw new AckerDBError("internal", "registered Err contains no application error");
  }
  return value;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(encode(value));
}
