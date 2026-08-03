import type { ChannelSessionAdapter } from "../../channels/hub.ts";
import { AckerDBError, throwIfAborted } from "../../shared/errors.ts";
import type { Subscriber } from "../../subscriptions/reactive.ts";
import type {
  RuntimePublication,
  SessionRuntimeContext,
} from "../../subscriptions/session.ts";
import type { OutboundReservation } from "../../subscriptions/delivery.ts";
import type { ServiceLimits } from "../limits.ts";

type SessionLimits = Pick<
  ServiceLimits,
  "maxConnections" | "maxSubscriptions" | "maxSubscriptionsPerConnection"
>;

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

export interface RuntimeSessionStoreOptions {
  readonly limits: SessionLimits;
  readonly telemetryConnectionId?: (clientSessionId: string) => string;
  readonly createSubscriber: (
    state: () => RuntimeSession,
    authEpoch: number,
  ) => Subscriber;
  readonly createChannelAdapter: (
    state: () => RuntimeSession,
  ) => ChannelSessionAdapter;
  readonly disconnectChannels: (adapter: ChannelSessionAdapter) => Promise<void>;
  readonly disconnectSubscriber: (subscriber: Subscriber) => void;
  readonly releaseCapture: (capture: AuthTransitionCapture) => void;
  readonly observeConnectionCount: (connections: number) => void;
}

/** Owns connected-session identity, capacity, and finite close/removal state. */
export class RuntimeSessionStore {
  private readonly sessions = new Map<string, RuntimeSession>();
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
    const subscriber = this.options.createSubscriber(
      () => state,
      context.authEpoch,
    );
    const channelAdapter = this.options.createChannelAdapter(() => state);
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
    void this.options.disconnectChannels(state.channelAdapter).catch(() => {});
    this.tryRemove(state);
    return drain.promise;
  }

  tryRemove(state: RuntimeSession): void {
    if (state.phase === "closing" && state.activeOperations === 0) {
      this.remove(state);
    }
  }

  claimSubscription(
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
      throw new AckerDBError(
        "overloaded",
        "Per-connection subscription capacity is full",
        {
          retryable: true,
          retryAfterMs: 0,
          resource: "subscription",
        },
      );
    }
    if (
      this.activeLogicalSubscriptions >=
        this.options.limits.maxSubscriptions
    ) {
      throw new AckerDBError(
        "overloaded",
        "Global subscription capacity is full",
        {
          retryable: true,
          retryAfterMs: 0,
          resource: "subscription",
        },
      );
    }
    state.subscriptionKinds.set(id, kind);
    this.activeLogicalSubscriptions++;
  }

  releaseSubscription(
    state: RuntimeSession,
    id: number,
    kind: "reactive" | "channel",
  ): void {
    if (state.subscriptionKinds.get(id) !== kind) return;
    state.subscriptionKinds.delete(id);
    this.activeLogicalSubscriptions--;
  }

  expectSubscription(
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

  private remove(state: RuntimeSession): void {
    if (state.phase === "removed") return;
    state.phase = "removed";
    const capture = state.capture;
    state.capture = null;
    if (capture !== null) this.options.releaseCapture(capture);
    this.options.disconnectSubscriber(state.subscriber);
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

function sessionCloseDrain(): SessionCloseDrain {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
