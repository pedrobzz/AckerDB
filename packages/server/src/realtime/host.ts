import type {
  ApplicationError,
  NativeRTCPeerConnectionState,
  NativeRTCSessionDescriptionInit,
  NativeRTCSignalingState,
  Outcome,
  PortableRTCConfiguration,
  RealtimeCandidateBatch,
  RealtimeIceCandidate,
  RealtimeStreamLimits,
} from "@ackerdb/core";
import type { Principal } from "../auth/credentials.ts";
import type { ProcedureCtx } from "../app/functions.ts";
import type { AnyRegisteredRealtime } from "./definition.ts";

export { deepFreeze } from "../shared/immutable.ts";
export { positiveSafeInteger } from "../shared/numbers.ts";
export { outcomeFromError } from "../runtime/outcome.ts";
export { settleOnAbort } from "../runtime/abort.ts";

export interface RealtimeProcedureContextOwner {
  readonly value: ProcedureCtx;
  release(): void;
}

export interface RealtimeServerSessionAdapter {
  createContext(signal: AbortSignal): RealtimeProcedureContextOwner;
  invoke<Value>(
    definition: AnyRegisteredRealtime,
    context: ProcedureCtx,
    work: () => Value | Promise<Value>,
  ): Promise<Value>;
  failed(error: unknown): void;
}

export interface RealtimeOfferInput {
  readonly address: string;
  readonly args: unknown;
  readonly offer: NativeRTCSessionDescriptionInit;
  readonly principal: Principal;
  /** Credential-revocation lifetime, not the initiating HTTP request signal. */
  readonly signal: AbortSignal;
  /** Transfers the initiating authentication lease to this peer generation. */
  readonly releaseAuthentication: () => void;
  readonly requestBytes: number;
  readonly recovery?: boolean;
}

export type RealtimeOfferResult =
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly answer: NativeRTCSessionDescriptionInit;
      readonly streamLimits: RealtimeStreamLimits;
      readonly candidates: readonly RealtimeIceCandidate[];
      readonly complete: boolean;
    }
  | {
      readonly ok: false;
      readonly error: ApplicationError;
    };

export type RealtimePatchResult =
  | ({ readonly ok: true } & RealtimeCandidateBatch)
  | { readonly ok: false; readonly outcome: Outcome };

export interface AuthorizedRealtimeApplication {
  readonly ok: true;
  readonly args: unknown;
  readonly state: unknown;
  readonly adapter: RealtimeServerSessionAdapter;
}

export interface RejectedRealtimeApplication {
  readonly ok: false;
  readonly error: ApplicationError;
}

export interface RealtimeRuntimeApplication {
  authorize(
    definition: AnyRegisteredRealtime,
    input: RealtimeOfferInput,
  ): Promise<AuthorizedRealtimeApplication | RejectedRealtimeApplication>;
}

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

export type RealtimeGlobalResourceKind =
  | "auxiliaryPeers"
  | "decodedStreams"
  | "mediaSources"
  | "tracks";

export interface RealtimeGlobalResourceLimits {
  readonly maxAuxiliaryPeers: number;
  readonly maxDecodedStreams: number;
  readonly maxMediaSources: number;
  readonly maxTracks: number;
}

export interface RealtimeGlobalResourceSnapshot {
  readonly limits: RealtimeGlobalResourceLimits;
  readonly active: Readonly<Record<RealtimeGlobalResourceKind, number>>;
  readonly saturated: Readonly<Record<RealtimeGlobalResourceKind, number>>;
}

export type RealtimeNetworkAdapterType =
  | "unknown"
  | "ethernet"
  | "wifi"
  | "cellular"
  | "vpn"
  | "loopback"
  | "any"
  | "cellular-2g"
  | "cellular-3g"
  | "cellular-4g"
  | "cellular-5g";

export interface RealtimeNetworkDiagnostic {
  readonly includedInterfaces: readonly string[] | null;
  readonly excludedInterfaces: readonly string[];
  readonly ignoredAdapterTypes: readonly RealtimeNetworkAdapterType[];
  readonly udpPortRange: { readonly min: number; readonly max: number } | null;
  readonly advertisedAddressMappings: number;
  readonly iceTimingOverrides: number;
}

export type RealtimeCloseReason =
  | "client"
  | "authentication"
  | "transport"
  | "handler"
  | "draining"
  | "setup";

export interface RealtimeHealthSnapshot {
  readonly sampledPeers: number;
  readonly sampleFailures: number;
  readonly directPaths: number;
  readonly relayPaths: number;
  readonly udpPaths: number;
  readonly tcpPaths: number;
  readonly roundTripTimeAverageMs: number;
  readonly roundTripTimeMaxMs: number;
  readonly jitterMaxMs: number;
  readonly packets: number;
  readonly packetsLost: number;
  readonly frames: number;
  readonly framesDropped: number;
  readonly availableIncomingBitrate: number;
  readonly availableOutgoingBitrate: number;
  readonly dataChannelBufferedAmountMax: number;
  readonly nativeQueueDrops: number;
  readonly dataChannelPressure: number;
  readonly streamCapacityPressure: number;
  readonly streamBufferPressure: number;
  readonly handlerSaturation: number;
  readonly resourceSaturation: number;
}

export interface RealtimeRuntimeSnapshot {
  readonly network: RealtimeNetworkDiagnostic | null;
  readonly activeSessions: number;
  readonly reservedSessions: number;
  readonly activePrincipals: number;
  readonly trackedHandshakeWindows: number;
  readonly offers: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly overloaded: number;
  readonly failed: number;
  readonly closed: number;
  readonly recoveryAttempts: number;
  readonly recoveryAccepted: number;
  readonly recoveryRejected: number;
  readonly recoveryFailed: number;
  readonly closeReasons: Readonly<Record<RealtimeCloseReason, number>>;
  readonly resources: RealtimeGlobalResourceSnapshot;
  readonly health: RealtimeHealthSnapshot;
}

export interface RealtimeRuntime {
  configuration(
    principal: Principal,
    signal: AbortSignal,
  ): Promise<PortableRTCConfiguration>;
  offer(input: RealtimeOfferInput): Promise<RealtimeOfferResult>;
  patch(
    sessionId: string,
    principal: Principal,
    batch: RealtimeCandidateBatch,
  ): Promise<RealtimePatchResult>;
  close(sessionId: string, principal: Principal): void;
  snapshot(): RealtimeRuntimeSnapshot;
  diagnostic(
    sessionId: string,
    principal: Principal,
  ): Promise<RealtimePeerDiagnostic>;
  sampleHealth(maxPeers?: number): Promise<void>;
  drain(): Promise<void>;
}

export interface RealtimeRuntimeHost {
  readonly application: RealtimeRuntimeApplication;
  readonly now: () => number;
  definition(address: string): AnyRegisteredRealtime | undefined;
}

export interface RealtimeRuntimeModule {
  create(host: RealtimeRuntimeHost): RealtimeRuntime;
}
