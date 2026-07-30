import { describe, expect, test } from "bun:test";
import {
  Ok,
  type PortableRTCPeerConnection,
} from "@ackerdb/core";
import { ANONYMOUS_PRINCIPAL } from "../../src/auth/credentials.ts";
import { invokeRegisteredHandler } from "../../src/app/invocation.ts";
import type { ProcedureCtx } from "../../src/app/functions.ts";
import { Registry } from "../../src/app/registry.ts";
import { realtime } from "../../src/realtime/definition.ts";
import {
  RealtimeHub,
  type RealtimeHubApplication,
  type RealtimeOfferInput,
  type RealtimeHubOptions,
} from "../../src/realtime/hub.ts";
import type { RealtimeConfigurationSource } from "../../src/realtime/engine.ts";
import type { RealtimeServerSessionAdapter } from "../../src/realtime/session.ts";
import { v } from "../../src/validation/v.ts";
import { testRealtimeEngine } from "./support.ts";

class FakeDataChannel extends EventTarget {
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState: RTCDataChannelState = "open";

  send(): void {}
}

class FakePeerConnection extends EventTarget {
  readonly channel = new FakeDataChannel();
  readonly remoteDescriptions: RTCSessionDescriptionInit[] = [];
  readonly candidates: (RTCIceCandidateInit | null)[] = [];
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  signalingState: RTCSignalingState = "stable";
  iceGatheringState: RTCIceGatheringState = "complete";
  localDescription: RTCSessionDescription | null = null;
  closed = false;
  onRemoteDescription: (() => void) | null = null;
  stallRemoteDescription = false;

  createDataChannel(
    label: string,
    options?: RTCDataChannelInit,
  ): RTCDataChannel {
    expect(label).toBe("ackerdb.typed.v1");
    expect(options).toEqual({ negotiated: true, id: 0, ordered: true });
    return this.channel as unknown as RTCDataChannel;
  }

  async setRemoteDescription(value: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescriptions.push(value);
    if (this.stallRemoteDescription) await new Promise(() => {});
    this.onRemoteDescription?.();
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "v=0\r\nanswer" };
  }

  async setLocalDescription(value: RTCLocalSessionDescriptionInit): Promise<void> {
    this.localDescription = value as RTCSessionDescription;
  }

  async addIceCandidate(value?: RTCIceCandidateInit | null): Promise<void> {
    this.candidates.push(value ?? null);
  }

  async getStats(): Promise<RTCStatsReport> {
    return new Map([
      ["transport", {
        id: "transport",
        type: "transport",
        timestamp: 1,
        selectedCandidatePairId: "pair",
      }],
      ["pair", {
        id: "pair",
        type: "candidate-pair",
        timestamp: 1,
        state: "succeeded",
        nominated: true,
        localCandidateId: "local",
        remoteCandidateId: "remote",
        currentRoundTripTime: 0.02,
      }],
      ["local", {
        id: "local",
        type: "local-candidate",
        timestamp: 1,
        candidateType: "host",
        protocol: "udp",
        address: "10.0.0.1",
      }],
      ["remote", {
        id: "remote",
        type: "remote-candidate",
        timestamp: 1,
        candidateType: "srflx",
        protocol: "udp",
        address: "203.0.113.1",
      }],
      ["inbound-audio", {
        id: "inbound-audio",
        type: "inbound-rtp",
        timestamp: 1,
        kind: "audio",
        bytesReceived: 128,
        packetsReceived: 2,
        packetsLost: 1,
        jitter: 0.004,
      }],
      ["outbound-video", {
        id: "outbound-video",
        type: "outbound-rtp",
        timestamp: 1,
        kind: "video",
        bytesSent: 256,
        packetsSent: 3,
        framesEncoded: 1,
        framesDropped: 2,
      }],
    ]) as RTCStatsReport;
  }

  close(): void {
    this.closed = true;
    this.connectionState = "closed";
  }
}

