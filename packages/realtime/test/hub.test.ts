import { describe, expect, test } from "bun:test";
import {
  ANONYMOUS_PRINCIPAL,
  realtime,
  Registry,
  v,
  type ProcedureCtx,
} from "@ackerdb/server";
import {
  outcomeFromError,
  type RealtimeOfferInput,
  type RealtimeOfferResult,
  type RealtimePrepareInput,
  type RealtimePrepareResult,
  type RealtimeRuntimeApplication,
  type RealtimeServerSessionAdapter,
} from "@ackerdb/server/realtime-host";
import {
  RealtimeHub,
  REALTIME_HUB_DEFAULTS,
  type RealtimeHubOptions,
} from "../src/hub.ts";
import { REALTIME_GLOBAL_RESOURCE_DEFAULTS } from "../src/resources.ts";
import type { RealtimeServerSessionLimits } from "../src/session.ts";
import {
  Ok,
  stableEncode,
  type PortableRTCPeerConnection,
} from "@ackerdb/core";
import { invokeRegisteredHandler } from "../../server/src/app/invocation.ts";
import type { RealtimeConfigurationSource } from "../src/engine.ts";
import {
  TestPeerConnection as FakePeerConnection,
  testRealtimeEngine,
} from "./support.ts";

const TEST_OWNER = "A".repeat(43);
const utf8 = new TextEncoder();

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
  authorize: RealtimeRuntimeApplication["authorize"] = async (_definition, input) => ({
    ok: true,
    args: input.args,
    state: undefined,
    adapter: adapter(),
  }),
): RealtimeRuntimeApplication {
  return { authorize };
}

function createHub(
  peer: FakePeerConnection | (() => FakePeerConnection),
  authorize?: RealtimeRuntimeApplication["authorize"],
  handler: (
    context: {
      readonly peerConnection: PortableRTCPeerConnection;
      createPeerConnection(): PortableRTCPeerConnection;
      readonly state: unknown;
    },
    args?: unknown,
  ) => void | Promise<void> = () => {},
  limits: Partial<
    Pick<
      RealtimeHubOptions,
      | "maxSessions"
      | "maxSessionsPerPrincipal"
      | "maxHandshakesPerWindow"
      | "handshakeWindowMs"
      | "maxTrackedPrincipals"
      | "maxRemoteCandidates"
      | "maxRemoteCandidateBytes"
      | "allowPrivateCandidateAddresses"
      | "preparedSessionTtlMs"
      | "maxPreparedBytes"
      | "authorizationTimeoutMs"
      | "configurationTimeoutMs"
      | "handlerTimeoutMs"
      | "signalingTimeoutMs"
      | "iceTimeoutMs"
      | "dtlsTimeoutMs"
      | "dataChannelTimeoutMs"
      | "diagnosticTimeoutMs"
      | "resourceLimits"
    >
  > & {
    readonly sessionLimits?: Partial<RealtimeServerSessionLimits>;
  } = {},
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
  const registry = new Registry({ assistants: { live: definition } });
  return new RealtimeHub({
    definition: (address) => registry.getRealtime(address),
    engine: testRealtimeEngine(
      () =>
        (typeof peer === "function" ? peer() : peer) as unknown as RTCPeerConnection,
    ),
    configuration,
    application: application(authorize),
    sessionLimits: {
      maxQueuedBytes: 32 * 1024 * 1024,
      maxBufferedAmount: 64 * 1024,
      maxConcurrentStreams: 4,
      maxIncomingBufferedBytes: 64 * 1024,
      defaultStreamMaxBytes: 1024,
      maxInFlightHandlers: 8,
      streamIdleMs: 30_000,
      maxAuxiliaryPeers: 2,
      maxDecodedStreams: 4,
      maxMediaSources: 4,
      ...limits.sessionLimits,
    },
    maxSessions: limits.maxSessions ?? 4,
    maxSessionsPerPrincipal: limits.maxSessionsPerPrincipal ?? 4,
    maxHandshakesPerWindow: limits.maxHandshakesPerWindow ?? 16,
    handshakeWindowMs: limits.handshakeWindowMs ?? 10_000,
    maxTrackedPrincipals: limits.maxTrackedPrincipals ?? 32,
    maxPendingCandidates: 8,
    maxRemoteCandidates: limits.maxRemoteCandidates ?? 8,
    maxRemoteCandidateBytes: limits.maxRemoteCandidateBytes ?? 8 * 1024,
    allowPrivateCandidateAddresses:
      limits.allowPrivateCandidateAddresses ?? false,
    terminalRetentionMs: 100,
    preparedSessionTtlMs: limits.preparedSessionTtlMs,
    maxPreparedBytes: limits.maxPreparedBytes,
    now: Date.now,
    authorizationTimeoutMs: limits.authorizationTimeoutMs,
    configurationTimeoutMs: limits.configurationTimeoutMs,
    handlerTimeoutMs: limits.handlerTimeoutMs,
    signalingTimeoutMs: limits.signalingTimeoutMs,
    iceTimeoutMs: limits.iceTimeoutMs,
    dtlsTimeoutMs: limits.dtlsTimeoutMs,
    dataChannelTimeoutMs: limits.dataChannelTimeoutMs,
    diagnosticTimeoutMs: limits.diagnosticTimeoutMs,
    resourceLimits: limits.resourceLimits,
  });
}

