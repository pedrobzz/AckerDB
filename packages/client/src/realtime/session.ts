import {
  PROTOCOL_VERSION,
  REALTIME_PROTOCOL_VERSION,
  ProtocolError,
  RealtimeDataPlane,
  RealtimeProtocolError,
  RealtimeStreamInterruptedError,
  WireError,
  decode,
  encode,
  getRef,
  parseRealtimeConfigurationMessage,
  parseRealtimeOfferRequest,
  parseRealtimeOfferResponse,
  parseRealtimePatchResponse,
  parseServerMessage,
  stableEncode,
  type ApplicationError,
  type AnyRealtimeRef,
  type EventMap,
  type EventUnion,
  type NativeRTCConfiguration,
  type NativeRTCDataChannel,
  type NativeRTCIceCandidate,
  type NativeRTCPeerConnection,
  type NativeRTCPeerConnectionIceEvent,
  type NativeRTCTrackEvent,
  type Outcome,
  type RealtimeArgs,
  type RealtimeClientEvents,
  type RealtimeClientStreams,
  type RealtimeError,
  type RealtimeIceCandidate,
  type RealtimeServerEvents,
  type RealtimeServerStreams,
  type RealtimeSignalFrame,
  type RealtimeStreamMap,
} from "@ackerdb/core";
import type {
  AckerDBClientError,
  AckerDBFetch,
  AckerDBReconnectOptions,
} from "../client.ts";

export type AckerDBPeerConnectionFactory = (
  configuration: NativeRTCConfiguration,
) => NativeRTCPeerConnection;

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

export interface AckerDBRealtimeOptions<
  ServerEvents extends EventMap,
  ServerStreams extends RealtimeStreamMap,
  Error = never,
> {
  /**
   * Makes equal client/ref/args calls one session and one complete `on`
   * bundle. A missing key is exclusive; a different key is a conflict.
   */
  readonly handlerKey?: string;
  readonly on?: AckerDBRealtimeOn<ServerEvents, ServerStreams, Error>;
}

export interface AckerDBRealtime<
  ClientEvents extends EventMap,
  ClientStreams extends RealtimeStreamMap,
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
  subscribe(listener: () => void): () => void;
  release(): void;
}

export class RealtimeHandlerKeyConflictError extends Error {
  constructor() {
    super(
      "equal realtime client/ref/args calls must all use the same non-empty handlerKey",
    );
    this.name = "RealtimeHandlerKeyConflictError";
  }
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
  readonly on?: AckerDBRealtimeOn<EventMap, RealtimeStreamMap, unknown>;
  readonly listeners: Set<() => void>;
  active: boolean;
}

interface PeerGeneration {
  readonly number: number;
  readonly peer: NativeRTCPeerConnection;
  readonly channel: NativeRTCDataChannel;
  readonly controller: AbortController;
  readonly headers: Readonly<Record<string, string>>;
  readonly localCandidates: RealtimeIceCandidate[];
  readonly recovery: boolean;
  dataPlane: RealtimeDataPlane | null;
  sessionId: string | null;
  clientStreamLimits: Readonly<Record<string, number>>;
  serverStreamLimits: Readonly<Record<string, number>>;
  setupCleanup?: () => void;
  signalingTail: Promise<void>;
  localComplete: boolean;
  serverComplete: boolean;
  initialNegotiationDone: boolean;
  signalingReady: boolean;
  makingOffer: boolean;
  settingRemoteAnswer: boolean;
  needsNegotiation: boolean;
  disconnectedHandle?: unknown;
  iceRestartHandle?: unknown;
  setupHandle?: unknown;
  restartingIce: boolean;
  closed: boolean;
}

