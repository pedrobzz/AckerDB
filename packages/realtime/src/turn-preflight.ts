import type {
  NativeRTCIceCandidateInit,
  PortableRTCPeerConnection,
  PortableRTCPeerConnectionIceEvent,
} from "@ackerdb/core";
import { ANONYMOUS_PRINCIPAL } from "@ackerdb/server";
import { realtimePeerDiagnostic } from "./diagnostics.ts";
import type {
  RealtimePeerEngine,
  RealtimePeerGeneration,
} from "./engine.ts";
import { createBundledRealtimeEngine } from "./native/engine.ts";
import {
  resolveRealtimeServerNetwork,
  type ResolvedRealtimeServerNetwork,
  type RealtimeServerNetworkOptions,
} from "./network.ts";
import {
  createTurnConfiguration,
  type RealtimeTurnOptions,
} from "./turn.ts";

const DEFAULT_TIMEOUT_MS = 20_000;
const PREFLIGHT_GENERATION_BYTES = 16 * 1024 * 1024;
const PROBE = "ackerdb-turn-preflight";
const RESPONSE = "ackerdb-turn-preflight-ok";
const TURN_PREFLIGHT_OWNER = "mNNqD96UXGNIX1tnUBTHYqtXYkUceF-lqzV8NSIcN8c";

type TurnTransport = "udp" | "tls";

interface ListenerTarget {
  addEventListener(
    type: string,
    callback: (event: unknown) => unknown,
  ): void;
  removeEventListener(
    type: string,
    callback: (event: unknown) => unknown,
  ): void;
}

interface RealtimeTurnPreflightClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** @internal Test seam for deterministic deadline and ownership coverage. */
export interface RealtimeTurnPreflightDependencies {
  readonly clock: RealtimeTurnPreflightClock;
  createEngine(network: ResolvedRealtimeServerNetwork): RealtimePeerEngine;
}

export interface RealtimeTurnPreflightOptions extends RealtimeTurnOptions {
  /** Absolute allocation, ICE, DTLS, diagnostics, and data-path deadline. */
  readonly timeoutMs?: number;
  /** Cancels both independent probes without exposing the abort reason. */
  readonly signal?: AbortSignal;
  /** The same host-network policy used by the target AckerDB runtime. */
  readonly network?: RealtimeServerNetworkOptions;
}

export type RealtimeTurnPreflightFailureCode =
  | "not_configured"
  | "cancelled"
  | "deadline_exceeded"
  | "unavailable";

export type RealtimeTurnTransportPreflightResult =
  | Readonly<{
    ok: true;
    durationMs: number;
    callerProtocol: "udp" | "tcp";
    receiverProtocol: "udp" | "tcp";
    bidirectionalData: true;
  }>
  | Readonly<{
    ok: false;
    code: RealtimeTurnPreflightFailureCode;
    durationMs: number;
    message: string;
  }>;

export interface RealtimeTurnPreflightResult {
  readonly udp: RealtimeTurnTransportPreflightResult;
  readonly tls: RealtimeTurnTransportPreflightResult;
}

const DEFAULT_DEPENDENCIES: RealtimeTurnPreflightDependencies = {
  clock: {
    now: Date.now,
    setTimeout(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    },
    clearTimeout(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  },
  createEngine: createBundledRealtimeEngine,
};

/**
 * Proves relay-only ICE/DTLS and bidirectional data independently over TURN/UDP
 * and TURN/TLS. Every native operation, including diagnostics, shares its
 * transport's absolute deadline and returns only stable, secret-safe failures.
 */
export function preflightRealtimeTurn(
  options: RealtimeTurnPreflightOptions,
): Promise<RealtimeTurnPreflightResult> {
  return preflightRealtimeTurnWith(options, DEFAULT_DEPENDENCIES);
}

/** @internal */
export async function preflightRealtimeTurnWith(
  options: RealtimeTurnPreflightOptions,
  dependencies: RealtimeTurnPreflightDependencies,
): Promise<RealtimeTurnPreflightResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("realtime TURN preflight timeoutMs must be positive");
  }
  const network = resolveRealtimeServerNetwork(options.network);
  createTurnConfiguration({
    urls: options.urls,
    secret: options.secret,
    ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
    ...(options.stunUrls === undefined ? {} : { stunUrls: options.stunUrls }),
    iceTransportPolicy: "relay",
  });
  const urls = typeof options.urls === "string" ? [options.urls] : [...options.urls];
  const [udp, tls] = await Promise.all([
    probe("udp", urls.filter(isUdpTurnUrl), options, network, timeoutMs, dependencies),
    probe("tls", urls.filter(isTlsTurnUrl), options, network, timeoutMs, dependencies),
  ]);
  return Object.freeze({ udp, tls });
}

