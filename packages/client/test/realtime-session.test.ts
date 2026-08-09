import { describe, expect, test } from "bun:test";
import {
  ACKERDB_VERSION,
  anyApi,
  decode,
  decodeRealtimeFrame,
  encode,
  encodeRealtimeEvent,
  encodeRealtimeFrame,
  parseRealtimeCandidatesMessage,
  parseRealtimeOfferRequest,
  parseRealtimePrepareRequest,
  RealtimeStreamInterruptedError,
  type RealtimeCandidatesMessage,
  type RealtimeRef,
} from "@ackerdb/core";
import {
  AckerDBClient,
  type AckerDBClientClock,
} from "../src/index.ts";
import { ManualClock } from "ackerdb-test-support/client-transport";

class FakeDataChannel extends EventTarget {
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState: RTCDataChannelState = "connecting";
  readonly sent: Uint8Array[] = [];

  send(data: string | Blob | ArrayBuffer | ArrayBufferView): void {
    if (typeof data === "string" || data instanceof Blob) {
      throw new Error("expected binary realtime data");
    }
    const value = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.sent.push(value.slice());
  }

  open(): void {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }

  receive(data: Uint8Array): void {
    this.dispatchEvent(new MessageEvent("message", {
      data: data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      ),
    }));
  }
}

class FakePeerConnection extends EventTarget {
  readonly channel = new FakeDataChannel();
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  closed = false;
  offers = 0;
  iceRestarts = 0;
  readonly negotiationOperations: string[] = [];

  constructor(
    private readonly autoIceComplete = true,
    private readonly autoChannelOpen = true,
    private readonly autoPeerConnect = true,
  ) {
    super();
  }

  createDataChannel(
    label: string,
    options?: RTCDataChannelInit,
  ): RTCDataChannel {
    expect(label).toBe("ackerdb.typed.v1");
    expect(options).toEqual({ negotiated: true, id: 0, ordered: true });
    return this.channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this.offers++;
    return { type: "offer", sdp: `v=0\r\nclient-${this.offers}` };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "v=0\r\nclient-answer" };
  }

  async setLocalDescription(value: RTCLocalSessionDescriptionInit): Promise<void> {
    this.negotiationOperations.push(`local:${value.type}`);
    if (value.type === "rollback") {
      this.localDescription = null;
      this.signalingState = "stable";
      return;
    }
    this.localDescription = value as RTCSessionDescription;
    this.signalingState = value.type === "offer"
      ? "have-local-offer"
      : "stable";
    if (this.autoIceComplete) {
      queueMicrotask(() => this.completeIce());
    }
  }

  async setRemoteDescription(value: RTCSessionDescriptionInit): Promise<void> {
    this.negotiationOperations.push(`remote:${value.type}`);
    this.remoteDescription = value as RTCSessionDescription;
    this.signalingState = value.type === "offer"
      ? "have-remote-offer"
      : "stable";
    if (value.type === "offer") return;
    queueMicrotask(() => {
      if (this.autoPeerConnect) {
        this.connectionState = "connected";
        this.dispatchEvent(new Event("connectionstatechange"));
      }
      if (this.autoChannelOpen) this.channel.open();
    });
  }

  async addIceCandidate(): Promise<void> {}

  setConfiguration(): void {}

  restartIce(): void {
    this.iceRestarts++;
    this.dispatchEvent(new Event("negotiationneeded"));
  }

  completeIce(): void {
    const event = new Event("icecandidate");
    Object.defineProperty(event, "candidate", { value: null });
    this.dispatchEvent(event);
  }

  emitIceCandidate(value: RTCIceCandidateInit): void {
    const event = new Event("icecandidate");
    Object.defineProperty(event, "candidate", {
      value: { toJSON: () => value },
    });
    this.dispatchEvent(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connectionState = "closed";
    this.dispatchEvent(new Event("connectionstatechange"));
  }
}

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await Bun.sleep(1);
  }
}

