import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import {
  isResult,
  uuidV7Timestamp,
  type SseAckRequest,
} from "@ackerdb/core";
import {
  type AnyRegistered,
  type AnyRegisteredSse,
  type SseCtx,
  type SseSource,
} from "../../app/functions.ts";
import {
  invokeFunction,
} from "../../app/invocation.ts";
import type { Registry } from "../../app/registry.ts";
import { ANONYMOUS_PRINCIPAL } from "../../auth/credentials.ts";
import type { AuthInvalidationPublisher } from "../../auth/invalidation.ts";
import { AckerDBError, throwIfAborted } from "../../shared/errors.ts";
import { OutboundBudget } from "../../subscriptions/delivery/budget.ts";
import {
  BoundedSseProducer,
  type SseDeliverySnapshot,
} from "../../subscriptions/delivery/sse.ts";
import type { ExposedHttpCodec } from "../../transport/http-codec.ts";
import { callerFairnessKey, transportSource } from "../caller.ts";
import type {
  RuntimeExternalRequest,
  RuntimeHttpMutationRequest,
  RuntimeHttpRequest,
  RuntimeHttpHandlerRequest,
  RuntimeSseRequest,
  RuntimeSseResponse,
} from "../contracts/requests.ts";
import { runInInvocationRoot } from "../invocation-state.ts";
import type { IdempotencyIdentity } from "../coordinator.ts";
import {
  restoreMutationResult,
  type RuntimeFunctionExecutor,
} from "../execution/functions.ts";
import {
  transportError,
  type RuntimeOperationRunner,
} from "../execution/operation-runner.ts";
import {
  RuntimeHttpResponses,
  type CommittedHttpMutation,
  type EncodedHttpBody,
} from "./response.ts";
import type { ServiceLimits } from "../limits.ts";
import type { RuntimeQueries } from "../queries/runtime.ts";
import { claimHttpRequestProvenance } from "../request-provenance.ts";
import type { RuntimeReactiveContext, RuntimeSession } from "../sessions/store.ts";
import { invokeSideEffectingHandler } from "../side-effecting-handler.ts";
import { validatedSseSource } from "../sse/source.ts";
import { digestOfWire } from "../../shared/digest.ts";
import { finiteMillis } from "../../shared/clock.ts";

const DIRECT_RUNTIME_SOURCE = transportSource({ family: "runtime", address: "local" });
const NO_OBLIGATIONS: readonly number[] = Object.freeze([]);

interface ClaimedHttpRequest {
  readonly requestBytes: number;
  readonly codec: ExposedHttpCodec;
  readonly fairnessKey: string;
  /**
   * The caller's own auth-invalidation channel, owned and released by the
   * listener. A direct in-process call has no response to protect, so it falls
   * back to the Runtime's immediate fan-out.
   */
  readonly invalidations: AuthInvalidationPublisher;
}

export interface RuntimeHttpOptions {
  readonly registry: Registry;
  readonly limits: ServiceLimits;
  readonly operations: RuntimeOperationRunner<RuntimeSession>;
  readonly functions: RuntimeFunctionExecutor<RuntimeReactiveContext>;
  readonly queries: RuntimeQueries;
  /** The origin-less publisher a call arriving without transport ownership uses. */
  readonly immediateInvalidations: AuthInvalidationPublisher;
  readonly admittedRequestBytes: (request: unknown, receivedBytes?: number) => number;
  readonly operationSignal: (signal?: AbortSignal) => AbortSignal;
  readonly admit: (fairnessKey: string) => { readonly release: () => void };
  readonly now: () => number;
}

/** Owns exposed HTTP calls and the full lifecycle of HTTP SSE streams. */
export class RuntimeHttp {
  readonly sseBudget: OutboundBudget;
  readonly sseProducers = new Map<string, BoundedSseProducer>();
  private readonly responses: RuntimeHttpResponses;

  constructor(private readonly options: RuntimeHttpOptions) {
    this.responses = new RuntimeHttpResponses(options.limits.maxFrameBytes);
    const controlReserve = Math.min(
      options.limits.maxFrameBytes,
      options.limits.sse.maxBytes - 1,
    );
    this.sseBudget = new OutboundBudget(options.limits.sse.maxBytes, controlReserve);
  }

  runQuery(request: RuntimeHttpRequest): Promise<Response> {
    const { requestBytes, codec, fairnessKey } = this.claim(request);
    return this.options.operations.run(null, requestBytes, () =>
      this.options.queries.execute(
        request.address,
        request.args,
        request.principal,
        fairnessKey,
        this.options.operationSignal(request.signal),
        requestBytes,
      ), {
      finalize: (outcome) => this.responses.respond(request, codec, "query", outcome),
      fairnessKey,
    });
  }

