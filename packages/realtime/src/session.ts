import {
  PerfectNegotiation,
  RealtimeDataPlane,
  type RealtimeDataPlanePressure,
  type PerfectNegotiationFailure,
  type PortableMediaStreamTrack,
  type PortableRTCDataChannel,
  type PortableRTCPeerConnection,
  type RealtimeDataPlaneIncomingStream,
  type RealtimeIceCandidate,
} from "@ackerdb/core";
import type {
  AnyRegisteredRealtime,
  ProcedureCtx,
  RealtimeAudioSourceOptions,
  RealtimeAudioStreamOptions,
  RealtimeCtx,
  RealtimeIncomingStream,
  RealtimeMedia,
  RealtimeOutgoingStream,
  RealtimeResource,
  RealtimeVideoSourceOptions,
  RealtimeVideoStreamOptions,
} from "@ackerdb/server";
import { AckerDBError } from "@ackerdb/server";
import {
  deepFreeze,
  type RealtimeProcedureContextOwner,
  type RealtimeServerSessionAdapter,
} from "@ackerdb/server/realtime-host";
import type { RealtimePeerGeneration, RealtimePeerLimits } from "./engine.ts";
import { nativeDecodedStreamDrops } from "./native/media.ts";
import { RemoteCandidatePolicy } from "./remote-candidate-policy.ts";
import {
  observeNativePeerTerminal,
  type RealtimeNativeQueueTerminalCounts,
  type RealtimeNativeQueueTerminalReason,
} from "./native/peer-connection.ts";
import {
  type RealtimeGlobalResourceBudget,
  type RealtimeGlobalResourceKind,
} from "./resources.ts";

export interface RealtimeServerSessionLimits {
  readonly maxQueuedBytes: number;
  readonly maxBufferedAmount: number;
  readonly maxConcurrentStreams: number;
  readonly maxIncomingBufferedBytes: number;
  readonly defaultStreamMaxBytes: number;
  readonly maxInFlightHandlers: number;
  readonly streamIdleMs: number;
  readonly maxAuxiliaryPeers: number;
  readonly maxDecodedStreams: number;
  readonly maxMediaSources: number;
  readonly maxDataChannelsPerPeer?: number;
  readonly maxSendersPerPeer?: number;
  readonly maxTransceiversPerPeer?: number;
}

type EventHandler = (payload: unknown) => unknown;
type StreamHandler = (input: RealtimeIncomingStream<unknown>) => unknown;
type OwnedResourceKind =
  | "auxiliaryPeer"
  | "decodedStream"
  | "mediaSource";

interface OwnedRealtimeResource {
  readonly resource: RealtimeResource;
  readonly kind: OwnedResourceKind;
  readonly closeNative: () => void;
  readonly releaseGlobal: () => void;
  readonly removeNativeTerminal?: () => void;
  observedNativeMediaDrops: number;
  released: boolean;
}

export interface RealtimeServerSessionOptions {
  readonly definition: AnyRegisteredRealtime;
  readonly args: unknown;
  readonly state: unknown;
  readonly peerConnection: PortableRTCPeerConnection;
  readonly dataChannel: PortableRTCDataChannel;
  readonly generation: RealtimePeerGeneration;
  /** Hub-owned, generation-wide remote candidate policy and accounting. */
  readonly remoteCandidates: RemoteCandidatePolicy;
  readonly adapter: RealtimeServerSessionAdapter;
  readonly limits: RealtimeServerSessionLimits;
  readonly observePressure?: (pressure: RealtimeSessionPressure) => void;
  /** Internal fixed-cardinality terminal signal from an auxiliary native peer. */
  readonly onNativeQueueTerminal?: (
    reason: RealtimeNativeQueueTerminalReason,
  ) => void;
  readonly resourceBudget?: RealtimeGlobalResourceBudget;
  /** Setup-phase cancellation; the credential signal continues after setup. */
  readonly setupSignal?: AbortSignal;
}

export type RealtimeSessionPressure =
  | RealtimeDataPlanePressure
  | "handler-saturation"
  | "resource-saturation";

const GLOBAL_RESOURCE_KIND = Object.freeze({
  auxiliaryPeer: "auxiliaryPeers",
  decodedStream: "decodedStreams",
  mediaSource: "mediaSources",
} as const satisfies Record<
  "auxiliaryPeer" | "decodedStream" | "mediaSource",
  RealtimeGlobalResourceKind
>);

const EMPTY_NATIVE_QUEUE_TERMINALS: RealtimeNativeQueueTerminalCounts =
  Object.freeze({
    "queue-limit": 0,
    "process-byte-budget": 0,
    "generation-byte-budget": 0,
  });

