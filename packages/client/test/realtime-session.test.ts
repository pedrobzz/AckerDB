import { describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  anyApi,
  decode,
  decodeRealtimeFrame,
  encode,
  encodeRealtimeEvent,
  parseRealtimeOfferRequest,
  RealtimeStreamInterruptedError,
  type RealtimeRef,
} from "@ackerdb/core";
import {
  AckerDBClient,
  RealtimeHandlerKeyConflictError,
} from "../src/index.ts";

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
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  closed = false;
  offers = 0;
  iceRestarts = 0;

  constructor(private readonly autoIceComplete = true) {
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

  async setLocalDescription(value: RTCLocalSessionDescriptionInit): Promise<void> {
    this.localDescription = value as RTCSessionDescription;
    this.signalingState = value.type === "offer"
      ? "have-local-offer"
      : this.signalingState;
    if (this.autoIceComplete) {
      queueMicrotask(() => this.completeIce());
    }
  }

  async setRemoteDescription(value: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = value as RTCSessionDescription;
    this.signalingState = "stable";
    queueMicrotask(() => {
      this.connectionState = "connected";
      this.dispatchEvent(new Event("connectionstatechange"));
      this.channel.open();
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

  close(): void {
    this.closed = true;
    this.connectionState = "closed";
  }
}

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await Bun.sleep(1);
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
}) {
  const {
    autoIceComplete = true,
    ...reconnectOptions
  } = reconnect ?? {};
  const peers: FakePeerConnection[] = [];
  let offers = 0;
  let closes = 0;
  let patches = 0;
  const recoveryOffers: boolean[] = [];
  const client = new AckerDBClient({
    url: "https://ackerdb.example.test",
    credential: { kind: "anonymous" },
    clientSessionId: "01890a5d-ac96-774b-b4c0-123456789abc",
    random: () => 0,
    reconnect: reconnectOptions,
    createPeerConnection: () => {
      const peer = new FakePeerConnection(autoIceComplete);
      peers.push(peer);
      return peer as unknown as RTCPeerConnection;
    },
    createWebSocket: () => {
      throw new Error("realtime must not open the application WebSocket");
    },
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      if (path === "/api/realtime/config") {
        return new Response(encode({
          v: PROTOCOL_VERSION,
          t: "realtime_config",
          configuration: { iceServers: [] },
        }));
      }
      if (path === "/api/realtime" && init?.method === "POST") {
        offers++;
        const request = parseRealtimeOfferRequest(
          decode(String(init.body)),
        );
        expect(request.ref).toBe("assistant.live");
        expect(request.args).toEqual({ assistantId: 1n });
        recoveryOffers.push(request.recovery === true);
        return new Response(encode({
          v: PROTOCOL_VERSION,
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
        path === "/api/realtime/abcdefghijklmnopqrstuvwxyzABCDEF" &&
        init?.method === "PATCH"
      ) {
        patches++;
        return new Response(encode({
          v: PROTOCOL_VERSION,
          t: "realtime_candidates",
          candidates: [],
          complete: true,
        }));
      }
      if (
        path === "/api/realtime/abcdefghijklmnopqrstuvwxyzABCDEF" &&
        init?.method === "DELETE"
      ) {
        closes++;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${path}`);
    },
  });
  return {
    client,
    peers,
    offers: () => offers,
    closes: () => closes,
    patches: () => patches,
    recoveryOffers,
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
    const session = client.realtime(
      assistant,
      { assistantId: 1n },
      { handlerKey: "bounded-setup" },
    );

    await eventually(() => session.currentState.phase === "reconnecting");
    expect(session.currentState).toMatchObject({
      phase: "reconnecting",
      error: { message: "WebRTC realtime setup timed out", retryable: true },
    });
    session.release();
    client.close();
  });

  test("equal keys retain one peer and one handler bundle across owners", async () => {
    const { client, peers, offers, closes } = fixture();
    const transcripts: string[] = [];
    let setups = 0;
    const options = {
      handlerKey: "use-xai-realtime",
      on: {
        peerConnection: () => {
          setups++;
        },
        event: {
          transcript: ({ text }: { readonly text: string }) => {
            transcripts.push(text);
          },
        },
      },
    };
    const chat = client.realtime(
      assistant,
      { assistantId: 1n },
      options,
    );
    const composer = client.realtime(
      assistant,
      { assistantId: 1n },
      options,
    );

    await eventually(() => chat.currentState.phase === "connected");
    expect(composer.currentState.phase).toBe("connected");
    expect(peers).toHaveLength(1);
    expect(offers()).toBe(1);
    expect(setups).toBe(1);
    expect(chat.peerConnection).toBe(composer.peerConnection);

    peers[0]!.channel.receive(encodeRealtimeEvent("transcript", {
      text: "first",
    }));
    await eventually(() => transcripts.length === 1);
    expect(transcripts).toEqual(["first"]);

    chat.release();
    peers[0]!.channel.receive(encodeRealtimeEvent("transcript", {
      text: "second",
    }));
    await eventually(() => transcripts.length === 2);
    expect(transcripts).toEqual(["first", "second"]);
    expect(peers[0]!.closed).toBe(false);

    composer.release();
    await eventually(() => closes() === 1);
    expect(peers[0]!.closed).toBe(true);
    client.close();
  });

  test("missing or different handler keys conflict instead of opening another peer", () => {
    const { client } = fixture();
    const first = client.realtime(
      assistant,
      { assistantId: 1n },
      { handlerKey: "one" },
    );
    expect(() => client.realtime(
      assistant,
      { assistantId: 1n },
      { handlerKey: "two" },
    )).toThrow(RealtimeHandlerKeyConflictError);
    expect(() => client.realtime(
      assistant,
      { assistantId: 1n },
    )).toThrow(RealtimeHandlerKeyConflictError);
    first.release();

    const exclusive = client.realtime(assistant, { assistantId: 1n });
    expect(() => client.realtime(
      assistant,
      { assistantId: 1n },
    )).toThrow(RealtimeHandlerKeyConflictError);
    exclusive.release();
    client.close();
  });

  test("sends typed events and enforces server-advertised stream limits", async () => {
    const { client, peers } = fixture();
    const session = client.realtime(assistant, { assistantId: 1n });
    await eventually(() => session.currentState.phase === "connected");

    expect(session.send("prompt", { text: "hello" })).toBe(true);
    expect(peers[0]!.channel.sent).toHaveLength(1);
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
      .map(decodeRealtimeFrame)
      .find((frame) => frame.t === "signal_description");
    expect(description).toMatchObject({
      t: "signal_description",
      description: { type: "offer", sdp: "v=0\r\nclient-2" },
    });

    session.release();
    client.close();
  });

  test("stops HTTP trickle after ICE completes over the open data channel", async () => {
    const { client, peers, patches } = fixture({ autoIceComplete: false });
    const session = client.realtime(assistant, { assistantId: 1n });
    await eventually(() => session.currentState.phase === "connected");
    await eventually(() => patches() > 0);

    peers[0]!.completeIce();
    await eventually(() =>
      peers[0]!.channel.sent
        .map(decodeRealtimeFrame)
        .some((frame) =>
          frame.t === "signal_candidate" && frame.candidate === null
        )
    );
    await Bun.sleep(150);
    const settled = patches();
    await Bun.sleep(250);
    expect(patches()).toBe(settled);

    session.release();
    client.close();
  });

  test("returns to connected when the native peer recovers from a transient disconnect", async () => {
    const { client, peers } = fixture();
    const phases: string[] = [];
    let connected = 0;
    const session = client.realtime(
      assistant,
      { assistantId: 1n },
      {
        on: {
          connected: () => {
            connected++;
          },
          stateChange: (state) => {
            phases.push(state.phase);
          },
        },
      },
    );
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

  test("replaces a peer that remains disconnected after its ICE restart deadline", async () => {
    const { client, peers, recoveryOffers, closes } = fixture({
      baseDelayMs: 1,
      maxDelayMs: 1,
      disconnectedGraceMs: 1,
      iceRestartTimeoutMs: 1,
    });
    const transcripts: string[] = [];
    let tracks = 0;
    const session = client.realtime(
      assistant,
      { assistantId: 1n },
      {
        on: {
          event: {
            transcript: ({ text }) => transcripts.push(text),
          },
          track: () => {
            tracks++;
          },
        },
      },
    );
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
    expect(recoveryOffers).toEqual([false, true]);
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
      fetch: async (url) => {
        expect(new URL(url).pathname).toBe("/api/realtime/config");
        return new Response(encode({
          v: PROTOCOL_VERSION,
          t: "realtime_config",
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

  test("awaits native media setup before creating the initial offer", async () => {
    const { client, peers, offers } = fixture();
    let finishSetup!: () => void;
    const setup = new Promise<void>((resolve) => {
      finishSetup = resolve;
    });
    const session = client.realtime(
      assistant,
      { assistantId: 1n },
      {
        on: {
          async peerConnection() {
            await setup;
          },
        },
      },
    );

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
});
