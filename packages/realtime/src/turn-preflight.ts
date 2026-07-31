import type {
  NativeRTCIceCandidateInit,
  PortableRTCPeerConnection,
  PortableRTCPeerConnectionIceEvent,
} from "@ackerdb/core";
import { ANONYMOUS_PRINCIPAL } from "@ackerdb/server";
import { realtimePeerDiagnostic } from "./diagnostics.ts";
import { createBundledRealtimeEngine } from "./native/engine.ts";
import {
  resolveRealtimeServerNetwork,
  type RealtimeServerNetworkOptions,
} from "./network.ts";
import {
  createTurnConfiguration,
  type RealtimeTurnOptions,
} from "./turn.ts";

const DEFAULT_TIMEOUT_MS = 20_000;
const PROBE = "ackerdb-turn-preflight";
const RESPONSE = "ackerdb-turn-preflight-ok";

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

export interface RealtimeTurnPreflightOptions extends RealtimeTurnOptions {
  /** Absolute allocation, ICE, DTLS, and bidirectional-data deadline. */
  readonly timeoutMs?: number;
  /** The same host-network policy used by the target AckerDB runtime. */
  readonly network?: RealtimeServerNetworkOptions;
}

export interface RealtimeTurnPreflightResult {
  readonly durationMs: number;
  readonly callerProtocol: "udp" | "tcp";
  readonly receiverProtocol: "udp" | "tcp";
  readonly bidirectionalData: true;
}

/**
 * Proves two real allocations, relay-only ICE/DTLS, and bidirectional data
 * through the configured TURN service. A listening port or HTTP health check
 * is insufficient evidence that allocation and relay permissions work.
 */
export async function preflightRealtimeTurn(
  options: RealtimeTurnPreflightOptions,
): Promise<RealtimeTurnPreflightResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("realtime TURN preflight timeoutMs must be positive");
  }
  const engine = createBundledRealtimeEngine(
    resolveRealtimeServerNetwork(options.network),
  );
  const configuration = await createTurnConfiguration({
    ...options,
    iceTransportPolicy: "relay",
  })(ANONYMOUS_PRINCIPAL, AbortSignal.timeout(timeoutMs));
  const caller = engine.createPeerConnection(configuration);
  const receiver = engine.createPeerConnection(configuration);
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
  const abort = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => {
    abort.abort(new DOMException(
      "TURN allocation and bidirectional relay preflight timed out",
      "TimeoutError",
    ));
  }, timeoutMs);
  timer.unref?.();

  try {
    const callerCandidates = collectCandidates(caller);
    const receiverCandidates = collectCandidates(receiver);
    await caller.setLocalDescription(await caller.createOffer());
    await waitFor(
      caller,
      "icegatheringstatechange",
      () => caller.iceGatheringState === "complete",
      abort.signal,
    );
    await receiver.setRemoteDescription(caller.localDescription!);
    for (const candidate of callerCandidates) {
      await receiver.addIceCandidate(candidate);
    }

    await receiver.setLocalDescription(await receiver.createAnswer());
    await waitFor(
      receiver,
      "icegatheringstatechange",
      () => receiver.iceGatheringState === "complete",
      abort.signal,
    );
    await caller.setRemoteDescription(receiver.localDescription!);
    for (const candidate of receiverCandidates) {
      await caller.addIceCandidate(candidate);
    }

    await Promise.all([
      waitFor(
        caller,
        "connectionstatechange",
        () => caller.connectionState === "connected",
        abort.signal,
      ),
      waitFor(
        receiver,
        "connectionstatechange",
        () => receiver.connectionState === "connected",
        abort.signal,
      ),
      waitFor(
        callerChannel,
        "open",
        () => callerChannel.readyState === "open",
        abort.signal,
      ),
      waitFor(
        receiverChannel,
        "open",
        () => receiverChannel.readyState === "open",
        abort.signal,
      ),
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

    const [callerDiagnostic, receiverDiagnostic] = await Promise.all([
      diagnostic(caller),
      diagnostic(receiver),
    ]);
    if (
      callerDiagnostic.path === undefined ||
      receiverDiagnostic.path === undefined ||
      !usesRelay(callerDiagnostic.path) ||
      !usesRelay(receiverDiagnostic.path)
    ) {
      throw new Error(
        "TURN preflight connected without selecting a relay candidate",
      );
    }
    const callerProtocol = protocol(callerDiagnostic.path.protocol);
    const receiverProtocol = protocol(receiverDiagnostic.path.protocol);
    return Object.freeze({
      durationMs: Math.max(0, Date.now() - startedAt),
      callerProtocol,
      receiverProtocol,
      bidirectionalData: true,
    });
  } finally {
    clearTimeout(timer);
    abort.abort(new DOMException("TURN preflight completed", "AbortError"));
    caller.close();
    receiver.close();
  }
}

function collectCandidates(
  peer: PortableRTCPeerConnection,
): NativeRTCIceCandidateInit[] {
  const values: NativeRTCIceCandidateInit[] = [];
  peer.addEventListener("icecandidate", (event) => {
    const candidate = (event as PortableRTCPeerConnectionIceEvent).candidate;
    if (candidate !== null) values.push(candidate.toJSON());
  });
  return values;
}

function waitFor(
  target: ListenerTarget,
  event: string,
  ready: (event?: unknown) => boolean,
  signal: AbortSignal,
): Promise<void> {
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

function usesRelay(path: {
  readonly localCandidateType?: string;
  readonly remoteCandidateType?: string;
}): boolean {
  return path.localCandidateType === "relay" ||
    path.remoteCandidateType === "relay";
}

function protocol(value: string | undefined): "udp" | "tcp" {
  if (value === "udp" || value === "tcp") return value;
  throw new Error("TURN preflight selected no supported UDP or TCP path");
}
