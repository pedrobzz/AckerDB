import { describe, expect, test } from "bun:test";
import type {
  PortableMediaStreamTrack,
  PortableRTCConfiguration,
  PortableRTCDataChannel,
  PortableRTCPeerConnection,
  PortableRTCStatsReport,
} from "@ackerdb/core";
import type {
  RealtimeAudioSource,
  RealtimeAudioSourceOptions,
  RealtimeAudioStream,
  RealtimeAudioStreamOptions,
  RealtimeVideoSource,
  RealtimeVideoSourceOptions,
  RealtimeVideoStream,
  RealtimeVideoStreamOptions,
} from "@ackerdb/server";
import type {
  RealtimeNativeQueueMetrics,
  RealtimePeerEngine,
  RealtimePeerGeneration,
} from "../src/engine.ts";
import {
  preflightRealtimeTurnWith,
  type RealtimeTurnPreflightDependencies,
} from "../src/turn-preflight.ts";

const SECRET = "0123456789abcdef0123456789abcdef";
const EMPTY_METRICS: RealtimeNativeQueueMetrics = Object.freeze({
  reservedBytes: 0,
  saturations: 0,
});

class Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve!: (value: Value) => void;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
}

class ManualClock {
  nowMs = 0;
  private sequence = 0;
  private readonly timers = new Map<
    number,
    { readonly at: number; readonly callback: () => void }
  >();

  readonly now = (): number => this.nowMs;

  readonly setTimeout = (callback: () => void, delayMs: number): number => {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.nowMs + delayMs, callback });
    return id;
  };

  readonly clearTimeout = (id: unknown): void => {
    if (typeof id === "number") this.timers.delete(id);
  };

  advance(milliseconds: number): void {
    this.nowMs += milliseconds;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at > this.nowMs) continue;
      this.timers.delete(id);
      timer.callback();
    }
  }
}

type ProbeBehavior =
  | { readonly kind: "success" }
  | { readonly kind: "stats-error"; readonly error: Error }
  | { readonly kind: "stats-stall"; readonly stats: Deferred<PortableRTCStatsReport> };

class FakeChannel extends EventTarget {
  readyState: RTCDataChannelState = "connecting";
  partner: FakeChannel | undefined;
  closed = 0;

  send(data: string): void {
    this.partner?.dispatchEvent(new MessageEvent("message", { data }));
  }

  open(): void {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.closed++;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}

class FakePeer extends EventTarget {
  connectionState: RTCPeerConnectionState = "new";
  signalingState: RTCSignalingState = "stable";
  iceGatheringState: RTCIceGatheringState = "new";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  channel: FakeChannel | undefined;
  closed = 0;

  constructor(
    private readonly pair: FakePair,
    private readonly behavior: ProbeBehavior,
  ) {
    super();
  }

  createDataChannel(): RTCDataChannel {
    const channel = new FakeChannel();
    this.channel = channel;
    this.pair.connectChannels();
    return channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "v=0\r\nfake-offer" };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "v=0\r\nfake-answer" };
  }

  async setLocalDescription(description: RTCLocalSessionDescriptionInit): Promise<void> {
    this.localDescription = description as RTCSessionDescription;
    this.iceGatheringState = "complete";
    this.dispatchEvent(new Event("icegatheringstatechange"));
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description as RTCSessionDescription;
    if (description.type === "answer") this.pair.connect();
  }

  async addIceCandidate(): Promise<void> {}

  getStats(): Promise<RTCStatsReport> {
    if (this.behavior.kind === "stats-error") {
      return Promise.reject(this.behavior.error);
    }
    if (this.behavior.kind === "stats-stall") {
      return this.behavior.stats.promise as Promise<RTCStatsReport>;
    }
    return Promise.resolve(stats(this.pair.transport));
  }

  close(): void {
    if (this.connectionState === "closed") return;
    this.closed++;
    this.connectionState = "closed";
    this.channel?.close();
  }
}

