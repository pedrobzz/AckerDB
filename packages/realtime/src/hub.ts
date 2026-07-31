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
  type PortableRTCStatsReport,
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
  type RealtimePrepareInput,
  type RealtimePrepareResult,
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
  RealtimePeerGeneration,
} from "./engine.ts";
import {
  realtimePeerDiagnostic,
  type RealtimePeerDiagnostic,
} from "./diagnostics.ts";
import type { RealtimeNetworkDiagnostic } from "./network.ts";
import {
  nativePeerPressure,
  observeNativePeerTerminal,
  type RealtimeNativeQueueTerminalCounts,
  type RealtimeNativeQueueTerminalReason,
} from "./native/peer-connection.ts";
import {
  REALTIME_GLOBAL_RESOURCE_DEFAULTS,
  RealtimeGlobalResourceBudget,
  type RealtimeGlobalResourceLimits,
  type RealtimeGlobalResourceSnapshot,
} from "./resources.ts";
import { PreparedSessions } from "./prepared-sessions.ts";
import {
  REMOTE_CANDIDATE_POLICY_DEFAULTS,
  RemoteCandidatePolicy,
  type RemoteCandidatePolicyOptions,
} from "./remote-candidate-policy.ts";

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
  readonly maxRemoteCandidates: number;
  readonly maxRemoteCandidateBytes: number;
  readonly allowPrivateCandidateAddresses: boolean;
  readonly terminalRetentionMs: number;
  readonly preparedSessionTtlMs?: number;
  readonly maxPreparedBytes?: number;
  readonly now: () => number;
  readonly networkDiagnostic?: RealtimeNetworkDiagnostic;
  readonly authorizationTimeoutMs?: number;
  readonly configurationTimeoutMs?: number;
  readonly handlerTimeoutMs?: number;
  readonly signalingTimeoutMs?: number;
  readonly iceTimeoutMs?: number;
  readonly dtlsTimeoutMs?: number;
  readonly dataChannelTimeoutMs?: number;
  readonly diagnosticTimeoutMs?: number;
}

