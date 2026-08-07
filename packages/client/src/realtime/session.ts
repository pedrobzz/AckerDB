import {
  PROTOCOL_VERSION,
  PerfectNegotiation,
  ProtocolError,
  RealtimeDataPlane,
  RealtimeProtocolError,
  RealtimeStreamInterruptedError,
  WireError,
  decode,
  encode,
  getRef,
  parseRealtimeIceCandidate,
  parseRealtimeOfferRequest,
  parseRealtimeOfferResponse,
  parseRealtimePatchResponse,
  parseRealtimePrepareRequest,
  parseRealtimePrepareResponse,
  parseServerMessage,
  stableEncode,
  type ApplicationError,
  type AnyRealtimeRef,
  type EventMap,
  type EventUnion,
  type NativeRTCConfiguration,
  type NativeRTCIceCandidate,
  type NativeRTCPeerConnection,
  type NativeRTCTrackEvent,
  type Outcome,
  type PerfectNegotiationFailure,
  type PortableRTCDataChannel,
  type RealtimeArgs,
  type RealtimeClientEvents,
  type RealtimeClientStreams,
  type RealtimeError,
  type RealtimeIceCandidate,
  type RealtimeServerEvents,
  type RealtimeServerStreams,
  type RealtimeStreamMap,
} from "@ackerdb/core";
import type {
  AckerDBClientError,
  AckerDBFetch,
  AckerDBReconnectOptions,
} from "../client.ts";

export type AckerDBPeerConnectionFactory = (
  configuration: NativeRTCConfiguration,
) => unknown;

export type AckerDBRealtimeEventOn<Events extends EventMap> =
  | {
      readonly [Name in keyof Events]?: (
        payload: Events[Name],
      ) => unknown;
    }
  | ((event: EventUnion<Events>) => unknown);

export interface AckerDBRealtimeIncomingStream<Metadata> {
  readonly id: string;
  readonly size?: number;
  readonly metadata: Metadata;
  readonly readable: ReadableStream<Uint8Array>;
  readonly abortSignal: AbortSignal;
}

export type AckerDBRealtimeStreamUnion<Streams extends RealtimeStreamMap> = {
  readonly [Name in Extract<keyof Streams, string>]:
    & { readonly type: Name }
    & AckerDBRealtimeIncomingStream<Streams[Name]>;
}[Extract<keyof Streams, string>];

export type AckerDBRealtimeStreamOn<Streams extends RealtimeStreamMap> =
  | {
      readonly [Name in keyof Streams]?: (
        input: AckerDBRealtimeIncomingStream<Streams[Name]>,
      ) => unknown;
    }
  | ((input: AckerDBRealtimeStreamUnion<Streams>) => unknown);

export type AckerDBRealtimeState<Error = never> =
  | {
      readonly phase: "connecting";
      readonly peerConnection?: NativeRTCPeerConnection;
    }
  | {
      readonly phase: "connected";
      readonly peerConnection: NativeRTCPeerConnection;
    }
  | {
      readonly phase: "reconnecting";
      readonly error: AckerDBClientError;
    }
  | {
      readonly phase: "disconnected";
    }
  | {
      readonly phase: "rejected";
      readonly error: Error;
    }
  | {
      readonly phase: "failed";
      readonly error: AckerDBClientError;
    };

export interface AckerDBRealtimeOn<
  ServerEvents extends EventMap,
  ServerStreams extends RealtimeStreamMap,
  Error = never,
> {
  readonly event?: AckerDBRealtimeEventOn<ServerEvents>;
  readonly stream?: AckerDBRealtimeStreamOn<ServerStreams>;
  readonly peerConnection?: (
    peerConnection: NativeRTCPeerConnection,
  ) => void | (() => void) | Promise<void | (() => void)>;
  readonly connected?: (peerConnection: NativeRTCPeerConnection) => unknown;
  readonly track?: (event: NativeRTCTrackEvent) => unknown;
  readonly stateChange?: (
    state: AckerDBRealtimeState<Error>,
    previous: AckerDBRealtimeState<Error>,
  ) => unknown;
}

export interface AckerDBRealtime<
  ClientEvents extends EventMap,
  ClientStreams extends RealtimeStreamMap,
  ServerEvents extends EventMap,
  ServerStreams extends RealtimeStreamMap,
  Error = never,
> {
  readonly currentState: AckerDBRealtimeState<Error>;
  readonly peerConnection: NativeRTCPeerConnection | null;
  send<Name extends Extract<keyof ClientEvents, string>>(
    event: Name,
    payload: NoInfer<ClientEvents[Name]>,
  ): boolean;
  openStream<Name extends Extract<keyof ClientStreams, string>>(
    stream: Name,
    metadata: NoInfer<ClientStreams[Name]>,
    options?: { readonly size?: number },
  ): {
    readonly id: string;
    readonly writable: WritableStream<Uint8Array>;
  };
  disconnect(): void;
  reconnect(): void;
  observe(
    on: AckerDBRealtimeOn<ServerEvents, ServerStreams, Error>,
  ): () => void;
  subscribe(listener: () => void): () => void;
  release(): void;
}

export interface RealtimeManagerClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RealtimeManagerPort {
  readonly fetch: AckerDBFetch;
  readonly createPeerConnection: AckerDBPeerConnectionFactory;
  readonly clock: RealtimeManagerClock;
  readonly reconnect: AckerDBReconnectOptions;
  readonly random: () => number;
  url(path: string): string;
  headers(): Readonly<Record<string, string>>;
  readResponse(response: Response, signal: AbortSignal): Promise<string>;
  clientError(outcome: Outcome): AckerDBClientError;
  isClientError(error: unknown): error is AckerDBClientError;
}

interface Observer {
  readonly listeners: Set<() => void>;
  readonly handlers: Set<HandlerObservation>;
  active: boolean;
}

