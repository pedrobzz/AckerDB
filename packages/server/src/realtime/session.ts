import {
  REALTIME_PROTOCOL_VERSION,
  RealtimeDataPlane,
  type RealtimeDataPlanePressure,
  type NativeRTCDataChannel,
  type PortableMediaStreamTrack,
  type PortableRTCDataChannel,
  type PortableRTCPeerConnection,
  type RealtimeDataPlaneIncomingStream,
  type RealtimeIceCandidate,
  type RealtimeSignalFrame,
} from "@ackerdb/core";
import type {
  OwnedProcedureContext,
  ProcedureCtx,
} from "../app/functions.ts";
import { AckerDBError } from "../shared/errors.ts";
import { deepFreeze } from "../shared/immutable.ts";
import type {
  AnyRegisteredRealtime,
  RealtimeCtx,
  RealtimeIncomingStream,
  RealtimeOutgoingStream,
} from "./definition.ts";
import type { RealtimePeerEngine, RealtimePeerLimits } from "./engine.ts";
import type {
  RealtimeAudioSourceOptions,
  RealtimeAudioStreamOptions,
  RealtimeMedia,
  RealtimeResource,
  RealtimeVideoSourceOptions,
  RealtimeVideoStreamOptions,
} from "./media.ts";
import {
  type RealtimeGlobalResourceBudget,
  type RealtimeGlobalResourceKind,
} from "./resources.ts";

export interface RealtimeServerSessionLimits {
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

export interface RealtimeServerSessionAdapter {
  createContext(signal: AbortSignal): OwnedProcedureContext;
  invoke<T>(
    definition: AnyRegisteredRealtime,
    context: ProcedureCtx,
    work: () => T | Promise<T>,
  ): Promise<T>;
  failed(error: unknown): void;
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
  released: boolean;
}

export interface RealtimeServerSessionOptions {
  readonly definition: AnyRegisteredRealtime;
  readonly args: unknown;
  readonly state: unknown;
  readonly peerConnection: PortableRTCPeerConnection;
  readonly dataChannel: PortableRTCDataChannel;
  readonly engine: RealtimePeerEngine;
  readonly adapter: RealtimeServerSessionAdapter;
  readonly limits: RealtimeServerSessionLimits;
  readonly observePressure?: (pressure: RealtimeSessionPressure) => void;
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
  private readonly engine: RealtimePeerEngine;
  private readonly limits: RealtimeServerSessionLimits;
  private readonly observePressure?: RealtimeServerSessionOptions["observePressure"];
  private readonly resourceBudget?: RealtimeGlobalResourceBudget;
  private readonly controller = new AbortController();
  private readonly contextOwner: OwnedProcedureContext;
  private readonly eventHandlers = new Map<string, EventHandler[]>();
  private readonly streamHandlers = new Map<string, StreamHandler>();
  private readonly dataPlane: RealtimeDataPlane;
  private readonly dataChannel: PortableRTCDataChannel;
  private readonly context: RealtimeCtx<any, any, any, any, any, any>;
  private readonly ownedResources = new Set<OwnedRealtimeResource>();
  private readonly ownedResourceCounts = {
    auxiliaryPeer: 0,
    decodedStream: 0,
    mediaSource: 0,
  };
  private activeHandlers = 0;
  private signalingTail = Promise.resolve();
  private initialNegotiationDone = false;
  private signalingReady = false;
  private makingOffer = false;
  private ignoreOffer = false;
  private needsNegotiation = false;
  private closed = false;

  private constructor(options: RealtimeServerSessionOptions) {
    this.definition = options.definition;
    this.args = options.args;
    this.state = options.state;
    this.peerConnection = options.peerConnection;
    this.engine = options.engine;
    this.adapter = options.adapter;
    this.limits = options.limits;
    this.observePressure = options.observePressure;
    this.resourceBudget = options.resourceBudget;
    this.abortSignal = this.controller.signal;
    this.contextOwner = this.adapter.createContext(this.controller.signal);
    this.context = this.createContext(this.contextOwner.value);
    this.dataChannel = options.dataChannel;
    this.dataPlane = new RealtimeDataPlane({
      channel: options.dataChannel as unknown as NativeRTCDataChannel,
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
      onSignal: (frame) => this.receiveSignal(frame),
      onFatalError: (error) => this.fail(error),
      onPressure: (pressure) => this.pressure(pressure),
    });
    this.peerConnection.addEventListener("connectionstatechange", this.peerStateChanged);
    this.peerConnection.addEventListener(
      "negotiationneeded",
      this.negotiationNeeded,
    );
    this.dataChannel.addEventListener("open", this.dataChannelOpened);
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
      this.negotiationNeeded,
    );
    this.dataChannel.removeEventListener("open", this.dataChannelOpened);
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