async function turns(count = 4): Promise<void> {
  for (let index = 0; index < count; index++) {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
}

type AssistantRef = RealtimeRef<
  { readonly assistantId: bigint },
  { readonly prompt: { readonly text: string } },
  { readonly transcript: { readonly text: string } },
  { readonly photo: { readonly contentType: "image/jpeg" } },
  { readonly audio: { readonly contentType: "audio/pcm" } },
  never
>;

const assistant = anyApi.assistant.live as AssistantRef;

function fixture(reconnect?: {
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly stableOpenMs?: number;
  readonly disconnectedGraceMs?: number;
  readonly iceRestartTimeoutMs?: number;
  readonly realtimeSetupTimeoutMs?: number;
  readonly autoIceComplete?: boolean;
  readonly autoChannelOpen?: boolean;
  readonly autoPeerConnect?: boolean;
  readonly clock?: AckerDBClientClock;
  readonly random?: () => number;
  readonly stallCleanup?: boolean;
  readonly rejectPrepare?: boolean;
  readonly onPatch?: (
    request: RealtimeCandidatesMessage,
  ) => Response | Promise<Response>;
}) {
  const {
    autoIceComplete = true,
    autoChannelOpen = true,
    autoPeerConnect = true,
    clock,
    random = () => 0,
    stallCleanup = false,
    rejectPrepare = false,
    onPatch,
    ...reconnectOptions
  } = reconnect ?? {};
  const peers: FakePeerConnection[] = [];
  let preparations = 0;
  let offers = 0;
  let closes = 0;
  let patches = 0;
  const recoveryPreparations: boolean[] = [];
  const tickets: string[] = [];
  const cleanupSignals: AbortSignal[] = [];
  const client = new AckerDBClient({
    url: "https://ackerdb.example.test",
    credential: { kind: "anonymous" },
    clientSessionId: "01890a5d-ac96-774b-b4c0-123456789abc",
    random,
    ...(clock === undefined ? {} : { clock }),
    reconnect: reconnectOptions,
    createPeerConnection: () => {
      const peer = new FakePeerConnection(
        autoIceComplete,
        autoChannelOpen,
        autoPeerConnect,
      );
      peers.push(peer);
      return peer;
    },
    createWebSocket: () => {
      throw new Error("realtime must not open the application WebSocket");
    },
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      if (path === "/_realtime/prepare" && init?.method === "POST") {
        preparations++;
        const request = parseRealtimePrepareRequest(
          decode(String(init.body)),
        );
        expect(request.ref).toBe("api.assistant.live");
        expect(request.args).toEqual({ assistantId: 1n });
        recoveryPreparations.push(request.recovery === true);
        if (rejectPrepare) {
          return new Response(encode({
            v: ACKERDB_VERSION,
            t: "realtime_rejected",
            error: {
              kind: "application",
              code: "forbidden",
              body: null,
              status: 403,
            },
          }), { status: 403 });
        }
        const ticket = String(preparations).padStart(43, "A");
        tickets.push(ticket);
        return new Response(encode({
          v: ACKERDB_VERSION,
          t: "realtime_prepared",
          ticket,
          configuration: { iceServers: [] },
        }));
      }
      if (path === "/_realtime" && init?.method === "POST") {
        const request = parseRealtimeOfferRequest(
          decode(String(init.body)),
        );
        const ticket = tickets[offers];
        if (ticket === undefined) throw new Error("offer has no prepared ticket");
        expect(request.ticket).toBe(ticket);
        offers++;
        return new Response(encode({
          v: ACKERDB_VERSION,
          t: "realtime_answer",
          sessionId: "abcdefghijklmnopqrstuvwxyzABCDEF",
          answer: { type: "answer", sdp: "v=0\r\nserver" },
          streamLimits: {
            client: { photo: 1024 },
            server: { audio: 2048 },
          },
          candidates: [],
          complete: true,
        }));
      }
      if (
        path === "/_realtime/abcdefghijklmnopqrstuvwxyzABCDEF" &&
        init?.method === "PATCH"
      ) {
        patches++;
        const request = parseRealtimeCandidatesMessage(
          decode(String(init.body)),
          "client",
        );
        if (onPatch !== undefined) return onPatch(request);
        return new Response(encode({
          v: ACKERDB_VERSION,
          t: "realtime_candidates",
          candidates: [],
          complete: true,
        }));
      }
      if (
        path === "/_realtime/abcdefghijklmnopqrstuvwxyzABCDEF" &&
        init?.method === "DELETE"
      ) {
        closes++;
        if (stallCleanup) {
          const signal = init?.signal;
          if (signal === undefined || signal === null) {
            throw new Error("cleanup requires an abort signal");
          }
          cleanupSignals.push(signal);
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${path}`);
    },
  });
  return {
    client,
    peers,
    preparations: () => preparations,
    offers: () => offers,
    closes: () => closes,
    patches: () => patches,
    recoveryPreparations,
    cleanupSignals,
  };
}

describe("AckerDB realtime client sessions", () => {
  test("turns a stalled realtime setup into bounded recovery", async () => {
    const client = new AckerDBClient({
      url: "https://ackerdb.example.test",
      credential: { kind: "anonymous" },
      clientSessionId: "01890a5d-ac96-774b-b4c0-123456789abc",
      reconnect: {
        realtimeSetupTimeoutMs: 10,
        baseDelayMs: 1_000,
        maxDelayMs: 1_000,
      },
      createWebSocket: () => {
        throw new Error("realtime must not open the application WebSocket");
      },
      createPeerConnection: () => {
        throw new Error("stalled configuration must not allocate a peer");
      },
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    });
    const session = client.realtime(assistant, { assistantId: 1n });

    await eventually(() => session.currentState.phase === "reconnecting");
    expect(session.currentState).toMatchObject({
      phase: "reconnecting",
      error: { message: "WebRTC realtime setup timed out", retryable: true },
    });
    session.release();
    client.close();
  });

  test("equal canonical sessions retain one peer while observation ownership stays separate", async () => {
    const { client, peers, preparations, offers, closes } = fixture();
    const transcripts: string[] = [];
    let setups = 0;
    let cleanups = 0;
    const observation = (owner: string) => ({
      peerConnection: () => {
        setups++;
        return () => {
          cleanups++;
        };
      },
      event: {
        transcript: ({ text }: { readonly text: string }) => {
          transcripts.push(`${owner}:${text}`);
        },
      },
    });
    const chat = client.realtime(assistant, { assistantId: 1n });
    const composer = client.realtime(assistant, { assistantId: 1n });
    const stopChatObservation = chat.observe(observation("chat"));
    composer.observe(observation("composer"));

    await eventually(() => chat.currentState.phase === "connected");
    expect(composer.currentState.phase).toBe("connected");
    expect(peers).toHaveLength(1);
    expect(preparations()).toBe(1);
    expect(offers()).toBe(1);
    expect(setups).toBe(2);
    expect(chat.peerConnection).toBe(composer.peerConnection);

    peers[0]!.channel.receive(encodeRealtimeEvent("transcript", {
      text: "first",
    }));
    await eventually(() => transcripts.length === 2);
    expect(transcripts).toEqual(["chat:first", "composer:first"]);

    stopChatObservation();
    expect(cleanups).toBe(1);
    chat.release();
    peers[0]!.channel.receive(encodeRealtimeEvent("transcript", {
      text: "second",
    }));
    await eventually(() => transcripts.length === 3);
    expect(transcripts).toEqual([
      "chat:first",
      "composer:first",
      "composer:second",
    ]);
    expect(peers[0]!.closed).toBe(false);

    composer.release();
    await eventually(() => closes() === 1);
    expect(cleanups).toBe(2);
    expect(peers[0]!.closed).toBe(true);
    client.close();
  });

  test("equal canonical keys retain independently without caller collision keys", () => {
    const { client } = fixture();
    const first = client.realtime(assistant, { assistantId: 1n });
    const second = client.realtime(assistant, { assistantId: 1n });
    first.release();
    second.release();
    client.close();
  });

  test("sends typed events and enforces server-advertised stream limits", async () => {
    const { client, peers } = fixture();
    const session = client.realtime(assistant, { assistantId: 1n });
    await eventually(() => session.currentState.phase === "connected");

    expect(session.send("prompt", { text: "hello" })).toBe(true);
    expect(peers[0]!.channel.sent
      .map((packet) => decodeRealtimeFrame(packet, "client"))
      .filter((frame) => frame.t === "event")).toHaveLength(1);
    expect(() => session.openStream(
      "photo",
      { contentType: "image/jpeg" },
      { size: 1025 },
    )).toThrow("no greater than 1024");

    session.release();
    client.close();
  });

  test("uses the internal data channel for native post-connect renegotiation", async () => {
    const { client, peers } = fixture();
    const session = client.realtime(assistant, { assistantId: 1n });
    await eventually(() => session.currentState.phase === "connected");
    expect(peers[0]!.offers).toBe(1);

    peers[0]!.dispatchEvent(new Event("negotiationneeded"));
    await eventually(() => peers[0]!.offers === 2);
    expect(peers[0]!.offers).toBe(2);
    const description = peers[0]!.channel.sent
      .map((packet) => decodeRealtimeFrame(packet, "client"))
      .find((frame) => frame.t === "signal_description");
    expect(description).toMatchObject({
      t: "signal_description",
      description: { type: "offer", sdp: "v=0\r\nclient-2" },
    });

    session.release();
    client.close();
  });

  test("keeps the client polite when a remote offer collides", async () => {
    const { client, peers } = fixture();
    const session = client.realtime(assistant, { assistantId: 1n });
    await eventually(() => session.currentState.phase === "connected");
    const peer = peers[0]!;
    peer.negotiationOperations.length = 0;
    peer.channel.sent.length = 0;
    peer.signalingState = "have-local-offer";
    peer.localDescription = {
      type: "offer",
      sdp: "v=0\r\ncolliding-client-offer",
    } as RTCSessionDescription;

    peer.channel.receive(encodeRealtimeFrame({
      v: ACKERDB_VERSION,
      t: "signal_description",
      description: { type: "offer", sdp: "v=0\r\nserver-offer" },
    }));
    await eventually(() =>
      peer.channel.sent
        .map((packet) => decodeRealtimeFrame(packet, "client"))
        .some((frame) => frame.t === "signal_description")
    );

    expect(peer.negotiationOperations).toEqual([
      "local:rollback",
      "remote:offer",
      "local:answer",
    ]);
    expect(peer.channel.sent.map((packet) => decodeRealtimeFrame(packet, "client")).find((frame) =>
      frame.t === "signal_description"
    )).toMatchObject({
      t: "signal_description",
      description: { type: "answer", sdp: "v=0\r\nclient-answer" },
    });

    session.release();
    client.close();
  });

  test("does not poll HTTP trickle before local ICE emits", async () => {
    const clock = new ManualClock();
    const { client, peers, patches } = fixture({
      autoIceComplete: false,
      clock,
    });
    const session = client.realtime(assistant, { assistantId: 1n });
    await eventually(() => session.currentState.phase === "connected");
    clock.advance(1_000);
    await Promise.resolve();
    expect(patches()).toBe(0);

    peers[0]!.completeIce();
    await eventually(() =>
      peers[0]!.channel.sent
        .map((packet) => decodeRealtimeFrame(packet, "client"))
        .some((frame) =>
          frame.t === "signal_candidate" && frame.candidate === null
        )
    );
    clock.advance(1_000);
    await Promise.resolve();
    expect(patches()).toBe(0);

    session.release();
    client.close();
  });

  test("serially flushes candidates that arrive while an HTTP patch is in flight", async () => {
    const requests: RealtimeCandidatesMessage[] = [];
    let resolveFirst!: (response: Response) => void;
    const response = (complete: boolean) => new Response(encode({
      v: ACKERDB_VERSION,
      t: "realtime_candidates",
      candidates: [],
      complete,
    }));
    const { client, peers } = fixture({
      autoIceComplete: false,
      autoChannelOpen: false,
      autoPeerConnect: false,
      onPatch: (request) => {
        requests.push(request);
        if (requests.length === 1) {
          return new Promise((resolve) => resolveFirst = resolve);
        }
        return response(true);
      },
    });
    const session = client.realtime(assistant, { assistantId: 1n });
    await eventually(() => peers.length === 1);
    const peer = peers[0]!;
    const first = {
      candidate: "candidate:1 1 UDP 1 8.8.8.8 9 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
    };
    const second = {
      candidate: "candidate:2 1 UDP 1 1.1.1.1 9 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
    };

    peer.emitIceCandidate(first);
    await eventually(() => requests.length === 1);
    peer.emitIceCandidate(second);
    await Promise.resolve();
    expect(requests).toEqual([{
      v: ACKERDB_VERSION,
      t: "realtime_candidates",
      candidates: [first],
      complete: false,
    }]);

    resolveFirst(response(false));
    await eventually(() => requests.length === 2);
    expect(requests[1]).toEqual({
      v: ACKERDB_VERSION,
      t: "realtime_candidates",
      candidates: [second],
      complete: false,
    });

    session.release();
    client.close();
  });

  test("continues a completed HTTP trickle without repeating end-of-candidates", async () => {
    const requests: RealtimeCandidatesMessage[] = [];
    let resolveContinuation!: (response: Response) => void;
    const serverCandidate = {
      candidate: "candidate:1 1 UDP 1 8.8.4.4 9 typ relay",
      sdpMid: "0",
      sdpMLineIndex: 0,
    };
    const { client, peers } = fixture({
      autoIceComplete: false,
      autoChannelOpen: false,
      autoPeerConnect: false,
      onPatch: (request) => {
        requests.push(request);
        if (requests.length === 1) {
          return new Response(encode({
            v: ACKERDB_VERSION,
            t: "realtime_candidates",
            candidates: [serverCandidate],
            complete: false,
          }));
        }
        return new Promise((resolve) => resolveContinuation = resolve);
      },
    });
    const session = client.realtime(assistant, { assistantId: 1n });
    await eventually(() => peers.length === 1);

    peers[0]!.completeIce();
    await eventually(() => requests.length === 2);
    expect(requests).toEqual([
      {
        v: ACKERDB_VERSION,
        t: "realtime_candidates",
        candidates: [],
        complete: true,
      },
      {
        v: ACKERDB_VERSION,
        t: "realtime_candidates",
        candidates: [],
        complete: false,
      },
    ]);

    peers[0]!.channel.open();
    resolveContinuation(new Response(encode({
      v: ACKERDB_VERSION,
      t: "realtime_candidates",
      candidates: [],
      complete: false,
    })));
    await turns(8);
    expect(requests).toHaveLength(2);

    session.release();
    client.close();
  });

  test("returns to connected when the native peer recovers from a transient disconnect", async () => {
    const { client, peers } = fixture();
    const phases: string[] = [];
    let connected = 0;
    const session = client.realtime(assistant, { assistantId: 1n });
    session.observe({
      connected: () => {
        connected++;
      },
      stateChange: (state) => {
        phases.push(state.phase);
      },
    });
    await eventually(() => session.currentState.phase === "connected");

    peers[0]!.connectionState = "disconnected";
    peers[0]!.dispatchEvent(new Event("connectionstatechange"));
    expect(session.currentState.phase).toBe("disconnected");

    peers[0]!.connectionState = "connected";
    peers[0]!.dispatchEvent(new Event("connectionstatechange"));
    await eventually(() => session.currentState.phase === "connected");

    expect(peers).toHaveLength(1);
    expect(connected).toBe(2);
    expect(phases.slice(-2)).toEqual(["disconnected", "connected"]);

    session.release();
    client.close();
  });

  test("restarts ICE after a disconnected grace period and retains the peer when it recovers", async () => {
    const { client, peers } = fixture({
      disconnectedGraceMs: 1,
      iceRestartTimeoutMs: 100,
    });
    const session = client.realtime(assistant, { assistantId: 1n });
    await eventually(() => session.currentState.phase === "connected");

    peers[0]!.connectionState = "disconnected";
    peers[0]!.dispatchEvent(new Event("connectionstatechange"));
    expect(session.currentState.phase).toBe("disconnected");
    await eventually(() => peers[0]!.iceRestarts === 1);
    expect(session.currentState.phase).toBe("reconnecting");

    peers[0]!.connectionState = "connected";
    peers[0]!.dispatchEvent(new Event("connectionstatechange"));
    await eventually(() => session.currentState.phase === "connected");
    expect(peers).toHaveLength(1);

    session.release();
    client.close();
  });

  test("uses ICE-state recovery when the peer connection state remains connected", async () => {
    const { client, peers } = fixture({
      disconnectedGraceMs: 1,
      iceRestartTimeoutMs: 100,
    });
    const session = client.realtime(assistant, { assistantId: 1n });
    await eventually(() => session.currentState.phase === "connected");

    peers[0]!.iceConnectionState = "disconnected";
    peers[0]!.dispatchEvent(new Event("iceconnectionstatechange"));
    await eventually(() => peers[0]!.iceRestarts === 1);
    expect(session.currentState.phase).toBe("reconnecting");

    peers[0]!.iceConnectionState = "connected";
    peers[0]!.dispatchEvent(new Event("iceconnectionstatechange"));
    await eventually(() => session.currentState.phase === "connected");
    expect(peers).toHaveLength(1);

    session.release();
    client.close();
  });

  test("replaces a peer that remains disconnected after its ICE restart deadline", async () => {
    const { client, peers, recoveryPreparations, closes } = fixture({
      baseDelayMs: 1,
      maxDelayMs: 1,
      disconnectedGraceMs: 1,
      iceRestartTimeoutMs: 1,
    });
    const transcripts: string[] = [];
    let tracks = 0;
    const session = client.realtime(assistant, { assistantId: 1n });
    session.observe({
      event: {
        transcript: ({ text }) => transcripts.push(text),
      },
      track: () => {
        tracks++;
      },
    });
    await eventually(() => session.currentState.phase === "connected");
    peers[0]!.channel.receive(encodeRealtimeEvent("transcript", {
      text: "before recovery",
    }));
    peers[0]!.dispatchEvent(Object.assign(new Event("track"), {
      track: { id: "old-audio", kind: "audio" },
    }));
    await eventually(() => transcripts.length === 1 && tracks === 1);
    const transfer = session.openStream(
      "photo",
      { contentType: "image/jpeg" },
      { size: 2 },
    );
    const writer = transfer.writable.getWriter();
    await writer.write(new Uint8Array([1]));

    peers[0]!.connectionState = "disconnected";
    peers[0]!.dispatchEvent(new Event("connectionstatechange"));
    await eventually(() => peers.length === 2);
    await eventually(() => session.currentState.phase === "connected");
    await eventually(() => closes() === 1);

    expect(peers[0]!.iceRestarts).toBe(1);
    expect(peers[0]!.closed).toBe(true);
    expect(peers[1]!.closed).toBe(false);
    expect(recoveryPreparations).toEqual([false, true]);
    expect(transcripts).toEqual(["before recovery"]);
    expect(tracks).toBe(1);
    await expect(writer.write(new Uint8Array([2]))).rejects.toBeInstanceOf(
      RealtimeStreamInterruptedError,
    );
    writer.releaseLock();

    session.release();
    client.close();
  });

  test("fails terminally when the platform cannot create WebRTC", async () => {
    let attempts = 0;
    const client = new AckerDBClient({
      url: "https://ackerdb.example.test",
      credential: { kind: "anonymous" },
      clientSessionId: "01890a5d-ac96-774b-b4c0-123456789abc",
      createWebSocket: () => {
        throw new Error("realtime must not open the application WebSocket");
      },
      createPeerConnection: () => {
        attempts++;
        throw new DOMException(
          "WebRTC is unavailable on this platform",
          "NotSupportedError",
        );
      },
      fetch: async (url, init) => {
        expect(new URL(url).pathname).toBe("/_realtime/prepare");
        expect(init?.method).toBe("POST");
        return new Response(encode({
          v: ACKERDB_VERSION,
          t: "realtime_prepared",
          ticket: "A".repeat(43),
          configuration: { iceServers: [] },
        }));
      },
    });
    const session = client.realtime(assistant, { assistantId: 1n });

    await eventually(() => session.currentState.phase === "failed");
    expect(session.currentState).toMatchObject({
      phase: "failed",
      error: {
        message: "WebRTC is unavailable on this platform",
        retryable: false,
      },
    });
    await Bun.sleep(20);
    expect(attempts).toBe(1);

    session.release();
    client.close();
  });

  test("validates reserved peer capabilities before the offer", async () => {
    let requests = 0;
    const client = new AckerDBClient({
      url: "https://ackerdb.example.test",
      credential: { kind: "anonymous" },
      clientSessionId: "01890a5d-ac96-774b-b4c0-123456789abc",
      createWebSocket: () => {
        throw new Error("realtime must not open the application WebSocket");
      },
      createPeerConnection: () => ({}),
      fetch: async (url, init) => {
        requests++;
        expect(new URL(url).pathname).toBe("/_realtime/prepare");
        expect(init?.method).toBe("POST");
        return new Response(encode({
          v: ACKERDB_VERSION,
          t: "realtime_prepared",
          ticket: "A".repeat(43),
          configuration: { iceServers: [] },
        }));
      },
    });
    const session = client.realtime(assistant, { assistantId: 1n });

    await eventually(() => session.currentState.phase === "failed");
    expect(session.currentState).toMatchObject({
      phase: "failed",
      error: {
        code: "validation",
        message: "RTCPeerConnection must support createDataChannel()",
        retryable: false,
      },
    });
    expect(requests).toBe(1);

    session.release();
    client.close();
  });

  test("awaits native media setup before creating the initial offer", async () => {
    const { client, peers, offers } = fixture();
    let finishSetup!: () => void;
    const setup = new Promise<void>((resolve) => {
      finishSetup = resolve;
    });
    const session = client.realtime(assistant, { assistantId: 1n });
    session.observe({
      async peerConnection() {
        await setup;
      },
    });

    await eventually(() => peers.length === 1);
    expect(offers()).toBe(0);
    expect(peers[0]!.offers).toBe(0);

    finishSetup();
    await eventually(() => session.currentState.phase === "connected");
    expect(offers()).toBe(1);
    expect(peers[0]!.offers).toBe(1);

    session.release();
    client.close();
  });

  test("keeps a stalled application setup terminal instead of retrying it", async () => {
    const { client, peers, offers, preparations } = fixture({
      realtimeSetupTimeoutMs: 5,
      baseDelayMs: 1,
      maxDelayMs: 1,
    });
    const session = client.realtime(assistant, { assistantId: 1n });
    session.observe({
      peerConnection: () => new Promise(() => {}),
    });

    await eventually(() => session.currentState.phase === "failed");
    expect(session.currentState).toMatchObject({
      phase: "failed",
      error: {
        code: "internal",
        message: "realtime on.peerConnection handler timed out",
        retryable: false,
      },
    });
    await Bun.sleep(10);
    expect(preparations()).toBe(1);
    expect(peers).toHaveLength(1);
    expect(peers[0]!.closed).toBe(true);
    expect(offers()).toBe(0);

    session.release();
    client.close();
  });

  test("keeps setup bounded until both the peer and AckerDB data channel open", async () => {
    const { client, peers } = fixture({
      autoChannelOpen: false,
      realtimeSetupTimeoutMs: 5,
      baseDelayMs: 100,
      maxDelayMs: 100,
    });
    const session = client.realtime(assistant, { assistantId: 1n });

    await eventually(() => peers[0]?.connectionState === "connected");
    expect(session.currentState.phase).toBe("connecting");
    await eventually(() => session.currentState.phase === "reconnecting");
    expect(peers[0]!.closed).toBe(true);

    session.release();
    client.close();
  });

  test("keeps setup bounded when the data channel opens before the peer", async () => {
    const { client, peers } = fixture({
      autoPeerConnect: false,
      realtimeSetupTimeoutMs: 5,
      baseDelayMs: 100,
      maxDelayMs: 100,
    });
    const session = client.realtime(assistant, { assistantId: 1n });

    await eventually(() => peers[0]?.channel.readyState === "open");
    expect(session.currentState.phase).toBe("connecting");
    await eventually(() => session.currentState.phase === "reconnecting");
    expect(peers[0]!.closed).toBe(true);

    session.release();
    client.close();
  });

  test("recovers one fresh generation when the AckerDB data channel closes", async () => {
    const { client, closes, peers, recoveryPreparations } = fixture({
      baseDelayMs: 1,
      maxDelayMs: 1,
    });
    const session = client.realtime(assistant, { assistantId: 1n });
    await eventually(() => session.currentState.phase === "connected");

    peers[0]!.channel.close();
    await eventually(() => peers.length === 2);
    await eventually(() => session.currentState.phase === "connected");
    expect(recoveryPreparations).toEqual([false, true]);
    expect(closes()).toBe(1);

    peers[0]!.channel.close();
    await Bun.sleep(10);
    expect(peers).toHaveLength(2);
    expect(closes()).toBe(1);

    session.release();
    client.close();
  });

  test("does not recover after explicit disconnect", async () => {
    const { client, peers } = fixture({ baseDelayMs: 1, maxDelayMs: 1 });
    const session = client.realtime(assistant, { assistantId: 1n });
    await eventually(() => session.currentState.phase === "connected");

    session.disconnect();
    peers[0]!.channel.close();
    await Bun.sleep(10);
    expect(session.currentState.phase).toBe("disconnected");
    expect(peers).toHaveLength(1);

    session.release();
    client.close();
  });

  test("treats exposed peer closure as disconnected until reconnect", async () => {
    const { client, peers, recoveryPreparations } = fixture({
      baseDelayMs: 1,
      maxDelayMs: 1,
    });
    const session = client.realtime(assistant, { assistantId: 1n });
    await eventually(() => session.currentState.phase === "connected");

    const peer = session.peerConnection;
    expect(peer).not.toBeNull();
    peer!.close();
    await eventually(() => session.currentState.phase === "disconnected");
    await Bun.sleep(10);
    expect(peers).toHaveLength(1);
    expect(recoveryPreparations).toEqual([false]);

    session.reconnect();
    await eventually(() => session.currentState.phase === "connected");
    expect(peers).toHaveLength(2);
    expect(recoveryPreparations).toEqual([false, false]);

    session.release();
    client.close();
  });

  test("keeps handler failures terminal instead of replacing the generation", async () => {
    const { client, peers } = fixture({ baseDelayMs: 1, maxDelayMs: 1 });
    const session = client.realtime(assistant, { assistantId: 1n });
    session.observe({
      event: {
        transcript: () => {
          throw new Error("application handler failed");
        },
      },
    });
    await eventually(() => session.currentState.phase === "connected");

    peers[0]!.channel.receive(encodeRealtimeEvent("transcript", { text: "one" }));
    await eventually(() => session.currentState.phase === "failed");
    expect(session.currentState).toMatchObject({
      phase: "failed",
      error: {
        code: "internal",
        message: "realtime event or stream handler failed",
        retryable: false,
      },
    });
    const observer = client.realtime(assistant, { assistantId: 1n });
    await Bun.sleep(10);
    expect(peers).toHaveLength(1);

    observer.release();
    session.release();
    client.close();
  });

  test("keeps rejected setup terminal until explicit reconnect", async () => {
    const { client, peers, preparations } = fixture({ rejectPrepare: true });
    const session = client.realtime(assistant, { assistantId: 1n });
    await eventually(() => session.currentState.phase === "rejected");

    const observer = client.realtime(assistant, { assistantId: 1n });
    await Bun.sleep(10);
    expect(preparations()).toBe(1);
    expect(peers).toHaveLength(0);

    session.reconnect();
    await eventually(() => preparations() === 2);
    await eventually(() => session.currentState.phase === "rejected");
    observer.release();
    session.release();
    client.close();
  });

  test("does not reset replacement backoff before a generation stays open", async () => {
    const clock = new ManualClock();
    const { client, peers } = fixture({
      clock,
      random: () => 0.999,
      baseDelayMs: 10,
      maxDelayMs: 100,
      stableOpenMs: 1_000,
    });
    const session = client.realtime(assistant, { assistantId: 1n });
    await eventually(() => session.currentState.phase === "connected");

    peers[0]!.connectionState = "failed";
    peers[0]!.dispatchEvent(new Event("connectionstatechange"));
    clock.advance(20);
    await eventually(() => peers.length === 2 && session.currentState.phase === "connected");

    peers[1]!.connectionState = "failed";
    peers[1]!.dispatchEvent(new Event("connectionstatechange"));
    clock.advance(20);
    await Bun.sleep(0);
    expect(peers).toHaveLength(2);
    clock.advance(20);
    await eventually(() => peers.length === 3);

    session.release();
    client.close();
  });

  test("bounds the single cleanup request even when its transport stalls", async () => {
    const clock = new ManualClock();
    const { cleanupSignals, client, closes } = fixture({
      clock,
      realtimeSetupTimeoutMs: 5,
      stallCleanup: true,
    });
    const session = client.realtime(assistant, { assistantId: 1n });
    await eventually(() => session.currentState.phase === "connected");

    session.release();
    await Promise.resolve();
    expect(closes()).toBe(1);
    expect(cleanupSignals).toHaveLength(1);
    expect(cleanupSignals[0]!.aborted).toBe(false);
    clock.advance(5);
    expect(cleanupSignals[0]!.aborted).toBe(true);

    client.close();
  });
});