async function probe(
  transport: TurnTransport,
  urls: readonly string[],
  options: RealtimeTurnPreflightOptions,
  network: ResolvedRealtimeServerNetwork,
  timeoutMs: number,
  dependencies: RealtimeTurnPreflightDependencies,
): Promise<RealtimeTurnTransportPreflightResult> {
  const startedAt = dependencies.clock.now();
  if (options.signal?.aborted === true) {
    return failure(transport, "cancelled", 0);
  }
  if (urls.length === 0) {
    return failure(transport, "not_configured", 0);
  }

  const abort = new AbortController();
  let timedOut = false;
  let parentCancelled = false;
  const timeout = dependencies.clock.setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, timeoutMs);
  const cancelled = () => {
    parentCancelled = true;
    abort.abort();
  };
  options.signal?.addEventListener("abort", cancelled, { once: true });

  let engine: RealtimePeerEngine | undefined;
  let generation: RealtimePeerGeneration | undefined;
  let caller: PortableRTCPeerConnection | undefined;
  let receiver: PortableRTCPeerConnection | undefined;
  let callerCandidates: CandidateCollector | undefined;
  let receiverCandidates: CandidateCollector | undefined;
  try {
    const configuration = await abortable(abort.signal, () =>
      createTurnConfiguration({
        urls,
        secret: options.secret,
        ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
        iceTransportPolicy: "relay",
      })(ANONYMOUS_PRINCIPAL, abort.signal, TURN_PREFLIGHT_OWNER)
    );
    engine = dependencies.createEngine(network);
    generation = engine.createGeneration(PREFLIGHT_GENERATION_BYTES);
    caller = generation.createPeerConnection(configuration);
    receiver = generation.createPeerConnection(configuration);
    const callerChannel = caller.createDataChannel(PROBE, {
      negotiated: true,
      id: 0,
      ordered: true,
    });
    const receiverChannel = receiver.createDataChannel(PROBE, {
      negotiated: true,
      id: 0,
      ordered: true,
    });
    callerCandidates = collectCandidates(caller);
    receiverCandidates = collectCandidates(receiver);

    await abortable(abort.signal, async () => {
      await caller!.setLocalDescription(await caller!.createOffer());
      await waitFor(
        caller!,
        "icegatheringstatechange",
        () => caller!.iceGatheringState === "complete",
        abort.signal,
      );
      await receiver!.setRemoteDescription(caller!.localDescription!);
      for (const candidate of callerCandidates!.values) {
        await receiver!.addIceCandidate(candidate);
      }

      await receiver!.setLocalDescription(await receiver!.createAnswer());
      await waitFor(
        receiver!,
        "icegatheringstatechange",
        () => receiver!.iceGatheringState === "complete",
        abort.signal,
      );
      await caller!.setRemoteDescription(receiver!.localDescription!);
      for (const candidate of receiverCandidates!.values) {
        await caller!.addIceCandidate(candidate);
      }

      await Promise.all([
        waitFor(caller!, "connectionstatechange", () =>
          caller!.connectionState === "connected", abort.signal),
        waitFor(receiver!, "connectionstatechange", () =>
          receiver!.connectionState === "connected", abort.signal),
        waitFor(callerChannel, "open", () =>
          callerChannel.readyState === "open", abort.signal),
        waitFor(receiverChannel, "open", () =>
          receiverChannel.readyState === "open", abort.signal),
      ]);

      const receiverMessage = waitFor(
        receiverChannel,
        "message",
        (event) => (event as { readonly data?: unknown } | undefined)?.data === PROBE,
        abort.signal,
      );
      callerChannel.send(PROBE);
      await receiverMessage;
      const callerMessage = waitFor(
        callerChannel,
        "message",
        (event) =>
          (event as { readonly data?: unknown } | undefined)?.data === RESPONSE,
        abort.signal,
      );
      receiverChannel.send(RESPONSE);
      await callerMessage;
    });

    const [callerDiagnostic, receiverDiagnostic] = await Promise.all([
      abortable(abort.signal, () => diagnostic(caller!)),
      abortable(abort.signal, () => diagnostic(receiver!)),
    ]);
    if (
      !usesExpectedRelay(callerDiagnostic.path, transport) ||
      !usesExpectedRelay(receiverDiagnostic.path, transport)
    ) {
      throw new Error("TURN preflight selected an unexpected candidate path");
    }
    return Object.freeze({
      ok: true,
      durationMs: elapsed(dependencies.clock, startedAt),
      callerProtocol: protocol(callerDiagnostic.path.protocol),
      receiverProtocol: protocol(receiverDiagnostic.path.protocol),
      bidirectionalData: true,
    });
  } catch {
    const code = timedOut
      ? "deadline_exceeded"
      : parentCancelled
        ? "cancelled"
        : "unavailable";
    return failure(
      transport,
      code,
      elapsed(dependencies.clock, startedAt),
    );
  } finally {
    dependencies.clock.clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancelled);
    abort.abort();
    callerCandidates?.dispose();
    receiverCandidates?.dispose();
    close(caller);
    close(receiver);
    close(generation);
    close(engine);
  }
}

