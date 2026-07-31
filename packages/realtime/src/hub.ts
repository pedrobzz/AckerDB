import { randomBytes } from "node:crypto";
import {
  parseRealtimeIceCandidate,
  parseRealtimeSessionDescription,
  stableEncode,
  type Outcome,
  type PortableRTCConfiguration,
  type PortableRTCDataChannel,
  type PortableRTCPeerConnection,
  type PortableRTCPeerConnectionIceEvent,
  type RealtimeCandidateBatch,
  type RealtimeIceCandidate,
} from "@ackerdb/core";
import {
  AckerDBError,
  type AnyRegisteredRealtime,
  type Principal,
} from "@ackerdb/server";
import {
  outcomeFromError,
  positiveSafeInteger,
  settleOnAbort,
  type RealtimeCloseReason,
  type RealtimeHealthSnapshot,
  type RealtimeOfferInput,
  type RealtimeOfferResult,
  type RealtimePatchResult,
  type RealtimeRuntimeApplication,
  type RealtimeRuntimeSnapshot,
  type RealtimeServerSessionAdapter,
} from "@ackerdb/server/realtime-host";
import {
  RealtimeServerSession,
  realtimePeerLimits,
  type RealtimeSessionPressure,
  type RealtimeServerSessionLimits,
} from "./session.ts";
import type {
  RealtimeConfigurationSource,
  RealtimePeerEngine,
} from "./engine.ts";
import {
  realtimePeerDiagnostic,
  type RealtimePeerDiagnostic,
} from "./diagnostics.ts";
import type { RealtimeNetworkDiagnostic } from "./network.ts";
import { nativePeerPressure } from "./native/peer-connection.ts";
import {
  REALTIME_GLOBAL_RESOURCE_DEFAULTS,
  RealtimeGlobalResourceBudget,
  type RealtimeGlobalResourceLimits,
  type RealtimeGlobalResourceSnapshot,
} from "./resources.ts";

export interface RealtimeHubOptions {
  readonly definition: (address: string) => AnyRegisteredRealtime | undefined;
  readonly engine: RealtimePeerEngine;
  readonly configuration: RealtimeConfigurationSource;
  readonly application: RealtimeRuntimeApplication;
  readonly sessionLimits: RealtimeServerSessionLimits;
  readonly resourceLimits?: Partial<RealtimeGlobalResourceLimits>;
  /** Package-internal shared budget used by the bundled native engine. */
  readonly resourceBudget?: RealtimeGlobalResourceBudget;
  readonly maxSessions: number;
  readonly maxSessionsPerPrincipal: number;
  readonly maxHandshakesPerWindow: number;
  readonly handshakeWindowMs: number;
  readonly maxTrackedPrincipals: number;
  readonly maxPendingCandidates: number;
  readonly terminalRetentionMs: number;
  readonly now: () => number;
  readonly networkDiagnostic?: RealtimeNetworkDiagnostic;
  readonly authorizationTimeoutMs?: number;
  readonly configurationTimeoutMs?: number;
  readonly handlerTimeoutMs?: number;
  readonly signalingTimeoutMs?: number;
  readonly iceTimeoutMs?: number;
  readonly dtlsTimeoutMs?: number;
  readonly dataChannelTimeoutMs?: number;
}

export const REALTIME_HUB_DEFAULTS = Object.freeze({
  maxSessions: 4_096,
  maxSessionsPerPrincipal: 16,
  maxHandshakesPerWindow: 32,
  handshakeWindowMs: 10_000,
  maxTrackedPrincipals: 8_192,
  maxPendingCandidates: 256,
  terminalRetentionMs: 30_000,
  authorizationTimeoutMs: 10_000,
  configurationTimeoutMs: 10_000,
  handlerTimeoutMs: 10_000,
  signalingTimeoutMs: 10_000,
  iceTimeoutMs: 10_000,
  dtlsTimeoutMs: 10_000,
  dataChannelTimeoutMs: 20_000,
  sessionLimits: Object.freeze({
    maxBufferedAmount: 1024 * 1024,
    maxConcurrentStreams: 16,
    maxIncomingBufferedBytes: 256 * 1024,
    defaultStreamMaxBytes: 16 * 1024 * 1024,
    maxInFlightHandlers: 128,
    streamIdleMs: 30_000,
    maxAuxiliaryPeers: 4,
    maxDecodedStreams: 8,
    maxMediaSources: 8,
    maxDataChannelsPerPeer: 16,
    maxSendersPerPeer: 32,
    maxTransceiversPerPeer: 32,
  }) satisfies RealtimeServerSessionLimits,
  resourceLimits: REALTIME_GLOBAL_RESOURCE_DEFAULTS,
});

