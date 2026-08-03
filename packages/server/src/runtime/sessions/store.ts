import { createHash } from "node:crypto";
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  stableEncode,
  type ChannelEventMessage,
  type ChannelReadyMessage,
  type ChannelRejectedMessage,
  type ErrorMessage,
  type EventMessage,
  type LiveEvent,
  type Outcome,
  type SubscribeMessage,
  type SubscriptionTransition,
  type TransitionMessage,
} from "@ackerdb/core";
import type { Principal } from "../../auth/credentials.ts";
import { authorizeInvocation } from "../../app/invocation.ts";
import type { Registry } from "../../app/registry.ts";
import type { OwnedProcedureContext } from "../../app/functions.ts";
import { ChannelHub, type ChannelSessionAdapter } from "../../channels/hub.ts";
import type { Engine } from "../../database/engine.ts";
import { AckerDBError, throwIfAborted } from "../../shared/errors.ts";
import {
  OutboundBudget,
  type OutboundReservation,
} from "../../subscriptions/delivery/budget.ts";
import {
  OrderedReactive,
  type Subscriber,
} from "../../subscriptions/reactive.ts";
import {
  prepareRuntimePublication,
  claimRuntimeRequestBytes,
  type RuntimeAuthTransition,
  type RuntimePublication,
  type RuntimePublicationBatch,
  type RuntimeRequest,
  type SessionApplicationMessage,
  type SessionRuntimeContext,
} from "../../subscriptions/session.ts";
import type { TelemetryOperation } from "../../telemetry/telemetry.ts";
import type { Telemetry } from "../../telemetry/telemetry.ts";
import type { ServiceLimits } from "../limits.ts";
import { outcomeFromError } from "../outcome.ts";
import {
  RuntimeOperationRunner,
  transportError,
  type OperationAdmission,
  type RuntimeOperationOutcome,
  type SessionOperationOrder,
} from "../execution/operation-runner.ts";
import type { RuntimeTraceIdentifiers } from "../telemetry/trace-bridge.ts";
import type { RuntimeTraceBridge } from "../telemetry/trace-bridge.ts";

export interface AuthTransitionCapture {
  phase: "revoking" | "reattaching";
  authEpoch: number;
  readonly frames: RuntimePublication[];
  readonly reservations: OutboundReservation[];
  bytes: number;
  active: boolean;
}

interface SessionCloseDrain {
  readonly promise: Promise<void>;
  resolve(): void;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

export interface RuntimeReactiveContext {
  readonly principal: Principal;
}

export interface RuntimeSession {
  context: SessionRuntimeContext;
  readonly contexts: WeakSet<SessionRuntimeContext>;
  subscriber: Subscriber;
  readonly channelAdapter: ChannelSessionAdapter;
  readonly subscriptionKinds: Map<number, "reactive" | "channel">;
  readonly telemetryConnectionId?: string;
  readonly subscriptionControlTails: Map<number, Promise<void>>;
  subscriptionControlFrontier: Promise<void>;
  pendingSubscriptionControls: number;
  capture: AuthTransitionCapture | null;
  phase: "open" | "closing" | "removed";
  closeDrain: SessionCloseDrain | null;
  activeOperations: number;
}

export interface RuntimeSessionOperationOptions<T> {
  readonly identifiers?: RuntimeTraceIdentifiers;
  readonly synthesizeHandler?: boolean;
  readonly successPublication?: (value: T) => RuntimePublication;
}

type SessionOperation = Extract<
  TelemetryOperation,
  "query" | "mutation" | "procedure" | "subscription"
>;

export interface RuntimeSessionStoreOptions {
  readonly limits: ServiceLimits;
  readonly engine: Pick<Engine, "schema">;
  readonly registry: Pick<Registry, "get">;
  readonly channels: ChannelHub;
  readonly reactive: OrderedReactive<RuntimeReactiveContext>;
  readonly operations: RuntimeOperationRunner<RuntimeSession>;
  readonly authCaptureBudget: OutboundBudget;
  readonly telemetry: Telemetry;
  readonly tracing: RuntimeTraceBridge;
  readonly telemetryConnectionId?: (clientSessionId: string) => string;
  readonly createChannelContext: (
    state: RuntimeSession,
    signal: AbortSignal,
    requestBytes: number,
  ) => OwnedProcedureContext;
  readonly observeConnectionCount: (connections: number) => void;
}

/**
 * Owns connected-session identity, the logical subscription namespace,
 * operation ordering, auth rotation, adapters, and publication lifetime.
 */
export class RuntimeSessionStore {
  private readonly sessions = new Map<string, RuntimeSession>();
  /**
   * The configured subscription limits govern the client's one ID namespace,
   * so this count includes both reactive listeners and channel memberships.
   * OrderedReactive deliberately has no independent capacity policy.
   */
  private activeLogicalSubscriptions = 0;