  runMutation(request: RuntimeHttpMutationRequest): Promise<Response> {
    const { requestBytes, codec, fairnessKey, invalidations } =
      this.claim(request);
    let committed: CommittedHttpMutation | undefined;
    return this.options.operations.run(null, requestBytes, async () => {
      const fn = this.expect(request.address, "mutation");
      const signal = this.options.operationSignal(request.signal);
      throwIfAborted(signal);
      let encoded: EncodedHttpBody | undefined;
      const result = await this.options.functions.commitMutation({
        fairnessKey,
        requestBytes,
        admissionSignal: signal,
        ...(request.idempotencyKey === undefined
          ? {}
          : { idempotency: this.idempotency(request, fairnessKey) }),
        fn,
        principal: request.principal,
        args: request.args,
        // A mutation that revokes the caller's own credential must not close
        // the door its own answer leaves through. The body is encoded inside
        // the transaction below, but that ordering is an implementation detail
        // and not a guarantee; the origin exclusion is the guarantee.
        publishAuthInvalidation: invalidations.publish,
        // The response body is the mutation's last fallible step. Validate and
        // bound it inside the transaction so an unshippable value never commits.
        validate: (value) => {
          if (!isResult(value)) {
            throw new AckerDBError("internal", "mutation boundary returned no Result");
          }
          encoded = this.responses.encodeBody(value.data, codec.encodeValue, "mutation", null);
        },
      });
      committed = Object.freeze({
        receipt: Object.freeze({
          commitVersion: result.commitVersion,
          durability: result.durability,
          replay: result.replay,
          obligations: NO_OBLIGATIONS,
        }),
        ...(encoded === undefined ? {} : { encoded }),
      });
      return restoreMutationResult(result.value);
    }, {
      finalize: (outcome) =>
        this.responses.respond(request, codec, "mutation", outcome, committed),
      fairnessKey,
    });
  }

  runProcedure(request: RuntimeHttpRequest): Promise<Response> {
    const { requestBytes, codec, fairnessKey, invalidations } =
      this.claim(request);
    return this.options.operations.run(null, requestBytes, async () => {
      const fn = this.expect(request.address, "procedure");
      const signal = this.options.operationSignal(request.signal);
      throwIfAborted(signal);
      const context = this.options.functions.createProcedureContext(
        request.principal,
        fairnessKey,
        signal,
        requestBytes,
        finiteMillis(this.options.now(), "runtime clock"),
        invalidations.publish,
      );
      return await invokeSideEffectingHandler(
        signal,
        "procedure",
        (onAuthorized) => invokeFunction(fn, context, request.args, { onAuthorized }),
      );
    }, {
      finalize: (outcome) => this.responses.respond(request, codec, "procedure", outcome),
      fairnessKey,
    });
  }

  /**
   * The HTTP entry point for a raw handler. No credential resolution, no args
   * decode, no codec: the buffered Request crosses whole and the handler's
   * Response leaves whole. A failure rejects with the transport error and the
   * listener answers it as the bare Outcome — the handler authored nothing, so
   * the framework speaks its own language.
   */
  runHttpHandler(input: RuntimeHttpHandlerRequest): Promise<Response> {
    const registered = this.options.registry.httpHandler(input.address);
    if (registered === undefined) {
      return Promise.reject(
        new AckerDBError("not_found", `unknown http handler "${input.address}"`),
      );
    }
    const requestBytes = Math.max(1, input.requestBytes ?? 1);
    const fairnessKey = input.fairnessKey
      ?? callerFairnessKey(ANONYMOUS_PRINCIPAL, DIRECT_RUNTIME_SOURCE);
    return this.options.operations.run(null, requestBytes, async () => {
      const signal = this.options.operationSignal(input.signal);
      throwIfAborted(signal);
      // The http surface has no auth members, so no account can ever unlink.
      const context = this.options.functions.createProcedureContext(
        ANONYMOUS_PRINCIPAL,
        fairnessKey,
        signal,
        requestBytes,
        finiteMillis(this.options.now(), "runtime clock"),
        () => {},
        "http",
      );
      return await invokeSideEffectingHandler(
        signal,
        "http handler",
        (onAuthorized) => runInInvocationRoot(ANONYMOUS_PRINCIPAL, async () => {
          onAuthorized();
          try {
            const response = await registered.handler(context, input.request);
            if (!(response instanceof Response)) {
              throw new Error("http handler returned a non-Response value");
            }
            return response;
          } catch (cause) {
            // Every uncaught throw — an AckerDBError, a validation error,
            // anything — crosses as the one sanitized `internal` outcome:
            // the handler authors its failures as Responses, so a thrown
            // message is never the handler speaking to the caller. The
            let described: string;
            try {
              described = cause instanceof Error
                ? cause.stack ?? cause.message
                : String(cause);
            } catch {
              described = "<unreadable handler error>";
            }
            console.log(`http handler "${input.address}" failed`, {
              error: described,
            });
            // Rethrowing a plain Error keeps the abort conversion above intact.
            throw new Error(`http handler "${input.address}" failed`);
          }
        }),
      );
    }, {
      fairnessKey,
    });
  }