const EMPTY_HEALTH: RealtimeHealthSnapshot = Object.freeze({
  sampledPeers: 0,
  sampleFailures: 0,
  directPaths: 0,
  relayPaths: 0,
  udpPaths: 0,
  tcpPaths: 0,
  roundTripTimeAverageMs: 0,
  roundTripTimeMaxMs: 0,
  jitterMaxMs: 0,
  packets: 0,
  packetsLost: 0,
  frames: 0,
  framesDropped: 0,
  availableIncomingBitrate: 0,
  availableOutgoingBitrate: 0,
  dataChannelBufferedAmountMax: 0,
  nativeQueueDrops: 0,
  dataChannelPressure: 0,
  streamCapacityPressure: 0,
  streamBufferPressure: 0,
  handlerSaturation: 0,
  resourceSaturation: 0,
});

interface Generation {
  readonly id: string;
  readonly owner: string;
  readonly peer: PortableRTCPeerConnection;
  readonly dataChannel: PortableRTCDataChannel;
  readonly candidates: RealtimeIceCandidate[];
  readonly removeSignalListener: () => void;
  readonly releaseAuthentication: () => void;
  session: RealtimeServerSession | null;
  complete: boolean;
  active: boolean;
  terminal?: Outcome;
  terminalTimer?: ReturnType<typeof setTimeout>;
  readonly deadlines: Partial<
    Record<RealtimeConnectionDeadline, ReturnType<typeof setTimeout>>
  >;
  observedPeerEventDrops: number;
  observedDataChannelEventDrops: number;
  removeReadinessListeners?: () => void;
}

interface HandshakeWindow {
  count: number;
  readonly expiresAt: number;
}

type RealtimeConnectionDeadline = "ice" | "dtls" | "data-channel";
const CLOSE_REASONS = Object.freeze([
  "client",
  "authentication",
  "transport",
  "handler",
  "draining",
  "setup",
] as const satisfies readonly RealtimeCloseReason[]);

function engineValue<Value>(
  value: unknown,
  label: string,
  parse: (value: unknown) => Value,
): Value {
  try {
    return Object.freeze(parse(value));
  } catch (cause) {
    throw new AckerDBError(
      "internal",
      `realtime engine produced invalid ${label}`,
      { cause },
    );
  }
}

function configuration(
  value: PortableRTCConfiguration,
): PortableRTCConfiguration {
  if (typeof value !== "object" || value === null) {
    throw new AckerDBError("internal", "realtime configuration source returned no configuration");
  }
  return structuredClone(value);
}

export class RealtimeHub {
  private readonly definition: RealtimeHubOptions["definition"];
  private readonly engine: RealtimePeerEngine;
  private readonly configurationSource: RealtimeConfigurationSource;
  private readonly application: RealtimeRuntimeApplication;
  private readonly sessionLimits: RealtimeServerSessionLimits;
  private readonly maxSessions: number;
  private readonly maxSessionsPerPrincipal: number;
  private readonly maxHandshakesPerWindow: number;
  private readonly handshakeWindowMs: number;
  private readonly maxTrackedPrincipals: number;
  private readonly maxPendingCandidates: number;
  private readonly terminalRetentionMs: number;
  private readonly now: () => number;
  private readonly networkDiagnostic: RealtimeNetworkDiagnostic | null;
  private readonly authorizationTimeoutMs: number;
  private readonly configurationTimeoutMs: number;
  private readonly handlerTimeoutMs: number;
  private readonly signalingTimeoutMs: number;
  private readonly iceTimeoutMs: number;
  private readonly dtlsTimeoutMs: number;
  private readonly dataChannelTimeoutMs: number;
  private readonly resourceBudget: RealtimeGlobalResourceBudget;
  private readonly generations = new Map<string, Generation>();
  private readonly reservationsByOwner = new Map<string, number>();
  private readonly handshakeWindows = new Map<string, HandshakeWindow>();
  private reserved = 0;
  private active = 0;
  private offers = 0;
  private accepted = 0;
  private rejected = 0;
  private overloaded = 0;
  private failed = 0;
  private closed = 0;
  private recoveryAttempts = 0;
  private recoveryAccepted = 0;
  private recoveryRejected = 0;
  private recoveryFailed = 0;
  private readonly closeReasons = Object.fromEntries(
    CLOSE_REASONS.map((reason) => [reason, 0]),
  ) as Record<RealtimeCloseReason, number>;
  private readonly sampleIds: string[] = [];
  private readonly sampleIndex = new Map<string, number>();
  private sampleCursor = 0;
  private sampling = false;
  private nativeQueueDrops = 0;
  private dataChannelPressure = 0;
  private streamCapacityPressure = 0;
  private streamBufferPressure = 0;
  private handlerSaturation = 0;
  private resourceSaturation = 0;
  private health: RealtimeHealthSnapshot = EMPTY_HEALTH;
  private accepting = true;