class FakePair {
  readonly peers: FakePeer[] = [];

  constructor(
    readonly transport: "udp" | "tls",
    readonly behavior: ProbeBehavior,
  ) {}

  peer(): PortableRTCPeerConnection {
    const peer = new FakePeer(this, this.behavior);
    this.peers.push(peer);
    return peer as unknown as PortableRTCPeerConnection;
  }

  connectChannels(): void {
    const [caller, receiver] = this.peers;
    if (caller?.channel === undefined || receiver?.channel === undefined) return;
    caller.channel.partner = receiver.channel;
    receiver.channel.partner = caller.channel;
  }

  connect(): void {
    for (const peer of this.peers) {
      peer.connectionState = "connected";
      peer.dispatchEvent(new Event("connectionstatechange"));
      peer.channel?.open();
    }
  }
}

class FakeGeneration implements RealtimePeerGeneration {
  pair: FakePair | undefined;
  closed = 0;

  constructor(
    private readonly behavior: (
      transport: "udp" | "tls",
    ) => ProbeBehavior,
  ) {}

  nativeQueueMetrics(): RealtimeNativeQueueMetrics {
    return EMPTY_METRICS;
  }

  createPeerConnection(
    configuration?: PortableRTCConfiguration,
  ): PortableRTCPeerConnection {
    if (this.pair === undefined) {
      if (configuration === undefined) {
        throw new Error("fake peer configuration is required");
      }
      const transport = turnTransport(configuration);
      this.pair = new FakePair(transport, this.behavior(transport));
    }
    return this.pair.peer();
  }

  close(): void {
    if (this.closed !== 0) return;
    this.closed++;
  }

  createAudioStream(
    _track: PortableMediaStreamTrack,
    _options?: RealtimeAudioStreamOptions,
  ): RealtimeAudioStream {
    throw new Error("not used");
  }

  createAudioSource(_options?: RealtimeAudioSourceOptions): RealtimeAudioSource {
    throw new Error("not used");
  }

  createVideoStream(
    _track: PortableMediaStreamTrack,
    _options?: RealtimeVideoStreamOptions,
  ): RealtimeVideoStream {
    throw new Error("not used");
  }

  createVideoSource(_options: RealtimeVideoSourceOptions): RealtimeVideoSource {
    throw new Error("not used");
  }
}

class FakeEngine implements RealtimePeerEngine {
  readonly generations: FakeGeneration[] = [];
  closed = 0;

  constructor(
    private readonly behavior: (
      transport: "udp" | "tls",
    ) => ProbeBehavior,
  ) {}

  nativeQueueMetrics(): RealtimeNativeQueueMetrics {
    return EMPTY_METRICS;
  }

  createGeneration(): RealtimePeerGeneration {
    const generation = new FakeGeneration(this.behavior);
    this.generations.push(generation);
    return generation;
  }

  close(): void {
    if (this.closed !== 0) return;
    this.closed++;
  }
}

function dependencies(
  clock: ManualClock,
  behavior: (transport: "udp" | "tls") => ProbeBehavior,
) {
  const engines: FakeEngine[] = [];
  const value: RealtimeTurnPreflightDependencies = {
    clock,
    createEngine: () => {
      const engine = new FakeEngine(behavior);
      engines.push(engine);
      return engine;
    },
  };
  return { value, engines };
}

function stats(transport: "udp" | "tls"): RTCStatsReport {
  return new Map([
    ["transport", {
      id: "transport",
      type: "transport",
      timestamp: 0,
      selectedCandidatePairId: "pair",
    }],
    ["pair", {
      id: "pair",
      type: "candidate-pair",
      timestamp: 0,
      state: "succeeded",
      nominated: true,
      localCandidateId: "local",
      remoteCandidateId: "remote",
    }],
    ["local", {
      id: "local",
      type: "local-candidate",
      timestamp: 0,
      candidateType: "relay",
      protocol: transport === "udp" ? "udp" : "tcp",
      relayProtocol: transport,
    }],
    ["remote", {
      id: "remote",
      type: "remote-candidate",
      timestamp: 0,
      candidateType: "relay",
      protocol: transport === "udp" ? "udp" : "tcp",
    }],
  ]) as unknown as RTCStatsReport;
}