interface Group {
  readonly key: string;
  readonly address: string;
  readonly args: unknown;
  readonly handlerKey: string | null;
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

const CONNECTING: AckerDBRealtimeState<never> = Object.freeze({
  phase: "connecting",
});
const DISCONNECTED: AckerDBRealtimeState<never> = Object.freeze({
  phase: "disconnected",
});
const SIGNALING_POLL_MS = 100;
const MAX_BUFFERED_AMOUNT = 1024 * 1024;
const MAX_CONCURRENT_STREAMS = 16;
const MAX_INCOMING_BUFFERED_BYTES = 256 * 1024;
const STREAM_IDLE_MS = 30_000;

function candidate(value: NativeRTCIceCandidate): RealtimeIceCandidate {
  const serialized = value.toJSON();
  return Object.freeze({
    candidate: serialized.candidate ?? "",
    ...(serialized.sdpMid === undefined ? {} : { sdpMid: serialized.sdpMid }),
    ...(serialized.sdpMLineIndex === undefined
      ? {}
      : { sdpMLineIndex: serialized.sdpMLineIndex }),
    ...(serialized.usernameFragment === undefined
      ? {}
      : { usernameFragment: serialized.usernameFragment }),
  });
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

  observe<Ref extends AnyRealtimeRef>(
    ref: Ref,
    args: NoInfer<RealtimeArgs<Ref>>,
    options: AckerDBRealtimeOptions<
      RealtimeServerEvents<Ref>,
      RealtimeServerStreams<Ref>,
      RealtimeError<Ref>
    > = {},
  ): AckerDBRealtime<
    RealtimeClientEvents<Ref>,
    RealtimeClientStreams<Ref>,
    RealtimeError<Ref>
  > {
    if (this.closed) {
      throw this.port.clientError(unavailable("client is closed", false));
    }
    if (
      options.handlerKey !== undefined &&
      (typeof options.handlerKey !== "string" || options.handlerKey.length === 0)
    ) {
      throw new TypeError("handlerKey must be a non-empty string");
    }
    const address = getRef(ref);
    const key = stableEncode([address, args]);
    const handlerKey = options.handlerKey ?? null;
    let group = this.byKey.get(key);
    if (group === undefined) {
      group = {
        key,
        address,
        args,
        handlerKey,
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
    } else if (
      group.handlerKey === null ||
      handlerKey === null ||
      group.handlerKey !== handlerKey
    ) {
      throw new RealtimeHandlerKeyConflictError();
    }
    const observer: Observer = {
      ...(options.on === undefined
        ? {}
        : {
            on: options.on as AckerDBRealtimeOn<
              EventMap,
              RealtimeStreamMap,
              unknown
            >,
          }),
      listeners: new Set(),
      active: true,
    };
    group.observers.add(observer);
    if (
      group.generation === null &&
      !group.explicitDisconnected &&
      !this.suspended
    ) {
      void this.connect(group);
    }
    return this.handle(group, observer) as AckerDBRealtime<
      RealtimeClientEvents<Ref>,
      RealtimeClientStreams<Ref>,
      RealtimeError<Ref>
    >;
  }

  authenticationChanged(): void {
    if (this.closed) return;
    for (const group of this.byKey.values()) {
      this.clearReconnect(group);
      this.stopGeneration(group, "AckerDB credential changed");
      if (!group.explicitDisconnected && !this.suspended) {
        this.replace(group, CONNECTING);
        void this.connect(group);
      }
    }
  }

  authenticationBlocked(error: AckerDBClientError): void {
    for (const group of this.byKey.values()) {
      this.clearReconnect(group);
      this.stopGeneration(group, error);
      this.replace(group, Object.freeze({ phase: "failed", error }));
    }
  }

  suspend(): void {
    if (this.closed || this.suspended) return;
    this.suspended = true;
    for (const group of this.byKey.values()) {
      this.clearReconnect(group);
      this.stopGeneration(group, "client suspended");
      this.replace(group, DISCONNECTED);
    }
  }

  resume(): void {
    if (this.closed || !this.suspended) return;
    this.suspended = false;
    for (const group of this.byKey.values()) {
      if (group.explicitDisconnected) continue;
      this.replace(group, CONNECTING);
      void this.connect(group);
    }
  }

  failAll(error: AckerDBClientError): void {
    for (const group of this.byKey.values()) {
      this.clearReconnect(group);
      this.stopGeneration(group, error);
      this.replace(group, Object.freeze({ phase: "failed", error }));
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
      }
      group.observers.clear();
    }
    this.byKey.clear();
  }

  private handle(
    group: Group,
    observer: Observer,
  ): AckerDBRealtime<EventMap, RealtimeStreamMap, unknown> {
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
      controller.abort(setupError);
      const generation = group.generation;
      if (generation !== null && generation.controller === controller) {
        this.recover(group, generation, setupError);
      } else if (group.pending === controller) {
        group.pending = null;
        this.recover(group, null, setupError);
      }
    }, this.port.reconnect.realtimeSetupTimeoutMs);
    let setupOwnedByGeneration = false;
    let peer: NativeRTCPeerConnection | undefined;
    try {
      const configuration = await this.configuration(controller.signal);
      if (
        controller.signal.aborted ||
        group.closed ||
        group.explicitDisconnected ||
        this.suspended ||
        this.closed
      ) {
        return;
      }
      peer = this.port.createPeerConnection(configuration);
      const channel = peer.createDataChannel("ackerdb.typed.v1", {
        negotiated: true,
        id: 0,
        ordered: true,
      });
      const generation: PeerGeneration = {
        number: ++group.nextGeneration,
        peer,
        channel,
        controller,
        headers: Object.freeze({ ...this.port.headers() }),
        localCandidates: [],
        recovery: group.reconnectAttempt > 0,
        dataPlane: null,
        sessionId: null,
        clientStreamLimits: Object.freeze({}),
        serverStreamLimits: Object.freeze({}),
        signalingTail: Promise.resolve(),
        localComplete: false,
        serverComplete: false,
        initialNegotiationDone: false,
        signalingReady: false,
        makingOffer: false,
        settingRemoteAnswer: false,
        needsNegotiation: false,
        restartingIce: false,
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
      let setup: void | (() => void);
      try {
        setup = await this.handler(group)?.on?.peerConnection?.(peer);
      } catch {
        throw this.port.clientError(
          unexpected("realtime on.peerConnection handler failed"),
        );
      }
      if (typeof setup === "function") {
        if (group.generation === generation && !generation.closed) {
          generation.setupCleanup = setup;
        } else {
          this.invokeHandler(setup);
        }
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
          if (outcome.retryable) this.recover(group, generation, error);
          else this.fail(group, generation, error);
        },
        onSignal: (frame) => this.receiveSignal(group, generation, frame),
        onFatalError: (error) => {
          this.fail(
            group,
            generation,
            this.normalize(error, "realtime data channel failed"),
          );
        },
      });