  constructor(options: RealtimeHubOptions) {
    this.definition = options.definition;
    this.engine = options.engine;
    this.configurationSource = options.configuration;
    this.application = options.application;
    this.sessionLimits = options.sessionLimits;
    for (const [name, value] of Object.entries(this.sessionLimits)) {
      positiveSafeInteger(value, `sessionLimits.${name}`);
    }
    this.resourceBudget = options.resourceBudget ??
      new RealtimeGlobalResourceBudget({
        ...REALTIME_HUB_DEFAULTS.resourceLimits,
        ...options.resourceLimits,
      });
    this.maxSessions = positiveSafeInteger(options.maxSessions, "maxSessions");
    this.maxSessionsPerPrincipal = positiveSafeInteger(
      options.maxSessionsPerPrincipal,
      "maxSessionsPerPrincipal",
    );
    this.maxHandshakesPerWindow = positiveSafeInteger(
      options.maxHandshakesPerWindow,
      "maxHandshakesPerWindow",
    );
    this.handshakeWindowMs = positiveSafeInteger(
      options.handshakeWindowMs,
      "handshakeWindowMs",
    );
    this.maxTrackedPrincipals = positiveSafeInteger(
      options.maxTrackedPrincipals,
      "maxTrackedPrincipals",
    );
    this.maxPendingCandidates = positiveSafeInteger(
      options.maxPendingCandidates,
      "maxPendingCandidates",
    );
    this.terminalRetentionMs = positiveSafeInteger(
      options.terminalRetentionMs,
      "terminalRetentionMs",
    );
    this.now = options.now;
    this.networkDiagnostic = options.networkDiagnostic ?? null;
    this.authorizationTimeoutMs = positiveSafeInteger(
      options.authorizationTimeoutMs ?? REALTIME_HUB_DEFAULTS.authorizationTimeoutMs,
      "authorizationTimeoutMs",
    );
    this.configurationTimeoutMs = positiveSafeInteger(
      options.configurationTimeoutMs ?? REALTIME_HUB_DEFAULTS.configurationTimeoutMs,
      "configurationTimeoutMs",
    );
    this.handlerTimeoutMs = positiveSafeInteger(
      options.handlerTimeoutMs ?? REALTIME_HUB_DEFAULTS.handlerTimeoutMs,
      "handlerTimeoutMs",
    );
    this.signalingTimeoutMs = positiveSafeInteger(
      options.signalingTimeoutMs ?? REALTIME_HUB_DEFAULTS.signalingTimeoutMs,
      "signalingTimeoutMs",
    );
    this.iceTimeoutMs = positiveSafeInteger(
      options.iceTimeoutMs ?? REALTIME_HUB_DEFAULTS.iceTimeoutMs,
      "iceTimeoutMs",
    );
    this.dtlsTimeoutMs = positiveSafeInteger(
      options.dtlsTimeoutMs ?? REALTIME_HUB_DEFAULTS.dtlsTimeoutMs,
      "dtlsTimeoutMs",
    );
    this.dataChannelTimeoutMs = positiveSafeInteger(
      options.dataChannelTimeoutMs ?? REALTIME_HUB_DEFAULTS.dataChannelTimeoutMs,
      "dataChannelTimeoutMs",
    );
  }

  get size(): number {
    return this.active;
  }

  snapshot(): RealtimeRuntimeSnapshot {
    return Object.freeze({
      network: this.networkDiagnostic,
      activeSessions: this.active,
      reservedSessions: this.reserved,
      activePrincipals: this.reservationsByOwner.size,
      trackedHandshakeWindows: this.handshakeWindows.size,
      offers: this.offers,
      accepted: this.accepted,
      rejected: this.rejected,
      overloaded: this.overloaded,
      failed: this.failed,
      closed: this.closed,
      recoveryAttempts: this.recoveryAttempts,
      recoveryAccepted: this.recoveryAccepted,
      recoveryRejected: this.recoveryRejected,
      recoveryFailed: this.recoveryFailed,
      closeReasons: Object.freeze({ ...this.closeReasons }),
      resources: this.resourceBudget.snapshot(),
      health: Object.freeze({
        ...this.health,
        nativeQueueDrops: this.nativeQueueDrops,
        dataChannelPressure: this.dataChannelPressure,
        streamCapacityPressure: this.streamCapacityPressure,
        streamBufferPressure: this.streamBufferPressure,
        handlerSaturation: this.handlerSaturation,
        resourceSaturation: this.resourceSaturation,
      }),
    });
  }

