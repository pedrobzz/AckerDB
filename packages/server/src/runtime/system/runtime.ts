import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthInvalidationPublisher } from "../../auth/invalidation.ts";
import { SYSTEM_PRINCIPAL } from "../../auth/credentials.ts";
import {
  isSystemOperationName,
  type SystemCtx,
  type SystemRunOptions,
} from "../../app/system.ts";
import { throwIfAborted } from "../../shared/errors.ts";
import { callerFairnessKey, transportSource } from "../caller.ts";
import type { RuntimeFunctionExecutor } from "../execution/functions.ts";
import type { RuntimeOperationRunner } from "../execution/operation-runner.ts";
import { runInInvocationRoot } from "../invocation-state.ts";
import type { RuntimeReactiveContext, RuntimeSession } from "../sessions/store.ts";
import { invokeSideEffectingHandler } from "../side-effecting-handler.ts";
import { inTransaction } from "../transaction-context.ts";

const SYSTEM_FAIRNESS_KEY = callerFairnessKey(
  SYSTEM_PRINCIPAL,
  transportSource({ family: "runtime", address: "local" }),
);

export interface RuntimeSystemOptions {
  readonly functions: RuntimeFunctionExecutor<RuntimeReactiveContext>;
  readonly operations: RuntimeOperationRunner<RuntimeSession>;
  readonly invalidations: AuthInvalidationPublisher;
  readonly signal: (signal?: AbortSignal) => AbortSignal;
  readonly now: () => number;
}

/** Owns named internal operations and their isolated invocation root. */
export class RuntimeSystem {
  private readonly root = AsyncLocalStorage.snapshot();

  constructor(private readonly options: RuntimeSystemOptions) {}

  run<R>(
    name: string,
    work: (ctx: SystemCtx) => R | PromiseLike<R>,
    runOptions?: SystemRunOptions,
  ): Promise<Awaited<R>> {
    if (!isSystemOperationName(name)) {
      return Promise.reject(new TypeError(
        "system operation name must contain at most 128 letters, digits, dots, colons, hyphens, or underscores, with every segment starting with a letter and no UUID segments",
      ));
    }
    const signal = this.options.signal(runOptions?.signal);
    const writerOwnedByCaller = inTransaction();
    try {
      throwIfAborted(signal);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.root(() => this.options.operations.run(
      null,
      1,
      async () => {
        const context = this.options.functions.createProcedureContext(
          SYSTEM_PRINCIPAL,
          SYSTEM_FAIRNESS_KEY,
          signal,
          1,
          readNow(this.options.now),
          this.options.invalidations.publish,
        );
        return await invokeSideEffectingHandler(
          signal,
          "system callback",
          (onAuthorized) => runInInvocationRoot(
            SYSTEM_PRINCIPAL,
            () => {
              onAuthorized();
              return work(context as SystemCtx);
            },
            writerOwnedByCaller,
          ),
        );
      },
      { fairnessKey: SYSTEM_FAIRNESS_KEY },
    ));
  }
}

function readNow(now: () => number): number {
  const value = now();
  if (!Number.isFinite(value)) throw new RangeError("runtime clock must return finite milliseconds");
  return value;
}