  constructor(private readonly options: RuntimeSessionStoreOptions) {}

  get size(): number {
    return this.sessions.size;
  }

  get(clientSessionId: string): RuntimeSession | undefined {
    return this.sessions.get(clientSessionId);
  }

  values(): IterableIterator<RuntimeSession> {
    return this.sessions.values();
  }

  open(context: SessionRuntimeContext): void {
    if (context.authEpoch !== 0) {
      throw new AckerDBError(
        "validation",
        "new sessions must start at auth epoch 0",
      );
    }
    if (context.principal.kind === "system" || context.principal.kind === "mcp") {
      throw new AckerDBError(
        "unauthorized",
        "principal cannot authenticate the AckerDB client API",
      );
    }
    if (this.sessions.has(context.clientSessionId)) {
      throw new AckerDBError(
        "conflict",
        "client session is already connected",
        { retryable: true, retryAfterMs: 0, resource: "connection" },
      );
    }
    if (this.sessions.size >= this.options.limits.maxConnections) {
      throw new AckerDBError(
        "overloaded",
        "connection capacity is full",
        { retryable: true, retryAfterMs: 0, resource: "connection" },
      );
    }

    let state!: RuntimeSession;
    const subscriber = this.makeSubscriber(() => state, context.authEpoch);
    const channelAdapter = this.makeChannelAdapter(() => state);
    state = {
      context,
      contexts: new WeakSet([context]),
      subscriber,
      channelAdapter,
      subscriptionKinds: new Map(),
      ...(this.options.telemetryConnectionId === undefined
        ? {}
        : {
            telemetryConnectionId: this.options.telemetryConnectionId(
              context.clientSessionId,
            ),
          }),
      subscriptionControlTails: new Map(),
      subscriptionControlFrontier: Promise.resolve(),
      pendingSubscriptionControls: 0,
      capture: null,
      phase: "open",
      closeDrain: null,
      activeOperations: 0,
    };
    this.sessions.set(context.clientSessionId, state);
    this.options.observeConnectionCount(this.sessions.size);
  }

  matching(context: SessionRuntimeContext): RuntimeSession | null {
    const state = this.sessions.get(context.clientSessionId);
    if (
      state === undefined ||
      state.context.authEpoch !== context.authEpoch ||
      state.context.principal !== context.principal ||
      state.context.fairnessKey !== context.fairnessKey ||
      state.context.signal !== context.signal
    ) {
      return null;
    }
    return state;
  }

  current(
    context: SessionRuntimeContext,
    allowAborted = false,
  ): RuntimeSession {
    const state = this.matching(context);
    if (state === null) {
      throw new AckerDBError("auth_stale", "authentication state changed");
    }
    if (state.phase !== "open") {
      throw new AckerDBError("auth_stale", "session is closing");
    }
    if (!allowAborted) throwIfAborted(context.signal);
    return state;
  }