      generation.needsNegotiation = false;
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const local = peer.localDescription;
      if (local === null || local.type !== "offer" || local.sdp === undefined) {
        throw this.port.clientError(
          unexpected("WebRTC produced no local realtime offer"),
        );
      }
      const response = await this.offer(
        group.address,
        group.args,
        { type: "offer", sdp: local.sdp },
        generation,
      );
      if (group.generation !== generation || generation.closed) return;
      if (response.t === "realtime_rejected") {
        this.stopGeneration(group, response.error);
        this.replace(group, Object.freeze({
          phase: "rejected",
          error: response.error,
        }));
        return;
      }
      generation.sessionId = response.sessionId;
      generation.serverComplete = response.complete;
      generation.clientStreamLimits = response.streamLimits.client;
      generation.serverStreamLimits = response.streamLimits.server;
      await peer.setRemoteDescription(response.answer);
      generation.initialNegotiationDone = true;
      this.enableSignalingWhenReady(group, generation);
      for (const ice of response.candidates) {
        await peer.addIceCandidate(ice);
      }
      this.maybeConnected(group, generation);
      void this.trickle(group, generation);
    } catch (error) {
      if (controller.signal.aborted || group.closed) return;
      const normalized = this.normalize(error, "realtime signaling failed");
      if (normalized.retryable) {
        if (group.generation === null && peer !== undefined) peer.close();
        this.recover(group, group.generation, normalized);
      } else {
        if (group.generation === null && peer !== undefined) peer.close();
        this.fail(group, group.generation, normalized);
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
      const ice = (event as NativeRTCPeerConnectionIceEvent).candidate;
      const serialized = ice === null ? null : candidate(ice);
      if (ice === null) generation.localComplete = true;
      if (generation.signalingReady) {
        void this.sequenceSignaling(generation, () =>
          generation.dataPlane!.sendSignal({
            v: REALTIME_PROTOCOL_VERSION,
            t: "signal_candidate",
            candidate: serialized,
          })
        ).catch((error) => this.signalingFailed(group, generation, error));
      } else if (ice !== null) {
        generation.localCandidates.push(candidate(ice));
      }
    });
    peer.addEventListener("track", (event) => {
      if (group.generation !== generation || generation.closed) return;
      this.invokeHandler(() =>
        this.handler(group)?.on?.track?.(event as NativeRTCTrackEvent)
      );
    });
    peer.addEventListener("connectionstatechange", () => {
      if (group.generation !== generation || generation.closed) return;
      switch (peer.connectionState) {
        case "connected":
          this.clearPeerRecovery(generation);
          this.maybeConnected(group, generation);
          return;
        case "disconnected":
          if (group.state.phase === "connected") this.replace(group, DISCONNECTED);
          this.scheduleIceRestart(group, generation);
          return;
        case "failed":
          this.recover(
            group,
            generation,
            this.port.clientError(
              unavailable("WebRTC peer connection failed", true),
            ),
          );
          return;
        case "closed":
          if (!generation.closed) {
            group.explicitDisconnected = true;
            this.stopGeneration(group, "native peer was closed");
            this.replace(group, DISCONNECTED);
          }
      }
    });
    peer.addEventListener("negotiationneeded", () => {
      this.negotiationNeeded(group, generation);
    });
    channel.addEventListener("open", () => {
      this.enableSignalingWhenReady(group, generation);
      this.maybeConnected(group, generation);
    });
  }

  private maybeConnected(group: Group, generation: PeerGeneration): void {
    if (
      group.generation !== generation ||
      generation.closed ||
      group.state.phase === "connected" ||
      generation.peer.connectionState !== "connected" ||
      generation.channel.readyState !== "open"
    ) {
      return;
    }
    group.reconnectAttempt = 0;
    this.replace(group, Object.freeze({
      phase: "connected",
      peerConnection: generation.peer,
    }));
    this.invokeHandler(() =>
      this.handler(group)?.on?.connected?.(generation.peer)
    );
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
      generation.peer.connectionState !== "disconnected"
    ) {
      return;
    }
    if (!generation.signalingReady) {
      this.recover(
        group,
        generation,
        this.port.clientError(
          unavailable(
            "WebRTC disconnected before managed ICE restart became available",
            true,
          ),
        ),
      );
      return;
    }

    const error = this.port.clientError(
      unavailable("WebRTC peer connection is recovering", true),
    );
    generation.restartingIce = true;
    this.replace(group, Object.freeze({ phase: "reconnecting", error }));
    try {
      const configuration = await this.configuration(
        generation.controller.signal,
      );
      if (
        group.generation !== generation ||
        generation.closed ||
        generation.peer.connectionState !== "disconnected"
      ) {
        return;
      }
      generation.peer.setConfiguration(configuration);
      generation.peer.restartIce();
      generation.iceRestartHandle = this.port.clock.setTimeout(() => {
        generation.iceRestartHandle = undefined;
        if (
          group.generation !== generation ||
          generation.closed ||
          generation.peer.connectionState === "connected"
        ) {
          return;
        }
        this.recover(
          group,
          generation,
          this.port.clientError(
            unavailable("WebRTC ICE restart timed out", true),
          ),
        );
      }, this.port.reconnect.iceRestartTimeoutMs);
    } catch (cause) {
      if (
        group.generation === generation &&
        !generation.closed &&
        !generation.controller.signal.aborted
      ) {
        this.recover(
          group,
          generation,
          this.normalize(cause, "WebRTC ICE restart failed"),
        );
      }
    } finally {
      generation.restartingIce = false;
    }
  }

  private enableSignalingWhenReady(
    group: Group,
    generation: PeerGeneration,
  ): void {
    if (
      group.generation !== generation ||
      generation.closed ||
      generation.signalingReady ||
      !generation.initialNegotiationDone ||
      generation.channel.readyState !== "open"
    ) {
      return;
    }
    generation.signalingReady = true;
    if (generation.needsNegotiation) {
      this.negotiationNeeded(group, generation);
    }
  }

  private negotiationNeeded(group: Group, generation: PeerGeneration): void {
    if (generation.closed || group.generation !== generation) return;
    if (!generation.signalingReady) {
      generation.needsNegotiation = true;
      return;
    }
    generation.needsNegotiation = false;
    void this.sequenceSignaling(generation, async () => {
      try {
        generation.makingOffer = true;
        const offer = await generation.peer.createOffer();
        await generation.peer.setLocalDescription(offer);
        const local = generation.peer.localDescription;
        if (local === null || local.type !== "offer" || local.sdp === undefined) {
          throw this.port.clientError(
            unexpected("WebRTC produced no renegotiation offer"),
          );
        }
        await generation.dataPlane!.sendSignal({
          v: REALTIME_PROTOCOL_VERSION,
          t: "signal_description",
          description: { type: "offer", sdp: local.sdp },
        });
      } finally {
        generation.makingOffer = false;
      }
    }).catch((error) => this.signalingFailed(group, generation, error));
  }

  private receiveSignal(
    group: Group,
    generation: PeerGeneration,
    frame: RealtimeSignalFrame,
  ): Promise<void> {
    return this.sequenceSignaling(generation, async () => {
      if (!generation.signalingReady) {
        throw this.port.clientError(
          unavailable(
            "realtime renegotiation arrived before initial negotiation completed",
            false,
          ),
        );
      }
      if (frame.t === "signal_candidate") {
        await generation.peer.addIceCandidate(frame.candidate);
        return;
      }

      const { description } = frame;
      const readyForOffer =
        !generation.makingOffer &&
        (
          generation.peer.signalingState === "stable" ||
          generation.settingRemoteAnswer
        );
      const offerCollision =
        description.type === "offer" && !readyForOffer;
      if (
        offerCollision &&
        generation.peer.signalingState !== "stable"
      ) {
        await generation.peer.setLocalDescription({ type: "rollback" });
      }
      generation.settingRemoteAnswer = description.type === "answer";
      try {
        await generation.peer.setRemoteDescription(description);
      } finally {
        generation.settingRemoteAnswer = false;
      }
      if (description.type === "answer") return;
      const answer = await generation.peer.createAnswer();
      await generation.peer.setLocalDescription(answer);
      const local = generation.peer.localDescription;
      if (local === null || local.type !== "answer" || local.sdp === undefined) {
        throw this.port.clientError(
          unexpected("WebRTC produced no renegotiation answer"),
        );
      }
      await generation.dataPlane!.sendSignal({
        v: REALTIME_PROTOCOL_VERSION,
        t: "signal_description",
        description: { type: "answer", sdp: local.sdp },
      });
    });
  }

  private sequenceSignaling<T>(
    generation: PeerGeneration,
    work: () => T | Promise<T>,
  ): Promise<T> {
    const result = generation.signalingTail.then(work);
    generation.signalingTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private signalingFailed(
    group: Group,
    generation: PeerGeneration,
    error: unknown,
  ): void {
    if (generation.closed || group.generation !== generation) return;
    this.recover(
      group,
      generation,
      this.normalize(error, "realtime renegotiation failed"),
    );
  }

  private async configuration(
    signal: AbortSignal,
  ): Promise<NativeRTCConfiguration> {
    const response = await this.port.fetch(
      this.port.url("/api/realtime/config"),
      {
        method: "GET",
        headers: this.port.headers(),
        signal,
      },
    );
    const value = decode(await this.port.readResponse(response, signal));
    if (!response.ok) throw this.responseError(value);
    return parseRealtimeConfigurationMessage(value).configuration;
  }

  private async offer(
    address: string,
    args: unknown,
    offer: { readonly type: "offer"; readonly sdp: string },
    generation: PeerGeneration,
  ) {
    const body = encode(parseRealtimeOfferRequest({
      v: PROTOCOL_VERSION,
      t: "realtime_offer",
      ref: address,
      args,
      offer,
      ...(generation.recovery ? { recovery: true as const } : {}),
    }));
    const response = await this.port.fetch(
      this.port.url("/api/realtime"),
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

  private async trickle(group: Group, generation: PeerGeneration): Promise<void> {
    try {
      while (
        group.generation === generation &&
        !generation.closed &&
        (
          !generation.localComplete ||
          !generation.serverComplete ||
          generation.localCandidates.length > 0
        )
      ) {
        await this.delay(SIGNALING_POLL_MS, generation.controller.signal);
        if (generation.closed || group.generation !== generation) return;
        const local = generation.localCandidates.splice(0);
        const body = encode({
          v: PROTOCOL_VERSION,
          t: "realtime_candidates",
          candidates: local,
          complete: generation.localComplete,
        });
        const response = await this.port.fetch(
          this.port.url(`/api/realtime/${generation.sessionId}`),
          {
            method: "PATCH",
            headers: generation.headers,
            body,
            signal: generation.controller.signal,
          },
        );
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
        generation.serverComplete = patch.complete;
        for (const ice of patch.candidates) {
          await generation.peer.addIceCandidate(ice);
        }
      }
    } catch (error) {
      if (generation.closed || group.generation !== generation) return;
      const normalized = this.normalize(error, "realtime ICE signaling failed");
      if (normalized.retryable) this.recover(group, generation, normalized);
      else this.fail(group, generation, normalized);
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
    const on = this.handler(group)?.on?.stream;
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
        return typeof on === "function"
          ? on(Object.freeze({ type: stream, ...value }) as never)
          : on[stream]?.(value);
      },
    });
  }

  private deliverEvent(group: Group, event: string, payload: unknown): unknown {
    const on = this.handler(group)?.on?.event;
    if (on === undefined) return;
    return typeof on === "function"
      ? on(Object.freeze({ type: event, payload }))
      : on[event]?.(payload);
  }

  private handler(group: Group): Observer | undefined {
    for (const observer of group.observers) {
      if (observer.active) return observer;
    }
    return undefined;
  }

  private replace(group: Group, state: AckerDBRealtimeState<unknown>): void {
    if (group.state === state) return;
    const previous = group.state;
    group.state = state;
    this.invokeHandler(() =>
      this.handler(group)?.on?.stateChange?.(state, previous)
    );
    for (const observer of [...group.observers]) {
      for (const listener of [...observer.listeners]) listener();
    }
  }

  private recover(
    group: Group,
    generation: PeerGeneration | null,
    error: AckerDBClientError,
  ): void {
    if (
      group.closed ||
      group.explicitDisconnected ||
      this.suspended ||
      this.closed
    ) {
      return;
    }
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
      this.fail(
        group,
        null,
        this.port.clientError(unexpected("client random source is invalid")),
      );
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
  }

  private fail(
    group: Group,
    generation: PeerGeneration | null,
    error: AckerDBClientError,
  ): void {
    this.clearReconnect(group);
    if (generation !== null) this.stopGeneration(group, error);
    this.replace(group, Object.freeze({ phase: "failed", error }));
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
    try {
      generation.setupCleanup?.();
    } catch (error) {
      this.invokeHandler(() => {
        throw error;
      });
    }
    if (generation.peer.connectionState !== "closed") generation.peer.close();
    if (generation.sessionId !== null) {
      void this.port.fetch(
        this.port.url(`/api/realtime/${generation.sessionId}`),
        {
          method: "DELETE",
          headers: generation.headers,
        },
      ).then((response) => response.body?.cancel()).catch(() => {});
    }
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
  }

  private delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const handle = this.port.clock.setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, milliseconds);
      const abort = () => {
        this.port.clock.clearTimeout(handle);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
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

  private invokeHandler(work: () => unknown): void {
    try {
      const result = work();
      if (
        typeof result === "object" &&
        result !== null &&
        typeof (result as PromiseLike<unknown>).then === "function"
      ) {
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