function procedure(signal: AbortSignal): ProcedureCtx {
  return Object.freeze({
    auth: ANONYMOUS_PRINCIPAL,
    abortSignal: signal,
    timestamp: 1,
    tx: async () => Ok(undefined),
    linkAccount: async () => {},
    unlinkAccount: async () => {},
  }) as ProcedureCtx;
}

function adapter(): RealtimeServerSessionAdapter {
  return {
    createContext: (signal) => ({
      value: procedure(signal),
      release: () => {},
    }),
    invoke: (owner, context, work) =>
      invokeRegisteredHandler(owner, context as never, work).then(
        (value) => value as never,
      ),
    failed: () => {},
  };
}

function application(
  authorize: RealtimeHubApplication["authorize"] = async (_definition, input) => ({
    ok: true,
    args: input.args,
    state: undefined,
    adapter: adapter(),
  }),
): RealtimeHubApplication {
  return { authorize };
}

function createHub(
  peer: FakePeerConnection | (() => FakePeerConnection),
  authorize?: RealtimeHubApplication["authorize"],
  handler: (
    context: {
      readonly peerConnection: PortableRTCPeerConnection;
      createPeerConnection(): PortableRTCPeerConnection;
    },
  ) => void | Promise<void> = () => {},
  limits: Partial<
    Pick<
      RealtimeHubOptions,
      | "maxSessions"
      | "maxSessionsPerPrincipal"
      | "maxHandshakesPerWindow"
      | "handshakeWindowMs"
      | "maxTrackedPrincipals"
      | "authorizationTimeoutMs"
      | "configurationTimeoutMs"
      | "handlerTimeoutMs"
      | "signalingTimeoutMs"
      | "iceTimeoutMs"
      | "dtlsTimeoutMs"
      | "dataChannelTimeoutMs"
      | "resourceLimits"
    >
  > = {},
  configuration: RealtimeConfigurationSource = () => ({
    iceServers: [{ urls: "turn:relay.example.test" }],
  }),
): RealtimeHub {
  const definition = realtime({
    args: { assistantId: v.bigint() },
    clientEvents: {},
    serverEvents: {},
    access: "public",
    handler,
  });
  return new RealtimeHub({
    registry: new Registry({ assistants: { live: definition } }),
    engine: testRealtimeEngine(
      () =>
        (typeof peer === "function" ? peer() : peer) as unknown as RTCPeerConnection,
    ),
    configuration,
    application: application(authorize),
    sessionLimits: {
      maxBufferedAmount: 64 * 1024,
      maxConcurrentStreams: 4,
      maxIncomingBufferedBytes: 64 * 1024,
      defaultStreamMaxBytes: 1024,
      maxInFlightHandlers: 8,
      streamIdleMs: 30_000,
      maxAuxiliaryPeers: 2,
      maxDecodedStreams: 4,
      maxMediaSources: 4,
    },
    maxSessions: limits.maxSessions ?? 4,
    maxSessionsPerPrincipal: limits.maxSessionsPerPrincipal ?? 4,
    maxHandshakesPerWindow: limits.maxHandshakesPerWindow ?? 16,
    handshakeWindowMs: limits.handshakeWindowMs ?? 10_000,
    maxTrackedPrincipals: limits.maxTrackedPrincipals ?? 32,
    maxPendingCandidates: 8,
    terminalRetentionMs: 100,
    now: Date.now,
    authorizationTimeoutMs: limits.authorizationTimeoutMs,
    configurationTimeoutMs: limits.configurationTimeoutMs,
    handlerTimeoutMs: limits.handlerTimeoutMs,
    signalingTimeoutMs: limits.signalingTimeoutMs,
    iceTimeoutMs: limits.iceTimeoutMs,
    dtlsTimeoutMs: limits.dtlsTimeoutMs,
    dataChannelTimeoutMs: limits.dataChannelTimeoutMs,
    resourceLimits: limits.resourceLimits,
  });
}