  async diagnostic(
    sessionId: string,
    principal: Principal,
  ): Promise<RealtimePeerDiagnostic> {
    const generation = this.owned(sessionId, principal);
    if (!generation.active) {
      throw new AckerDBError("not_found", "realtime session is not active");
    }
    return realtimePeerDiagnostic({
      observedAtMs: this.now(),
      connectionState: generation.peer.connectionState,
      signalingState: generation.peer.signalingState,
      iceGatheringState: generation.peer.iceGatheringState,
      report: await generation.peer.getStats(),
    });
  }

  async sampleHealth(maxPeers = 8): Promise<void> {
    positiveSafeInteger(maxPeers, "maxPeers");
    if (this.sampling) return;
    if (this.sampleIds.length === 0) {
      this.clearLiveHealth();
      return;
    }
    this.sampling = true;
    try {
      const count = Math.min(maxPeers, this.sampleIds.length);
      const ids: string[] = [];
      for (let index = 0; index < count; index++) {
        if (this.sampleCursor >= this.sampleIds.length) this.sampleCursor = 0;
        ids.push(this.sampleIds[this.sampleCursor++]!);
      }
      const samples = await Promise.all(ids.map(async (id) => {
        const generation = this.generations.get(id);
        if (generation === undefined || !generation.active) return null;
        this.captureNativeDrops(generation);
        try {
          const diagnostic = realtimePeerDiagnostic({
            observedAtMs: this.now(),
            connectionState: generation.peer.connectionState,
            signalingState: generation.peer.signalingState,
            iceGatheringState: generation.peer.iceGatheringState,
            report: await generation.peer.getStats(),
          });
          return { generation, diagnostic };
        } catch {
          return { generation, diagnostic: null };
        }
      }));

      let failures = 0;
      let direct = 0;
      let relay = 0;
      let udp = 0;
      let tcp = 0;
      let rttCount = 0;
      let rttTotal = 0;
      let rttMax = 0;
      let jitterMax = 0;
      let packets = 0;
      let packetsLost = 0;
      let frames = 0;
      let framesDropped = 0;
      let incomingBitrate = 0;
      let outgoingBitrate = 0;
      let bufferedAmount = 0;
      let sampled = 0;
      for (const sample of samples) {
        if (sample === null) continue;
        if (sample.diagnostic === null) {
          failures++;
          continue;
        }
        sampled++;
        const { generation, diagnostic } = sample;
        const path = diagnostic.path;
        if (
          path?.localCandidateType === "relay" ||
          path?.remoteCandidateType === "relay"
        ) {
          relay++;
        } else if (path !== undefined) {
          direct++;
        }
        if (path?.protocol === "udp") udp++;
        if (path?.protocol === "tcp") tcp++;
        if (diagnostic.roundTripTimeMs !== undefined) {
          rttCount++;
          rttTotal += diagnostic.roundTripTimeMs;
          rttMax = Math.max(rttMax, diagnostic.roundTripTimeMs);
        }
        incomingBitrate += diagnostic.availableIncomingBitrate ?? 0;
        outgoingBitrate += diagnostic.availableOutgoingBitrate ?? 0;
        bufferedAmount = Math.max(
          bufferedAmount,
          generation.dataChannel.bufferedAmount,
        );
        for (const direction of ["inbound", "outbound"] as const) {
          for (const kind of ["audio", "video"] as const) {
            const flow = diagnostic[direction]?.[kind];
            if (flow === undefined) continue;
            packets += flow.packets ?? 0;
            packetsLost += flow.packetsLost ?? 0;
            frames += flow.frames ?? 0;
            framesDropped += flow.framesDropped ?? 0;
            jitterMax = Math.max(jitterMax, flow.jitterMs ?? 0);
          }
        }
      }
      this.health = Object.freeze({
        sampledPeers: sampled,
        sampleFailures: failures,
        directPaths: direct,
        relayPaths: relay,
        udpPaths: udp,
        tcpPaths: tcp,
        roundTripTimeAverageMs: rttCount === 0 ? 0 : rttTotal / rttCount,
        roundTripTimeMaxMs: rttMax,
        jitterMaxMs: jitterMax,
        packets,
        packetsLost,
        frames,
        framesDropped,
        availableIncomingBitrate: sampled === 0 ? 0 : incomingBitrate / sampled,
        availableOutgoingBitrate: sampled === 0 ? 0 : outgoingBitrate / sampled,
        dataChannelBufferedAmountMax: bufferedAmount,
        nativeQueueDrops: this.nativeQueueDrops,
        dataChannelPressure: this.dataChannelPressure,
        streamCapacityPressure: this.streamCapacityPressure,
        streamBufferPressure: this.streamBufferPressure,
        handlerSaturation: this.handlerSaturation,
        resourceSaturation: this.resourceSaturation,
      });
    } finally {
      this.sampling = false;
    }
  }