/**
 * One authorized server peer generation. The public context exposes the actual
 * peer connection while this object owns only AckerDB's negotiated typed data
 * channel and generation-scoped handler registrations.
 */
export class RealtimeServerSession {
  readonly peerConnection: PortableRTCPeerConnection;
  readonly abortSignal: AbortSignal;

  private readonly definition: AnyRegisteredRealtime;
  private readonly args: unknown;
  private readonly state: unknown;
  private readonly adapter: RealtimeServerSessionAdapter;
  private readonly generation: RealtimePeerGeneration;
  private readonly limits: RealtimeServerSessionLimits;
  private readonly observePressure?: RealtimeServerSessionOptions["observePressure"];
  private readonly onNativeQueueTerminal?: RealtimeServerSessionOptions["onNativeQueueTerminal"];
  private readonly resourceBudget?: RealtimeGlobalResourceBudget;
  private readonly controller = new AbortController();
  private readonly contextOwner: RealtimeProcedureContextOwner;
  private readonly eventHandlers = new Map<string, EventHandler[]>();
  private readonly streamHandlers = new Map<string, StreamHandler>();
  private readonly dataPlane: RealtimeDataPlane;
  private readonly negotiation: PerfectNegotiation;
  private readonly dataChannel: PortableRTCDataChannel;
  private readonly context: RealtimeCtx<any, any, any, any, any, any>;
  private readonly ownedResources = new Set<OwnedRealtimeResource>();
  private readonly ownedResourceCounts = {
    auxiliaryPeer: 0,
    decodedStream: 0,
    mediaSource: 0,
  };
  private activeHandlers = 0;
  private nativeMediaDropCount = 0;
  private readonly nativeQueueTerminals = {
    "queue-limit": 0,
    "process-byte-budget": 0,
    "generation-byte-budget": 0,
  } satisfies Record<RealtimeNativeQueueTerminalReason, number>;
  private closed = false;

  private constructor(options: RealtimeServerSessionOptions) {
    this.definition = options.definition;
    this.args = options.args;
    this.state = options.state;
    this.peerConnection = options.peerConnection;
    this.generation = options.generation;
    this.adapter = options.adapter;
    this.limits = options.limits;
    this.observePressure = options.observePressure;
    this.onNativeQueueTerminal = options.onNativeQueueTerminal;
    this.resourceBudget = options.resourceBudget;
    this.abortSignal = this.controller.signal;
    this.contextOwner = this.adapter.createContext(this.controller.signal);
    this.context = this.createContext(this.contextOwner.value);
    this.dataChannel = options.dataChannel;
    this.dataPlane = new RealtimeDataPlane({
      channel: options.dataChannel,
      localPrefix: "s",
      maxBufferedAmount: options.limits.maxBufferedAmount,
      maxConcurrentStreams: options.limits.maxConcurrentStreams,
      maxIncomingBufferedBytes: options.limits.maxIncomingBufferedBytes,
      streamIdleMs: options.limits.streamIdleMs,
      onEvent: (event, payload) => this.receiveEvent(event, payload),
      onIncomingStream: (stream, metadata, size) =>
        this.receiveStream(stream, metadata, size),
      onSessionError: () => {
        throw new AckerDBError(
          "malformed",
          "client sent a server-owned realtime session error",
        );
      },
      onSignal: (frame) => {
        if (frame.t === "signal_candidate") {
          const candidate = options.remoteCandidates.acceptCandidate(
            frame.candidate,
          );
          if (candidate === undefined) return;
          return this.negotiation.receiveSignal({ ...frame, candidate });
        }
        const description = Object.freeze({
          ...frame.description,
          sdp: options.remoteCandidates.acceptSdp(frame.description.sdp),
        });
        return this.negotiation.receiveSignal({ ...frame, description });
      },
      onFatalError: (error) => this.fail(error),
      onPressure: (pressure) => this.pressure(pressure),
    });
    this.negotiation = new PerfectNegotiation({
      peerConnection: this.peerConnection,
      polite: false,
      signalingTransportReady: this.dataChannel.readyState === "open",
      sendSignal: (frame) => this.dataPlane.sendSignal(frame),
      createError: (failure) => this.negotiationError(failure),
      failed: (error) => this.fail(error),
    });
    this.peerConnection.addEventListener("connectionstatechange", this.peerStateChanged);
    this.peerConnection.addEventListener(
      "negotiationneeded",
      this.negotiation.negotiationNeeded,
    );
    this.dataChannel.addEventListener(
      "open",
      this.negotiation.signalingTransportReady,
    );
  }

