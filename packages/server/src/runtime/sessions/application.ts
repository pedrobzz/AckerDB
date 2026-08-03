import { createHash } from "node:crypto";
import {
  PROTOCOL_VERSION,
  isApplicationError,
  isResult,
  stableEncode,
  type ApplicationErrorMessage,
  type ChannelJoinMessage,
  type ChannelLeaveMessage,
  type ChannelSendMessage,
  type MutationMessage,
  type MutationOkMessage,
  type Outcome,
  type ProcedureMessage,
  type ProcedureOkMessage,
  type QueryMessage,
  type QueryOkMessage,
  type ResetRequestMessage,
  type SubscribeMessage,
  type UnsubscribeMessage,
} from "@ackerdb/core";
import { invokeFunction } from "../../app/invocation.ts";
import type { Registry } from "../../app/registry.ts";
import type { AuthInvalidationBoundary } from "../../auth/invalidation.ts";
import type { Engine } from "../../database/engine.ts";
import { AckerDBError, throwIfAborted } from "../../shared/errors.ts";
import type {
  RuntimeMutationResult,
  RuntimePublication,
  RuntimeRequest,
  SessionRuntimeContext,
} from "../../subscriptions/session/contract.ts";
import type {
  ReactiveCommit,
  Subscriber,
} from "../../subscriptions/reactive/contract.ts";
import type { OrderedReactive } from "../../subscriptions/reactive/ordered.ts";
import { invokeSideEffectingHandler } from "../side-effecting-handler.ts";
import type { CommitResult } from "../coordinator.ts";
import {
  restoreMutationResult,
  type RuntimeFunctionExecutor,
} from "../execution/functions.ts";
import type { RuntimeQueries } from "../queries/runtime.ts";
import type { RuntimeReactiveContext, RuntimeSession } from "./store.ts";
import { RuntimeSessionStore } from "./store.ts";

interface FinishedRuntimeMutation {
  readonly result: RuntimeMutationResult;
  readonly publication: RuntimePublication;
}

export interface RuntimeSessionApplicationOptions {
  readonly engine: Pick<Engine, "durability">;
  readonly registry: Pick<Registry, "get">;
  readonly store: RuntimeSessionStore;
  readonly functions: RuntimeFunctionExecutor<RuntimeReactiveContext>;
  readonly queries: RuntimeQueries;
  readonly reactive: OrderedReactive<RuntimeReactiveContext>;
  readonly authInvalidation: AuthInvalidationBoundary;
  readonly operationSignal: (signal?: AbortSignal) => AbortSignal;
  readonly now: () => number;
}

/** Owns the client-session protocol operations layered over RuntimeSessionStore. */
export class RuntimeSessionApplication {
  constructor(private readonly options: RuntimeSessionApplicationOptions) {}

  subscribe(
    context: SessionRuntimeContext,
    request: RuntimeRequest<SubscribeMessage>,
  ): Promise<void> {
    const { message } = request;
    return this.options.store.run(context, request, "subscription", message.ref, (state) =>
      this.options.store.subscribe(
        state,
        message.id,
        message.ref,
        message.args,
        message.cursor === undefined ? undefined : Object.freeze({ ...message.cursor }),
      ), {
      identifiers: { requestId: String(message.id), subscriptionId: String(message.id) },
    });
  }

  unsubscribe(
    context: SessionRuntimeContext,
    request: RuntimeRequest<UnsubscribeMessage>,
  ): Promise<void> {
    const { message } = request;
    return this.options.store.run(context, request, "subscription", undefined, (state) =>
      this.options.store.unsubscribe(state, message.id), {
      identifiers: { requestId: String(message.id), subscriptionId: String(message.id) },
    });
  }

  reset(
    context: SessionRuntimeContext,
    request: RuntimeRequest<ResetRequestMessage>,
  ): Promise<void> {
    const { message } = request;
    return this.options.store.run(context, request, "subscription", undefined, (state) =>
      this.options.store.reset(state, message.id, message.cursor), {
      identifiers: { requestId: String(message.id), subscriptionId: String(message.id) },
    });
  }

  async joinChannel(
    context: SessionRuntimeContext,
    request: RuntimeRequest<ChannelJoinMessage>,
  ): Promise<void> {
    const { message } = request;
    await this.options.store.run(
      context,
      request,
      "subscription",
      message.ref,
      (state, requestBytes) => this.options.store.joinChannel(
        state,
        message.id,
        message.ref,
        message.args,
        Object.hasOwn(message, "room"),
        message.room,
        requestBytes,
      ),
      {
        identifiers: { requestId: String(message.id), subscriptionId: String(message.id) },
        successPublication: (publication) => publication,
      },
    );
  }

  async leaveChannel(
    context: SessionRuntimeContext,
    request: RuntimeRequest<ChannelLeaveMessage>,
  ): Promise<void> {
    const { message } = request;
    await this.options.store.run(
      context,
      request,
      "subscription",
      undefined,
      (state, requestBytes) => this.options.store.leaveChannel(state, message.id, requestBytes),
      { identifiers: { requestId: String(message.id), subscriptionId: String(message.id) } },
    );
  }