function offerInput(
  overrides: Partial<RealtimeOfferInput> = {},
): RealtimeOfferInput {
  return {
    address: "assistants.live",
    args: { assistantId: 1n },
    offer: { type: "offer", sdp: "v=0\r\noffer" },
    principal: ANONYMOUS_PRINCIPAL,
    signal: new AbortController().signal,
    releaseAuthentication: () => {},
    requestBytes: 64,
    ...overrides,
  };
}

describe("RealtimeHub", () => {
  test("releases admission when authorization exceeds its deadline", async () => {
    let peers = 0;
    let releases = 0;
    const hub = createHub(
      () => {
        peers++;
        return new FakePeerConnection();
      },
      () => new Promise(() => {}),
      () => {},
      { authorizationTimeoutMs: 10 },
    );

    await expect(hub.offer(offerInput({
      releaseAuthentication: () => releases++,
    }))).rejects.toMatchObject({
      code: "unavailable",
      retryable: true,
      message: "realtime authorization timed out",
    });
    expect(peers).toBe(0);
    expect(releases).toBe(1);
    expect(hub.snapshot()).toMatchObject({
      activeSessions: 0,
      reservedSessions: 0,
      failed: 1,
      setupStages: {
        authorization: {
          completed: 0,
          failed: 0,
          timedOut: 1,
        },
      },
    });
  });

  test("attributes signaling timeouts and releases every owned resource", async () => {
    const peer = new FakePeerConnection();
    peer.stallRemoteDescription = true;
    let releases = 0;
    const hub = createHub(peer, undefined, undefined, {
      signalingTimeoutMs: 10,
    });

    await expect(hub.offer(offerInput({
      releaseAuthentication: () => releases++,
    }))).rejects.toMatchObject({
      code: "unavailable",
      retryable: true,
      message: "realtime remote description timed out",
    });
    expect(peer.closed).toBe(true);
    expect(releases).toBe(1);
    expect(hub.snapshot()).toMatchObject({
      activeSessions: 0,
      reservedSessions: 0,
      setupStages: {
        authorization: { completed: 1 },
        configuration: { completed: 1 },
        handler: { completed: 1 },
        signaling: { completed: 0, failed: 0, timedOut: 1 },
      },
    });
  });

  test("bounds stalled deployment configuration before native allocation", async () => {
    let peers = 0;
    const hub = createHub(
      () => {
        peers++;
        return new FakePeerConnection();
      },
      undefined,
      undefined,
      { configurationTimeoutMs: 10 },
      () => new Promise(() => {}),
    );

    await expect(hub.offer(offerInput())).rejects.toMatchObject({
      code: "unavailable",
      retryable: true,
      message: "realtime ICE configuration timed out",
    });
    expect(peers).toBe(0);
    expect(hub.snapshot()).toMatchObject({
      activeSessions: 0,
      closeReasons: { setup: 0 },
      setupStages: {
        configuration: { completed: 0, failed: 0, timedOut: 1 },
      },
    });
  });

  test("bounds a stalled realtime handler and releases its native generation", async () => {
    const peer = new FakePeerConnection();
    const hub = createHub(
      peer,
      undefined,
      () => new Promise(() => {}),
      { handlerTimeoutMs: 10 },
    );

    await expect(hub.offer(offerInput())).rejects.toMatchObject({
      code: "unavailable",
      retryable: true,
      message: "realtime handler setup timed out",
    });
    expect(peer.closed).toBe(true);
    expect(hub.snapshot()).toMatchObject({
      activeSessions: 0,
      closeReasons: { setup: 1 },
      setupStages: {
        handler: { completed: 0, failed: 0, timedOut: 1 },
      },
    });
  });

  for (const scenario of [
    {
      name: "terminates a generation that never completes ICE",
      configure: (_peer: FakePeerConnection) => {},
      limits: { iceTimeoutMs: 10 },
      stages: {
        ice: { completed: 0, failed: 0, timedOut: 1 },
        dtls: { completed: 0, failed: 0, timedOut: 0 },
        "data-channel": { completed: 1, failed: 0, timedOut: 0 },
      },
    },
    {
      name: "terminates a generation that completes ICE but not DTLS",
      configure: (peer: FakePeerConnection) => {
        peer.iceConnectionState = "connected";
      },
      limits: { dtlsTimeoutMs: 10 },
      stages: {
        ice: { completed: 1, failed: 0, timedOut: 0 },
        dtls: { completed: 0, failed: 0, timedOut: 1 },
        "data-channel": { completed: 1, failed: 0, timedOut: 0 },
      },
    },
    {
      name: "terminates a generation whose typed data channel never opens",
      configure: (peer: FakePeerConnection) => {
        peer.connectionState = "connected";
        peer.channel.readyState = "connecting";
      },
      limits: { dataChannelTimeoutMs: 10 },
      stages: {
        ice: { completed: 1, failed: 0, timedOut: 0 },
        dtls: { completed: 1, failed: 0, timedOut: 0 },
        "data-channel": { completed: 0, failed: 0, timedOut: 1 },
      },
    },
  ]) {
    test(scenario.name, async () => {
      const peer = new FakePeerConnection();
      scenario.configure(peer);
      let releases = 0;
      const hub = createHub(
        peer,
        undefined,
        undefined,
        scenario.limits,
      );
      expect((await hub.offer(offerInput({
        releaseAuthentication: () => releases++,
      }))).ok).toBe(true);

      await Bun.sleep(20);

      expect(peer.closed).toBe(true);
      expect(releases).toBe(1);
      expect(hub.snapshot()).toMatchObject({
        activeSessions: 0,
        reservedSessions: 0,
        setupStages: scenario.stages,
      });
    });
  }

  test("owns one peer generation and retains authentication until close", async () => {
    const peer = new FakePeerConnection();
    const hub = createHub(peer);
    let releases = 0;
    const result = await hub.offer(offerInput({
      releaseAuthentication: () => releases++,
      recovery: true,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected accepted realtime offer");
    expect(peer.remoteDescriptions).toEqual([{
      type: "offer",
      sdp: "v=0\r\noffer",
    }]);
    expect(hub.size).toBe(1);
    expect(releases).toBe(0);
    expect(hub.snapshot()).toMatchObject({
      recoveryAttempts: 1,
      recoveryAccepted: 1,
      recoveryRejected: 0,
      recoveryFailed: 0,
    });
    expect(hub.snapshot().recoveryDurationMs).toBeGreaterThanOrEqual(0);

    expect((await hub.patch(result.sessionId, ANONYMOUS_PRINCIPAL, {
      candidates: [{
        candidate: "candidate:1 1 UDP 1 127.0.0.1 9 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
      }],
      complete: true,
    })).ok).toBe(true);
    expect(peer.candidates).toHaveLength(2);

    hub.close(result.sessionId, ANONYMOUS_PRINCIPAL);
    expect(peer.closed).toBe(true);
    expect(hub.size).toBe(0);
    expect(releases).toBe(1);
    expect(hub.snapshot().closeReasons.client).toBe(1);
  });

  test("installs the application track listener before applying the remote offer", async () => {
    const peer = new FakePeerConnection();
    let receivedTrack = false;
    peer.onRemoteDescription = () => {
      peer.dispatchEvent(Object.assign(new Event("track"), {
        track: { id: "microphone", kind: "audio" },
      }));
    };
    const hub = createHub(peer, undefined, (ctx) => {
      ctx.peerConnection.addEventListener("track", () => {
        receivedTrack = true;
      });
    });

    const result = await hub.offer(offerInput());

    expect(result.ok).toBe(true);
    expect(receivedTrack).toBe(true);
  });

  test("releases authentication without allocating a peer when authorization rejects", async () => {
    const peer = new FakePeerConnection();
    const hub = createHub(peer, async () => ({
      ok: false,
      error: {
        kind: "application",
        code: "assistant_missing",
        body: { id: 0n },
        status: 404,
      },
    }));
    let releases = 0;
    const result = await hub.offer(offerInput({
      args: { assistantId: 0n },
      releaseAuthentication: () => releases++,
      recovery: true,
    }));
    expect(result).toMatchObject({
      ok: false,
      error: { code: "assistant_missing" },
    });
    expect(peer.remoteDescriptions).toEqual([]);
    expect(hub.size).toBe(0);
    expect(releases).toBe(1);
    expect(hub.snapshot()).toMatchObject({
      recoveryAttempts: 1,
      recoveryAccepted: 0,
      recoveryRejected: 1,
      recoveryFailed: 0,
    });
  });

  test("credential revocation closes the retained generation", async () => {
    const peer = new FakePeerConnection();
    const hub = createHub(peer);
    const credential = new AbortController();
    let releases = 0;
    const result = await hub.offer(offerInput({
      signal: credential.signal,
      releaseAuthentication: () => releases++,
    }));
    expect(result.ok).toBe(true);
    credential.abort(new Error("revoked"));
    expect(peer.closed).toBe(true);
    expect(hub.size).toBe(0);
    expect(releases).toBe(1);
    expect(hub.snapshot().closeReasons.authentication).toBe(1);
  });

  test("reserves per-principal capacity before allocating a native peer", async () => {
    const peers: FakePeerConnection[] = [];
    const hub = createHub(
      () => {
        const peer = new FakePeerConnection();
        peers.push(peer);
        return peer;
      },
      undefined,
      undefined,
      { maxSessions: 4, maxSessionsPerPrincipal: 1 },
    );
    const input = offerInput();

    const first = await hub.offer(input);
    expect(first.ok).toBe(true);
    expect(peers).toHaveLength(1);
    await expect(hub.offer(input)).rejects.toMatchObject({
      code: "overloaded",
      resource: "connection",
    });
    expect(peers).toHaveLength(1);

    if (!first.ok) throw new Error("expected accepted realtime offer");
    hub.close(first.sessionId, ANONYMOUS_PRINCIPAL);
    expect((await hub.offer(input)).ok).toBe(true);
    expect(peers).toHaveLength(2);
  });

  test("reauthorizes and reruns the handler for a replacement generation", async () => {
    const peers: FakePeerConnection[] = [];
    let authorizations = 0;
    let handlers = 0;
    const hub = createHub(
      () => {
        const peer = new FakePeerConnection();
        peers.push(peer);
        return peer;
      },
      async (_definition, input) => {
        authorizations++;
        return {
          ok: true,
          args: input.args,
          state: undefined,
          adapter: adapter(),
        };
      },
      () => {
        handlers++;
      },
    );
    const baseInput = offerInput();

    const first = await hub.offer(baseInput);
    if (!first.ok) throw new Error("expected accepted initial generation");
    hub.close(first.sessionId, ANONYMOUS_PRINCIPAL);
    const replacement = await hub.offer({ ...baseInput, recovery: true });

    expect(replacement.ok).toBe(true);
    expect(authorizations).toBe(2);
    expect(handlers).toBe(2);
    expect(peers).toHaveLength(2);
    expect(hub.snapshot()).toMatchObject({
      recoveryAttempts: 1,
      recoveryAccepted: 1,
      recoveryRejected: 0,
      recoveryFailed: 0,
    });
    if (replacement.ok) {
      hub.close(replacement.sessionId, ANONYMOUS_PRINCIPAL);
    }
  });

  test("shares one finite auxiliary-peer budget across active sessions", async () => {
    const peers: FakePeerConnection[] = [];
    const hub = createHub(
      () => {
        const peer = new FakePeerConnection();
        peers.push(peer);
        return peer;
      },
      undefined,
      (ctx) => {
        ctx.createPeerConnection();
      },
      {
        maxSessions: 4,
        maxSessionsPerPrincipal: 4,
        resourceLimits: {
          maxAuxiliaryPeers: 1,
          maxDecodedStreams: 4,
          maxMediaSources: 4,
        },
      },
    );
    const input = offerInput();

    const first = await hub.offer(input);
    expect(first.ok).toBe(true);
    expect(peers).toHaveLength(2);
    await expect(hub.offer(input)).rejects.toMatchObject({
      code: "overloaded",
      resource: "connection",
    });
    expect(peers).toHaveLength(3);
    expect(hub.snapshot().resources).toMatchObject({
      active: { auxiliaryPeers: 1 },
      saturated: { auxiliaryPeers: 1 },
    });

    if (!first.ok) throw new Error("expected accepted realtime offer");
    hub.close(first.sessionId, ANONYMOUS_PRINCIPAL);
    expect((await hub.offer(input)).ok).toBe(true);
    expect(peers).toHaveLength(5);
  });

  test("rate-limits handshakes per principal before native allocation", async () => {
    const peers: FakePeerConnection[] = [];
    const hub = createHub(
      () => {
        const peer = new FakePeerConnection();
        peers.push(peer);
        return peer;
      },
      async () => ({
        ok: false,
        error: {
          kind: "application",
          code: "assistant_missing",
          body: {},
          status: 404,
        },
      }),
      undefined,
      {
        maxHandshakesPerWindow: 1,
        handshakeWindowMs: 60_000,
      },
    );
    const input = offerInput();

    expect((await hub.offer(input)).ok).toBe(false);
    await expect(hub.offer(input)).rejects.toMatchObject({
      code: "overloaded",
      resource: "connection",
    });
    expect(peers).toHaveLength(0);
  });

  test("exposes bounded aggregate status and redacted per-session diagnostics", async () => {
    const peer = new FakePeerConnection();
    peer.connectionState = "connected";
    const hub = createHub(peer);
    const result = await hub.offer(offerInput());
    if (!result.ok) throw new Error("expected accepted realtime offer");

    expect(hub.snapshot()).toMatchObject({
      activeSessions: 1,
      reservedSessions: 1,
      activePrincipals: 1,
      trackedHandshakeWindows: 1,
      offers: 1,
      accepted: 1,
      rejected: 0,
    });
    const diagnostic = await hub.diagnostic(
      result.sessionId,
      ANONYMOUS_PRINCIPAL,
    );
    expect(diagnostic).toMatchObject({
      connectionState: "connected",
      path: {
        localCandidateType: "host",
        remoteCandidateType: "srflx",
        protocol: "udp",
      },
      roundTripTimeMs: 20,
    });
    expect(JSON.stringify(diagnostic)).not.toContain("10.0.0.1");
    expect(JSON.stringify(diagnostic)).not.toContain("203.0.113.1");

    await hub.sampleHealth(1);
    expect(hub.snapshot().health).toMatchObject({
      sampledPeers: 1,
      sampleFailures: 0,
      directPaths: 1,
      relayPaths: 0,
      udpPaths: 1,
      tcpPaths: 0,
      roundTripTimeAverageMs: 20,
      roundTripTimeMaxMs: 20,
      jitterMaxMs: 4,
      packets: 5,
      packetsLost: 1,
      frames: 1,
      framesDropped: 2,
      firstInboundAudio: 1,
      firstInboundVideo: 0,
      firstOutboundAudio: 0,
      firstOutboundVideo: 1,
    });

    await hub.sampleHealth(1);
    expect(hub.snapshot().health).toMatchObject({
      firstInboundAudio: 1,
      firstOutboundVideo: 1,
    });

    hub.close(result.sessionId, ANONYMOUS_PRINCIPAL);
    expect(hub.snapshot().closeReasons.client).toBe(1);
  });
});