interface HandlerObservation {
  readonly on: AckerDBRealtimeOn<EventMap, RealtimeStreamMap, unknown>;
  active: boolean;
  setupGeneration?: number;
  setupPending?: Promise<void>;
  setupCleanup?: () => void;
}

interface PeerGeneration {
  readonly number: number;
  readonly peer: NativeRTCPeerConnection;
  readonly channel: PortableRTCDataChannel;
  readonly controller: AbortController;
  readonly headers: Readonly<Record<string, string>>;
  readonly localCandidates: RealtimeIceCandidate[];
  readonly negotiation: PerfectNegotiation;
  dataPlane: RealtimeDataPlane | null;
  sessionId: string | null;
  clientStreamLimits: Readonly<Record<string, number>>;
  serverStreamLimits: Readonly<Record<string, number>>;
  /** The local end-of-candidates marker must use HTTP until the data plane opens. */
  httpComplete: boolean;
  httpCompleteDelivered: boolean;
  httpCompleteInFlight: boolean;
  serverComplete: boolean;
  trickleRunning: boolean;
  trickleRequested: boolean;
  disconnectedHandle?: unknown;
  iceRestartHandle?: unknown;
  setupHandle?: unknown;
  stableHandle?: unknown;
  cleanupStarted: boolean;
  restartingIce: boolean;
  handlerPending: number;
  closed: boolean;
}

interface Group {
  readonly key: string;
  readonly address: string;
  readonly args: unknown;
  readonly observers: Set<Observer>;
  state: AckerDBRealtimeState<unknown>;
  generation: PeerGeneration | null;
  pending: AbortController | null;
  nextGeneration: number;
  reconnectAttempt: number;
  reconnectHandle?: unknown;
  explicitDisconnected: boolean;
  closed: boolean;
}

type Settlement =
  | { readonly kind: "recover"; readonly error: AckerDBClientError }
  | { readonly kind: "failed"; readonly error: AckerDBClientError }
  | { readonly kind: "rejected"; readonly error: ApplicationError };

const CONNECTING: AckerDBRealtimeState<never> = Object.freeze({
  phase: "connecting",
});
const DISCONNECTED: AckerDBRealtimeState<never> = Object.freeze({
  phase: "disconnected",
});
const MAX_BUFFERED_AMOUNT = 1024 * 1024;
const MAX_CONCURRENT_STREAMS = 16;
const MAX_INCOMING_BUFFERED_BYTES = 256 * 1024;
const STREAM_IDLE_MS = 30_000;
const HANDLER_FAILURE = Symbol("ackerdb realtime handler failure");

function terminal(state: AckerDBRealtimeState<unknown>): boolean {
  return state.phase === "failed" || state.phase === "rejected";
}

function thenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof Reflect.get(value, "then") === "function"
  );
}

function candidate(value: NativeRTCIceCandidate): RealtimeIceCandidate {
  return Object.freeze(parseRealtimeIceCandidate(value.toJSON()));
}

function unexpected(message: string): Outcome {
  return Object.freeze({
    code: "internal",
    retryable: false,
    message,
    resource: "connection",
  });
}