  sendChannel(
    context: SessionRuntimeContext,
    request: RuntimeRequest<ChannelSendMessage>,
  ): Promise<void> {
    const { message } = request;
    return this.options.store.run(
      context,
      request,
      "subscription",
      undefined,
      (state, requestBytes) => this.options.store.sendChannel(
        state,
        message.id,
        message.event,
        message.payload,
        requestBytes,
      ),
      { identifiers: { requestId: String(message.id), subscriptionId: String(message.id) } },
    );
  }

  query(
    context: SessionRuntimeContext,
    request: RuntimeRequest<QueryMessage>,
  ): Promise<unknown> {
    const { message } = request;
    let publication: RuntimePublication | undefined;
    return this.options.store.run(context, request, "query", message.ref, async (_state, requestBytes) => {
      const result = await this.options.queries.execute(
        message.ref,
        message.args,
        context.principal,
        context.fairnessKey,
        this.options.operationSignal(context.signal),
        requestBytes,
      );
      if (!isResult(result)) throw new AckerDBError("internal", "query boundary returned no Result");
      publication = this.options.store.prepare(
        result.ok
          ? {
              v: PROTOCOL_VERSION,
              t: "ok",
              id: message.id,
              kind: "query",
              value: result.data,
            } satisfies QueryOkMessage
          : {
              v: PROTOCOL_VERSION,
              t: "app_err",
              id: message.id,
              kind: "query",
              error: applicationError(result.error),
            } satisfies ApplicationErrorMessage,
        "query result",
      );
      return result.ok ? result.data : result;
    }, {
      identifiers: { requestId: String(message.id) },
      successPublication: () => requiredPublication(publication, "query"),
    });
  }

  async procedure(
    context: SessionRuntimeContext,
    request: RuntimeRequest<ProcedureMessage>,
  ): Promise<unknown> {
    const { message } = request;
    let publication: RuntimePublication | undefined;
    const invalidations = this.options.authInvalidation.publisher(
      context.principal,
      context.invalidationScope,
    );
    try {
      return await this.options.store.run(
        context,
        request,
        "procedure",
        message.ref,
        async (_state, requestBytes) => {
          const fn = this.expect(message.ref, "procedure");
          const signal = this.options.operationSignal(request.signal ?? context.signal);
          throwIfAborted(signal);
          const procedure = this.options.functions.createProcedureContext(
            context.principal,
            context.fairnessKey,
            signal,
            requestBytes,
            this.readNow(),
            invalidations.publish,
          );
          try {
            const result = await invokeSideEffectingHandler(
              signal,
              "procedure",
              (onAuthorized) => invokeFunction(fn, procedure.value, message.args, { onAuthorized }),
            );
            if (!isResult(result)) {
              throw new AckerDBError("internal", "procedure boundary returned no Result");
            }
            publication = this.options.store.prepare(
              result.ok
                ? {
                    v: PROTOCOL_VERSION,
                    t: "ok",
                    id: message.id,
                    kind: "procedure",
                    value: result.data,
                  } satisfies ProcedureOkMessage
                : {
                    v: PROTOCOL_VERSION,
                    t: "app_err",
                    id: message.id,
                    kind: "procedure",
                    error: applicationError(result.error),
                  } satisfies ApplicationErrorMessage,
              "procedure result",
            );
            return result.ok ? result.data : result;
          } finally {
            procedure.release();
          }
        },
        {
          identifiers: { requestId: String(message.id) },
          successPublication: () => requiredPublication(publication, "procedure"),
        },
      );
    } finally {
      invalidations.finish();
    }
  }

  mutation(
    context: SessionRuntimeContext,
    request: RuntimeRequest<MutationMessage>,
  ): Promise<RuntimeMutationResult> {
    const { message } = request;
    let successPublication: RuntimePublication | undefined;
    return this.options.store.run(context, request, "mutation", message.ref, async (state, requestBytes) => {
      const fn = this.expect(message.ref, "mutation");
      const signal = this.options.operationSignal(context.signal);
      let executedPublication: RuntimePublication | undefined;
      const result = await this.options.functions.commitMutation({
        fairnessKey: context.fairnessKey,
        requestBytes,
        admissionSignal: signal,
        subscriber: state.subscriber,
        idempotency: {
          sessionId: context.clientSessionId,
          requestId: message.mutationRequestId,
          issuedAt: message.issuedAt,
          principalFingerprint: digest(context.principal),
          functionRef: message.ref,
          argsFingerprint: digest(message.args),
        },
        fn,
        principal: context.principal,
        args: message.args,
        validate: (value, version, _writes, publication) => {
          executedPublication = this.options.store.prepare(
            this.mutationFrame(
              message,
              value,
              version,
              this.options.engine.durability,
              "executed",
              publication.affectedCallerIds,
            ),
            "mutation result",
          );
        },
      });
      const finished = await this.finishMutation(state, message, result, executedPublication);
      successPublication = finished.publication;
      return finished.result;
    }, {
      identifiers: { requestId: String(message.id), mutationId: message.mutationRequestId },
      synthesizeHandler: false,
      successPublication: () => requiredPublication(successPublication, "mutation"),
    });
  }