  run<Message extends { readonly id: number }, T>(
    context: SessionRuntimeContext,
    request: RuntimeRequest<Message>,
    operation: SessionOperation,
    functionName: string | undefined,
    work: (state: RuntimeSession, requestBytes: number) => T | Promise<T>,
    options: RuntimeSessionOperationOptions<T> = {},
  ): Promise<T> {
    const { message } = request;
    const requestBytes = claimRuntimeRequestBytes(request) ?? byteLength(message);
    const state = this.matching(context);
    const execute = () => {
      if (state === null) {
        throw new AckerDBError("auth_stale", "authentication state changed");
      }
      throwIfAborted(context.signal);
      return work(state, requestBytes);
    };
    const sessionOrder: SessionOperationOrder | undefined = operation === "subscription"
      ? { kind: "subscription-control", id: message.id }
      : operation === "mutation"
        ? { kind: "subscription-frontier" }
        : undefined;
    return this.options.operations.run(
      state,
      operation,
      functionName,
      requestBytes,
      execute,
      {
        identifiers: options.identifiers ?? {},
        synthesizeHandler: options.synthesizeHandler ?? true,
        finalize: (outcome) =>
          this.publishOperationOutcome(
            context,
            state,
            message.id,
            operation,
            outcome,
            options,
          ),
        fairnessKey: context.fairnessKey,
        ...(sessionOrder === undefined ? {} : { sessionOrder }),
      },
    );
  }

  async transitionAuth(transition: RuntimeAuthTransition): Promise<RuntimePublicationBatch> {
    const state = this.current(transition.from, true);
    return this.options.operations.run(state, "subscription", undefined, 1, async () => {
      if (
        transition.to.clientSessionId !== transition.from.clientSessionId ||
        transition.to.authEpoch !== transition.from.authEpoch + 1
      ) {
        throw new AckerDBError("validation", "authentication transition is not monotonic");
      }
      throwIfAborted(transition.to.signal);
      const captured: AuthTransitionCapture = {
        phase: "revoking",
        authEpoch: transition.from.authEpoch,
        frames: [],
        reservations: [],
        bytes: 0,
        active: true,
      };
      state.capture = captured;
      try {
        const channels = this.options.channels.descriptions(state.channelAdapter);
        await this.options.channels.disconnect(
          state.channelAdapter,
          "authentication-change",
        );
        const rotation = await this.options.reactive.rotateAuth(
          state.subscriber,
          transition.to.authEpoch,
        );
        if (rotation.deliveryFailures.length > 0) {
          throw new AckerDBError(
            "unavailable",
            "subscription revocation could not be delivered",
            {
              resource: "subscription",
              cause: rotation.deliveryFailures[0]?.error,
            },
          );
        }
        if (
          state.capture !== captured ||
          this.sessions.get(transition.from.clientSessionId) !== state
        ) {
          throw new AckerDBError("auth_stale", "authentication state changed");
        }
        state.contexts.add(transition.to);
        state.context = transition.to;
        state.subscriber = this.makeSubscriber(() => state, transition.to.authEpoch);
        captured.phase = "reattaching";
        captured.authEpoch = transition.to.authEpoch;
        for (const definition of rotation.subscriptions) {
          try {
            await this.attachSubscription(
              state,
              definition.id,
              definition.address,
              definition.args,
            );
          } catch (error) {
            this.captureFrame(captured, this.prepare({
              v: PROTOCOL_VERSION,
              t: "err",
              id: definition.id,
              outcome: outcomeFromError(transportError(error)),
            }, "subscription frame", "subscription"));
          }
        }
        for (const definition of channels) {
          try {
            const publication = await this.attachChannel(
              state,
              definition.id,
              definition.address,
              definition.args,
              definition.hasRoom,
              definition.room,
              byteLength(definition),
            );
            this.captureFrame(captured, publication);
          } catch (error) {
            this.releaseSubscription(state, definition.id, "channel");
            this.captureFrame(captured, this.prepare({
              v: PROTOCOL_VERSION,
              t: "err",
              id: definition.id,
              outcome: outcomeFromError(transportError(error)),
            }, "channel frame", "subscription"));
          }
        }
        return this.finishCapture(captured);
      } catch (error) {
        void this.startClose(state);
        throw error;
      } finally {
        if (state.capture === captured) state.capture = null;
        this.releaseCapture(captured);
      }
    }, {
      fairnessKey: transition.from.fairnessKey,
      sessionOrder: { kind: "subscription-frontier" },
    });
  }