interface CandidateCollector {
  readonly values: NativeRTCIceCandidateInit[];
  dispose(): void;
}

function collectCandidates(peer: PortableRTCPeerConnection): CandidateCollector {
  const values: NativeRTCIceCandidateInit[] = [];
  const listener = (event: unknown) => {
    const candidate = (event as PortableRTCPeerConnectionIceEvent).candidate;
    if (candidate !== null) values.push(candidate.toJSON());
  };
  peer.addEventListener("icecandidate", listener);
  return {
    values,
    dispose: () => peer.removeEventListener("icecandidate", listener),
  };
}

function waitFor(
  target: ListenerTarget,
  event: string,
  ready: (event?: unknown) => boolean,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener(event, changed);
      signal.removeEventListener("abort", aborted);
    };
    const changed = (value: unknown) => {
      if (!ready(value)) return;
      cleanup();
      resolve();
    };
    const aborted = () => {
      cleanup();
      reject(signal.reason);
    };
    target.addEventListener(event, changed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

function abortable<Value>(
  signal: AbortSignal,
  operation: () => Value | PromiseLike<Value>,
): Promise<Value> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      reject(signal.reason);
    };
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve()
      .then(() => signal.aborted ? Promise.reject(signal.reason) : operation())
      .then(
        (value) => {
          signal.removeEventListener("abort", aborted);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", aborted);
          reject(error);
        },
      );
  });
}

async function diagnostic(peer: PortableRTCPeerConnection) {
  return realtimePeerDiagnostic({
    observedAtMs: Date.now(),
    connectionState: peer.connectionState,
    signalingState: peer.signalingState,
    iceGatheringState: peer.iceGatheringState,
    report: await peer.getStats(),
  });
}

function usesExpectedRelay(
  path: {
    readonly localCandidateType?: string;
    readonly remoteCandidateType?: string;
    readonly relayProtocol?: string;
  } | undefined,
  transport: TurnTransport,
): path is NonNullable<typeof path> & { readonly protocol?: string } {
  return path !== undefined &&
    (path.localCandidateType === "relay" || path.remoteCandidateType === "relay") &&
    path.relayProtocol === transport;
}

function protocol(value: string | undefined): "udp" | "tcp" {
  if (value === "udp" || value === "tcp") return value;
  throw new Error("TURN preflight selected no supported UDP or TCP path");
}

function isUdpTurnUrl(value: string): boolean {
  if (!value.startsWith("turn:")) return false;
  const transport = new URLSearchParams(value.split("?", 2)[1]).get("transport");
  return transport === null || transport.toLowerCase() === "udp";
}

function isTlsTurnUrl(value: string): boolean {
  return value.startsWith("turns:");
}

function elapsed(clock: RealtimeTurnPreflightClock, startedAt: number): number {
  return Math.max(0, clock.now() - startedAt);
}

function failure(
  transport: TurnTransport,
  code: RealtimeTurnPreflightFailureCode,
  durationMs: number,
): RealtimeTurnTransportPreflightResult {
  const name = transport === "udp" ? "TURN/UDP" : "TURN/TLS";
  const suffix = code === "not_configured"
    ? "is not configured"
    : code === "cancelled"
      ? "was cancelled"
      : code === "deadline_exceeded"
        ? "timed out"
        : "failed";
  return Object.freeze({
    ok: false,
    code,
    durationMs,
    message: `${name} preflight ${suffix}`,
  });
}

function close(value: { close(): void } | undefined): void {
  try {
    value?.close();
  } catch {
    // A completed diagnostic must not be replaced by cleanup failure details.
  }
}