  async configuration(
    principal: Principal,
    parentSignal?: AbortSignal,
  ): Promise<PortableRTCConfiguration> {
    return configuration(await this.withTimeout(
      (signal) => Promise.resolve(this.configurationSource(principal, signal)),
      this.configurationTimeoutMs,
      "realtime ICE configuration",
      parentSignal,
    ));
  }

  async offer(input: RealtimeOfferInput): Promise<RealtimeOfferResult> {
    this.offers++;
    if (input.recovery) this.recoveryAttempts++;
    let authenticationOwned = true;
    const owner = stableEncode(input.principal);
    let reservationOwned = false;
    let peer: PortableRTCPeerConnection | undefined;
    let generation: Generation | undefined;
    try {
      if (!this.accepting) {
        throw new AckerDBError("draining", "realtime service is draining", {
          resource: "connection",
          retryable: true,
          retryAfterMs: 1_000,
        });
      }
      this.consumeHandshake(owner);
      if (this.reserved >= this.maxSessions) {
        throw new AckerDBError("overloaded", "realtime session capacity is full", {
          resource: "connection",
          retryable: true,
          retryAfterMs: 0,
        });
      }
      if (
        (this.reservationsByOwner.get(owner) ?? 0) >=
          this.maxSessionsPerPrincipal
      ) {
        throw new AckerDBError(
          "overloaded",
          "realtime principal session capacity is full",
          { resource: "connection", retryable: true, retryAfterMs: 0 },
        );
      }
      this.reserve(owner);
      reservationOwned = true;
      if (input.signal.aborted) throw input.signal.reason;
      const definition = this.definition(input.address);
      if (definition === undefined) {
        throw new AckerDBError("not_found", `unknown realtime "${input.address}"`);
      }
      const authorized = await this.withTimeout(
        (signal) =>
          this.application.authorize(
            definition,
            Object.freeze({ ...input, signal }),
          ),
        this.authorizationTimeoutMs,
        "realtime authorization",
        input.signal,
      );
      if (!authorized.ok) {
        this.rejected++;
        if (input.recovery) this.recoveryRejected++;
        return Object.freeze({ ok: false, error: authorized.error });
      }
      if (input.signal.aborted) throw input.signal.reason;

      const id = randomBytes(24).toString("base64url");
      peer = this.engine.createPeerConnection(
        await this.configuration(input.principal, input.signal),
        realtimePeerLimits(this.sessionLimits),
      );
      const dataChannel = peer.createDataChannel("ackerdb.typed.v1", {
        negotiated: true,
        id: 0,
        ordered: true,
      });
      const abort = () =>
        this.closeGeneration(id, input.signal.reason, "authentication");
      input.signal.addEventListener("abort", abort, { once: true });
      generation = {
        id,
        owner,
        peer,
        dataChannel,
        candidates: [],
        removeSignalListener: () =>
          input.signal.removeEventListener("abort", abort),
        releaseAuthentication: input.releaseAuthentication,
        session: null,
        complete: false,
        active: true,
        deadlines: {},
        observedPeerEventDrops: 0,
        observedDataChannelEventDrops: 0,
      };
      this.generations.set(id, generation);
      this.addSampleId(id);
      this.active++;
      reservationOwned = false;
      authenticationOwned = false;
      if (input.signal.aborted) throw input.signal.reason;

      peer.addEventListener("icecandidate", (event) => {
        if (!generation!.active) return;
        const ice = (event as PortableRTCPeerConnectionIceEvent).candidate;
        const serialized = ice === null
          ? null
          : engineValue(
            ice.toJSON(),
            "ICE candidate",
            parseRealtimeIceCandidate,
          );
        if (generation!.session?.sendIceCandidate(serialized)) {
          if (ice === null) generation!.complete = true;
          return;
        }
        if (ice === null) {
          generation!.complete = true;
          return;
        }
        if (generation!.candidates.length >= this.maxPendingCandidates) {
          this.failGeneration(
            generation!,
            new AckerDBError(
              "overloaded",
              "realtime ICE candidate capacity is full",
              { resource: "connection" },
            ),
          );
          return;
        }
        generation!.candidates.push(serialized!);
      });
      const connectionChanged = () => {
        if (peer!.connectionState === "connected") {
          this.clearDeadline(generation!, "ice");
          this.clearDeadline(generation!, "dtls");
        }
        if (
          peer!.connectionState === "closed" ||
          peer!.connectionState === "failed"
        ) {
          this.closeGeneration(
            id,
            new AckerDBError("unavailable", "realtime peer connection ended", {
              resource: "connection",
              retryable: peer!.connectionState === "failed",
            }),
            "transport",
          );
        }
      };
      const iceConnectionChanged = () => {
        if (
          peer!.iceConnectionState === "connected" ||
          peer!.iceConnectionState === "completed"
        ) {
          this.clearDeadline(generation!, "ice");
          this.armDtlsDeadline(generation!);
        }
      };
      const dataChannelOpened = () => {
        if (dataChannel.readyState === "open") {
          this.clearDeadline(generation!, "data-channel");
        }
      };
      peer.addEventListener("connectionstatechange", connectionChanged);
      peer.addEventListener(
        "iceconnectionstatechange",
        iceConnectionChanged,
      );
      dataChannel.addEventListener("open", dataChannelOpened);
      generation.removeReadinessListeners = () => {
        peer!.removeEventListener("connectionstatechange", connectionChanged);
        peer!.removeEventListener(
          "iceconnectionstatechange",
          iceConnectionChanged,
        );
        dataChannel.removeEventListener("open", dataChannelOpened);
      };

      const adapter: RealtimeServerSessionAdapter = {
        ...authorized.adapter,
        failed: (error) => {
          authorized.adapter.failed(error);
          this.failGeneration(generation!, error, "handler");
        },
      };
      const serverSession = await this.withTimeout(
        (signal) =>
          RealtimeServerSession.create({
            definition,
            args: authorized.args,
            state: authorized.state,
            peerConnection: peer!,
            dataChannel,
            engine: this.engine,
            adapter,
            limits: this.sessionLimits,
            observePressure: (pressure) => this.observePressure(pressure),
            resourceBudget: this.resourceBudget,
            setupSignal: signal,
          }),
        this.handlerTimeoutMs,
        "realtime handler setup",
        input.signal,
      );
      generation.session = serverSession;
      await this.withTimeout(
        () => peer!.setRemoteDescription(input.offer),
        this.signalingTimeoutMs,
        "realtime remote description",
        input.signal,
      );
      const answer = await this.withTimeout(
        () => peer!.createAnswer(),
        this.signalingTimeoutMs,
        "realtime answer creation",
        input.signal,
      );
      await this.withTimeout(
        () => peer!.setLocalDescription(answer),
        this.signalingTimeoutMs,
        "realtime local description",
        input.signal,
      );
      serverSession.initialNegotiationComplete();
      const local = peer.localDescription;
      if (local === null) {
        throw new AckerDBError("internal", "realtime engine produced no local answer");
      }
      const batch = this.drainCandidates(generation);
      const streamLimits = Object.freeze({
        client: this.streamLimits(
          definition.clientStreams as Readonly<
            Record<string, { readonly maxBytes?: number }>
          >,
        ),
        server: this.streamLimits(
          definition.serverStreams as Readonly<
            Record<string, { readonly maxBytes?: number }>
          >,
        ),
      });
      this.accepted++;
      if (input.recovery) this.recoveryAccepted++;
      this.armConnectionDeadlines(generation);
      return Object.freeze({
        ok: true,
        sessionId: id,
        answer: engineValue(
          local,
          "answer",
          (value) => parseRealtimeSessionDescription(value, "answer"),
        ),
        streamLimits,
        ...batch,
      });
    } catch (error) {
      if (input.recovery) this.recoveryFailed++;
      if (generation === undefined) {
        const outcome = outcomeFromError(error);
        if (outcome.code === "overloaded") this.overloaded++;
        else this.failed++;
      }
      if (generation !== undefined) {
        this.closeGeneration(generation.id, error, "setup");
      } else if (peer !== undefined && peer.connectionState !== "closed") {
        peer.close();
      }
      throw error;
    } finally {
      if (reservationOwned) this.releaseReservation(owner);
      if (authenticationOwned) input.releaseAuthentication();
    }
  }