  async subscribe(
    state: RuntimeSession,
    id: number,
    address: string,
    args: unknown,
    cursor?: SubscribeMessage["cursor"],
  ): Promise<void> {
    this.claimSubscription(state, id, "reactive");
    try {
      await this.attachSubscription(state, id, address, snapshotValue(args), cursor);
    } catch (error) {
      this.releaseSubscription(state, id, "reactive");
      throw error;
    }
  }

  unsubscribe(state: RuntimeSession, id: number): void {
    this.expectSubscription(state, id, "reactive");
    this.options.reactive.unsubscribe(state.subscriber, id);
    this.releaseSubscription(state, id, "reactive");
  }

  reset(
    state: RuntimeSession,
    id: number,
    cursor: Parameters<OrderedReactive<RuntimeReactiveContext>["reset"]>[2],
  ): Promise<void> {
    this.expectSubscription(state, id, "reactive");
    return this.options.reactive.reset(state.subscriber, id, cursor);
  }

  async joinChannel(
    state: RuntimeSession,
    id: number,
    address: string,
    args: unknown,
    hasRoom: boolean,
    room: unknown,
    requestBytes: number,
  ): Promise<RuntimePublication> {
    this.claimSubscription(state, id, "channel");
    try {
      return await this.attachChannel(
        state,
        id,
        address,
        snapshotValue(args),
        hasRoom,
        room,
        requestBytes,
      );
    } catch (error) {
      this.releaseSubscription(state, id, "channel");
      throw error;
    }
  }

  async leaveChannel(
    state: RuntimeSession,
    id: number,
    requestBytes: number,
  ): Promise<void> {
    this.expectSubscription(state, id, "channel");
    await this.options.channels.leave(
      state.channelAdapter,
      id,
      "leave",
      requestBytes,
    );
    this.releaseSubscription(state, id, "channel");
  }

  sendChannel(
    state: RuntimeSession,
    id: number,
    event: string,
    payload: unknown,
    requestBytes: number,
  ): Promise<void> {
    this.expectSubscription(state, id, "channel");
    return this.options.channels.handle(
      state.channelAdapter,
      id,
      event,
      payload,
      requestBytes,
    );
  }

  prepare(
    frame: SessionApplicationMessage,
    label: string,
    resource: "operation" | "subscription" = "operation",
  ): RuntimePublication {
    const startedAt = this.options.telemetry.enabled ? performance.now() : 0;
    let publication: RuntimePublication;
    try {
      publication = prepareRuntimePublication(frame);
    } catch (error) {
      const failure = new AckerDBError(
        "validation",
        `${label} is not wire-representable`,
        { cause: error },
      );
      if (this.options.telemetry.enabled) {
        this.options.tracing.span({
          stage: "encoding",
          outcome: failure.code,
          resource: "outbound",
          durationMs: Math.max(0, performance.now() - startedAt),
        }, resource === "subscription" ? "subscription" : "query");
      }
      throw failure;
    }
    if (publication.bytes > this.options.limits.maxFrameBytes) {
      const failure = new AckerDBError(
        "overloaded",
        `${label} exceeds maxFrameBytes`,
        { resource },
      );
      if (this.options.telemetry.enabled) {
        this.options.tracing.span({
          stage: "encoding",
          outcome: failure.code,
          resource: "outbound",
          durationMs: Math.max(0, performance.now() - startedAt),
          sizeBytes: publication.bytes,
        }, resource === "subscription" ? "subscription" : "query");
      }
      throw failure;
    }
    if (this.options.telemetry.enabled) {
      this.options.tracing.span({
        stage: "encoding",
        outcome: "ok",
        resource: "outbound",
        durationMs: Math.max(0, performance.now() - startedAt),
        sizeBytes: publication.bytes,
        ...(frame.t === "ok" && frame.kind === "query"
          ? {
              resultCount: Array.isArray(frame.value)
                ? frame.value.length
                : frame.value === null
                  ? 0
                  : 1,
            }
          : {}),
      }, resource === "subscription" ? "subscription" : "query");
    }
    return publication;
  }