  async runSse(request: RuntimeSseRequest): Promise<RuntimeSseResponse> {
    const { requestBytes, codec, fairnessKey, invalidations } =
      this.claim(request);
    let release: () => void;
    try {
      release = this.options.admit(fairnessKey).release;
    } catch (error) {
      throw transportError(error);
    }
    const execute = async (): Promise<RuntimeSseResponse> => {
      let producer: BoundedSseProducer | null = null;
      let streamId: string | null = null;
      let lifecycle: Promise<void> | null = null;
      try {
        const fn = this.expect(request.address, "sse") as AnyRegisteredSse;
        if (fn.yields === undefined) {
          throw new AckerDBError("internal", `sse "${request.address}" has no yields validator`);
        }
        const signal = this.options.operationSignal(request.signal);
        throwIfAborted(signal);
        producer = new BoundedSseProducer({
          budget: this.sseBudget,
          limits: this.options.limits,
          signal,
        });
        streamId = this.register(producer);
        void producer.finished.then(() => this.remove(streamId!, producer!));
        const authorized = Promise.withResolvers<void>();
        let handlerContext: <T>(work: () => T) => T = (work) => work();
        const procedure = this.options.functions.createProcedureContext(
          request.principal,
          fairnessKey,
          producer.signal,
          requestBytes,
          finiteMillis(this.options.now(), "runtime clock"),
          invalidations.publish,
        );
        const handler = invokeFunction(fn, procedure as SseCtx, request.args, {
          onAuthorized: () => {
            handlerContext = AsyncLocalStorage.snapshot();
            authorized.resolve();
          },
        });
        const completion = handler.then(async (result: SseSource<unknown>) => {
          const source = validatedSseSource(codec, result, handlerContext);
          try {
            await producer!.merge(source);
          } catch (error) {
            void source.cancel(error).catch(() => {});
            throw error;
          }
          return producer!.complete();
        }).catch(async (error) => {
          producer!.fail(error);
          try {
            await producer!.complete();
          } catch {
            // Preserve the handler failure after terminal ACK/cancel owns cleanup.
          }
          throw error;
        });
        lifecycle = completion.finally(release);
        void lifecycle.catch(() => {});
        await Promise.race([
          authorized.promise,
          handler.then(
            () => undefined,
            (error) => { throw error; },
          ),
        ]);
        return Object.freeze({ stream: producer.stream, streamId });
      } catch (error) {
        if (producer !== null) {
          try {
            await producer.stream.cancel(error);
          } catch {
            // No stream escaped this boundary; cancellation is capacity cleanup.
          }
        }
        if (lifecycle !== null) await lifecycle.catch(() => {});
        else release();
        throw transportError(error);
      }
    };
    return execute();
  }

  ackSse(request: SseAckRequest): boolean {
    return this.sseProducers.get(request.stream)?.ack(request.seq, request.proof) ?? false;
  }

  sseSnapshot(streamId: string): SseDeliverySnapshot | null {
    return this.sseProducers.get(streamId)?.snapshot() ?? null;
  }

  private claim(request: RuntimeExternalRequest): ClaimedHttpRequest {
    const provenance = claimHttpRequestProvenance(request);
    return {
      requestBytes: this.options.admittedRequestBytes(
        { ref: request.address, args: request.args },
        provenance?.bytes,
      ),
      codec: this.codec(request.address),
      fairnessKey: request.fairnessKey
        ?? callerFairnessKey(request.principal, DIRECT_RUNTIME_SOURCE),
      invalidations: provenance?.invalidations ?? this.options.immediateInvalidations,
    };
  }

  private idempotency(
    request: RuntimeHttpMutationRequest,
    fairnessKey: string,
  ): IdempotencyIdentity {
    const requestId = request.idempotencyKey!;
    let issuedAt: number;
    try {
      issuedAt = uuidV7Timestamp(requestId);
    } catch (cause) {
      throw new AckerDBError("validation", "Idempotency-Key must be a UUIDv7", {
        cause,
        resource: "idempotency",
      });
    }
    return {
      sessionId: fairnessKey,
      requestId,
      issuedAt,
      principalFingerprint: fairnessKey,
      functionRef: request.address,
      argsFingerprint: digestOfWire(request.args),
    };
  }

  private codec(address: string): ExposedHttpCodec {
    const exposed = this.options.registry.exposedFunction(address);
    if (exposed === undefined) {
      throw new AckerDBError("not_found", `"${address}" is not exposed over HTTP`);
    }
    return exposed.codec;
  }

  private expect(
    address: string,
    kind: "mutation" | "procedure" | "sse",
  ): AnyRegistered {
    const fn = this.options.registry.get(address);
    if (fn === undefined) throw new AckerDBError("not_found", `unknown function "${address}"`);
    if (fn.kind !== kind) {
      throw new AckerDBError("validation", `"${address}" is a ${fn.kind}, expected a ${kind}`);
    }
    return fn;
  }

  private register(producer: BoundedSseProducer): string {
    let streamId: string;
    do streamId = randomBytes(16).toString("base64url");
    while (this.sseProducers.has(streamId));
    this.sseProducers.set(streamId, producer);
    return streamId;
  }

  private remove(streamId: string, producer: BoundedSseProducer): void {
    if (this.sseProducers.get(streamId) === producer) this.sseProducers.delete(streamId);
  }

}