function unavailable(
  message: string,
  retryable: boolean,
  retryAfterMs?: number,
): Outcome {
  return Object.freeze({
    code: "unavailable",
    retryable,
    message,
    resource: "connection",
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

export class RealtimeManager {
  private readonly byKey = new Map<string, Group>();
  private suspended = false;
  private closed = false;

  constructor(private readonly port: RealtimeManagerPort) {}

  retain<Ref extends AnyRealtimeRef>(
    ref: Ref,
    args: NoInfer<RealtimeArgs<Ref>>,
  ): AckerDBRealtime<
    RealtimeClientEvents<Ref>,
    RealtimeClientStreams<Ref>,
    RealtimeServerEvents<Ref>,
    RealtimeServerStreams<Ref>,
    RealtimeError<Ref>
  > {
    if (this.closed) {
      throw this.port.clientError(unavailable("client is closed", false));
    }
    const address = getRef(ref);
    const key = stableEncode([address, args]);
    let group = this.byKey.get(key);
    if (group === undefined) {
      group = {
        key,
        address,
        args,
        observers: new Set(),
        state: CONNECTING,
        generation: null,
        pending: null,
        nextGeneration: 0,
        reconnectAttempt: 0,
        explicitDisconnected: false,
        closed: false,
      };
      this.byKey.set(key, group);
    }
    const observer: Observer = {
      listeners: new Set(),
      handlers: new Set(),
      active: true,
    };
    group.observers.add(observer);
    if (
      group.generation === null &&
      !group.explicitDisconnected &&
      !terminal(group.state) &&
      !this.suspended
    ) {
      void this.connect(group);
    }
    return this.handle(group, observer) as AckerDBRealtime<
      RealtimeClientEvents<Ref>,
      RealtimeClientStreams<Ref>,
      RealtimeServerEvents<Ref>,
      RealtimeServerStreams<Ref>,
      RealtimeError<Ref>
    >;
  }

  authenticationChanged(): void {
    if (this.closed) return;
    for (const group of this.byKey.values()) {
      this.clearReconnect(group);
      this.stopGeneration(group, "AckerDB credential changed");
      if (group.explicitDisconnected) continue;
      if (this.suspended) {
        if (terminal(group.state)) this.replace(group, DISCONNECTED);
      } else {
        this.replace(group, CONNECTING);
        void this.connect(group);
      }
    }
  }

  authenticationBlocked(error: AckerDBClientError): void {
    for (const group of this.byKey.values()) {
      this.settle(group, group.generation, { kind: "failed", error });
    }
  }

  suspend(): void {
    if (this.closed || this.suspended) return;
    this.suspended = true;
    for (const group of this.byKey.values()) {
      if (terminal(group.state)) continue;
      this.clearReconnect(group);
      this.stopGeneration(group, "client suspended");
      this.replace(group, DISCONNECTED);
    }
  }

  resume(): void {
    if (this.closed || !this.suspended) return;
    this.suspended = false;
    for (const group of this.byKey.values()) {
      if (group.explicitDisconnected || terminal(group.state)) continue;
      this.replace(group, CONNECTING);
      void this.connect(group);
    }
  }

  failAll(error: AckerDBClientError): void {
    for (const group of this.byKey.values()) {
      this.settle(group, group.generation, { kind: "failed", error });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const group of [...this.byKey.values()]) {
      group.closed = true;
      this.clearReconnect(group);
      this.stopGeneration(group, "client closed");
      for (const observer of group.observers) {
        observer.active = false;
        observer.listeners.clear();
        for (const observation of observer.handlers) observation.active = false;
        observer.handlers.clear();
      }
      group.observers.clear();
    }
    this.byKey.clear();
  }

  private handle(
    group: Group,
    observer: Observer,
  ): AckerDBRealtime<EventMap, RealtimeStreamMap, EventMap, RealtimeStreamMap, unknown> {
    let released = false;
    return Object.freeze({
      get currentState() {
        return group.state;
      },
      get peerConnection() {
        return group.generation?.peer ?? null;
      },
      send: (event: string, payload: unknown): boolean =>
        !released && group.state.phase === "connected"
          ? group.generation?.dataPlane?.send(event, payload) ?? false
          : false,
      openStream: (
        stream: string,
        metadata: unknown,
        options?: { readonly size?: number },
      ) => {
        if (released || group.state.phase !== "connected") {
          throw new RealtimeStreamInterruptedError(
            "unopened",
            "realtime session is not connected",
          );
        }
        const generation = group.generation;
        const limit = generation?.clientStreamLimits[stream];
        if (generation === null || generation.dataPlane === null || limit === undefined) {
          throw new TypeError(`unknown client realtime stream "${stream}"`);
        }
        return generation.dataPlane.openStream(
          stream,
          metadata,
          limit,
          options?.size,
        );
      },
      disconnect: () => {
        if (released) return;
        group.explicitDisconnected = true;
        this.clearReconnect(group);
        this.stopGeneration(group, "realtime session disconnected");
        this.replace(group, DISCONNECTED);
      },
      reconnect: () => {
        if (released || group.closed || this.closed) return;
        group.explicitDisconnected = false;
        group.reconnectAttempt = 0;
        this.clearReconnect(group);
        this.stopGeneration(group, "realtime session reconnecting");
        if (this.suspended) {
          this.replace(group, DISCONNECTED);
        } else {
          this.replace(group, CONNECTING);
          void this.connect(group);
        }
      },
      observe: (
        on: AckerDBRealtimeOn<EventMap, RealtimeStreamMap, unknown>,
      ) => {
        if (released) return () => {};
        const observation: HandlerObservation = { on, active: true };
        observer.handlers.add(observation);
        const generation = group.generation;
        if (generation !== null && !generation.closed) {
          void this.attachPeerHandler(group, generation, observation).catch(() => {
            if (group.generation !== generation || generation.closed) return;
            this.settle(group, generation, {
              kind: "failed",
              error: this.port.clientError(
                unexpected("realtime on.peerConnection handler failed"),
              ),
            });
          });
        }
        return () => this.releaseHandler(observer, observation);
      },
      subscribe: (listener: () => void) => {
        if (released) return () => {};
        observer.listeners.add(listener);
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          observer.listeners.delete(listener);
        };
      },
      release: () => {
        if (released) return;
        released = true;
        observer.active = false;
        observer.listeners.clear();
        for (const observation of [...observer.handlers]) {
          this.releaseHandler(observer, observation);
        }
        group.observers.delete(observer);
        if (group.observers.size !== 0) return;
        group.closed = true;
        this.clearReconnect(group);
        this.stopGeneration(group, "realtime session released");
        this.byKey.delete(group.key);
      },
    });
  }

  private async connect(group: Group): Promise<void> {
    if (
      group.closed ||
      group.generation !== null ||
      group.pending !== null ||
      group.explicitDisconnected ||
      terminal(group.state) ||
      this.suspended ||
      this.closed
    ) {
      return;
    }
    const controller = new AbortController();
    group.pending = controller;
    const setupError = this.port.clientError(
      unavailable("WebRTC realtime setup timed out", true),
    );
    const setupHandle = this.port.clock.setTimeout(() => {
      if (group.closed || group.explicitDisconnected || this.closed) return;
      const generation = group.generation;
      const handlerTimedOut = generation !== null &&
        generation.controller === controller &&
        generation.handlerPending > 0;
      const error = handlerTimedOut
        ? this.port.clientError(
          unexpected("realtime on.peerConnection handler timed out"),
        )
        : setupError;
      controller.abort(error);
      if (generation !== null && generation.controller === controller) {
        this.settle(group, generation, {
          kind: handlerTimedOut ? "failed" : "recover",
          error,
        });
      } else if (group.pending === controller) {
        group.pending = null;
        this.settle(group, null, { kind: "recover", error: setupError });
      }
    }, this.port.reconnect.realtimeSetupTimeoutMs);
    let setupOwnedByGeneration = false;
    let peer: NativeRTCPeerConnection | undefined;
    try {
      const prepared = await this.prepare(group, controller.signal);
      if (
        controller.signal.aborted ||
        group.closed ||
        group.explicitDisconnected ||
        terminal(group.state) ||
        this.suspended ||
        this.closed
      ) {
        return;
      }
      if (prepared.t === "realtime_rejected") {
        this.settle(group, null, {
          kind: "rejected",
          error: prepared.error,
        });
        return;
      }
      peer = this.requireCapabilities<NativeRTCPeerConnection>(
        this.port.createPeerConnection(prepared.configuration),
        "RTCPeerConnection",
        [
          "createDataChannel",
          "createOffer",
          "createAnswer",
          "setLocalDescription",
          "setRemoteDescription",
          "addIceCandidate",
          "close",
          "restartIce",
          "addEventListener",
        ],
        [
          "connectionState",
          "iceConnectionState",
          "signalingState",
          "localDescription",
        ],
      );
      const channel = this.requireCapabilities<PortableRTCDataChannel>(
        peer.createDataChannel("ackerdb.typed.v1", {
          negotiated: true,
          id: 0,
          ordered: true,
        }),
        "AckerDB realtime data channel",
        ["send", "addEventListener", "removeEventListener"],
        [
          "readyState",
          "bufferedAmount",
          "binaryType",
          "bufferedAmountLowThreshold",
        ],
      );
      let generation!: PeerGeneration;
      const negotiation = new PerfectNegotiation({
        peerConnection: peer,
        polite: true,
        signalingTransportReady: channel.readyState === "open",
        sendSignal: (frame) => generation.dataPlane!.sendSignal(frame),
        createError: (failure) => this.negotiationError(failure),
        failed: (error) => this.signalingFailed(group, generation, error),
      });
      generation = {
        number: ++group.nextGeneration,
        peer,
        channel,
        controller,
        headers: Object.freeze({ ...this.port.headers() }),
        localCandidates: [],
        negotiation,
        dataPlane: null,
        sessionId: null,
        clientStreamLimits: Object.freeze({}),
        serverStreamLimits: Object.freeze({}),
        httpComplete: false,
        httpCompleteDelivered: false,
        httpCompleteInFlight: false,
        serverComplete: false,
        trickleRunning: false,
        trickleRequested: false,
        cleanupStarted: false,
        restartingIce: false,
        handlerPending: 0,
        setupHandle,
        closed: false,
      };
      setupOwnedByGeneration = true;
      group.generation = generation;
      this.installPeerListeners(group, generation);
      this.replace(group, Object.freeze({
        phase: "connecting",
        peerConnection: peer,
      }));
      try {
        await Promise.all(
          this.handlers(group).map((observation) =>
            this.attachPeerHandler(group, generation, observation)
          ),
        );
      } catch {
        throw this.port.clientError(
          unexpected("realtime on.peerConnection handler failed"),
        );
      }
      if (group.generation !== generation || generation.closed) return;

      generation.dataPlane = new RealtimeDataPlane({
        channel,
        localPrefix: "c",
        maxBufferedAmount: MAX_BUFFERED_AMOUNT,
        maxConcurrentStreams: MAX_CONCURRENT_STREAMS,
        maxIncomingBufferedBytes: MAX_INCOMING_BUFFERED_BYTES,
        streamIdleMs: STREAM_IDLE_MS,
        onEvent: (event, payload) => this.deliverEvent(group, event, payload),
        onIncomingStream: (stream, metadata, size) =>
          this.incomingStream(group, generation, stream, metadata, size),
        onSessionError: (outcome) => {
          const error = this.port.clientError(outcome);
          this.settle(group, generation, {
            kind: outcome.retryable ? "recover" : "failed",
            error,
          });
        },
        onSignal: (frame) => generation.negotiation.receiveSignal(frame),
        onFatalError: (error) => {
          this.settle(group, generation, {
            kind: error instanceof RealtimeStreamInterruptedError
              ? "recover"
              : "failed",
            error: error instanceof RealtimeStreamInterruptedError
              ? this.normalize(error, "realtime data channel failed")
              : this.terminalDataPlaneError(error),
          });
        },
      });

      const offer = await generation.negotiation.createInitialOffer();
      const response = await this.offer(
        prepared.ticket,
        offer,
        generation,
      );
      if (group.generation !== generation || generation.closed) return;
      if (response.t === "realtime_rejected") {
        this.settle(group, generation, {
          kind: "rejected",
          error: response.error,
        });
        return;
      }
      generation.sessionId = response.sessionId;
      generation.clientStreamLimits = response.streamLimits.client;
      generation.serverStreamLimits = response.streamLimits.server;
      generation.serverComplete = response.complete;
      await peer.setRemoteDescription(response.answer);
      generation.negotiation.initialNegotiationComplete();
      for (const ice of response.candidates) {
        await peer.addIceCandidate(ice);
      }
      this.maybeConnected(group, generation);
      this.requestTrickle(group, generation);
    } catch (error) {
      if (controller.signal.aborted || group.closed) return;
      const normalized = this.normalize(error, "realtime signaling failed");
      if (normalized.retryable) {
        if (group.generation === null && peer !== undefined) peer.close();
        this.settle(group, group.generation, {
          kind: "recover",
          error: normalized,
        });
      } else {
        if (group.generation === null && peer !== undefined) peer.close();
        this.settle(group, group.generation, {
          kind: "failed",
          error: normalized,
        });
      }
    } finally {
      if (group.pending === controller) group.pending = null;
      if (!setupOwnedByGeneration) {
        this.port.clock.clearTimeout(setupHandle);
      }
    }
  }

  private installPeerListeners(group: Group, generation: PeerGeneration): void {
    const { peer, channel } = generation;
    peer.addEventListener("icecandidate", (event) => {
      if (generation.closed) return;
      const ice = event.candidate;
      if (ice === null) {
        const sent = generation.negotiation.sendIceCandidate(null);
        if (!sent) generation.httpComplete = true;
        if (!sent) this.requestTrickle(group, generation);
        return;
      }
      const serialized = candidate(ice);
      const sent = generation.negotiation.sendIceCandidate(serialized);
      if (!sent) generation.localCandidates.push(serialized);
      if (!sent) this.requestTrickle(group, generation);
    });
    peer.addEventListener("track", (event) => {
      if (group.generation !== generation || generation.closed) return;
      this.forEachHandler(group, (on) => on.track?.(event));
    });
    peer.addEventListener("connectionstatechange", () => {
      if (group.generation !== generation || generation.closed) return;
      switch (peer.connectionState) {
        case "connected":
          this.maybeConnected(group, generation);
          return;
        case "disconnected":
          this.clearStableOpen(generation);
          if (group.state.phase === "connected") this.replace(group, DISCONNECTED);
          this.scheduleIceRestart(group, generation);
          return;
        case "failed":
          this.settle(group, generation, {
            kind: "recover",
            error: this.port.clientError(
              unavailable("WebRTC peer connection failed", true),
            ),
          });
          return;
        case "closed":
          group.explicitDisconnected = true;
          this.clearReconnect(group);
          this.stopGeneration(group, "realtime peer connection closed");
          this.replace(group, DISCONNECTED);
      }
    });
    peer.addEventListener("iceconnectionstatechange", () => {
      if (group.generation !== generation || generation.closed) return;
      switch (peer.iceConnectionState) {
        case "connected":
        case "completed":
          this.maybeConnected(group, generation);
          return;
        case "disconnected":
          this.clearStableOpen(generation);
          if (group.state.phase === "connected") this.replace(group, DISCONNECTED);
          this.scheduleIceRestart(group, generation);
          return;
        case "failed":
          this.settle(
            group,
            generation,
            {
              kind: "recover",
              error: this.port.clientError(
                unavailable("WebRTC ICE connection failed", true),
              ),
            },
          );
      }
    });
    peer.addEventListener("negotiationneeded", () => {
      if (generation.closed || group.generation !== generation) return;
      generation.negotiation.negotiationNeeded();
    });
    channel.addEventListener("open", () => {
      generation.negotiation.signalingTransportReady();
      this.requestTrickle(group, generation);
      this.maybeConnected(group, generation);
    });
    const dataChannelFailed = () => {
      if (group.generation !== generation || generation.closed) return;
      this.settle(group, generation, {
        kind: "recover",
        error: this.port.clientError(
          unavailable("WebRTC data channel failed", true),
        ),
      });
    };
    channel.addEventListener("close", dataChannelFailed);
    channel.addEventListener("error", dataChannelFailed);
  }

  private maybeConnected(group: Group, generation: PeerGeneration): void {
    if (
      group.generation !== generation ||
      generation.closed ||
      group.state.phase === "connected" ||
      generation.peer.connectionState !== "connected" ||
      generation.peer.iceConnectionState === "disconnected" ||
      generation.peer.iceConnectionState === "failed" ||
      generation.channel.readyState !== "open"
    ) {
      return;
    }
    this.clearPeerRecovery(generation);
    this.replace(group, Object.freeze({
      phase: "connected",
      peerConnection: generation.peer,
    }));
    this.armStableOpen(group, generation);
    this.forEachHandler(group, (on) => on.connected?.(generation.peer));
  }

  private scheduleIceRestart(
    group: Group,
    generation: PeerGeneration,
  ): void {
    if (
      generation.disconnectedHandle !== undefined ||
      generation.iceRestartHandle !== undefined ||
      generation.restartingIce
    ) {
      return;
    }
    generation.disconnectedHandle = this.port.clock.setTimeout(() => {
      generation.disconnectedHandle = undefined;
      void this.restartDisconnectedPeer(group, generation);
    }, this.port.reconnect.disconnectedGraceMs);
  }

  private async restartDisconnectedPeer(
    group: Group,
    generation: PeerGeneration,
  ): Promise<void> {
    if (
      group.generation !== generation ||
      generation.closed ||
      !this.peerIsDisconnected(generation.peer)
    ) {
      return;
    }
    if (!generation.negotiation.ready) {
      this.settle(group, generation, {
        kind: "recover",
        error: this.port.clientError(
          unavailable(
            "WebRTC disconnected before managed ICE restart became available",
            true,
          ),
        ),
      });
      return;
    }

    const error = this.port.clientError(
      unavailable("WebRTC peer connection is recovering", true),
    );
    generation.restartingIce = true;
    this.replace(group, Object.freeze({ phase: "reconnecting", error }));
    try {
      if (
        group.generation !== generation ||
        generation.closed ||
        !this.peerIsDisconnected(generation.peer)
      ) {
        return;
      }
      generation.peer.restartIce();
      generation.iceRestartHandle = this.port.clock.setTimeout(() => {
        generation.iceRestartHandle = undefined;
        if (
          group.generation !== generation ||
          generation.closed ||
          !this.peerIsDisconnected(generation.peer)
        ) {
          return;
        }
        this.settle(group, generation, {
          kind: "recover",
          error: this.port.clientError(
            unavailable("WebRTC ICE restart timed out", true),
          ),
        });
      }, this.port.reconnect.iceRestartTimeoutMs);
    } catch (cause) {
      if (
        group.generation === generation &&
        !generation.closed &&
        !generation.controller.signal.aborted
      ) {
        this.settle(group, generation, {
          kind: "recover",
          error: this.normalize(cause, "WebRTC ICE restart failed"),
        });
      }
    } finally {
      generation.restartingIce = false;
    }
  }

  private signalingFailed(
    group: Group,
    generation: PeerGeneration,
    error: unknown,
  ): void {
    if (generation.closed || group.generation !== generation) return;
    this.settle(group, generation, {
      kind: "recover",
      error: this.normalize(error, "realtime renegotiation failed"),
    });
  }

  private negotiationError(
    failure: PerfectNegotiationFailure,
  ): AckerDBClientError {
    if (failure === "signal-before-ready") {
      return this.port.clientError(
        unavailable(
          "realtime renegotiation arrived before initial negotiation completed",
          false,
        ),
      );
    }
    const message = {
      "missing-initial-offer": "WebRTC produced no local realtime offer",
      "missing-offer": "WebRTC produced no renegotiation offer",
      "missing-answer": "WebRTC produced no renegotiation answer",
    }[failure];
    return this.port.clientError(unexpected(message));
  }

  private async prepare(
    group: Group,
    signal: AbortSignal,
  ) {
    const body = encode(parseRealtimePrepareRequest({
      v: PROTOCOL_VERSION,
      t: "realtime_prepare",
      ref: group.address,
      args: group.args,
      ...(group.reconnectAttempt > 0 ? { recovery: true as const } : {}),
    }));
    const response = await this.port.fetch(
      this.port.url("/_realtime/prepare"),
      {
        method: "POST",
        headers: this.port.headers(),
        body,
        signal,
      },
    );
    const value = decode(await this.port.readResponse(response, signal));
    if (response.ok) return parseRealtimePrepareResponse(value);
    try {
      const parsed = parseRealtimePrepareResponse(value);
      if (parsed.t === "realtime_rejected") return parsed;
    } catch {
      // A framework error response is parsed below.
    }
    throw this.responseError(value);
  }

  private async offer(
    ticket: string,
    offer: { readonly type: "offer"; readonly sdp: string },
    generation: PeerGeneration,
  ) {
    const body = encode(parseRealtimeOfferRequest({
      v: PROTOCOL_VERSION,
      t: "realtime_offer",
      ticket,
      offer,
    }));
    const response = await this.port.fetch(
      this.port.url("/_realtime"),
      {
        method: "POST",
        headers: generation.headers,
        body,
        signal: generation.controller.signal,
      },
    );
    const value = decode(
      await this.port.readResponse(response, generation.controller.signal),
    );
    if (response.ok) return parseRealtimeOfferResponse(value);
    try {
      const parsed = parseRealtimeOfferResponse(value);
      if (parsed.t === "realtime_rejected") return parsed;
    } catch {
      // A framework error response is parsed below.
    }
    throw this.responseError(value);
  }

  private requestTrickle(group: Group, generation: PeerGeneration): void {
    if (group.generation !== generation || generation.closed) return;
    generation.trickleRequested = true;
    if (generation.trickleRunning || generation.sessionId === null) return;
    generation.trickleRunning = true;
    void this.trickle(group, generation).finally(() => {
      generation.trickleRunning = false;
      if (
        generation.trickleRequested &&
        group.generation === generation &&
        !generation.closed
      ) {
        this.requestTrickle(group, generation);
      }
    });
  }

  private flushTrickleToDataPlane(generation: PeerGeneration): boolean {
    if (!generation.negotiation.ready) return false;
    while (generation.localCandidates.length > 0) {
      const candidate = generation.localCandidates.shift()!;
      if (generation.negotiation.sendIceCandidate(candidate)) continue;
      generation.localCandidates.unshift(candidate);
      return false;
    }
    if (
      generation.httpComplete &&
      !generation.httpCompleteDelivered &&
      !generation.httpCompleteInFlight
    ) {
      if (!generation.negotiation.sendIceCandidate(null)) return false;
      generation.httpComplete = false;
      generation.httpCompleteDelivered = true;
    }
    return !generation.httpCompleteInFlight;
  }

  private async trickle(group: Group, generation: PeerGeneration): Promise<void> {
    try {
      while (group.generation === generation && !generation.closed) {
        generation.trickleRequested = false;
        // A channel can open in setRemoteDescription() before the initial
        // answer marks negotiation complete. Its open callback must wait for
        // that owner to hand signaling over instead of starting HTTP trickle.
        if (
          generation.channel.readyState === "open" &&
          !generation.negotiation.ready
        ) {
          return;
        }
        if (this.flushTrickleToDataPlane(generation)) return;
        const local = generation.localCandidates.splice(0);
        const complete = generation.httpComplete &&
          !generation.httpCompleteDelivered;
        const continuation = generation.httpCompleteDelivered &&
          !generation.serverComplete &&
          !generation.negotiation.ready &&
          local.length === 0;
        if (local.length === 0 && !complete && !continuation) return;
        if (generation.sessionId === null) return;
        const body = encode({
          v: PROTOCOL_VERSION,
          t: "realtime_candidates",
          candidates: local,
          complete,
        });
        generation.httpCompleteInFlight = complete;
        const response = await this.port.fetch(
          this.port.url(`/_realtime/${generation.sessionId}`),
          {
            method: "PATCH",
            headers: generation.headers,
            body,
            signal: generation.controller.signal,
          },
        );
        generation.httpCompleteInFlight = false;
        const value = decode(
          await this.port.readResponse(response, generation.controller.signal),
        );
        if (!response.ok) {
          try {
            const ended = parseRealtimePatchResponse(value);
            if (ended.t === "realtime_ended") {
              throw this.port.clientError(ended.outcome);
            }
          } catch (error) {
            if (this.port.isClientError(error)) throw error;
          }
          throw this.responseError(value);
        }
        const patch = parseRealtimePatchResponse(value);
        if (patch.t === "realtime_ended") {
          throw this.port.clientError(patch.outcome);
        }
        if (complete) generation.httpCompleteDelivered = true;
        generation.serverComplete = patch.complete;
        for (const ice of patch.candidates) {
          await generation.peer.addIceCandidate(ice);
        }
        if (this.flushTrickleToDataPlane(generation)) return;
        // An empty incomplete response is the server releasing its wait
        // because its internal data channel became ready. Wait for the
        // matching local open event instead of turning that hand-off into an
        // HTTP polling loop.
        if (
          !patch.complete &&
          patch.candidates.length === 0 &&
          generation.localCandidates.length === 0
        ) {
          return;
        }
        if (patch.complete && generation.localCandidates.length === 0) return;
      }
    } catch (error) {
      if (generation.closed || group.generation !== generation) return;
      const normalized = this.normalize(error, "realtime ICE signaling failed");
      this.settle(group, generation, {
        kind: normalized.retryable ? "recover" : "failed",
        error: normalized,
      });
    } finally {
      generation.httpCompleteInFlight = false;
    }
  }

  private incomingStream(
    group: Group,
    generation: PeerGeneration,
    stream: string,
    metadata: unknown,
    size: number | undefined,
  ) {
    const maxBytes = generation.serverStreamLimits[stream];
    const on = this.streamHandler(group, stream);
    if (maxBytes === undefined || on === undefined) return undefined;
    return Object.freeze({
      maxBytes,
      accept: (input: {
        readonly id: string;
        readonly readable: ReadableStream<Uint8Array>;
        readonly abortSignal: AbortSignal;
      }) => {
        const value = Object.freeze({
          id: input.id,
          ...(size === undefined ? {} : { size }),
          metadata,
          readable: input.readable,
          abortSignal: input.abortSignal,
        });
        return this.handleDataPlaneHandlers([() =>
          typeof on === "function"
            ? on(Object.freeze({ type: stream, ...value }) as never)
            : on[stream]?.(value)
        ]);
      },
    });
  }

  private deliverEvent(group: Group, event: string, payload: unknown): unknown {
    const work: Array<() => unknown> = [];
    for (const observation of this.handlers(group)) {
      const on = observation.on.event;
      if (on === undefined) continue;
      work.push(() =>
        typeof on === "function"
          ? on(Object.freeze({ type: event, payload }))
          : on[event]?.(payload)
      );
    }
    return this.handleDataPlaneHandlers(work);
  }

  private handlers(group: Group): HandlerObservation[] {
    const handlers: HandlerObservation[] = [];
    for (const observer of group.observers) {
      if (!observer.active) continue;
      for (const observation of observer.handlers) {
        if (observation.active) handlers.push(observation);
      }
    }
    return handlers;
  }

  private attachPeerHandler(
    group: Group,
    generation: PeerGeneration,
    observation: HandlerObservation,
  ): Promise<void> {
    if (!observation.active || observation.setupGeneration === generation.number) {
      return observation.setupPending ?? Promise.resolve();
    }
    observation.setupGeneration = generation.number;
    generation.handlerPending++;
    const run = (async () => {
      const setup = await observation.on.peerConnection?.(generation.peer);
      if (typeof setup !== "function") return;
      if (
        observation.active &&
        group.generation === generation &&
        !generation.closed
      ) {
        observation.setupCleanup = setup;
      } else {
        this.invokeHandler(setup);
      }
    })().finally(() => {
      generation.handlerPending--;
    });
    observation.setupPending = run;
    return run.finally(() => {
      if (observation.setupPending === run) observation.setupPending = undefined;
    });
  }

  private releaseHandler(
    observer: Observer,
    observation: HandlerObservation,
  ): void {
    if (!observation.active) return;
    observation.active = false;
    observer.handlers.delete(observation);
    const cleanup = observation.setupCleanup;
    observation.setupCleanup = undefined;
    if (cleanup !== undefined) this.invokeHandler(cleanup);
  }

  private forEachHandler(
    group: Group,
    work: (on: AckerDBRealtimeOn<EventMap, RealtimeStreamMap, unknown>) => unknown,
  ): void {
    for (const observation of this.handlers(group)) {
      this.invokeHandler(() => work(observation.on));
    }
  }

  private streamHandler(
    group: Group,
    stream: string,
  ): AckerDBRealtimeStreamOn<RealtimeStreamMap> | undefined {
    for (const observation of this.handlers(group)) {
      const on = observation.on.stream;
      if (typeof on === "function" || on?.[stream] !== undefined) return on;
    }
    return undefined;
  }

  private handleDataPlaneHandlers(work: Array<() => unknown>): unknown {
    const pending: PromiseLike<unknown>[] = [];
    let failed = false;
    for (const run of work) {
      try {
        const result = run();
        if (thenable(result)) pending.push(result);
      } catch {
        failed = true;
      }
    }
    if (pending.length === 0) {
      if (failed) throw HANDLER_FAILURE;
      return;
    }
    return Promise.allSettled(pending).then((settlements) => {
      if (failed || settlements.some((settlement) => settlement.status === "rejected")) {
        throw HANDLER_FAILURE;
      }
    });
  }

  private replace(group: Group, state: AckerDBRealtimeState<unknown>): void {
    if (group.state === state) return;
    const previous = group.state;
    group.state = state;
    this.forEachHandler(group, (on) => on.stateChange?.(state, previous));
    for (const observer of [...group.observers]) {
      for (const listener of [...observer.listeners]) listener();
    }
  }

  private settle(
    group: Group,
    generation: PeerGeneration | null,
    settlement: Settlement,
  ): void {
    if (
      (generation !== null && group.generation !== generation) ||
      group.closed ||
      this.closed
    ) {
      return;
    }
    if (settlement.kind === "recover") {
      const { error } = settlement;
      if (
        group.explicitDisconnected ||
        terminal(group.state) ||
        this.suspended
      ) {
        return;
      }
      if (error.retryable) {
        if (generation !== null) this.stopGeneration(group, error);
        this.replace(group, Object.freeze({ phase: "reconnecting", error }));
        if (group.reconnectHandle !== undefined) return;
        const windowMs = Math.min(
          this.port.reconnect.maxDelayMs,
          this.port.reconnect.baseDelayMs *
            2 ** Math.min(group.reconnectAttempt + 1, 30),
        );
        const random = this.port.random();
        if (!Number.isFinite(random) || random < 0 || random >= 1) {
          this.settle(group, null, {
            kind: "failed",
            error: this.port.clientError(
              unexpected("client random source is invalid"),
            ),
          });
          return;
        }
        const minimum = Math.max(
          this.port.reconnect.baseDelayMs,
          Math.min(error.retryAfterMs ?? 0, 30_000),
        );
        const ceiling = Math.max(minimum, windowMs);
        const delay = minimum + Math.floor(random * (ceiling - minimum + 1));
        group.reconnectAttempt++;
        group.reconnectHandle = this.port.clock.setTimeout(() => {
          group.reconnectHandle = undefined;
          void this.connect(group);
        }, delay);
        return;
      }
    }
    this.clearReconnect(group);
    this.stopGeneration(group, settlement.error);
    if (settlement.kind === "rejected") {
      this.replace(group, Object.freeze({
        phase: "rejected",
        error: settlement.error,
      }));
    } else {
      this.replace(group, Object.freeze({
        phase: "failed",
        error: settlement.error,
      }));
    }
  }

  private stopGeneration(
    group: Group,
    reason: unknown,
  ): void {
    group.pending?.abort(reason);
    group.pending = null;
    const generation = group.generation;
    if (generation === null || generation.closed) return;
    generation.closed = true;
    group.generation = null;
    this.clearPeerRecovery(generation);
    generation.controller.abort(reason);
    generation.dataPlane?.close(reason);
    generation.dataPlane = null;
    for (const observation of this.handlers(group)) {
      const cleanup = observation.setupCleanup;
      observation.setupCleanup = undefined;
      if (cleanup !== undefined) this.invokeHandler(cleanup);
    }
    if (generation.peer.connectionState !== "closed") generation.peer.close();
    this.cleanup(generation);
  }

  private clearReconnect(group: Group): void {
    if (group.reconnectHandle !== undefined) {
      this.port.clock.clearTimeout(group.reconnectHandle);
      group.reconnectHandle = undefined;
    }
  }

  private clearPeerRecovery(generation: PeerGeneration): void {
    if (generation.disconnectedHandle !== undefined) {
      this.port.clock.clearTimeout(generation.disconnectedHandle);
      generation.disconnectedHandle = undefined;
    }
    if (generation.iceRestartHandle !== undefined) {
      this.port.clock.clearTimeout(generation.iceRestartHandle);
      generation.iceRestartHandle = undefined;
    }
    if (generation.setupHandle !== undefined) {
      this.port.clock.clearTimeout(generation.setupHandle);
      generation.setupHandle = undefined;
    }
    this.clearStableOpen(generation);
  }

  private armStableOpen(group: Group, generation: PeerGeneration): void {
    if (generation.stableHandle !== undefined) return;
    generation.stableHandle = this.port.clock.setTimeout(() => {
      generation.stableHandle = undefined;
      if (
        group.generation === generation &&
        !generation.closed &&
        generation.peer.connectionState === "connected" &&
        generation.peer.iceConnectionState !== "disconnected" &&
        generation.peer.iceConnectionState !== "failed" &&
        generation.channel.readyState === "open"
      ) {
        group.reconnectAttempt = 0;
      }
    }, this.port.reconnect.stableOpenMs);
  }

  private clearStableOpen(generation: PeerGeneration): void {
    if (generation.stableHandle === undefined) return;
    this.port.clock.clearTimeout(generation.stableHandle);
    generation.stableHandle = undefined;
  }

  private peerIsDisconnected(peer: NativeRTCPeerConnection): boolean {
    return peer.connectionState === "disconnected" ||
      peer.iceConnectionState === "disconnected";
  }

  private cleanup(generation: PeerGeneration): void {
    if (generation.sessionId === null || generation.cleanupStarted) return;
    generation.cleanupStarted = true;
    const controller = new AbortController();
    const deadline = this.port.clock.setTimeout(
      () => controller.abort(),
      this.port.reconnect.realtimeSetupTimeoutMs,
    );
    let request: Promise<Response>;
    try {
      request = this.port.fetch(
        this.port.url(`/_realtime/${generation.sessionId}`),
        {
          method: "DELETE",
          headers: generation.headers,
          signal: controller.signal,
        },
      );
    } catch {
      this.port.clock.clearTimeout(deadline);
      return;
    }
    void request.then((response) => {
      void response.body?.cancel().catch(() => {});
    }).catch(() => {}).finally(() => {
      this.port.clock.clearTimeout(deadline);
    });
  }

  private responseError(value: unknown): AckerDBClientError {
    try {
      const frame = parseServerMessage(value);
      if (frame.t === "err") return this.port.clientError(frame.outcome);
    } catch (error) {
      return this.normalize(error, "invalid realtime error response");
    }
    return this.port.clientError(
      unavailable("realtime endpoint returned an invalid error", false),
    );
  }

  private terminalDataPlaneError(error: unknown): AckerDBClientError {
    if (error === HANDLER_FAILURE) {
      return this.port.clientError(
        unexpected("realtime event or stream handler failed"),
      );
    }
    if (this.port.isClientError(error)) return error;
    const normalized = this.normalize(error, "realtime data plane failed");
    return normalized.retryable
      ? this.port.clientError(unexpected("realtime data plane failed"))
      : normalized;
  }

  private normalize(error: unknown, message: string): AckerDBClientError {
    if (this.port.isClientError(error)) return error;
    if (error instanceof ProtocolError) {
      return this.port.clientError({
        code: error.code,
        retryable: false,
        message: error.message,
        resource: "connection",
      });
    }
    if (
      error instanceof WireError ||
      error instanceof RealtimeProtocolError ||
      error instanceof TypeError ||
      error instanceof RangeError
    ) {
      return this.port.clientError({
        code: "validation",
        retryable: false,
        message: error.message,
        resource: "connection",
      });
    }
    if (
      error instanceof DOMException &&
      (
        error.name === "NotSupportedError" ||
        error.name === "NotAllowedError" ||
        error.name === "SecurityError"
      )
    ) {
      return this.port.clientError({
        code: "validation",
        retryable: false,
        message: error.message,
        resource: "connection",
      });
    }
    return this.port.clientError(unavailable(message, true));
  }

  private requireCapabilities<T>(
    value: unknown,
    name: string,
    methods: readonly string[],
    properties: readonly string[],
  ): T {
    if (typeof value !== "object" || value === null) {
      throw new DOMException(`${name} must be an object`, "NotSupportedError");
    }
    const target = value as Record<string, unknown>;
    for (const method of methods) {
      if (typeof target[method] !== "function") {
        throw new DOMException(
          `${name} must support ${method}()`,
          "NotSupportedError",
        );
      }
    }
    for (const property of properties) {
      if (!(property in target)) {
        throw new DOMException(
          `${name} must expose ${property}`,
          "NotSupportedError",
        );
      }
    }
    return target as T;
  }

  private invokeHandler(work: () => unknown): void {
    try {
      const result = work();
      if (thenable(result)) {
        void Promise.resolve(result).catch((error) => {
          queueMicrotask(() => {
            throw error;
          });
        });
      }
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  }
}