  admit(
    state: RuntimeSession,
    order?: SessionOperationOrder,
  ): OperationAdmission {
    if (state.phase !== "open") {
      throw new AckerDBError("auth_stale", "session is closing");
    }
    if (state.activeOperations >= this.options.limits.maxOperationsPerConnection) {
      throw new AckerDBError(
        "overloaded",
        "per-connection operation capacity is full",
        {
          retryable: true,
          retryAfterMs: 0,
          resource: "operation",
        },
      );
    }
    state.activeOperations++;

    let predecessor: Promise<void> | undefined;
    let control: {
      readonly id: number;
      readonly completion: Deferred<void>;
    } | undefined;
    if (order?.kind === "subscription-control") {
      predecessor = state.subscriptionControlTails.get(order.id);
      const completion = deferred<void>();
      control = { id: order.id, completion };
      state.pendingSubscriptionControls++;
      state.subscriptionControlTails.set(order.id, completion.promise);
      state.subscriptionControlFrontier = Promise.all([
        state.subscriptionControlFrontier,
        completion.promise,
      ]).then(() => {});
    } else if (
      order?.kind === "subscription-frontier" &&
      state.pendingSubscriptionControls > 0
    ) {
      predecessor = state.subscriptionControlFrontier;
    }

    let active = true;
    return {
      predecessor,
      release: () => {
        if (!active) return;
        active = false;
        if (control !== undefined) {
          state.pendingSubscriptionControls--;
          if (state.subscriptionControlTails.get(control.id) === control.completion.promise) {
            state.subscriptionControlTails.delete(control.id);
          }
          control.completion.resolve(undefined);
          if (state.pendingSubscriptionControls === 0) {
            state.subscriptionControlFrontier = Promise.resolve();
          }
        }
        state.activeOperations--;
        this.tryRemove(state);
      },
    };
  }

  close(context: SessionRuntimeContext): Promise<void> {
    const state = this.sessions.get(context.clientSessionId);
    if (state === undefined || !state.contexts.has(context)) {
      return Promise.resolve();
    }
    return this.startClose(state);
  }

  startClose(state: RuntimeSession): Promise<void> {
    if (state.phase === "removed") return Promise.resolve();
    if (state.phase === "closing") {
      return state.closeDrain?.promise ?? Promise.resolve();
    }
    state.phase = "closing";
    const drain = sessionCloseDrain();
    state.closeDrain = drain;
    void this.options.channels.disconnect(state.channelAdapter, "disconnect").catch(() => {});
    this.tryRemove(state);
    return drain.promise;
  }

  tryRemove(state: RuntimeSession): void {
    if (state.phase === "closing" && state.activeOperations === 0) {
      this.remove(state);
    }
  }

  private async publishOperationOutcome<T>(
    context: SessionRuntimeContext,
    state: RuntimeSession | null,
    id: number,
    operation: SessionOperation,
    outcome: RuntimeOperationOutcome<T>,
    options: RuntimeSessionOperationOptions<T>,
  ): Promise<T> {
    if (!context.signal.aborted) {
      const successPublication = outcome.ok
        ? options.successPublication?.(outcome.value)
        : undefined;
      const message = outcome.ok
        ? successPublication?.message
        : {
            v: PROTOCOL_VERSION,
            t: "err",
            id,
            outcome: outcomeFromError(outcome.error),
          } satisfies ErrorMessage;
      if (message !== undefined) {
        if (state !== null) {
          await this.publish(
            state,
            context.authEpoch,
            message,
            successPublication,
          );
        } else {
          await context.publish(successPublication ?? this.prepare(
            message,
            "application frame",
            operation === "subscription" ? "subscription" : "operation",
          ));
        }
      }
    }
    if (outcome.ok) return outcome.value;
    throw outcome.error;
  }

