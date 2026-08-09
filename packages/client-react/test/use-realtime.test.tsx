import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  encode,
  encodeRealtimeEvent,
  type RealtimeRef,
} from "@ackerdb/core";
import type {
  AckerDBWebSocket,
} from "@ackerdb/client";
import {
  AckerDBProvider,
  useRealtime,
  type AckerDBProviderConfig,
  type UseRealtimeResult,
} from "@ackerdb/client-react";
import { StrictMode, act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { actEnvironment, mountPoint } from "ackerdb-test-support/dom";

class FakeSocket implements AckerDBWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(): void {}
  close(): void {}
}

class FakeDataChannel extends EventTarget {
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState: RTCDataChannelState = "connecting";
  send(): void {}

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
  iceConnectionState: RTCIceConnectionState = "new";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescription | null = null;

  createDataChannel(): RTCDataChannel {
    return this.channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "v=0\r\nclient" };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "v=0\r\nclient" };
  }

  async setLocalDescription(value: RTCLocalSessionDescriptionInit): Promise<void> {
    this.localDescription = value as RTCSessionDescription;
    queueMicrotask(() => {
      const event = new Event("icecandidate");
      Object.defineProperty(event, "candidate", { value: null });
      this.dispatchEvent(event);
    });
  }

  async setRemoteDescription(): Promise<void> {
    queueMicrotask(() => {
      this.connectionState = "connected";
      this.dispatchEvent(new Event("connectionstatechange"));
      this.channel.open();
    });
  }

  async addIceCandidate(): Promise<void> {}

  restartIce(): void {}

  close(): void {
    this.connectionState = "closed";
  }
}

type Assistant = RealtimeRef<
  { readonly assistantId: bigint },
  {},
  { readonly transcript: { readonly text: string } },
  {},
  {},
  never
>;

const assistant = { $ref: "api.assistant.live" } as Assistant;
const results = new Map<string, UseRealtimeResult<Assistant>>();

interface ProbeProps {
  readonly id: string;
  readonly onTranscript: (text: string) => void;
}

function Probe({ id, onTranscript }: ProbeProps): ReactNode {
  const result = useRealtime(assistant, { assistantId: 1n }, {
    on: {
      event: {
        transcript: ({ text }) => onTranscript(text),
      },
    },
  });
  results.set(id, result);
  return <span>{id}:{result.state.phase};</span>;
}

function app(
  config: AckerDBProviderConfig,
  probes: readonly ProbeProps[],
): ReactNode {
  return (
    <AckerDBProvider config={config}>
      <StrictMode>
        {probes.map((probe) => <Probe key={probe.id} {...probe} />)}
      </StrictMode>
    </AckerDBProvider>
  );
}

async function render(root: Root, value: ReactNode): Promise<void> {
  await act(async () => {
    root.render(value);
  });
}

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await act(async () => {
      await Bun.sleep(1);
    });
  }
}

beforeAll(() => actEnvironment(true));
afterAll(() => actEnvironment(false));

describe("useRealtime", () => {
  test("retains one peer and broadcasts through independently owned hook observations", async () => {
    const peers: FakePeerConnection[] = [];
    let offers = 0;
    let releases = 0;
    let patches = 0;
    const config: AckerDBProviderConfig = {
      url: "https://react-realtime.test",
      credential: { kind: "anonymous" },
      clientSessionId: "react-realtime-session",
      random: () => 0,
      createWebSocket: () => new FakeSocket(),
      createPeerConnection: () => {
        const peer = new FakePeerConnection();
        peers.push(peer);
        return peer as unknown as RTCPeerConnection;
      },
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        if (path === "/_realtime/prepare" && init?.method === "POST") {
          return new Response(encode({
            v: PROTOCOL_VERSION,
            t: "realtime_prepared",
            ticket: "A".repeat(43),
            configuration: {},
          }));
        }
        if (path === "/_realtime" && init?.method === "POST") {
          offers++;
          return new Response(encode({
            v: PROTOCOL_VERSION,
            t: "realtime_answer",
            sessionId: "abcdefghijklmnopqrstuvwxyzABCDEF",
            answer: { type: "answer", sdp: "v=0\r\nserver" },
            streamLimits: { client: {}, server: {} },
            candidates: [],
            complete: true,
          }));
        }
        if (init?.method === "PATCH") {
          patches++;
          return new Response(encode({
            v: PROTOCOL_VERSION,
            t: "realtime_candidates",
            candidates: [],
            complete: true,
          }));
        }
        if (init?.method === "DELETE") {
          releases++;
          return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected request ${init?.method ?? "GET"} ${path}`);
      },
    };
    const root = createRoot(mountPoint());
    const calls: string[] = [];
    const messages = (text: string) => calls.push(`messages:${text}`);
    const composer = (text: string) => calls.push(`composer:${text}`);
    const updatedComposer = (text: string) => calls.push(`updated:${text}`);

    await render(root, app(config, [
      { id: "messages", onTranscript: messages },
      { id: "composer", onTranscript: composer },
    ]));
    await eventually(() => results.get("messages")?.state.phase === "connected");
    expect(peers).toHaveLength(1);
    expect(offers).toBe(1);
    // This fake opens its data channel during setRemoteDescription(). The
    // initial HTTP answer still owns signaling until that await completes.
    expect(patches).toBe(0);
    expect(results.get("messages")?.peerConnection).toBe(
      results.get("composer")?.peerConnection,
    );

    await act(async () => {
      peers[0]!.channel.receive(encodeRealtimeEvent("transcript", {
        text: "one",
      }));
    });
    await eventually(() => calls.length === 2);
    expect(calls).toEqual(["messages:one", "composer:one"]);

    await render(root, app(config, [
      { id: "composer", onTranscript: updatedComposer },
    ]));
    await act(async () => {});
    expect(peers).toHaveLength(1);

    await act(async () => {
      peers[0]!.channel.receive(encodeRealtimeEvent("transcript", {
        text: "two",
      }));
    });
    await eventually(() => calls.length === 3);
    expect(calls).toEqual(["messages:one", "composer:one", "updated:two"]);

    await act(async () => root.unmount());
    expect(peers[0]!.connectionState).toBe("closed");
    expect(releases).toBe(1);
  });
});