function prepareInput(
  overrides: Partial<RealtimePrepareInput> = {},
): RealtimePrepareInput {
  return {
    address: "assistants.live",
    args: { assistantId: 1n },
    principal: ANONYMOUS_PRINCIPAL,
    owner: TEST_OWNER,
    signal: new AbortController().signal,
    releaseAuthentication: () => {},
    requestBytes: 64,
    ...overrides,
  };
}

function offerInput(ticket: string, owner = TEST_OWNER): RealtimeOfferInput {
  return {
    ticket,
    owner,
    offer: { type: "offer", sdp: "v=0\r\noffer" },
  };
}

function remoteCandidate(address: string, type = "host") {
  return Object.freeze({
    candidate: `candidate:1 1 UDP 1 ${address} 9 typ ${type}`,
    sdpMid: "0",
    sdpMLineIndex: 0,
  });
}

async function prepareAndOffer(
  hub: RealtimeHub,
  input: RealtimePrepareInput = prepareInput(),
): Promise<RealtimeOfferResult> {
  const prepared: RealtimePrepareResult = await hub.prepare(input);
  if (!prepared.ok) return prepared;
  return hub.offer(offerInput(prepared.ticket, input.owner));
}

async function turns(count = 4): Promise<void> {
  for (let index = 0; index < count; index++) {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
}

describe("RealtimeHub", () => {
  test("uses the measured default native-peer envelope", () => {
    expect(REALTIME_HUB_DEFAULTS.maxSessions).toBe(1_024);
    expect(REALTIME_GLOBAL_RESOURCE_DEFAULTS.maxAuxiliaryPeers).toBe(2_048);
  });

  test("rejects a session queue bound the native ABI cannot represent", () => {
    expect(() => createHub(new FakePeerConnection(), undefined, undefined, {
      sessionLimits: { maxQueuedBytes: 0x1_0000_0000 },
    })).toThrow("sessionLimits.maxQueuedBytes must not exceed 4294967295");
  });

  test("bounds on-demand diagnostics and hides native failure details", async () => {
    const peer = new FakePeerConnection();
    const secret = "native-provider-token-must-not-leak";
    peer.getStats = () => Promise.reject(new Error(secret));
    const failed = createHub(peer, undefined, undefined, {
      diagnosticTimeoutMs: 10,
    });
    const failedOffer = await prepareAndOffer(failed);
    if (!failedOffer.ok) throw new Error("expected accepted offer");

    try {
      await failed.diagnostic(failedOffer.sessionId, TEST_OWNER);
      throw new Error("expected diagnostic failure");
    } catch (error) {
      expect(error).toMatchObject({
        code: "unavailable",
        message: "realtime diagnostic failed",
      });
      expect(String(error)).not.toContain(secret);
      expect((error as Error).cause).toBeUndefined();
    }

    const stalledPeer = new FakePeerConnection();
    stalledPeer.getStats = () => new Promise(() => {});
    const stalled = createHub(stalledPeer, undefined, undefined, {
      diagnosticTimeoutMs: 10,
    });
    const stalledOffer = await prepareAndOffer(stalled);
    if (!stalledOffer.ok) throw new Error("expected accepted offer");
    await expect(
      stalled.diagnostic(stalledOffer.sessionId, TEST_OWNER),
    ).rejects.toMatchObject({
      code: "deadline_exceeded",
      message: "realtime diagnostic timed out",
    });
  });

  test("sanitizes unexpected setup failures while retaining a fixed classification", async () => {
    const secret = "Authorization: Bearer provider-secret";
    const handlerHub = createHub(
      new FakePeerConnection(),
      undefined,
      () => {
        throw new Error(secret);
      },
    );
    let handlerFailure: unknown;
    try {
      await prepareAndOffer(handlerHub);
    } catch (error) {
      handlerFailure = error;
    }
    expect(outcomeFromError(handlerFailure)).toEqual({
      code: "internal",
      retryable: false,
      message: "internal server error",
    });
    expect(handlerHub.snapshot().closeReasons.setup).toBe(1);
    expect(JSON.stringify(handlerHub.snapshot())).not.toContain(secret);

    const peer = new FakePeerConnection();
    peer.createAnswer = () => Promise.reject(new Error(secret));
    const nativeHub = createHub(peer);
    let nativeFailure: unknown;
    try {
      await prepareAndOffer(nativeHub);
    } catch (error) {
      nativeFailure = error;
    }
    expect(outcomeFromError(nativeFailure)).toEqual({
      code: "internal",
      retryable: false,
      message: "internal server error",
    });
    expect(nativeHub.snapshot().closeReasons.setup).toBe(1);
    expect(JSON.stringify(nativeHub.snapshot())).not.toContain(secret);
  });

  test("bounds health sampling, ignores late stats, and cancels diagnostics on drain", async () => {
    const peer = new FakePeerConnection();
    const validStats = peer.getStats.bind(peer);
    let statsCalls = 0;
    let resolveStats!: (report: RTCStatsReport) => void;
    peer.getStats = () => new Promise((resolve) => {
      statsCalls++;
      resolveStats = resolve;
    });
    const hub = createHub(peer, undefined, undefined, {
      diagnosticTimeoutMs: 10,
    });
    const offer = await prepareAndOffer(hub);
    if (!offer.ok) throw new Error("expected accepted offer");

    await hub.sampleHealth(1);
    expect(hub.snapshot().health).toMatchObject({
      sampledPeers: 0,
      sampleFailures: 1,
    });
    await hub.sampleHealth(1);
    expect(statsCalls).toBe(1);
    resolveStats(await validStats());
    await Promise.resolve();
    expect(hub.snapshot().health).toMatchObject({
      sampledPeers: 0,
      sampleFailures: 1,
    });

    let resolveDrainStats!: (report: RTCStatsReport) => void;
    peer.getStats = () => new Promise((resolve) => {
      resolveDrainStats = resolve;
    });
    const pending = hub.diagnostic(offer.sessionId, TEST_OWNER);
    await Promise.resolve();
    await hub.drain();
    await expect(pending).rejects.toMatchObject({
      code: "draining",
      message: "realtime service is draining",
    });
    resolveDrainStats(await validStats());
    await Promise.resolve();
    expect(peer.closed).toBe(true);
  });

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

    await expect(hub.prepare(prepareInput({
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
    });
  });

  test("attributes signaling timeouts and releases every owned resource", async () => {
    const peer = new FakePeerConnection();
    peer.stallRemoteDescription = true;
    let releases = 0;
    const hub = createHub(peer, undefined, undefined, {
      signalingTimeoutMs: 10,
    });

    await expect(prepareAndOffer(hub, prepareInput({
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

    await expect(hub.prepare(prepareInput())).rejects.toMatchObject({
      code: "unavailable",
      retryable: true,
      message: "realtime ICE configuration timed out",
    });
    expect(peers).toBe(0);
    expect(hub.snapshot()).toMatchObject({
      activeSessions: 0,
      closeReasons: { setup: 0 },
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

    await expect(prepareAndOffer(hub)).rejects.toMatchObject({
      code: "internal",
      retryable: false,
      message: "realtime handler setup timed out",
    });
    expect(peer.closed).toBe(true);
    expect(hub.snapshot()).toMatchObject({
      activeSessions: 0,
      closeReasons: { setup: 1 },
    });
  });

  for (const scenario of [
    {
      name: "terminates a generation that never completes ICE",
      configure: (_peer: FakePeerConnection) => {},
      limits: { iceTimeoutMs: 10 },
    },
    {
      name: "terminates a generation that completes ICE but not DTLS",
      configure: (peer: FakePeerConnection) => {
        peer.iceConnectionState = "connected";
      },
      limits: { dtlsTimeoutMs: 10 },
    },
    {
      name: "terminates a generation whose typed data channel never opens",
      configure: (peer: FakePeerConnection) => {
        peer.connectionState = "connected";
        peer.channel.readyState = "connecting";
      },
      limits: { dataChannelTimeoutMs: 10 },
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
      expect((await prepareAndOffer(hub, prepareInput({
        releaseAuthentication: () => releases++,
      }))).ok).toBe(true);

      await Bun.sleep(20);

      expect(peer.closed).toBe(true);
      expect(releases).toBe(1);
      expect(hub.snapshot()).toMatchObject({
        activeSessions: 0,
        reservedSessions: 0,
      });
    });
  }

  test("owns one peer generation and retains authentication until close", async () => {
    const peer = new FakePeerConnection();
    const hub = createHub(peer);
    let releases = 0;
    const result = await prepareAndOffer(hub, prepareInput({
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
    expect((await hub.patch(result.sessionId, TEST_OWNER, {
      candidates: [{
        candidate: "candidate:1 1 UDP 1 8.8.8.8 9 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
      }],
      complete: false,
    })).ok).toBe(true);
    expect(peer.candidates).toHaveLength(1);

    hub.close(result.sessionId, TEST_OWNER);
    expect(peer.closed).toBe(true);
    expect(hub.size).toBe(0);
    expect(releases).toBe(1);
    expect(hub.snapshot().closeReasons.client).toBe(1);
  });

  test("uses one event-driven final HTTP candidate wait without repeating end-of-candidates", async () => {
    const peer = new FakePeerConnection();
    peer.channel.readyState = "connecting";
    const hub = createHub(peer);
    const result = await prepareAndOffer(hub);
    if (!result.ok) throw new Error("expected an accepted realtime offer");

    await expect(hub.patch(result.sessionId, TEST_OWNER, {
      candidates: [],
      complete: false,
    })).resolves.toEqual({ ok: true, candidates: [], complete: false });

    let settled = false;
    const final = hub.patch(result.sessionId, TEST_OWNER, {
      candidates: [],
      complete: true,
    }).then((value) => {
      settled = true;
      return value;
    });
    await turns();
    expect(settled).toBe(false);
    await expect(hub.patch(result.sessionId, TEST_OWNER, {
      candidates: [],
      complete: true,
    })).rejects.toMatchObject({ code: "overloaded" });

    const serverCandidate = remoteCandidate("8.8.4.4", "relay");
    const event = new Event("icecandidate");
    Object.defineProperty(event, "candidate", {
      value: { toJSON: () => serverCandidate },
    });
    peer.dispatchEvent(event);
    await expect(final).resolves.toEqual({
      ok: true,
      candidates: [serverCandidate],
      complete: false,
    });

    let readySettled = false;
    const ready = hub.patch(result.sessionId, TEST_OWNER, {
      candidates: [],
      complete: false,
    }).then((value) => {
      readySettled = true;
      return value;
    });
    await turns();
    expect(readySettled).toBe(false);
    peer.channel.readyState = "open";
    peer.channel.dispatchEvent(new Event("open"));
    await expect(ready).resolves.toEqual({
      ok: true,
      candidates: [],
      complete: false,
    });
    expect(peer.candidates).toEqual([null]);

    hub.close(result.sessionId, TEST_OWNER);
  });

  test("releases a final candidate wait when its request aborts or the session closes", async () => {
    const peer = new FakePeerConnection();
    peer.channel.readyState = "connecting";
    const hub = createHub(peer);
    const result = await prepareAndOffer(hub);
    if (!result.ok) throw new Error("expected an accepted realtime offer");
    const controller = new AbortController();
    const reason = new Error("request cancelled");
    const aborted = hub.patch(
      result.sessionId,
      TEST_OWNER,
      { candidates: [], complete: true },
      controller.signal,
    );
    await turns();
    controller.abort(reason);
    await expect(aborted).rejects.toBe(reason);

    const closing = hub.patch(result.sessionId, TEST_OWNER, {
      candidates: [],
      complete: true,
    });
    await turns();
    hub.close(result.sessionId, TEST_OWNER);
    await expect(closing).rejects.toMatchObject({ code: "not_found" });
  });

  test("filters ignored host candidates from an initial SDP while retaining a usable relay", async () => {
    let peers = 0;
    let releases = 0;
    const peer = new FakePeerConnection();
    const hub = createHub(() => {
      peers++;
      return peer;
    });
    const prepared = await hub.prepare(prepareInput({
      releaseAuthentication: () => releases++,
    }));
    if (!prepared.ok) throw new Error("expected a prepared realtime session");

    const result = await hub.offer({
      ...offerInput(prepared.ticket),
      offer: {
        type: "offer",
        sdp: [
          "v=0",
          `a=${remoteCandidate("browser-opaque-id.local").candidate}`,
          `a=${remoteCandidate("10.1.2.3").candidate}`,
          `a=${remoteCandidate("8.8.8.8", "relay").candidate}`,
          "",
        ].join("\r\n"),
      },
    });

    expect(result.ok).toBe(true);
    expect(peers).toBe(1);
    expect(releases).toBe(0);
    expect(peer.remoteDescriptions).toEqual([{
      type: "offer",
      sdp: [
        "v=0",
        `a=${remoteCandidate("8.8.8.8", "relay").candidate}`,
        "",
      ].join("\r\n"),
    }]);
  });

  test("rejects a prohibited non-host initial SDP candidate before native peer allocation", async () => {
    let peers = 0;
    let releases = 0;
    const hub = createHub(() => {
      peers++;
      return new FakePeerConnection();
    });
    const prepared = await hub.prepare(prepareInput({
      releaseAuthentication: () => releases++,
    }));
    if (!prepared.ok) throw new Error("expected a prepared realtime session");

    await expect(hub.offer({
      ...offerInput(prepared.ticket),
      offer: {
        type: "offer",
        sdp: `v=0\r\na=${remoteCandidate("127.0.0.1", "srflx").candidate}\r\n`,
      },
    })).rejects.toMatchObject({ code: "malformed" });

    expect(peers).toBe(0);
    expect(releases).toBe(1);
    expect(hub.snapshot()).toMatchObject({
      activeSessions: 0,
      reservedSessions: 0,
    });
  });

  test("carries initial SDP candidate accounting into later HTTP trickle", async () => {
    const peer = new FakePeerConnection();
    const hub = createHub(peer, undefined, undefined, {
      maxRemoteCandidates: 1,
    });
    const prepared = await hub.prepare(prepareInput());
    if (!prepared.ok) throw new Error("expected a prepared realtime session");
    const result = await hub.offer({
      ...offerInput(prepared.ticket),
      offer: {
        type: "offer",
        sdp: `v=0\r\na=${remoteCandidate("8.8.8.8").candidate}\r\n`,
      },
    });
    if (!result.ok) throw new Error("expected an accepted realtime offer");

    expect(await hub.patch(result.sessionId, TEST_OWNER, {
      candidates: [remoteCandidate("1.1.1.1")],
      complete: false,
    })).toMatchObject({
      ok: false,
      outcome: { code: "overloaded", resource: "connection" },
    });
    expect(peer.candidates).toEqual([]);
    expect(peer.closed).toBe(true);
  });

  test("terminates a generation before a mixed HTTP candidate batch reaches native", async () => {
    const peer = new FakePeerConnection();
    const hub = createHub(peer);
    const result = await prepareAndOffer(hub);
    if (!result.ok) throw new Error("expected an accepted realtime offer");

    const patched = await hub.patch(result.sessionId, TEST_OWNER, {
      candidates: [
        remoteCandidate("8.8.8.8"),
        remoteCandidate("127.0.0.1", "srflx"),
      ],
      complete: false,
    });

    expect(patched).toMatchObject({
      ok: false,
      outcome: { code: "malformed", retryable: false },
    });
    expect(peer.candidates).toEqual([]);
    expect(peer.closed).toBe(true);
    expect(hub.snapshot()).toMatchObject({
      activeSessions: 0,
      reservedSessions: 0,
    });
  });

  test("admits a classified private candidate only through the deployment opt-in", async () => {
    const peer = new FakePeerConnection();
    const hub = createHub(peer, undefined, undefined, {
      allowPrivateCandidateAddresses: true,
    });
    const result = await prepareAndOffer(hub);
    if (!result.ok) throw new Error("expected an accepted realtime offer");
    const privateCandidate = remoteCandidate("10.1.2.3");
    const privateRelay = remoteCandidate("10.1.2.4", "relay");

    expect(await hub.patch(result.sessionId, TEST_OWNER, {
      candidates: [privateCandidate, privateRelay],
      complete: false,
    })).toMatchObject({ ok: true });
    expect(peer.candidates).toEqual([privateCandidate, privateRelay]);

    hub.close(result.sessionId, TEST_OWNER);
  });

  test("ignores default private and mDNS host trickle while passing a relay candidate to native", async () => {
    const peer = new FakePeerConnection();
    const hub = createHub(peer);
    const result = await prepareAndOffer(hub);
    if (!result.ok) throw new Error("expected an accepted realtime offer");
    const relay = remoteCandidate("8.8.8.8", "relay");

    expect(await hub.patch(result.sessionId, TEST_OWNER, {
      candidates: [
        remoteCandidate("192.168.1.2"),
        remoteCandidate("browser-opaque-id.local"),
        relay,
      ],
      complete: false,
    })).toMatchObject({ ok: true });
    expect(peer.candidates).toEqual([relay]);
    expect(peer.closed).toBe(false);

    hub.close(result.sessionId, TEST_OWNER);
  });

  for (const scenario of [
    {
      name: "candidate count",
      limits: { maxRemoteCandidates: 1 },
    },
    {
      name: "canonical candidate bytes",
      limits: {
        maxRemoteCandidateBytes: utf8.encode(
          stableEncode(remoteCandidate("8.8.8.8")),
        ).byteLength,
      },
    },
  ] as const) {
    test(`terminates a generation when repeated HTTP trickle exceeds ${scenario.name}`, async () => {
      const peer = new FakePeerConnection();
      const hub = createHub(peer, undefined, undefined, scenario.limits);
      const result = await prepareAndOffer(hub);
      if (!result.ok) throw new Error("expected an accepted realtime offer");
      const first = remoteCandidate("8.8.8.8");

      expect((await hub.patch(result.sessionId, TEST_OWNER, {
        candidates: [first],
        complete: false,
      })).ok).toBe(true);
      const terminal = await hub.patch(result.sessionId, TEST_OWNER, {
        candidates: [remoteCandidate("1.1.1.1")],
        complete: false,
      });

      expect(terminal).toMatchObject({
        ok: false,
        outcome: {
          code: "overloaded",
          resource: "connection",
          retryable: true,
          retryAfterMs: 0,
        },
      });
      expect(peer.candidates).toEqual([first]);
      expect(peer.closed).toBe(true);
    });
  }

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

    const result = await prepareAndOffer(hub);

    expect(result.ok).toBe(true);
    expect(receivedTrack).toBe(true);
  });

  test("releases authentication without allocating a peer when authorization rejects", async () => {
    let peers = 0;
    let configurations = 0;
    const hub = createHub(
      () => {
        peers++;
        return new FakePeerConnection();
      },
      async () => ({
        ok: false,
        error: {
          kind: "application",
          code: "assistant_missing",
          body: { id: 0n },
          status: 404,
        },
      }),
      undefined,
      {},
      () => {
        configurations++;
        return {};
      },
    );
    let releases = 0;
    const result = await hub.prepare(prepareInput({
      args: { assistantId: 0n },
      releaseAuthentication: () => releases++,
      recovery: true,
    }));
    expect(result).toMatchObject({
      ok: false,
      error: { code: "assistant_missing" },
    });
    expect(peers).toBe(0);
    expect(configurations).toBe(0);
    expect(hub.size).toBe(0);
    expect(releases).toBe(1);
    expect(hub.snapshot()).toMatchObject({
      recoveryAttempts: 1,
      recoveryAccepted: 0,
      recoveryRejected: 1,
      recoveryFailed: 0,
    });
  });

  test("does not admit an abandoned prepare after authorization has started", async () => {
    let releaseAuthorization!: () => void;
    const authorization = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    let authorizing = false;
    let releases = 0;
    const setup = new AbortController();
    const hub = createHub(
      new FakePeerConnection(),
      async (_definition, input) => {
        authorizing = true;
        await authorization;
        return {
          ok: true,
          args: input.args,
          state: undefined,
          adapter: adapter(),
        };
      },
    );
    const reason = new Error("prepare request abandoned");
    const pending = hub.prepare(prepareInput({
      setupSignal: setup.signal,
      releaseAuthentication: () => releases++,
    }));

    await turns();
    expect(authorizing).toBe(true);
    setup.abort(reason);
    await expect(pending).rejects.toBe(reason);
    releaseAuthorization();
    await turns();

    expect(hub.size).toBe(0);
    expect(hub.snapshot()).toMatchObject({
      activeSessions: 0,
      reservedSessions: 0,
    });
    expect(releases).toBe(1);
  });

  test("cancels an abandoned offer setup and releases its reservation once", async () => {
    const peer = new FakePeerConnection();
    peer.stallRemoteDescription = true;
    let releases = 0;
    const hub = createHub(peer);
    const prepared = await hub.prepare(prepareInput({
      releaseAuthentication: () => releases++,
    }));
    if (!prepared.ok) throw new Error("expected a prepared realtime session");
    const setup = new AbortController();
    const reason = new Error("offer request abandoned");
    const pending = hub.offer({
      ...offerInput(prepared.ticket),
      setupSignal: setup.signal,
    });

    await turns(8);
    expect(peer.remoteDescriptions).toHaveLength(1);
    setup.abort(reason);
    await expect(pending).rejects.toBe(reason);

    expect(peer.closed).toBe(true);
    expect(hub.size).toBe(0);
    expect(hub.snapshot()).toMatchObject({
      activeSessions: 0,
      reservedSessions: 0,
    });
    expect(releases).toBe(1);
  });

  test("keeps a ticket consumable before setup and a peer alive after setup", async () => {
    const peer = new FakePeerConnection();
    let releases = 0;
    const hub = createHub(peer);
    const prepared = await hub.prepare(prepareInput({
      releaseAuthentication: () => releases++,
    }));
    if (!prepared.ok) throw new Error("expected a prepared realtime session");
    const beforeOffer = new AbortController();
    const beforeReason = new Error("offer already abandoned");
    beforeOffer.abort(beforeReason);

    await expect(hub.offer({
      ...offerInput(prepared.ticket),
      setupSignal: beforeOffer.signal,
    })).rejects.toBe(beforeReason);
    expect(peer.remoteDescriptions).toHaveLength(0);
    expect(hub.snapshot()).toMatchObject({
      activeSessions: 0,
      reservedSessions: 1,
    });
    expect(releases).toBe(0);

    const afterOffer = new AbortController();
    const accepted = await hub.offer({
      ...offerInput(prepared.ticket),
      setupSignal: afterOffer.signal,
    });
    if (!accepted.ok) throw new Error("expected an accepted realtime offer");
    afterOffer.abort(new Error("response connection closed"));

    expect(peer.closed).toBe(false);
    expect(hub.size).toBe(1);
    expect(releases).toBe(0);
    hub.close(accepted.sessionId, TEST_OWNER);
    expect(peer.closed).toBe(true);
    expect(releases).toBe(1);
  });

  test("rejects non-wire authorization state before native allocation", async () => {
    const state: { self?: unknown } = {};
    state.self = state;
    let peers = 0;
    let configurations = 0;
    let releases = 0;
    const hub = createHub(
      () => {
        peers++;
        return new FakePeerConnection();
      },
      async (_definition, input) => ({
        ok: true,
        args: input.args,
        state,
        adapter: adapter(),
      }),
      undefined,
      {},
      () => {
        configurations++;
        return {};
      },
    );

    await expect(hub.prepare(prepareInput({
      releaseAuthentication: () => releases++,
    }))).rejects.toMatchObject({
      code: "internal",
      message: "realtime authorization state is not wire-representable",
    });
    expect(configurations).toBe(1);
    expect(peers).toBe(0);
    expect(releases).toBe(1);
    expect(hub.snapshot().reservedSessions).toBe(0);
  });

  test("round-trips canonical BigInt and bytes authorization through a prepared ticket", async () => {
    const peer = new FakePeerConnection();
    const authorizedArgs = {
      assistantId: 7n,
      revision: 12n,
      bytes: new Uint8Array([1, 2, 3]),
    };
    const authorizedState = {
      cursor: 99n,
      resume: new Uint8Array([4, 5, 6]),
    };
    let observed: { readonly args: unknown; readonly state: unknown } | undefined;
    const hub = createHub(
      peer,
      async () => ({
        ok: true,
        args: authorizedArgs,
        state: authorizedState,
        adapter: adapter(),
      }),
      (context, args) => {
        observed = Object.freeze({ args, state: context.state });
      },
    );

    const prepared = await hub.prepare(prepareInput());
    if (!prepared.ok) throw new Error("expected a prepared realtime session");
    const result = await hub.offer(offerInput(prepared.ticket));
    if (!result.ok) throw new Error("expected an accepted realtime offer");
    expect(observed).toEqual({
      args: authorizedArgs,
      state: authorizedState,
    });

    hub.close(result.sessionId, TEST_OWNER);
  });

  test("fails prepared-ticket admission closed by retained-byte budget", async () => {
    const peers: FakePeerConnection[] = [];
    let releases = 0;
    const hub = createHub(
      () => {
        const peer = new FakePeerConnection();
        peers.push(peer);
        return peer;
      },
      async (_definition, input) => ({
        ok: true,
        args: input.args,
        state: { blob: new Uint8Array(1024) },
        adapter: adapter(),
      }),
      undefined,
      { maxSessions: 4, maxPreparedBytes: 4_000 },
    );
    const first = await hub.prepare(prepareInput({
      releaseAuthentication: () => releases++,
    }));
    if (!first.ok) throw new Error("expected the first ticket to fit");

    await expect(hub.prepare(prepareInput({
      releaseAuthentication: () => releases++,
    }))).rejects.toMatchObject({
      code: "overloaded",
      resource: "connection",
    });
    expect(peers).toHaveLength(0);
    expect(releases).toBe(1);
    expect(hub.snapshot()).toMatchObject({
      activeSessions: 0,
      reservedSessions: 1,
    });

    const accepted = await hub.offer(offerInput(first.ticket));
    if (!accepted.ok) throw new Error("expected the admitted ticket to remain usable");
    hub.close(accepted.sessionId, TEST_OWNER);
    expect(releases).toBe(2);
    expect(hub.snapshot().reservedSessions).toBe(0);
  });

  test("credential revocation closes the retained generation", async () => {
    const peer = new FakePeerConnection();
    const hub = createHub(peer);
    const credential = new AbortController();
    let releases = 0;
    const result = await prepareAndOffer(hub, prepareInput({
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

  test("keeps a prepared ticket owner-bound and atomically consumes it once", async () => {
    const peers: FakePeerConnection[] = [];
    let releases = 0;
    const hub = createHub(() => {
      const peer = new FakePeerConnection();
      peers.push(peer);
      return peer;
    });
    const prepared = await hub.prepare(prepareInput({
      releaseAuthentication: () => releases++,
    }));
    if (!prepared.ok) throw new Error("expected a prepared realtime session");

    await expect(hub.offer(offerInput(prepared.ticket, "B".repeat(43))))
      .rejects.toMatchObject({ code: "not_found" });
    expect(peers).toHaveLength(0);
    expect(releases).toBe(0);
    expect(hub.snapshot()).toMatchObject({
      activeSessions: 0,
      reservedSessions: 1,
    });

    const first = hub.offer(offerInput(prepared.ticket));
    const replay = hub.offer(offerInput(prepared.ticket));
    await expect(replay).rejects.toMatchObject({ code: "not_found" });
    const accepted = await first;
    if (!accepted.ok) throw new Error("expected the first ticket consume to succeed");
    expect(peers).toHaveLength(1);
    expect(hub.snapshot()).toMatchObject({
      activeSessions: 1,
      reservedSessions: 1,
    });

    hub.close(accepted.sessionId, TEST_OWNER);
    expect(releases).toBe(1);
    expect(hub.snapshot().reservedSessions).toBe(0);
  });

  test("releases unconsumed tickets once on expiry, revocation, and drain", async () => {
    const peers: FakePeerConnection[] = [];
    let releases = 0;
    const hub = createHub(
      () => {
        const peer = new FakePeerConnection();
        peers.push(peer);
        return peer;
      },
      undefined,
      undefined,
      { preparedSessionTtlMs: 10 },
    );
    const expired = await hub.prepare(prepareInput({
      releaseAuthentication: () => releases++,
    }));
    if (!expired.ok) throw new Error("expected a prepared realtime session");
    await Bun.sleep(25);
    await expect(hub.offer(offerInput(expired.ticket))).rejects.toMatchObject({
      code: "not_found",
    });
    expect(releases).toBe(1);
    expect(hub.snapshot().reservedSessions).toBe(0);

    const credential = new AbortController();
    const revoked = await hub.prepare(prepareInput({
      signal: credential.signal,
      releaseAuthentication: () => releases++,
    }));
    if (!revoked.ok) throw new Error("expected a prepared realtime session");
    credential.abort(new Error("revoked"));
    await expect(hub.offer(offerInput(revoked.ticket))).rejects.toMatchObject({
      code: "not_found",
    });
    expect(releases).toBe(2);
    expect(hub.snapshot().reservedSessions).toBe(0);

    const draining = await hub.prepare(prepareInput({
      releaseAuthentication: () => releases++,
    }));
    if (!draining.ok) throw new Error("expected a prepared realtime session");
    await hub.drain();
    await expect(hub.offer(offerInput(draining.ticket))).rejects.toMatchObject({
      code: "draining",
    });
    expect(peers).toHaveLength(0);
    expect(releases).toBe(3);
    expect(hub.snapshot().reservedSessions).toBe(0);
  });

  test("runs a seeded public prepared-ticket lifecycle without leaking capacity", async () => {
    const hub = createHub(
      () => new FakePeerConnection(),
      undefined,
      undefined,
      { maxSessions: 4, maxSessionsPerPrincipal: 4 },
    );
    const pending: Array<{ readonly ticket: string; readonly credential: AbortController }> = [];
    let issued = 0;
    let releases = 0;
    let seed = 0x110_2026;
    const next = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed;
    };

    for (let step = 0; step < 48; step++) {
      const action = pending.length === 0
        ? 0
        : pending.length >= 3
        ? 2
        : next() % 4;
      if (action === 0) {
        const credential = new AbortController();
        issued++;
        const prepared = await hub.prepare(prepareInput({
          signal: credential.signal,
          releaseAuthentication: () => releases++,
        }));
        if (!prepared.ok) throw new Error("generated preparation unexpectedly rejected");
        pending.push({ ticket: prepared.ticket, credential });
      } else {
        const index = next() % pending.length;
        const entry = pending[index]!;
        if (action === 1) {
          await expect(hub.offer(offerInput(entry.ticket, "C".repeat(43))))
            .rejects.toMatchObject({ code: "not_found" });
        } else if (action === 2) {
          pending.splice(index, 1);
          const accepted = await hub.offer(offerInput(entry.ticket));
          if (!accepted.ok) throw new Error("generated ticket consume unexpectedly rejected");
          hub.close(accepted.sessionId, TEST_OWNER);
        } else {
          pending.splice(index, 1);
          entry.credential.abort(new Error("generated revocation"));
        }
      }
      expect(hub.snapshot()).toMatchObject({
        activeSessions: 0,
        reservedSessions: pending.length,
      });
    }

    await hub.drain();
    expect(hub.snapshot()).toMatchObject({
      activeSessions: 0,
      reservedSessions: 0,
    });
    expect(releases).toBe(issued);
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
    const input = prepareInput();

    const first = await prepareAndOffer(hub, input);
    expect(first.ok).toBe(true);
    expect(peers).toHaveLength(1);
    await expect(prepareAndOffer(hub, input)).rejects.toMatchObject({
      code: "overloaded",
      resource: "connection",
    });
    expect(peers).toHaveLength(1);

    if (!first.ok) throw new Error("expected accepted realtime offer");
    hub.close(first.sessionId, TEST_OWNER);
    expect((await prepareAndOffer(hub, input)).ok).toBe(true);
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
    const baseInput = prepareInput();

    const first = await prepareAndOffer(hub, baseInput);
    if (!first.ok) throw new Error("expected accepted initial generation");
    hub.close(first.sessionId, TEST_OWNER);
    const replacement = await prepareAndOffer(hub, {
      ...baseInput,
      recovery: true,
    });

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
      hub.close(replacement.sessionId, TEST_OWNER);
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
    const input = prepareInput();

    const first = await prepareAndOffer(hub, input);
    expect(first.ok).toBe(true);
    expect(peers).toHaveLength(2);
    await expect(prepareAndOffer(hub, input)).rejects.toMatchObject({
      code: "overloaded",
      resource: "connection",
    });
    expect(peers).toHaveLength(3);
    expect(hub.snapshot().resources).toMatchObject({
      active: { auxiliaryPeers: 1 },
      saturated: { auxiliaryPeers: 1 },
    });

    if (!first.ok) throw new Error("expected accepted realtime offer");
    hub.close(first.sessionId, TEST_OWNER);
    expect((await prepareAndOffer(hub, input)).ok).toBe(true);
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
    const input = prepareInput();

    expect((await hub.prepare(input)).ok).toBe(false);
    await expect(hub.prepare(input)).rejects.toMatchObject({
      code: "overloaded",
      resource: "connection",
    });
    expect(peers).toHaveLength(0);
  });

  test("preserves existing handshake windows when the owner table is full", async () => {
    const hub = createHub(
      () => new FakePeerConnection(),
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
        maxTrackedPrincipals: 1,
        maxHandshakesPerWindow: 2,
        handshakeWindowMs: 60_000,
      },
    );
    const incumbent = prepareInput();

    expect((await hub.prepare(incumbent)).ok).toBe(false);
    await expect(hub.prepare(prepareInput({ owner: "B".repeat(43) })))
      .rejects.toMatchObject({
        code: "overloaded",
        resource: "connection",
        retryable: true,
        retryAfterMs: 0,
      });
    expect(hub.snapshot().trackedHandshakeWindows).toBe(1);

    expect((await hub.prepare(incumbent)).ok).toBe(false);
    await expect(hub.prepare(incumbent)).rejects.toMatchObject({
      code: "overloaded",
      message: "realtime principal handshake rate is full",
    });
    expect(hub.snapshot().trackedHandshakeWindows).toBe(1);
  });

  test("exposes bounded aggregate status and redacted per-session diagnostics", async () => {
    const peer = new FakePeerConnection();
    peer.connectionState = "connected";
    const hub = createHub(peer);
    const result = await prepareAndOffer(hub);
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
      TEST_OWNER,
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
    });

    hub.close(result.sessionId, TEST_OWNER);
    expect(hub.snapshot().closeReasons.client).toBe(1);
  });
});