  private makeSubscriber(state: () => RuntimeSession, authEpoch: number): Subscriber {
    const publish = (message: SessionApplicationMessage): Promise<void> =>
      this.publish(state(), authEpoch, message);
    return Object.freeze({
      sendTransition: (id: number, transition: SubscriptionTransition) => publish({
        v: PROTOCOL_VERSION,
        t: "transition",
        id,
        transition,
      } satisfies TransitionMessage),
      sendEvent: (id: number, event: LiveEvent) => publish({
        v: PROTOCOL_VERSION,
        t: "event",
        id,
        event,
      } satisfies EventMessage),
      sendError: (id: number, outcome: Outcome) => publish({
        v: PROTOCOL_VERSION,
        t: "err",
        id,
        outcome,
      } satisfies ErrorMessage),
    });
  }

  private makeChannelAdapter(state: () => RuntimeSession): ChannelSessionAdapter {
    return Object.freeze({
      get principal(): Principal {
        return state().context.principal;
      },
      createContext: (
        signal: AbortSignal,
        requestBytes: number,
      ): OwnedProcedureContext =>
        this.options.createChannelContext(state(), signal, requestBytes),
      send: async (id: number, event: string, payload: unknown): Promise<boolean> => {
        const current = state();
        try {
          await this.publish(current, current.context.authEpoch, {
            v: PROTOCOL_VERSION,
            t: "channel_event",
            id,
            event,
            payload,
          } satisfies ChannelEventMessage);
          return true;
        } catch {
          return false;
        }
      },
    });
  }

  private async publish(
    state: RuntimeSession,
    sourceAuthEpoch: number,
    message: SessionApplicationMessage,
    prepared?: RuntimePublication,
  ): Promise<void> {
    if (prepared !== undefined && prepared.message !== message) {
      throw new TypeError("prepared publication does not own the supplied message");
    }
    const capture = state.capture;
    if (capture !== null) {
      if (!this.captureAccepts(capture, sourceAuthEpoch, message)) return;
      this.captureFrame(
        capture,
        prepared ?? this.prepare(message, "subscription frame", "subscription"),
      );
      return;
    }
    if (sourceAuthEpoch !== state.context.authEpoch) return;
    const publication = prepared ?? this.prepare(
      message,
      "application frame",
      message.t === "transition" || message.t === "event" ||
          this.options.tracing.currentScope()?.operation === "subscription"
        ? "subscription"
        : "operation",
    );
    if (!await state.context.publish(publication)) {
      throw new AckerDBError("auth_stale", "authentication state changed");
    }
  }

  private captureAccepts(
    capture: AuthTransitionCapture,
    sourceAuthEpoch: number,
    message: SessionApplicationMessage,
  ): boolean {
    if (sourceAuthEpoch !== capture.authEpoch) return false;
    if (capture.phase === "revoking") {
      return (
        message.t === "transition" &&
        message.transition.kind === "revoked" &&
        message.transition.outcome.code === "auth_stale"
      ) || (message.t === "err" && message.outcome.code === "auth_stale");
    }
    return (
      (message.t === "transition" && message.transition.kind === "reset") ||
      (message.t === "event" && message.event.kind === "reset") ||
      message.t === "channel_ready" ||
      message.t === "channel_event" ||
      message.t === "channel_rejected" ||
      message.t === "err"
    );
  }