  async patch(
    sessionId: string,
    principal: Principal,
    batch: RealtimeCandidateBatch,
  ): Promise<RealtimePatchResult> {
    const generation = this.owned(sessionId, principal);
    if (generation.terminal !== undefined) {
      return Object.freeze({ ok: false, outcome: generation.terminal });
    }
    if (!generation.active) {
      throw new AckerDBError("not_found", "realtime session is not active");
    }
    if (batch.candidates.length > this.maxPendingCandidates) {
      throw new AckerDBError("validation", "realtime ICE candidate batch is too large");
    }
    for (const raw of batch.candidates) {
      await generation.peer.addIceCandidate(raw);
    }
    if (batch.complete) await generation.peer.addIceCandidate(null);
    return Object.freeze({ ok: true, ...this.drainCandidates(generation) });
  }

  close(sessionId: string, principal: Principal): void {
    this.owned(sessionId, principal);
    this.closeGeneration(
      sessionId,
      new Error("realtime session closed by client"),
      "client",
    );
  }

  async drain(): Promise<void> {
    this.accepting = false;
    for (const generation of [...this.generations.values()]) {
      this.closeGeneration(
        generation.id,
        new AckerDBError("draining", "realtime service is draining", {
          resource: "connection",
          retryable: true,
          retryAfterMs: 1_000,
        }),
        "draining",
      );
    }
    this.engine.close();
  }

