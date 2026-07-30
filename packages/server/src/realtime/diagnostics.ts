import type {
  NativeRTCPeerConnectionState,
  NativeRTCSignalingState,
  PortableRTCStats,
  PortableRTCStatsReport,
} from "@ackerdb/core";

export interface RealtimeCandidatePathDiagnostic {
  readonly localCandidateType?: "host" | "srflx" | "prflx" | "relay";
  readonly remoteCandidateType?: "host" | "srflx" | "prflx" | "relay";
  readonly protocol?: "udp" | "tcp";
  readonly relayProtocol?: "udp" | "tcp" | "tls";
}

export interface RealtimeMediaFlowDiagnostic {
  readonly bytes?: number;
  readonly packets?: number;
  readonly packetsLost?: number;
  readonly jitterMs?: number;
  readonly concealedSamples?: number;
  readonly frames?: number;
  readonly framesDropped?: number;
}

export interface RealtimePeerDiagnostic {
  readonly observedAtMs: number;
  readonly connectionState: NativeRTCPeerConnectionState;
  readonly signalingState: NativeRTCSignalingState;
  readonly iceGatheringState: "new" | "gathering" | "complete";
  readonly path?: RealtimeCandidatePathDiagnostic;
  readonly roundTripTimeMs?: number;
  readonly availableIncomingBitrate?: number;
  readonly availableOutgoingBitrate?: number;
  readonly inbound?: Readonly<{
    audio?: RealtimeMediaFlowDiagnostic;
    video?: RealtimeMediaFlowDiagnostic;
  }>;
  readonly outbound?: Readonly<{
    audio?: RealtimeMediaFlowDiagnostic;
    video?: RealtimeMediaFlowDiagnostic;
  }>;
}

export interface RealtimePeerDiagnosticInput {
  readonly observedAtMs: number;
  readonly connectionState: NativeRTCPeerConnectionState;
  readonly signalingState: NativeRTCSignalingState;
  readonly iceGatheringState: "new" | "gathering" | "complete";
  readonly report: PortableRTCStatsReport;
}

type MediaKind = "audio" | "video";
type CandidateType = "host" | "srflx" | "prflx" | "relay";
type Protocol = "udp" | "tcp";
type RelayProtocol = Protocol | "tls";

const MAX_STATS = 4_096;
const CANDIDATE_TYPES = new Set<CandidateType>([
  "host",
  "srflx",
  "prflx",
  "relay",
]);
const PROTOCOLS = new Set<Protocol>(["udp", "tcp"]);
const RELAY_PROTOCOLS = new Set<RelayProtocol>(["udp", "tcp", "tls"]);

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function known<Value extends string>(
  value: unknown,
  values: ReadonlySet<Value>,
): Value | undefined {
  return typeof value === "string" && values.has(value as Value)
    ? value as Value
    : undefined;
}

function stat(
  report: PortableRTCStatsReport,
  id: unknown,
): PortableRTCStats | undefined {
  return typeof id === "string" ? report.get(id) : undefined;
}

function selectedPair(
  report: PortableRTCStatsReport,
): PortableRTCStats | undefined {
  for (const value of report.values()) {
    if (value.type !== "transport") continue;
    const pair = stat(report, value.selectedCandidatePairId);
    if (pair?.type === "candidate-pair") return pair;
  }
  for (const value of report.values()) {
    if (
      value.type === "candidate-pair" &&
      value.state === "succeeded" &&
      (value.nominated === true || value.selected === true)
    ) {
      return value;
    }
  }
  return undefined;
}

function add(
  target: Record<string, number>,
  property: string,
  value: unknown,
  scale = 1,
): void {
  const number = nonNegative(value);
  if (number !== undefined) {
    target[property] = (target[property] ?? 0) + number * scale;
  }
}

function max(
  target: Record<string, number>,
  property: string,
  value: unknown,
  scale = 1,
): void {
  const number = nonNegative(value);
  if (number !== undefined) {
    target[property] = Math.max(target[property] ?? 0, number * scale);
  }
}