  private async attachChannel(
    state: RuntimeSession,
    id: number,
    address: string,
    args: unknown,
    hasRoom: boolean,
    room: unknown,
    requestBytes: number,
  ): Promise<RuntimePublication> {
    const result = await this.options.channels.join({
      session: state.channelAdapter,
      id,
      address,
      args,
      hasRoom,
      ...(hasRoom ? { room: snapshotValue(room) } : {}),
      requestBytes,
    });
    const message = result.ok
      ? {
          v: PROTOCOL_VERSION,
          t: "channel_ready",
          id,
          authEpoch: state.context.authEpoch,
        } satisfies ChannelReadyMessage
      : {
          v: PROTOCOL_VERSION,
          t: "channel_rejected",
          id,
          authEpoch: state.context.authEpoch,
          error: result.error,
        } satisfies ChannelRejectedMessage;
    if (!result.ok) this.releaseSubscription(state, id, "channel");
    return this.prepare(message, "channel frame", "subscription");
  }

  private captureFrame(
    capture: AuthTransitionCapture,
    publication: RuntimePublication,
  ): void {
    if (!capture.active) {
      throw new AckerDBError("auth_stale", "authentication state changed");
    }
    const maxItems = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.options.limits.maxSubscriptionsPerConnection * 2,
    );
    const maxBytes =
      this.options.limits.webSocket.maxBytesPerConnection - this.options.limits.maxFrameBytes;
    if (capture.frames.length >= maxItems || publication.bytes > maxBytes - capture.bytes) {
      throw new AckerDBError(
        "overloaded",
        "authentication transition exceeds capture capacity",
        {
          retryable: true,
          retryAfterMs: 0,
          resource: "subscription",
        },
      );
    }
    const reservation = this.options.authCaptureBudget.reserve(
      publication.bytes,
      "application",
    );
    if (reservation === null) {
      throw new AckerDBError(
        "overloaded",
        "authentication transition exceeds global capture capacity",
        {
          retryable: true,
          retryAfterMs: 0,
          resource: "subscription",
        },
      );
    }
    capture.frames.push(publication);
    capture.reservations.push(reservation);
    capture.bytes += publication.bytes;
  }

  private finishCapture(capture: AuthTransitionCapture): RuntimePublicationBatch {
    if (!capture.active) {
      throw new AckerDBError("auth_stale", "authentication state changed");
    }
    capture.active = false;
    const frames = capture.frames.splice(0);
    const reservations = capture.reservations.splice(0);
    const bytes = capture.bytes;
    capture.bytes = 0;
    let released = false;
    return Object.freeze({
      frames,
      bytes,
      release: () => {
        if (released) return;
        released = true;
        frames.length = 0;
        for (const reservation of reservations) reservation.release();
        reservations.length = 0;
      },
    });
  }

  private releaseCapture(capture: AuthTransitionCapture): void {
    if (!capture.active && capture.reservations.length === 0) return;
    capture.active = false;
    capture.frames.length = 0;
    capture.bytes = 0;
    for (const reservation of capture.reservations) reservation.release();
    capture.reservations.length = 0;
  }

