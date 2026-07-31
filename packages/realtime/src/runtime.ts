import type {
  RealtimeRuntimeHost,
  RealtimeRuntimeModule,
} from "@ackerdb/server/realtime-host";
import type { RealtimeConfigurationSource } from "./engine.ts";
import { RealtimeHub, REALTIME_HUB_DEFAULTS } from "./hub.ts";
import { createBundledRealtimeEngine } from "./native/engine.ts";
import {
  resolveRealtimeServerNetwork,
  type RealtimeServerNetworkOptions,
} from "./network.ts";
import {
  REALTIME_GLOBAL_RESOURCE_DEFAULTS,
  RealtimeGlobalResourceBudget,
  type RealtimeGlobalResourceLimits,
} from "./resources.ts";
import type { RealtimeServerSessionLimits } from "./session.ts";
import {
  createTurnConfiguration,
  type RealtimeTurnOptions,
} from "./turn.ts";

export interface RealtimeOptions {
  readonly configuration?: RealtimeConfigurationSource;
  /** Built-in short-lived coturn REST credentials. */
  readonly turn?: RealtimeTurnOptions;
  readonly maxSessions?: number;
  readonly maxSessionsPerPrincipal?: number;
  readonly maxHandshakesPerWindow?: number;
  readonly handshakeWindowMs?: number;
  readonly maxTrackedPrincipals?: number;
  readonly maxPendingCandidates?: number;
  /** Cumulative untrusted remote ICE candidates permitted per generation. */
  readonly maxRemoteCandidates?: number;
  /** Cumulative canonical remote ICE candidate bytes permitted per generation. */
  readonly maxRemoteCandidateBytes?: number;
  readonly terminalRetentionMs?: number;
  /** Lifetime for an authenticated, authorized offer ticket. */
  readonly preparedSessionTtlMs?: number;
  /** Maximum accounted bytes retained by all prepared tickets. */
  readonly maxPreparedBytes?: number;
  readonly sessionLimits?: Partial<RealtimeServerSessionLimits>;
  readonly resourceLimits?: Partial<RealtimeGlobalResourceLimits>;
  /** Deployment-owned bind, candidate, UDP, and ICE timing policy. */
  readonly network?: RealtimeServerNetworkOptions;
  readonly authorizationTimeoutMs?: number;
  readonly configurationTimeoutMs?: number;
  readonly handlerTimeoutMs?: number;
  readonly signalingTimeoutMs?: number;
  readonly iceTimeoutMs?: number;
  readonly dtlsTimeoutMs?: number;
  readonly dataChannelTimeoutMs?: number;
  readonly diagnosticTimeoutMs?: number;
}

/**
 * The complete optional server runtime. Constructing the module is inert;
 * native libwebrtc loads only when a Runtime containing realtime definitions
 * asks the module to create its adapter.
 */
export function createRealtimeRuntime(
  options: RealtimeOptions = {},
): RealtimeRuntimeModule {
  if (options.configuration !== undefined && options.turn !== undefined) {
    throw new TypeError(
      "realtime accepts either configuration or turn, not both",
    );
  }
  return Object.freeze({
    create: (host: RealtimeRuntimeHost) => {
      const network = resolveRealtimeServerNetwork(options.network);
      const resources = new RealtimeGlobalResourceBudget({
        ...REALTIME_GLOBAL_RESOURCE_DEFAULTS,
        ...options.resourceLimits,
      });
      return new RealtimeHub({
        definition: host.definition,
        engine: createBundledRealtimeEngine(network, resources),
        configuration: options.configuration ??
          (options.turn === undefined
            ? () => ({})
            : createTurnConfiguration(options.turn, host.now)),
        application: host.application,
        maxSessions: options.maxSessions ??
          REALTIME_HUB_DEFAULTS.maxSessions,
        maxSessionsPerPrincipal: options.maxSessionsPerPrincipal ??
          REALTIME_HUB_DEFAULTS.maxSessionsPerPrincipal,
        maxHandshakesPerWindow: options.maxHandshakesPerWindow ??
          REALTIME_HUB_DEFAULTS.maxHandshakesPerWindow,
        handshakeWindowMs: options.handshakeWindowMs ??
          REALTIME_HUB_DEFAULTS.handshakeWindowMs,
        maxTrackedPrincipals: options.maxTrackedPrincipals ??
          REALTIME_HUB_DEFAULTS.maxTrackedPrincipals,
        maxPendingCandidates: options.maxPendingCandidates ??
          REALTIME_HUB_DEFAULTS.maxPendingCandidates,
        maxRemoteCandidates: options.maxRemoteCandidates ??
          REALTIME_HUB_DEFAULTS.maxRemoteCandidates,
        maxRemoteCandidateBytes: options.maxRemoteCandidateBytes ??
          REALTIME_HUB_DEFAULTS.maxRemoteCandidateBytes,
        allowPrivateCandidateAddresses: network.allowPrivateCandidateAddresses,
        terminalRetentionMs: options.terminalRetentionMs ??
          REALTIME_HUB_DEFAULTS.terminalRetentionMs,
        preparedSessionTtlMs: options.preparedSessionTtlMs ??
          REALTIME_HUB_DEFAULTS.preparedSessionTtlMs,
        maxPreparedBytes: options.maxPreparedBytes ??
          REALTIME_HUB_DEFAULTS.maxPreparedBytes,
        sessionLimits: Object.freeze({
          ...REALTIME_HUB_DEFAULTS.sessionLimits,
          ...options.sessionLimits,
        }),
        resourceBudget: resources,
        now: host.now,
        networkDiagnostic: network.diagnostic,
        authorizationTimeoutMs: options.authorizationTimeoutMs,
        configurationTimeoutMs: options.configurationTimeoutMs,
        handlerTimeoutMs: options.handlerTimeoutMs,
        signalingTimeoutMs: options.signalingTimeoutMs,
        iceTimeoutMs: options.iceTimeoutMs,
        dtlsTimeoutMs: options.dtlsTimeoutMs,
        dataChannelTimeoutMs: options.dataChannelTimeoutMs,
        diagnosticTimeoutMs: options.diagnosticTimeoutMs,
      });
    },
  });
}
