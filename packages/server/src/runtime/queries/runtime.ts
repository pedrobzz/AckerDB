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
import type { RuntimeReactiveContext } from "../sessions/store.ts";
import type { RuntimeFunctionExecutor } from "../execution/functions.ts";
import type { RuntimeReadExecutor } from "../execution/read.ts";

interface QueryExecution {
  readonly value: unknown;
  readonly readSet: ReadonlySet<string>;
  readonly commitVersion: bigint;
}

export interface RuntimeQueriesOptions {
  readonly registry: Pick<Registry, "get">;
  readonly reads: RuntimeReadExecutor;
  readonly functions: RuntimeFunctionExecutor<RuntimeReactiveContext>;
  readonly shutdownSignal: () => AbortSignal;
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
    return execute();
  }

  private encode(execution: QueryExecution): QueryEvaluation {
    if (!isResult(execution.value)) {
      throw new AckerDBError("internal", "subscription query boundary returned no Result");
    }
    const wireValue = execution.value.ok
      ? execution.value.data
      : execution.value.error;
    return Object.freeze({
      ...execution,
      value: execution.value.ok ? execution.value.data : undefined,
      ...(execution.value.ok
        ? {}
        : { applicationError: applicationError(execution.value.error) }),
      encoded: encode(wireValue),
    });
  }

  private expect(address: string) {
    const fn = this.options.registry.get(address);
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