  private async attachSubscription(
    state: RuntimeSession,
    id: number,
    address: string,
    args: unknown,
    cursor?: SubscribeMessage["cursor"],
  ): Promise<void> {
    if (address.startsWith("events.")) {
      const table = address.slice("events.".length);
      const tableDefinition = this.options.engine.schema.tables[table];
      if (tableDefinition?.kind !== "event") {
        throw new AckerDBError("not_found", `unknown event table "${table}"`);
      }
      const subscription = tableDefinition.eventSubscription!;
      const policyAt = this.options.telemetry.enabled ? performance.now() : 0;
      let authorized: Awaited<ReturnType<typeof authorizeInvocation>>;
      try {
        authorized = await authorizeInvocation(
          subscription,
          { auth: state.context.principal },
          args,
        );
        if (this.options.telemetry.enabled) {
          this.options.tracing.span({
            stage: "policy",
            outcome: "ok",
            functionName: address,
            resource: "subscription",
            durationMs: Math.max(0, performance.now() - policyAt),
          }, "subscription");
        }
      } catch (error) {
        if (this.options.telemetry.enabled) {
          this.options.tracing.span({
            stage: "policy",
            outcome: outcomeFromError(transportError(error)).code,
            functionName: address,
            resource: "subscription",
            durationMs: Math.max(0, performance.now() - policyAt),
          }, "subscription");
        }
        throw error;
      }
      await this.options.reactive.subscribeEvent({
        subscriber: state.subscriber,
        id,
        table,
        authEpoch: state.context.authEpoch,
        args: authorized.args,
        matches: subscription.matches as (row: unknown, args: unknown) => boolean,
      });
      return;
    }

    this.expectQuery(address);
    await this.options.reactive.subscribeQuery({
      subscriber: state.subscriber,
      id,
      address,
      args,
      policyScopeFingerprint: digest(state.context.principal),
      fairnessKey: state.context.fairnessKey,
      context: { principal: state.context.principal },
      authEpoch: state.context.authEpoch,
      ...(cursor === undefined ? {} : { cursor }),
    });
  }

  private claimSubscription(
    state: RuntimeSession,
    id: number,
    kind: "reactive" | "channel",
  ): void {
    if (state.subscriptionKinds.has(id)) {
      throw new AckerDBError(
        "conflict",
        "subscription ID is already active",
      );
    }
    if (
      state.subscriptionKinds.size >=
        this.options.limits.maxSubscriptionsPerConnection
    ) {
      throw subscriptionOverload("Per-connection subscription capacity is full");
    }
    if (this.activeLogicalSubscriptions >= this.options.limits.maxSubscriptions) {
      throw subscriptionOverload("Global subscription capacity is full");
    }
    state.subscriptionKinds.set(id, kind);
    this.activeLogicalSubscriptions++;
  }

  private releaseSubscription(
    state: RuntimeSession,
    id: number,
    kind: "reactive" | "channel",
  ): void {
    if (state.subscriptionKinds.get(id) !== kind) return;
    state.subscriptionKinds.delete(id);
    this.activeLogicalSubscriptions--;
  }

  private expectSubscription(
    state: RuntimeSession,
    id: number,
    kind: "reactive" | "channel",
  ): void {
    const actual = state.subscriptionKinds.get(id);
    if (actual === undefined) {
      throw new AckerDBError("not_found", "subscription is not active");
    }
    if (actual !== kind) {
      throw new AckerDBError(
        "validation",
        `${kind} operation cannot target a ${actual} subscription`,
      );
    }
  }

  private expectQuery(address: string): void {
    const fn = this.options.registry.get(address);
    if (fn === undefined) {
      throw new AckerDBError("not_found", `unknown function "${address}"`);
    }
    if (fn.kind !== "query") {
      throw new AckerDBError(
        "validation",
        `"${address}" is a ${fn.kind}, expected a query`,
      );
    }
  }

  private remove(state: RuntimeSession): void {
    if (state.phase === "removed") return;
    state.phase = "removed";
    const capture = state.capture;
    state.capture = null;
    if (capture !== null) this.releaseCapture(capture);
    this.options.reactive.disconnect(state.subscriber);
    this.activeLogicalSubscriptions -= state.subscriptionKinds.size;
    state.subscriptionKinds.clear();
    if (this.sessions.get(state.context.clientSessionId) === state) {
      this.sessions.delete(state.context.clientSessionId);
      this.options.observeConnectionCount(this.sessions.size);
    }
    const drain = state.closeDrain;
    state.closeDrain = null;
    drain?.resolve();
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function sessionCloseDrain(): SessionCloseDrain {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function subscriptionOverload(message: string): AckerDBError {
  return new AckerDBError("overloaded", message, {
    retryable: true,
    retryAfterMs: 0,
    resource: "subscription",
  });
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(encode(value));
}

function snapshotValue(value: unknown): unknown {
  return decode(encode(value));
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableEncode(value)).digest("base64url");
}