export const REALTIME_HUB_DEFAULTS = Object.freeze({
  maxSessions: 1_024,
  maxSessionsPerPrincipal: 16,
  maxHandshakesPerWindow: 32,
  handshakeWindowMs: 10_000,
  maxTrackedPrincipals: 8_192,
  maxPendingCandidates: 256,
  maxRemoteCandidates: REMOTE_CANDIDATE_POLICY_DEFAULTS.maxCandidates,
  maxRemoteCandidateBytes: REMOTE_CANDIDATE_POLICY_DEFAULTS.maxBytes,
  allowPrivateCandidateAddresses:
    REMOTE_CANDIDATE_POLICY_DEFAULTS.allowPrivateAddresses,
  terminalRetentionMs: 30_000,
  preparedSessionTtlMs: 30_000,
  maxPreparedBytes: 16 * 1024 * 1024,
  authorizationTimeoutMs: 10_000,
  configurationTimeoutMs: 10_000,
  handlerTimeoutMs: 10_000,
  signalingTimeoutMs: 10_000,
  iceTimeoutMs: 10_000,
  dtlsTimeoutMs: 10_000,
  dataChannelTimeoutMs: 20_000,
  diagnosticTimeoutMs: 5_000,
  sessionLimits: Object.freeze({
    maxQueuedBytes: 32 * 1024 * 1024,
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
  nativeProcessReservedBytes: 0,
  nativeProcessQueueSaturations: 0,
  nativeGenerationQueueSaturations: 0,
  nativeQueueLimitTerminations: 0,
  nativeProcessBudgetTerminations: 0,
  nativeGenerationBudgetTerminations: 0,
  dataChannelPressure: 0,
  streamCapacityPressure: 0,
  streamBufferPressure: 0,
  handlerSaturation: 0,
  resourceSaturation: 0,
});

interface Generation {
  readonly id: string;
  readonly owner: string;
  readonly native: RealtimePeerGeneration;
  readonly peer: PortableRTCPeerConnection;
  readonly dataChannel: PortableRTCDataChannel;
  readonly candidates: RealtimeIceCandidate[];
  /** One final HTTP trickle request may wait for a server ICE update. */
  candidateWaiter?: CandidateWaiter;
  /** Native end-of-remote-candidates was already delivered exactly once. */
  remoteComplete: boolean;
  /** The sole generation-wide owner of remote candidate policy/accounting. */
  readonly remoteCandidates: RemoteCandidatePolicy;
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
  observedNativeMediaDrops: number;
  observedNativeQueueSaturations: number;
  observedNativeQueueTerminals: RealtimeNativeQueueTerminalCounts;
  nativeTerminalReason?: RealtimeNativeQueueTerminalReason;
  statsRequest?: StatsRequest;
  removeReadinessListeners?: () => void;
}

interface CandidateWaiter {
  readonly promise: Promise<void>;
  resolve(): void;
}

function candidateWaiter(): CandidateWaiter {
  let resolve!: () => void;
  return Object.freeze({
    promise: new Promise<void>((settle) => resolve = settle),
    resolve: () => resolve(),
  });
}

interface DisposableSignal {
  readonly signal: AbortSignal;
  dispose(): void;
}

function setupSignal(
  authentication: AbortSignal,
  request: AbortSignal | undefined,
): DisposableSignal {
  if (request === undefined || request === authentication) {
    return { signal: authentication, dispose: () => {} };
  }
  const controller = new AbortController();
  const abort = (source: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  const abortAuthentication = () => abort(authentication);
  const abortRequest = () => abort(request);
  authentication.addEventListener("abort", abortAuthentication, { once: true });
  request.addEventListener("abort", abortRequest, { once: true });
  if (authentication.aborted) abort(authentication);
  else if (request.aborted) abort(request);
  return {
    signal: controller.signal,
    dispose: () => {
      authentication.removeEventListener("abort", abortAuthentication);
      request.removeEventListener("abort", abortRequest);
    },
  };
}

interface StatsRequest {
  readonly promise: Promise<PortableRTCStatsReport>;
  settled: boolean;
  claimed: boolean;
}

function createStatsRequest(
  peer: PortableRTCPeerConnection,
): StatsRequest {
  let operation: Promise<PortableRTCStatsReport>;
  try {
    operation = peer.getStats();
  } catch (error) {
    operation = Promise.reject(error);
  }
  const request: StatsRequest = {
    promise: operation,
    settled: false,
    claimed: false,
  };
  void operation.then(
    () => request.settled = true,
    () => request.settled = true,
  );
  return request;
}

const EMPTY_NATIVE_QUEUE_TERMINALS: RealtimeNativeQueueTerminalCounts =
  Object.freeze({
    "queue-limit": 0,
    "process-byte-budget": 0,
    "generation-byte-budget": 0,
  });

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

function nativeQueueTerminalFailure(
  reason: RealtimeNativeQueueTerminalReason,
): AckerDBError {
  switch (reason) {
    case "queue-limit":
    case "process-byte-budget":
    case "generation-byte-budget":
      return new AckerDBError(
        "overloaded",
        "realtime native queue capacity is full",
        { resource: "connection", retryable: true, retryAfterMs: 0 },
      );
  }
}

function nativeQueueTerminalCounts(
  primary: RealtimeNativeQueueTerminalCounts,
  auxiliary: RealtimeNativeQueueTerminalCounts | undefined,
  observed: RealtimeNativeQueueTerminalReason | undefined,
): RealtimeNativeQueueTerminalCounts {
  const counts = {
    "queue-limit": primary["queue-limit"] + (auxiliary?.["queue-limit"] ?? 0),
    "process-byte-budget":
      primary["process-byte-budget"] +
      (auxiliary?.["process-byte-budget"] ?? 0),
    "generation-byte-budget":
      primary["generation-byte-budget"] +
      (auxiliary?.["generation-byte-budget"] ?? 0),
  } satisfies Record<RealtimeNativeQueueTerminalReason, number>;
  if (observed !== undefined) counts[observed] = Math.max(1, counts[observed]);
  return Object.freeze(counts);
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
  private readonly remoteCandidatePolicy: RemoteCandidatePolicyOptions;
  private readonly terminalRetentionMs: number;
  private readonly prepared: PreparedSessions;
  private readonly now: () => number;
  private readonly networkDiagnostic: RealtimeNetworkDiagnostic | null;
  private readonly authorizationTimeoutMs: number;
  private readonly configurationTimeoutMs: number;
  private readonly handlerTimeoutMs: number;
  private readonly signalingTimeoutMs: number;
  private readonly iceTimeoutMs: number;
  private readonly dtlsTimeoutMs: number;
  private readonly dataChannelTimeoutMs: number;
  private readonly diagnosticTimeoutMs: number;
  private readonly diagnosticController = new AbortController();
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
  private nativeGenerationQueueSaturations = 0;
  private nativeQueueLimitTerminations = 0;
  private nativeProcessBudgetTerminations = 0;
  private nativeGenerationBudgetTerminations = 0;
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
    if (this.sessionLimits.maxQueuedBytes > 0xffff_ffff) {
      throw new RangeError(
        "sessionLimits.maxQueuedBytes must not exceed 4294967295",
      );
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
    const allowPrivateAddresses = options.allowPrivateCandidateAddresses;
    if (typeof allowPrivateAddresses !== "boolean") {
      throw new TypeError(
        "allowPrivateCandidateAddresses must be a boolean",
      );
    }
    this.remoteCandidatePolicy = Object.freeze({
      maxCandidates: positiveSafeInteger(
        options.maxRemoteCandidates,
        "maxRemoteCandidates",
      ),
      maxBytes: positiveSafeInteger(
        options.maxRemoteCandidateBytes,
        "maxRemoteCandidateBytes",
      ),
      allowPrivateAddresses,
    });
    this.terminalRetentionMs = positiveSafeInteger(
      options.terminalRetentionMs,
      "terminalRetentionMs",
    );
    this.prepared = new PreparedSessions({
      maxEntries: this.maxSessions,
      maxBytes: positiveSafeInteger(
        options.maxPreparedBytes ?? REALTIME_HUB_DEFAULTS.maxPreparedBytes,
        "maxPreparedBytes",
      ),
      ttlMs: positiveSafeInteger(
        options.preparedSessionTtlMs ?? REALTIME_HUB_DEFAULTS.preparedSessionTtlMs,
        "preparedSessionTtlMs",
      ),
    });
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
    this.diagnosticTimeoutMs = positiveSafeInteger(
      options.diagnosticTimeoutMs ?? REALTIME_HUB_DEFAULTS.diagnosticTimeoutMs,
      "diagnosticTimeoutMs",
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
        ...this.nativeQueueTelemetry(),
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
    owner: string,
  ): Promise<RealtimePeerDiagnostic> {
    const generation = this.owned(sessionId, owner);
    if (!generation.active) {
      throw new AckerDBError("not_found", "realtime session is not active");
    }
    try {
      return await this.withTimeout(
        async () => realtimePeerDiagnostic({
          observedAtMs: this.now(),
          connectionState: generation.peer.connectionState,
          signalingState: generation.peer.signalingState,
          iceGatheringState: generation.peer.iceGatheringState,
          report: await this.stats(generation),
        }),
        this.diagnosticTimeoutMs,
        "realtime diagnostic",
        this.diagnosticController.signal,
        "deadline_exceeded",
      );
    } catch (error) {
      if (
        error instanceof AckerDBError &&
        (
          (
            error.code === "deadline_exceeded" &&
            error.message === "realtime diagnostic timed out"
          ) ||
          (
            error.code === "draining" &&
            error === this.diagnosticController.signal.reason
          )
        )
      ) {
        throw error;
      }
      throw new AckerDBError(
        "unavailable",
        "realtime diagnostic failed",
        { resource: "connection" },
      );
    }
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
      let samples: ({
        readonly generation: Generation;
        readonly diagnostic: RealtimePeerDiagnostic | null;
      } | null)[];
      try {
        samples = await this.withTimeout(
          () => Promise.all(ids.map(async (id) => {
            const generation = this.generations.get(id);
            if (generation === undefined || !generation.active) return null;
            this.captureNativeDrops(generation);
            try {
              const diagnostic = realtimePeerDiagnostic({
                observedAtMs: this.now(),
                connectionState: generation.peer.connectionState,
                signalingState: generation.peer.signalingState,
                iceGatheringState: generation.peer.iceGatheringState,
                report: await this.stats(generation),
              });
              return { generation, diagnostic };
            } catch {
              return { generation, diagnostic: null };
            }
          })),
          this.diagnosticTimeoutMs,
          "realtime health sample",
          this.diagnosticController.signal,
          "deadline_exceeded",
        );
      } catch {
        if (this.diagnosticController.signal.aborted) return;
        samples = ids.map((id) => {
          const generation = this.generations.get(id);
          return generation === undefined || !generation.active
            ? null
            : { generation, diagnostic: null };
        });
      }

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
        ...this.nativeQueueTelemetry(),
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

  private async configuration(
    principal: Principal,
    parentSignal: AbortSignal | undefined,
    owner: string,
  ): Promise<PortableRTCConfiguration> {
    return configuration(await this.withTimeout(
      (signal) => Promise.resolve(this.configurationSource(principal, signal, owner)),
      this.configurationTimeoutMs,
      "realtime ICE configuration",
      parentSignal,
    ));
  }

  async prepare(input: RealtimePrepareInput): Promise<RealtimePrepareResult> {
    if (input.recovery) this.recoveryAttempts++;
    const { owner } = input;
    const setup = setupSignal(input.signal, input.setupSignal);
    let reservationOwned = false;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (reservationOwned) {
        reservationOwned = false;
        this.releaseReservation(owner);
      }
      input.releaseAuthentication();
    };
    let prepared = false;
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
      if (setup.signal.aborted) throw setup.signal.reason;
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
        setup.signal,
      );
      if (!authorized.ok) {
        this.rejected++;
        if (input.recovery) this.recoveryRejected++;
        return Object.freeze({ ok: false, error: authorized.error });
      }
      if (setup.signal.aborted) throw setup.signal.reason;

      const preparedConfiguration = await this.configuration(
        input.principal,
        setup.signal,
        owner,
      );
      if (setup.signal.aborted) throw setup.signal.reason;
      let payload: string;
      try {
        payload = stableEncode({
          address: input.address,
          args: authorized.args,
          state: authorized.state,
          principal: input.principal,
          configuration: preparedConfiguration,
        });
      } catch (cause) {
        throw new AckerDBError(
          "internal",
          "realtime authorization state is not wire-representable",
          { cause },
        );
      }
      const ticket = randomBytes(32).toString("base64url");
      if (setup.signal.aborted) throw setup.signal.reason;
      this.prepared.add({
        ticket,
        owner,
        definition,
        adapter: authorized.adapter,
        payload,
        recovery: input.recovery === true,
        signal: input.signal,
        release,
      });
      prepared = true;
      return Object.freeze({
        ok: true,
        ticket,
        configuration: preparedConfiguration,
      });
    } catch (error) {
      if (input.recovery) this.recoveryFailed++;
      const outcome = outcomeFromError(error);
      if (outcome.code === "overloaded") this.overloaded++;
      else this.failed++;
      throw error;
    } finally {
      setup.dispose();
      if (!prepared) release();
    }
  }

  async offer(input: RealtimeOfferInput): Promise<RealtimeOfferResult> {
    this.offers++;
    let prepared: ReturnType<PreparedSessions["consume"]> | undefined;
    let recovery = false;
    let native: RealtimePeerGeneration | undefined;
    let peer: PortableRTCPeerConnection | undefined;
    let generation: Generation | undefined;
    let setup: DisposableSignal | undefined;
    try {
      if (!this.accepting) {
        throw new AckerDBError("draining", "realtime service is draining", {
          resource: "connection",
          retryable: true,
          retryAfterMs: 1_000,
        });
      }
      if (input.setupSignal?.aborted) throw input.setupSignal.reason;
      prepared = this.prepared.consume(input.ticket, input.owner);
      recovery = prepared.recovery;
      const {
        adapter,
        args,
        configuration: preparedConfiguration,
        definition,
        release: releaseAuthentication,
        signal,
        state,
      } = prepared;
      setup = setupSignal(signal, input.setupSignal);
      if (setup.signal.aborted) throw setup.signal.reason;
      // The complete SDP is classified/accounted before this offer can cause
      // any native allocation or peer mutation.
      const sdp = input.offer.sdp;
      if (sdp === undefined) {
        throw new AckerDBError("malformed", "realtime offer SDP is required");
      }
      const remoteCandidates = new RemoteCandidatePolicy(
        this.remoteCandidatePolicy,
      );
      const sanitizedOffer = Object.freeze({
        ...input.offer,
        sdp: remoteCandidates.acceptSdp(sdp),
      });
      const id = randomBytes(24).toString("base64url");
      native = this.engine.createGeneration(this.sessionLimits.maxQueuedBytes);
      const nativeGeneration = native;
      peer = nativeGeneration.createPeerConnection(
        preparedConfiguration,
        realtimePeerLimits(this.sessionLimits),
      );
      const dataChannel = peer.createDataChannel("ackerdb.typed.v1", {
        negotiated: true,
        id: 0,
        ordered: true,
      });
      const abort = () =>
        this.closeGeneration(id, signal.reason, "authentication");
      signal.addEventListener("abort", abort, { once: true });
      generation = {
        id,
        owner: input.owner,
        native: nativeGeneration,
        peer,
        dataChannel,
        candidates: [],
        remoteCandidates,
        removeSignalListener: () =>
          signal.removeEventListener("abort", abort),
        releaseAuthentication,
        session: null,
        complete: false,
        remoteComplete: false,
        active: true,
        deadlines: {},
        observedPeerEventDrops: 0,
        observedDataChannelEventDrops: 0,
        observedNativeMediaDrops: 0,
        observedNativeQueueSaturations: 0,
        observedNativeQueueTerminals: EMPTY_NATIVE_QUEUE_TERMINALS,
      };
      this.generations.set(id, generation);
      this.addSampleId(id);
      this.active++;
      prepared = undefined;
      let nativeTerminalFailure: AckerDBError | undefined;
      observeNativePeerTerminal(peer, (reason) => {
        nativeTerminalFailure = this.failNativeQueueTerminal(
          generation!,
          reason,
        );
      });
      if (!generation.active) {
        throw nativeTerminalFailure ?? nativeQueueTerminalFailure(
          generation.nativeTerminalReason ?? "queue-limit",
        );
      }
      if (setup.signal.aborted) throw setup.signal.reason;

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
          this.wakeCandidateWaiter(generation!);
          return;
        }
        if (ice === null) {
          generation!.complete = true;
          this.wakeCandidateWaiter(generation!);
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
        this.wakeCandidateWaiter(generation!);
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
          this.wakeCandidateWaiter(generation!);
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

      const sessionAdapter: RealtimeServerSessionAdapter = {
        ...adapter,
        failed: (error) => {
          adapter.failed(error);
          this.failGeneration(generation!, error, "handler");
        },
      };
      const serverSession = await this.withTimeout(
        (signal) =>
          RealtimeServerSession.create({
            definition,
            args,
            state,
            peerConnection: peer!,
            dataChannel,
            generation: nativeGeneration,
            remoteCandidates,
            adapter: sessionAdapter,
            limits: this.sessionLimits,
            observePressure: (pressure) => this.observePressure(pressure),
            onNativeQueueTerminal: (reason) => {
              this.failNativeQueueTerminal(generation!, reason);
            },
            resourceBudget: this.resourceBudget,
            setupSignal: signal,
          }),
        this.handlerTimeoutMs,
        "realtime handler setup",
        setup.signal,
        "internal",
      );
      this.assertActive(generation, setup.signal, serverSession);
      generation.session = serverSession;
      await this.withTimeout(
        () => peer!.setRemoteDescription(sanitizedOffer),
        this.signalingTimeoutMs,
        "realtime remote description",
        setup.signal,
      );
      this.assertActive(generation, setup.signal);
      const answer = await this.withTimeout(
        () => peer!.createAnswer(),
        this.signalingTimeoutMs,
        "realtime answer creation",
        setup.signal,
      );
      this.assertActive(generation, setup.signal);
      await this.withTimeout(
        () => peer!.setLocalDescription(answer),
        this.signalingTimeoutMs,
        "realtime local description",
        setup.signal,
      );
      this.assertActive(generation, setup.signal);
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
      if (recovery) this.recoveryAccepted++;
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
      if (recovery) this.recoveryFailed++;
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
      if (generation === undefined) native?.close();
      prepared?.release();
      throw error;
    } finally {
      setup?.dispose();
    }
  }

  cancelPrepared(ticket: string, owner: string): void {
    this.prepared.cancel(ticket, owner);
  }

  async patch(
    sessionId: string,
    owner: string,
    batch: RealtimeCandidateBatch,
    signal?: AbortSignal,
  ): Promise<RealtimePatchResult> {
    const generation = this.owned(sessionId, owner);
    if (generation.terminal !== undefined) {
      return Object.freeze({ ok: false, outcome: generation.terminal });
    }
    if (!generation.active) {
      throw new AckerDBError("not_found", "realtime session is not active");
    }
    let candidates: readonly RealtimeIceCandidate[];
    try {
      // Validate and charge the entire batch before even its first candidate
      // can reach native WebRTC. A policy failure ends this generation once.
      candidates = generation.remoteCandidates.acceptBatch(
        batch.candidates,
      );
    } catch (error) {
      const outcome = outcomeFromError(error);
      this.failGeneration(generation, error);
      return Object.freeze({ ok: false, outcome });
    }
    for (const raw of candidates) {
      await generation.peer.addIceCandidate(raw);
    }
    if (batch.complete && !generation.remoteComplete) {
      await generation.peer.addIceCandidate(null);
      generation.remoteComplete = true;
    }
    if (
      (batch.complete || (
        generation.remoteComplete && batch.candidates.length === 0
      )) &&
      generation.candidates.length === 0 &&
      !generation.complete &&
      generation.dataChannel.readyState !== "open"
    ) {
      await this.waitForServerCandidates(generation, signal);
    }
    if (generation.terminal !== undefined) {
      return Object.freeze({ ok: false, outcome: generation.terminal });
    }
    if (!generation.active) {
      throw new AckerDBError("not_found", "realtime session is not active");
    }
    return Object.freeze({ ok: true, ...this.drainCandidates(generation) });
  }

  close(sessionId: string, owner: string): void {
    this.owned(sessionId, owner);
    this.closeGeneration(
      sessionId,
      new Error("realtime session closed by client"),
      "client",
    );
  }

  async drain(): Promise<void> {
    this.accepting = false;
    this.diagnosticController.abort(new AckerDBError(
      "draining",
      "realtime service is draining",
      { resource: "connection", retryable: true, retryAfterMs: 1_000 },
    ));
    this.prepared.drain();
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

  private owned(sessionId: string, owner: string): Generation {
    const generation = this.generations.get(sessionId);
    if (
      generation === undefined ||
      generation.owner !== owner
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

  private async waitForServerCandidates(
    generation: Generation,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      generation.candidates.length > 0 ||
      generation.complete ||
      generation.dataChannel.readyState === "open"
    ) {
      return;
    }
    if (generation.candidateWaiter !== undefined) {
      throw new AckerDBError(
        "overloaded",
        "realtime ICE candidate wait is already pending",
        { resource: "connection", retryable: true, retryAfterMs: 0 },
      );
    }
    const waiter = generation.candidateWaiter = candidateWaiter();
    try {
      await (signal === undefined
        ? waiter.promise
        : settleOnAbort(waiter.promise, signal));
    } finally {
      if (generation.candidateWaiter === waiter) {
        generation.candidateWaiter = undefined;
        waiter.resolve();
      }
    }
  }

  private wakeCandidateWaiter(generation: Generation): void {
    const waiter = generation.candidateWaiter;
    if (waiter === undefined) return;
    generation.candidateWaiter = undefined;
    waiter.resolve();
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

  private assertActive(
    generation: Generation,
    signal: AbortSignal,
    session?: RealtimeServerSession,
  ): void {
    if (generation.active && !signal.aborted) return;
    const reason = signal.reason ?? new AckerDBError(
      "unavailable",
      "realtime session setup was cancelled",
      { resource: "connection" },
    );
    session?.close(reason);
    throw reason;
  }

  private withTimeout<Value>(
    work: (signal: AbortSignal) => Value | Promise<Value>,
    timeoutMs: number,
    label: string,
    parentSignal?: AbortSignal,
    timeoutCode: "internal" | "unavailable" | "deadline_exceeded" =
      "unavailable",
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
      timeoutCode,
      `${label} timed out`,
      {
        resource: "connection",
        retryable: timeoutCode !== "internal",
        ...(timeoutCode === "internal" ? {} : { retryAfterMs: 0 }),
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
    const metrics = generation.native.nativeQueueMetrics();
    const peerDelta = Math.max(
      0,
      pressure.peerEventDrops - generation.observedPeerEventDrops,
    );
    const dataChannelDelta = Math.max(
      0,
      pressure.dataChannelEventDrops -
        generation.observedDataChannelEventDrops,
    );
    const mediaDrops = generation.session?.nativeMediaDrops() ?? 0;
    const mediaDelta = Math.max(
      0,
      mediaDrops - generation.observedNativeMediaDrops,
    );
    const saturationDelta = Math.max(
      0,
      metrics.saturations - generation.observedNativeQueueSaturations,
    );
    const terminals = nativeQueueTerminalCounts(
      pressure.terminalReasons,
      generation.session?.nativeQueueTerminalCounts(),
      generation.nativeTerminalReason,
    );
    const queueLimitDelta = Math.max(
      0,
      terminals["queue-limit"] -
        generation.observedNativeQueueTerminals["queue-limit"],
    );
    const processBudgetDelta = Math.max(
      0,
      terminals["process-byte-budget"] -
        generation.observedNativeQueueTerminals["process-byte-budget"],
    );
    const generationBudgetDelta = Math.max(
      0,
      terminals["generation-byte-budget"] -
        generation.observedNativeQueueTerminals["generation-byte-budget"],
    );
    generation.observedPeerEventDrops = pressure.peerEventDrops;
    generation.observedDataChannelEventDrops =
      pressure.dataChannelEventDrops;
    generation.observedNativeMediaDrops = mediaDrops;
    generation.observedNativeQueueSaturations = metrics.saturations;
    generation.observedNativeQueueTerminals = terminals;
    this.nativeQueueDrops += peerDelta + dataChannelDelta + mediaDelta;
    this.nativeGenerationQueueSaturations += saturationDelta;
    this.nativeQueueLimitTerminations += queueLimitDelta;
    this.nativeProcessBudgetTerminations += processBudgetDelta;
    this.nativeGenerationBudgetTerminations += generationBudgetDelta;
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
      ...this.nativeQueueTelemetry(),
      dataChannelPressure: this.dataChannelPressure,
      streamCapacityPressure: this.streamCapacityPressure,
      streamBufferPressure: this.streamBufferPressure,
      handlerSaturation: this.handlerSaturation,
      resourceSaturation: this.resourceSaturation,
    });
  }

  private nativeQueueTelemetry() {
    const process = this.engine.nativeQueueMetrics();
    return Object.freeze({
      nativeProcessReservedBytes: process.reservedBytes,
      nativeProcessQueueSaturations: process.saturations,
      nativeGenerationQueueSaturations: this.nativeGenerationQueueSaturations,
      nativeQueueLimitTerminations: this.nativeQueueLimitTerminations,
      nativeProcessBudgetTerminations: this.nativeProcessBudgetTerminations,
      nativeGenerationBudgetTerminations:
        this.nativeGenerationBudgetTerminations,
    });
  }

  private stats(generation: Generation): Promise<PortableRTCStatsReport> {
    if (
      generation.statsRequest === undefined ||
      generation.statsRequest.settled
    ) {
      generation.statsRequest = createStatsRequest(generation.peer);
    }
    const request = generation.statsRequest;
    if (request.claimed) {
      return Promise.reject(new AckerDBError(
        "unavailable",
        "realtime diagnostic is already pending",
        { resource: "connection" },
      ));
    }
    // A native getStats() call cannot be cancelled. Attach at most one caller
    // to a stalled promise so repeated health ticks cannot accumulate an
    // unbounded chain of pending Promise reactions for the same peer.
    request.claimed = true;
    return request.promise;
  }

  private failNativeQueueTerminal(
    generation: Generation,
    reason: RealtimeNativeQueueTerminalReason,
  ): AckerDBError {
    generation.nativeTerminalReason ??= reason;
    const error = nativeQueueTerminalFailure(generation.nativeTerminalReason);
    this.failGeneration(generation, error, "transport");
    return error;
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
    this.wakeCandidateWaiter(generation);
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
      this.captureNativeDrops(generation);
      if (this.sampleIds.length === 0) this.clearLiveHealth();
      generation.session = null;
      if (generation.peer.connectionState !== "closed") {
        generation.peer.close();
      }
      generation.native.close();
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
      throw new AckerDBError(
        "overloaded",
        "realtime handshake owner capacity is full",
        { resource: "connection", retryable: true, retryAfterMs: 0 },
      );
    }
    this.handshakeWindows.set(owner, {
      count: 1,
      expiresAt: now + this.handshakeWindowMs,
    });
  }
}