function media(
  report: PortableRTCStatsReport,
  type: "inbound-rtp" | "outbound-rtp",
): Readonly<Partial<Record<MediaKind, RealtimeMediaFlowDiagnostic>>> | undefined {
  const totals: Partial<Record<MediaKind, Record<string, number>>> = {};
  for (const value of report.values()) {
    if (value.type !== type) continue;
    const kind = value.kind === "audio" || value.kind === "video"
      ? value.kind
      : value.mediaType === "audio" || value.mediaType === "video"
        ? value.mediaType
        : undefined;
    if (kind === undefined) continue;
    const total = totals[kind] ??= {};
    add(
      total,
      "bytes",
      type === "inbound-rtp" ? value.bytesReceived : value.bytesSent,
    );
    add(
      total,
      "packets",
      type === "inbound-rtp" ? value.packetsReceived : value.packetsSent,
    );
    add(total, "packetsLost", value.packetsLost);
    max(total, "jitterMs", value.jitter, 1_000);
    add(total, "concealedSamples", value.concealedSamples);
    add(
      total,
      "frames",
      type === "inbound-rtp" ? value.framesDecoded : value.framesEncoded,
    );
    add(total, "framesDropped", value.framesDropped);
  }

  const output: Partial<Record<MediaKind, RealtimeMediaFlowDiagnostic>> = {};
  for (const kind of ["audio", "video"] as const) {
    const total = totals[kind];
    if (total !== undefined && Object.keys(total).length > 0) {
      output[kind] = Object.freeze(total);
    }
  }
  return Object.keys(output).length === 0 ? undefined : Object.freeze(output);
}

export function realtimePeerDiagnostic(
  input: RealtimePeerDiagnosticInput,
): RealtimePeerDiagnostic {
  if (input.report.size > MAX_STATS) {
    throw new RangeError(`WebRTC stats report exceeds ${MAX_STATS} entries`);
  }
  const pair = selectedPair(input.report);
  const local = pair === undefined
    ? undefined
    : stat(input.report, pair.localCandidateId);
  const remote = pair === undefined
    ? undefined
    : stat(input.report, pair.remoteCandidateId);
  const path = pair === undefined
    ? undefined
    : Object.freeze({
        ...(known(local?.candidateType, CANDIDATE_TYPES) === undefined
          ? {}
          : {
              localCandidateType: known(
                local?.candidateType,
                CANDIDATE_TYPES,
              ),
            }),
        ...(known(remote?.candidateType, CANDIDATE_TYPES) === undefined
          ? {}
          : {
              remoteCandidateType: known(
                remote?.candidateType,
                CANDIDATE_TYPES,
              ),
            }),
        ...(known(local?.protocol ?? remote?.protocol, PROTOCOLS) === undefined
          ? {}
          : {
              protocol: known(
                local?.protocol ?? remote?.protocol,
                PROTOCOLS,
              ),
            }),
        ...(known(local?.relayProtocol, RELAY_PROTOCOLS) === undefined
          ? {}
          : {
              relayProtocol: known(
                local?.relayProtocol,
                RELAY_PROTOCOLS,
              ),
            }),
      });
  const roundTripTime = nonNegative(pair?.currentRoundTripTime);
  const availableIncomingBitrate = nonNegative(
    pair?.availableIncomingBitrate,
  );
  const availableOutgoingBitrate = nonNegative(
    pair?.availableOutgoingBitrate,
  );
  const inbound = media(input.report, "inbound-rtp");
  const outbound = media(input.report, "outbound-rtp");

  return Object.freeze({
    observedAtMs: input.observedAtMs,
    connectionState: input.connectionState,
    signalingState: input.signalingState,
    iceGatheringState: input.iceGatheringState,
    ...(path === undefined || Object.keys(path).length === 0 ? {} : { path }),
    ...(roundTripTime === undefined
      ? {}
      : { roundTripTimeMs: roundTripTime * 1_000 }),
    ...(availableIncomingBitrate === undefined
      ? {}
      : { availableIncomingBitrate }),
    ...(availableOutgoingBitrate === undefined
      ? {}
      : { availableOutgoingBitrate }),
    ...(inbound === undefined ? {} : { inbound }),
    ...(outbound === undefined ? {} : { outbound }),
  });
}