  close(context: SessionRuntimeContext, _outcome: Outcome): Promise<void> {
    return this.options.store.close(context);
  }

  private async finishMutation(
    state: RuntimeSession,
    message: MutationMessage,
    result: CommitResult<unknown, ReactiveCommit>,
    executedPublication?: RuntimePublication,
  ): Promise<FinishedRuntimeMutation> {
    const value = restoreMutationResult(result.value);
    let obligations: readonly number[];
    if (!value.ok && result.publication === undefined) {
      obligations = [];
    } else if (result.replay === "replayed") {
      const convergence = await this.options.reactive.converge(state.subscriber, result.commitVersion);
      obligations = convergence.affectedCallerIds;
      this.assertConvergence(state.subscriber, obligations, convergence.deliveryFailures);
    } else {
      const convergence = result.publication?.result;
      if (convergence === undefined) {
        throw convergenceError("commit publication did not produce convergence state");
      }
      obligations = convergence.affectedCallerIds;
      this.assertConvergence(state.subscriber, obligations, convergence.deliveryFailures);
    }
    let publication = executedPublication;
    if (!value.ok && result.publication === undefined) {
      publication = this.options.store.prepare(this.mutationFrame(
        message,
        value,
        result.commitVersion,
        result.durability,
        result.replay,
        obligations,
      ), "mutation result");
    } else if (result.replay === "replayed") {
      try {
        publication = this.options.store.prepare(this.mutationFrame(
          message,
          value,
          result.commitVersion,
          result.durability,
          result.replay,
          obligations,
        ), "mutation result");
      } catch {
        throw convergenceError(
          `mutation ${message.mutationRequestId} committed but its receipt cannot fit one frame`,
        );
      }
    }
    if (
      publication === undefined ||
      (publication.message.t !== "ok" && publication.message.t !== "app_err") ||
      publication.message.kind !== "mutation"
    ) {
      throw convergenceError("committed mutation publication was not prepared");
    }
    return Object.freeze({
      result: Object.freeze({
        value: value.ok ? value.data : value,
        receipt: publication.message.receipt!,
      }),
      publication,
    });
  }

  private mutationFrame(
    message: MutationMessage,
    value: unknown,
    commitVersion: bigint,
    durability: CommitResult<unknown, ReactiveCommit>["durability"],
    replay: "executed" | "replayed",
    obligations: readonly number[],
  ): MutationOkMessage | ApplicationErrorMessage {
    if (!isResult(value)) throw new AckerDBError("internal", "mutation boundary returned no Result");
    const receipt = {
      mutationRequestId: message.mutationRequestId,
      commitVersion,
      durability,
      replay,
      obligations: Object.freeze([...obligations]),
    };
    return value.ok
      ? {
          v: PROTOCOL_VERSION,
          t: "ok",
          id: message.id,
          kind: "mutation",
          value: value.data,
          receipt,
        }
      : {
          v: PROTOCOL_VERSION,
          t: "app_err",
          id: message.id,
          kind: "mutation",
          error: applicationError(value.error),
          receipt,
        };
  }

  private assertConvergence(
    caller: Subscriber,
    obligations: readonly number[],
    failures: readonly { subscriber: Subscriber; subscriptionId: number; error: unknown }[],
  ): void {
    const required = new Set(obligations);
    const failure = failures.find(
      (candidate) => candidate.subscriber === caller && required.has(candidate.subscriptionId),
    );
    if (failure !== undefined) {
      throw new AckerDBError(
        "convergence_unavailable",
        "mutation committed but subscription convergence failed",
        { committed: true, cause: failure.error },
      );
    }
  }

  private expect(address: string, kind: "mutation" | "procedure") {
    const fn = this.options.registry.get(address);
    if (fn === undefined) throw new AckerDBError("not_found", `unknown function "${address}"`);
    if (fn.kind !== kind) {
      throw new AckerDBError("validation", `"${address}" is a ${fn.kind}, expected a ${kind}`);
    }
    return fn;
  }

  private readNow(): number {
    const now = this.options.now();
    if (!Number.isFinite(now)) throw new RangeError("runtime clock must return finite milliseconds");
    return now;
  }
}

function applicationError(value: unknown) {
  if (!isApplicationError(value)) {
    throw new AckerDBError("internal", "registered Err contains no application error");
  }
  return value;
}

function requiredPublication(
  publication: RuntimePublication | undefined,
  operation: "query" | "procedure" | "mutation",
): RuntimePublication {
  if (publication === undefined) throw new Error(`${operation} publication was not prepared`);
  return publication;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableEncode(value)).digest("base64url");
}

function convergenceError(message: string): AckerDBError {
  return new AckerDBError("convergence_unavailable", message, { committed: true });
}