  private owned(sessionId: string, principal: Principal): Generation {
    const generation = this.generations.get(sessionId);
    if (
      generation === undefined ||
      generation.owner !== stableEncode(principal)
    ) {
      throw new AckerDBError("not_found", "realtime session does not exist");
    }
    return generation;
  }

  private drainCandidates(generation: Generation): RealtimeCandidateBatch {
    const candidates = Object.freeze(generation.candidates.splice(0));
    return Object.freeze({
      candidates,
      complete: generation.complete,
    });
  }

  private streamLimits(
    streams: Readonly<Record<string, { readonly maxBytes?: number }>>,
  ): Readonly<Record<string, number>> {
    return Object.freeze(Object.fromEntries(
      Object.entries(streams).map(([name, declaration]) => [
        name,
        declaration.maxBytes ?? this.sessionLimits.defaultStreamMaxBytes,
      ]),
    ));
  }

  private withTimeout<Value>(
    work: (signal: AbortSignal) => Value | Promise<Value>,
    timeoutMs: number,
    label: string,
    parentSignal?: AbortSignal,
  ): Promise<Value> {
    const controller = new AbortController();
    const parentAborted = () => controller.abort(
      parentSignal?.reason ??
        new AckerDBError("unavailable", `${label} was cancelled`, {
          resource: "connection",
        }),
    );
    parentSignal?.addEventListener("abort", parentAborted, { once: true });
    if (parentSignal?.aborted) parentAborted();
    const timer = setTimeout(() => controller.abort(new AckerDBError(
      "unavailable",
      `${label} timed out`,
      {
        resource: "connection",
        retryable: true,
        retryAfterMs: 0,
      },
    )), timeoutMs);
    timer.unref?.();
    const operation = controller.signal.aborted
      ? Promise.reject(controller.signal.reason)
      : Promise.resolve().then(() => work(controller.signal));
    return settleOnAbort(
      operation,
      controller.signal,
    ).finally(() => {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", parentAborted);
    });
  }

  private armConnectionDeadlines(generation: Generation): void {
    if (
      generation.peer.iceConnectionState === "connected" ||
      generation.peer.iceConnectionState === "completed" ||
      generation.peer.connectionState === "connected"
    ) {
      this.armDtlsDeadline(generation);
    } else {
      this.armDeadline(generation, "ice", this.iceTimeoutMs, "ICE");
    }
    if (generation.dataChannel.readyState !== "open") {
      this.armDeadline(
        generation,
        "data-channel",
        this.dataChannelTimeoutMs,
        "data channel",
      );
    }
  }

  private armDtlsDeadline(generation: Generation): void {
    if (generation.peer.connectionState !== "connected") {
      this.armDeadline(generation, "dtls", this.dtlsTimeoutMs, "DTLS");
    }
  }

  private armDeadline(
    generation: Generation,
    stage: RealtimeConnectionDeadline,
    timeoutMs: number,
    label: string,
  ): void {
    if (!generation.active || generation.deadlines[stage] !== undefined) return;
    const timer = setTimeout(() => {
      delete generation.deadlines[stage];
      this.failGeneration(
        generation,
        new AckerDBError(
          "unavailable",
          `realtime ${label} setup timed out`,
          { resource: "connection", retryable: true, retryAfterMs: 0 },
        ),
      );
    }, timeoutMs);
    timer.unref?.();
    generation.deadlines[stage] = timer;
  }

  private clearDeadline(
    generation: Generation,
    stage: RealtimeConnectionDeadline,
  ): void {
    const timer = generation.deadlines[stage];
    if (timer === undefined) return;
    clearTimeout(timer);
    delete generation.deadlines[stage];
  }

  private observePressure(pressure: RealtimeSessionPressure): void {
    if (pressure === "data-channel-buffer") this.dataChannelPressure++;
    else if (pressure === "stream-capacity") this.streamCapacityPressure++;
    else if (pressure === "stream-buffer") this.streamBufferPressure++;
    else if (pressure === "handler-saturation") this.handlerSaturation++;
    else this.resourceSaturation++;
  }

  private captureNativeDrops(generation: Generation): void {
    const pressure = nativePeerPressure(generation.peer);
    const peerDelta = Math.max(
      0,
      pressure.peerEventDrops - generation.observedPeerEventDrops,
    );
    const dataChannelDelta = Math.max(
      0,
      pressure.dataChannelEventDrops -
        generation.observedDataChannelEventDrops,
    );
    generation.observedPeerEventDrops = pressure.peerEventDrops;
    generation.observedDataChannelEventDrops =
      pressure.dataChannelEventDrops;
    this.nativeQueueDrops += peerDelta + dataChannelDelta;
  }