function turnTransport(configuration: PortableRTCConfiguration): "udp" | "tls" {
  const first = configuration.iceServers?.[0];
  const urls = typeof first?.urls === "string" ? [first.urls] : first?.urls ?? [];
  return urls.some((url) => url.startsWith("turns:")) ? "tls" : "udp";
}

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await Promise.resolve();
  }
  throw new Error("condition did not become true");
}

describe("TURN preflight", () => {
  test("reports UDP success and TLS failure independently without exposing its cause", async () => {
    const clock = new ManualClock();
    const secret = "provider-token-do-not-leak";
    const { value } = dependencies(clock, (transport) =>
      transport === "udp"
        ? { kind: "success" }
        : { kind: "stats-error", error: new Error(secret) }
    );

    const result = await preflightRealtimeTurnWith({
      urls: [
        "turn:relay.example.test:3478?transport=udp",
        "turns:relay.example.test:443?transport=tcp",
      ],
      secret: SECRET,
    }, value);

    expect(result.udp).toMatchObject({
      ok: true,
      callerProtocol: "udp",
      receiverProtocol: "udp",
      bidirectionalData: true,
    });
    expect(result.tls).toEqual({
      ok: false,
      code: "unavailable",
      durationMs: 0,
      message: "TURN/TLS preflight failed",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("bounds stalled native work, closes every owner once, and ignores late completion", async () => {
    const clock = new ManualClock();
    const lateStats = new Deferred<PortableRTCStatsReport>();
    const { value, engines } = dependencies(clock, (transport) =>
      transport === "udp"
        ? { kind: "stats-stall", stats: lateStats }
        : { kind: "success" }
    );
    const result = preflightRealtimeTurnWith({
      urls: "turn:relay.example.test:3478?transport=udp",
      secret: SECRET,
      timeoutMs: 50,
    }, value);

    await eventually(() => engines.length === 1);
    clock.advance(50);
    expect(await result).toEqual({
      udp: {
        ok: false,
        code: "deadline_exceeded",
        durationMs: 50,
        message: "TURN/UDP preflight timed out",
      },
      tls: {
        ok: false,
        code: "not_configured",
        durationMs: 0,
        message: "TURN/TLS preflight is not configured",
      },
    });
    const engine = engines[0]!;
    expect(engine.closed).toBe(1);
    expect(engine.generations).toHaveLength(1);
    expect(engine.generations[0]!.closed).toBe(1);
    expect(engine.generations[0]!.pair!.peers.map((peer) => peer.closed)).toEqual([
      1,
      1,
    ]);

    lateStats.resolve(stats("udp") as unknown as PortableRTCStatsReport);
    await Promise.resolve();
    expect(engine.closed).toBe(1);
    expect(engine.generations[0]!.closed).toBe(1);
  });

  test("an already-aborted caller allocates no native owner", async () => {
    const clock = new ManualClock();
    const { value, engines } = dependencies(clock, () => ({ kind: "success" }));
    const controller = new AbortController();
    controller.abort(new Error("credential-do-not-leak"));

    const result = await preflightRealtimeTurnWith({
      urls: [
        "turn:relay.example.test:3478?transport=udp",
        "turns:relay.example.test:443?transport=tcp",
      ],
      secret: SECRET,
      signal: controller.signal,
    }, value);

    expect(result).toEqual({
      udp: {
        ok: false,
        code: "cancelled",
        durationMs: 0,
        message: "TURN/UDP preflight was cancelled",
      },
      tls: {
        ok: false,
        code: "cancelled",
        durationMs: 0,
        message: "TURN/TLS preflight was cancelled",
      },
    });
    expect(engines).toHaveLength(0);
  });
});