  static async create(
    options: RealtimeServerSessionOptions,
  ): Promise<RealtimeServerSession> {
    const session = new RealtimeServerSession(options);
    const abortSetup = () => session.close(options.setupSignal?.reason);
    if (options.setupSignal?.aborted) {
      abortSetup();
    } else {
      options.setupSignal?.addEventListener("abort", abortSetup, {
        once: true,
      });
    }
    try {
      await session.invoke(() =>
        options.definition.handler(
          session.context as never,
          options.args as never,
        )
      );
      return session;
    } catch (error) {
      session.close(error);
      throw error;
    } finally {
      options.setupSignal?.removeEventListener("abort", abortSetup);
    }
  }

  close(reason: unknown = new Error("realtime session closed")): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort(reason);
    this.peerConnection.removeEventListener(
      "connectionstatechange",
      this.peerStateChanged,
    );
    this.peerConnection.removeEventListener(
      "negotiationneeded",
      this.negotiation.negotiationNeeded,
    );
    this.dataChannel.removeEventListener(
      "open",
      this.negotiation.signalingTransportReady,
    );
    this.dataPlane.close(reason);
    this.eventHandlers.clear();
    this.streamHandlers.clear();
    for (const owned of [...this.ownedResources].reverse()) {
      try {
        owned.resource.close();
      } catch (error) {
        this.adapter.failed(error);
      }
    }
    this.contextOwner.release();
    if (this.peerConnection.connectionState !== "closed") {
      this.peerConnection.close();
    }
  }

  sendSessionError(outcome: Parameters<RealtimeDataPlane["sendSessionError"]>[0]): boolean {
    return this.dataPlane.sendSessionError(outcome);
  }

  /** Cumulative upstream audio/video frames discarded before JavaScript. */
  nativeMediaDrops(): number {
    for (const owned of this.ownedResources) {
      this.captureNativeMediaDrops(owned);
    }
    return this.nativeMediaDropCount;
  }

  /** Fixed-cardinality native terminal observations from auxiliary peers. */
  nativeQueueTerminalCounts(): RealtimeNativeQueueTerminalCounts {
    return Object.freeze({ ...this.nativeQueueTerminals });
  }

  /** Called by the hub after the initial HTTP answer owns localDescription. */
  initialNegotiationComplete(): void {
    if (this.closed) return;
    // The initial answer already includes every peer mutation performed by the
    // awaited realtime handler. Any negotiationneeded event queued while that
    // answer was being assembled is therefore satisfied by the HTTP exchange,
    // not a request for an immediate second offer.
    this.negotiation.initialNegotiationComplete({
      discardPendingNegotiation: true,
    });
  }

  /**
   * Routes post-connect ICE through the ordered internal data channel. False
   * means the initial HTTP trickle still owns this candidate.
   */
  sendIceCandidate(candidate: RealtimeIceCandidate | null): boolean {
    return !this.closed && this.negotiation.sendIceCandidate(candidate);
  }

  private createContext(procedure: ProcedureCtx): RealtimeCtx<any, any, any, any, any, any> {
    const media: RealtimeMedia = Object.freeze({
      audioStream: (
        track: PortableMediaStreamTrack,
        options?: RealtimeAudioStreamOptions,
      ) =>
        this.createOwned(
          "decodedStream",
          this.limits.maxDecodedStreams,
          () => this.generation.createAudioStream(track, options),
        ),
      audioSource: (options?: RealtimeAudioSourceOptions) =>
        this.createOwned(
          "mediaSource",
          this.limits.maxMediaSources,
          () => this.generation.createAudioSource(options),
        ),
      videoStream: (
        track: PortableMediaStreamTrack,
        options?: RealtimeVideoStreamOptions,
      ) =>
        this.createOwned(
          "decodedStream",
          this.limits.maxDecodedStreams,
          () => this.generation.createVideoStream(track, options),
        ),
      videoSource: (options: RealtimeVideoSourceOptions) =>
        this.createOwned(
          "mediaSource",
          this.limits.maxMediaSources,
          () => this.generation.createVideoSource(options),
        ),
    });
    return Object.freeze({
      ...procedure,
      state: this.state,
      peerConnection: this.peerConnection,
      createPeerConnection: (configuration) =>
        this.createOwned(
          "auxiliaryPeer",
          this.limits.maxAuxiliaryPeers,
          () => this.generation.createPeerConnection(
            configuration,
            realtimePeerLimits(this.limits),
          ),
        ),
      run: (work: () => unknown): void => {
        if (typeof work !== "function") {
          throw new TypeError("realtime run work must be a function");
        }
        void this.invoke(work).catch((error) => this.fail(error));
      },
      media,
      on: (event: string, handler: EventHandler): (() => void) => {
        if (!Object.hasOwn(this.definition.clientEvents, event)) {
          throw new TypeError(`unknown client realtime event "${event}"`);
        }
        if (typeof handler !== "function") {
          throw new TypeError("realtime event handler must be a function");
        }
        let handlers = this.eventHandlers.get(event);
        if (handlers === undefined) {
          handlers = [];
          this.eventHandlers.set(event, handlers);
        }
        handlers.push(handler);
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          const current = this.eventHandlers.get(event);
          if (current === undefined) return;
          const index = current.indexOf(handler);
          if (index !== -1) current.splice(index, 1);
          if (current.length === 0) this.eventHandlers.delete(event);
        };
      },
      send: (event: string, payload: unknown): boolean => {
        const declaration = this.definition.serverEvents[event];
        if (declaration === undefined) {
          throw new TypeError(`unknown server realtime event "${event}"`);
        }
        const validated = deepFreeze(declaration.check(payload, `event.${event}`));
        return this.dataPlane.send(event, validated);
      },
      onStream: (stream: string, handler: StreamHandler): void => {
        if (!Object.hasOwn(this.definition.clientStreams, stream)) {
          throw new TypeError(`unknown client realtime stream "${stream}"`);
        }
        if (typeof handler !== "function") {
          throw new TypeError("realtime stream handler must be a function");
        }
        if (this.streamHandlers.has(stream)) {
          throw new TypeError(`realtime stream "${stream}" already has a handler`);
        }
        this.streamHandlers.set(stream, handler);
      },
      openStream: (
        stream: string,
        metadata: unknown,
        options?: { readonly size?: number },
      ): RealtimeOutgoingStream => {
        const declaration = this.definition.serverStreams[stream];
        if (declaration === undefined) {
          throw new TypeError(`unknown server realtime stream "${stream}"`);
        }
        const validated = deepFreeze(
          declaration.metadata.check(metadata, `stream.${stream}.metadata`),
        );
        return this.dataPlane.openStream(
          stream,
          validated,
          declaration.maxBytes ?? this.limits.defaultStreamMaxBytes,
          options?.size,
        );
      },
    });
  }

  private createOwned<Resource extends RealtimeResource>(
    kind: OwnedResourceKind,
    limit: number,
    create: () => Resource,
  ): Resource {
    if (this.ownedResourceCounts[kind] >= limit) {
      this.pressure("resource-saturation");
      throw new AckerDBError(
        "overloaded",
        `realtime ${kind} capacity is full`,
        { resource: "connection", retryable: true, retryAfterMs: 0 },
      );
    }
    const globalKind = GLOBAL_RESOURCE_KIND[kind];
    let releaseGlobal: () => void;
    try {
      releaseGlobal = this.resourceBudget?.claim(globalKind) ?? (() => {});
    } catch (error) {
      this.pressure("resource-saturation");
      throw error;
    }
    let resource: Resource;
    try {
      resource = create();
    } catch (error) {
      releaseGlobal();
      throw error;
    }
    const removeNativeTerminal = kind === "auxiliaryPeer"
      ? observeNativePeerTerminal(
        resource as unknown as PortableRTCPeerConnection,
        (reason) => this.recordNativeQueueTerminal(reason),
      )
      : undefined;
    if (this.closed) {
      try {
        removeNativeTerminal?.();
        resource.close();
      } finally {
        releaseGlobal();
      }
      throw new AckerDBError("unavailable", "realtime session is closed", {
        resource: "connection",
      });
    }
    const owned: OwnedRealtimeResource = {
      resource,
      kind,
      closeNative: resource.close.bind(resource),
      releaseGlobal,
      removeNativeTerminal,
      observedNativeMediaDrops: nativeDecodedStreamDrops(resource) ?? 0,
      released: false,
    };
    try {
      Object.defineProperty(resource, "close", {
        value: () => this.closeOwned(owned),
      });
    } catch (error) {
      try {
        owned.removeNativeTerminal?.();
        owned.closeNative();
      } finally {
        releaseGlobal();
      }
      throw new TypeError("realtime resource must expose an ownable close()", {
        cause: error,
      });
    }
    this.ownedResourceCounts[kind]++;
    this.ownedResources.add(owned);
    return resource;
  }

  private closeOwned(owned: OwnedRealtimeResource): void {
    if (owned.released) return;
    this.captureNativeMediaDrops(owned);
    owned.released = true;
    this.ownedResources.delete(owned);
    this.ownedResourceCounts[owned.kind]--;
    try {
      owned.removeNativeTerminal?.();
      owned.closeNative();
    } finally {
      owned.releaseGlobal();
    }
  }

  private captureNativeMediaDrops(owned: OwnedRealtimeResource): void {
    const current = nativeDecodedStreamDrops(owned.resource);
    if (current === undefined) return;
    this.nativeMediaDropCount += Math.max(
      0,
      current - owned.observedNativeMediaDrops,
    );
    owned.observedNativeMediaDrops = current;
  }

  private recordNativeQueueTerminal(
    reason: RealtimeNativeQueueTerminalReason,
  ): void {
    this.nativeQueueTerminals[reason]++;
    this.onNativeQueueTerminal?.(reason);
  }

  private receiveEvent(event: string, payload: unknown): void {
    const declaration = this.definition.clientEvents[event];
    if (declaration === undefined) {
      throw new AckerDBError(
        "validation",
        `unknown client realtime event "${event}"`,
      );
    }
    const validated = deepFreeze(declaration.check(payload, `event.${event}`));
    for (const handler of [...(this.eventHandlers.get(event) ?? [])]) {
      void this.invoke(() => handler(validated)).catch((error) => this.fail(error));
    }
  }

  private receiveStream(
    stream: string,
    metadata: unknown,
    size: number | undefined,
  ): {
    readonly maxBytes: number;
    readonly accept: (input: RealtimeDataPlaneIncomingStream) => unknown;
  } | undefined {
    const declaration = this.definition.clientStreams[stream];
    const handler = this.streamHandlers.get(stream);
    if (declaration === undefined || handler === undefined) return undefined;
    const validated = deepFreeze(
      declaration.metadata.check(metadata, `stream.${stream}.metadata`),
    );
    return Object.freeze({
      maxBytes: declaration.maxBytes ?? this.limits.defaultStreamMaxBytes,
      accept: (input: RealtimeDataPlaneIncomingStream) =>
        this.invoke(() =>
          handler(Object.freeze({
            id: input.id,
            ...(size === undefined ? {} : { size }),
            metadata: validated,
            readable: input.readable,
            abortSignal: input.abortSignal,
          }))
        ),
    });
  }

  private async invoke<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.closed) {
      throw new AckerDBError("unavailable", "realtime session is closed", {
        resource: "connection",
      });
    }
    if (this.activeHandlers >= this.limits.maxInFlightHandlers) {
      this.pressure("handler-saturation");
      throw new AckerDBError(
        "overloaded",
        "realtime handler capacity is full",
        { resource: "operation", retryable: true, retryAfterMs: 0 },
      );
    }
    this.activeHandlers++;
    try {
      return await this.adapter.invoke(
        this.definition,
        this.contextOwner.value,
        work,
      );
    } finally {
      this.activeHandlers--;
    }
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    try {
      this.adapter.failed(error);
    } finally {
      this.close(error);
    }
  }

  private pressure(pressure: RealtimeSessionPressure): void {
    try {
      this.observePressure?.(pressure);
    } catch {
      // Operational observation is fail-open and cannot alter media behavior.
    }
  }

  private negotiationError(failure: PerfectNegotiationFailure): AckerDBError {
    if (failure === "signal-before-ready") {
      return new AckerDBError(
        "malformed",
        "realtime renegotiation arrived before initial negotiation completed",
      );
    }
    const message = {
      "missing-initial-offer": "realtime peer produced no initial offer",
      "missing-offer": "realtime peer produced no renegotiation offer",
      "missing-answer": "realtime peer produced no renegotiation answer",
    }[failure];
    return new AckerDBError("internal", message);
  }

  private readonly peerStateChanged = (): void => {
    if (
      this.peerConnection.connectionState === "failed" ||
      this.peerConnection.connectionState === "closed"
    ) {
      this.close(
        new AckerDBError("unavailable", "realtime peer connection ended", {
          resource: "connection",
          retryable: this.peerConnection.connectionState === "failed",
        }),
      );
    }
  };
}

export function realtimePeerLimits(
  limits: RealtimeServerSessionLimits,
): RealtimePeerLimits {
  return Object.freeze({
    maxDataChannels: limits.maxDataChannelsPerPeer ?? 16,
    maxSenders: limits.maxSendersPerPeer ?? 32,
    maxTransceivers: limits.maxTransceiversPerPeer ?? 32,
  });
}