  private addSampleId(id: string): void {
    this.sampleIndex.set(id, this.sampleIds.length);
    this.sampleIds.push(id);
  }

  private removeSampleId(id: string): void {
    const index = this.sampleIndex.get(id);
    if (index === undefined) return;
    const last = this.sampleIds.pop()!;
    this.sampleIndex.delete(id);
    if (index < this.sampleIds.length) {
      this.sampleIds[index] = last;
      this.sampleIndex.set(last, index);
      this.sampleCursor = index;
    } else if (this.sampleCursor > this.sampleIds.length) {
      this.sampleCursor = 0;
    }
    if (this.sampleIds.length === 0) this.clearLiveHealth();
  }

  private clearLiveHealth(): void {
    this.health = Object.freeze({
      ...EMPTY_HEALTH,
      nativeQueueDrops: this.nativeQueueDrops,
      dataChannelPressure: this.dataChannelPressure,
      streamCapacityPressure: this.streamCapacityPressure,
      streamBufferPressure: this.streamBufferPressure,
      handlerSaturation: this.handlerSaturation,
      resourceSaturation: this.resourceSaturation,
    });
  }

  private failGeneration(
    generation: Generation,
    error: unknown,
    closeReason: RealtimeCloseReason = "transport",
  ): void {
    if (!generation.active) return;
    const outcome = outcomeFromError(error);
    generation.terminal = outcome;
    generation.session?.sendSessionError(outcome);
    this.stopGeneration(generation, error, true, closeReason);
  }

  private closeGeneration(
    id: string,
    reason: unknown,
    closeReason: RealtimeCloseReason,
  ): void {
    const generation = this.generations.get(id);
    if (generation === undefined) return;
    this.stopGeneration(generation, reason, false, closeReason);
  }

  private stopGeneration(
    generation: Generation,
    reason: unknown,
    retainTerminal: boolean,
    closeReason: RealtimeCloseReason,
  ): void {
    if (generation.active) {
      this.captureNativeDrops(generation);
      for (const timer of Object.values(generation.deadlines)) {
        clearTimeout(timer);
      }
      generation.active = false;
      this.removeSampleId(generation.id);
      this.active--;
      this.closed++;
      this.closeReasons[closeReason]++;
      if (retainTerminal) this.failed++;
      this.releaseReservation(generation.owner);
      generation.removeSignalListener();
      generation.removeReadinessListeners?.();
      generation.removeReadinessListeners = undefined;
      generation.releaseAuthentication();
      generation.session?.close(reason);
      generation.session = null;
      if (generation.peer.connectionState !== "closed") {
        generation.peer.close();
      }
    }
    if (retainTerminal && generation.terminal !== undefined) {
      generation.terminalTimer ??= setTimeout(() => {
        this.generations.delete(generation.id);
      }, this.terminalRetentionMs);
      generation.terminalTimer.unref?.();
      return;
    }
    if (generation.terminalTimer !== undefined) {
      clearTimeout(generation.terminalTimer);
    }
    this.generations.delete(generation.id);
  }

  private reserve(owner: string): void {
    this.reserved++;
    this.reservationsByOwner.set(
      owner,
      (this.reservationsByOwner.get(owner) ?? 0) + 1,
    );
  }

  private releaseReservation(owner: string): void {
    const count = this.reservationsByOwner.get(owner);
    if (count === undefined) return;
    this.reserved--;
    if (count === 1) this.reservationsByOwner.delete(owner);
    else this.reservationsByOwner.set(owner, count - 1);
  }

  private consumeHandshake(owner: string): void {
    const now = this.now();
    for (;;) {
      const oldest = this.handshakeWindows.entries().next().value as
        | [string, HandshakeWindow]
        | undefined;
      if (oldest === undefined || oldest[1].expiresAt > now) break;
      this.handshakeWindows.delete(oldest[0]);
    }

    const current = this.handshakeWindows.get(owner);
    if (current !== undefined) {
      if (current.count >= this.maxHandshakesPerWindow) {
        throw new AckerDBError(
          "overloaded",
          "realtime principal handshake rate is full",
          {
            resource: "connection",
            retryable: true,
            retryAfterMs: Math.min(
              30_000,
              Math.max(0, current.expiresAt - now),
            ),
          },
        );
      }
      current.count++;
      return;
    }

    if (this.handshakeWindows.size >= this.maxTrackedPrincipals) {
      const oldest = this.handshakeWindows.keys().next().value as
        | string
        | undefined;
      if (oldest !== undefined) this.handshakeWindows.delete(oldest);
    }
    this.handshakeWindows.set(owner, {
      count: 1,
      expiresAt: now + this.handshakeWindowMs,
    });
  }
}