  /** Called by the hub after the initial HTTP answer owns localDescription. */
  initialNegotiationComplete(): void {
    if (this.closed) return;
    // The initial answer already includes every peer mutation performed by the
    // awaited realtime handler. Any negotiationneeded event queued while that
    // answer was being assembled is therefore satisfied by the HTTP exchange,
    // not a request for an immediate second offer.
    this.needsNegotiation = false;
    this.initialNegotiationDone = true;
    this.enableSignalingWhenReady();
  }

  /**
   * Routes post-connect ICE through the ordered internal data channel. False
   * means the initial HTTP trickle still owns this candidate.
   */
  sendIceCandidate(candidate: RealtimeIceCandidate | null): boolean {
    if (!this.signalingReady || this.closed) return false;
    void this.sequenceSignaling(() =>
      this.dataPlane.sendSignal({
        v: REALTIME_PROTOCOL_VERSION,
        t: "signal_candidate",
        candidate,
      })
    ).catch((error) => this.fail(error));
    return true;
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
          () => this.engine.createAudioStream(track, options),
        ),
      audioSource: (options?: RealtimeAudioSourceOptions) =>
        this.createOwned(
          "mediaSource",
          this.limits.maxMediaSources,
          () => this.engine.createAudioSource(options),
        ),
      videoStream: (
        track: PortableMediaStreamTrack,
        options?: RealtimeVideoStreamOptions,
      ) =>
        this.createOwned(
          "decodedStream",
          this.limits.maxDecodedStreams,
          () => this.engine.createVideoStream(track, options),
        ),
      videoSource: (options: RealtimeVideoSourceOptions) =>
        this.createOwned(
          "mediaSource",
          this.limits.maxMediaSources,
          () => this.engine.createVideoSource(options),
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
          () => this.engine.createPeerConnection(
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
    if (this.closed) {
      resource.close();
      releaseGlobal();
      throw new AckerDBError("unavailable", "realtime session is closed", {
        resource: "connection",
      });
    }
    const owned: OwnedRealtimeResource = {
      resource,
      kind,
      closeNative: resource.close.bind(resource),
      releaseGlobal,
      released: false,
    };
    try {
      Object.defineProperty(resource, "close", {
        value: () => this.closeOwned(owned),
      });
    } catch (error) {
      try {
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
    owned.released = true;
    this.ownedResources.delete(owned);
    this.ownedResourceCounts[owned.kind]--;
    try {
      owned.closeNative();
    } finally {
      owned.releaseGlobal();
    }
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

  private receiveSignal(frame: RealtimeSignalFrame): Promise<void> {
    return this.sequenceSignaling(async () => {
      if (!this.signalingReady) {
        throw new AckerDBError(
          "malformed",
          "realtime renegotiation arrived before initial negotiation completed",
        );
      }
      if (frame.t === "signal_candidate") {
        if (!this.ignoreOffer) {
          await this.peerConnection.addIceCandidate(frame.candidate);
        }
        return;
      }

      const { description } = frame;
      const offerCollision =
        description.type === "offer" &&
        (
          this.makingOffer ||
          this.peerConnection.signalingState !== "stable"
        );
      this.ignoreOffer = offerCollision;
      if (this.ignoreOffer) return;
      await this.peerConnection.setRemoteDescription(description);
      if (description.type === "answer") return;
      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);
      const local = this.peerConnection.localDescription;
      if (local === null || local.type !== "answer" || local.sdp === undefined) {
        throw new AckerDBError(
          "internal",
          "realtime peer produced no renegotiation answer",
        );
      }
      await this.dataPlane.sendSignal({
        v: REALTIME_PROTOCOL_VERSION,
        t: "signal_description",
        description: { type: "answer", sdp: local.sdp },
      });
    });
  }

  private sequenceSignaling<T>(work: () => T | Promise<T>): Promise<T> {
    const result = this.signalingTail.then(work);
    this.signalingTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private enableSignalingWhenReady(): void {
    if (
      this.signalingReady ||
      !this.initialNegotiationDone ||
      this.dataChannel.readyState !== "open"
    ) {
      return;
    }
    this.signalingReady = true;
    if (this.needsNegotiation) this.negotiationNeeded();
  }

  private readonly dataChannelOpened = (): void => {
    this.enableSignalingWhenReady();
  };

  private readonly negotiationNeeded = (): void => {
    if (this.closed) return;
    if (!this.signalingReady) {
      this.needsNegotiation = true;
      return;
    }
    this.needsNegotiation = false;
    void this.sequenceSignaling(async () => {
      try {
        this.makingOffer = true;
        const offer = await this.peerConnection.createOffer();
        await this.peerConnection.setLocalDescription(offer);
        const local = this.peerConnection.localDescription;
        if (local === null || local.type !== "offer" || local.sdp === undefined) {
          throw new AckerDBError(
            "internal",
            "realtime peer produced no renegotiation offer",
          );
        }
        await this.dataPlane.sendSignal({
          v: REALTIME_PROTOCOL_VERSION,
          t: "signal_description",
          description: { type: "offer", sdp: local.sdp },
        });
      } finally {
        this.makingOffer = false;
      }
    }).catch((error) => this.fail(error));
  };

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
