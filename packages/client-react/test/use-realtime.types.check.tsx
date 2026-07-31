// Compile-time contract for useRealtime: one generated reference derives the
// complete handler namespace, lifecycle state, events, and finite streams.
import type {
  ApplicationError,
  RealtimeRef,
} from "@ackerdb/core";
import type { AckerDBPeerConnectionFactory } from "@ackerdb/client";
import {
  skip,
  useRealtime,
  type RealtimeOn,
  type UseRealtimeOptions,
} from "@ackerdb/client-react";

type AssistantRejected = ApplicationError<
  "assistant_missing",
  { readonly assistantId: bigint },
  404
>;

const browserPeerConnection: AckerDBPeerConnectionFactory = (configuration) =>
  new RTCPeerConnection(configuration);

declare const assistant: RealtimeRef<
  { readonly assistantId: bigint },
  {
    readonly prompt: { readonly text: string };
    readonly cancel: {};
  },
  {
    readonly transcript: { readonly text: string; readonly final: boolean };
    readonly usage: { readonly tokens: number };
  },
  {
    readonly photo: { readonly contentType: "image/jpeg" };
  },
  {
    readonly audio: { readonly contentType: "audio/pcm"; readonly rate: number };
  },
  AssistantRejected
>;

const mapped: RealtimeOn<typeof assistant> = {
  peerConnection(peer) {
    peer.addTransceiver("audio");
    peer.createDataChannel("application", { ordered: true }).send("hello");
    void peer.getStats();
  },
  connected(peer) {
    peer.restartIce();
  },
  track(event) {
    if (event.track !== null) event.track.enabled = true;
    event.receiver?.getParameters();
    event.transceiver.direction = "sendrecv";
  },
  event: {
    transcript(value) {
      const text: string = value.text;
      const final: boolean = value.final;
      void [text, final];
    },
    usage(value) {
      const tokens: number = value.tokens;
      void tokens;
    },
  },
  stream: {
    audio(input) {
      const type: "audio/pcm" = input.metadata.contentType;
      const rate: number = input.metadata.rate;
      const bytes: ReadableStream<Uint8Array> = input.readable;
      void [type, rate, bytes];
    },
  },
  stateChange(state) {
    if (state.phase === "rejected") {
      const code: "assistant_missing" = state.error.code;
      const id: bigint = state.error.body.assistantId;
      void [code, id];
    }
  },
};

const union: RealtimeOn<typeof assistant> = {
  async peerConnection(peer) {
    await Promise.resolve();
    peer.addTransceiver("video");
    return () => {};
  },
  event(event) {
    if (event.type === "transcript") {
      const text: string = event.payload.text;
      void text;
    } else {
      const tokens: number = event.payload.tokens;
      void tokens;
    }
  },
  stream(input) {
    const type: "audio" = input.type;
    const rate: number = input.metadata.rate;
    void [type, rate];
  },
};

interface UseAssistantInput {
  readonly on?: RealtimeOn<typeof assistant>;
}

function useAssistant(input: UseAssistantInput = {}) {
  return useRealtime(assistant, { assistantId: 1n }, {
    handlerKey: "useAssistant",
    on: input.on,
  });
}

function Consumer() {
  const session = useAssistant({ on: mapped });
  session.send("prompt", { text: "hello" });
  session.send("cancel", {});
  session.openStream("photo", { contentType: "image/jpeg" }, {
    size: 1024,
  });
  const peer = session.peerConnection;
  peer?.addTransceiver("audio");
  if (session.state.phase === "connected") {
    session.state.peerConnection.addTransceiver("audio");
  }
  useRealtime(assistant, { assistantId: 2n }, { on: union });
  useRealtime(assistant, skip);
  void peer;
  return null;
}

const options: UseRealtimeOptions<typeof assistant> = {
  handlerKey: "useAssistant",
  on: mapped,
};
void options;
void browserPeerConnection;

// @ts-expect-error arguments come from the realtime declaration
useRealtime(assistant, { assistantId: "one" });
const result = useRealtime(assistant, { assistantId: 1n });
// @ts-expect-error client event names are exact
result.send("transcript", { text: "wrong", final: true });
// @ts-expect-error client event payloads are exact
result.send("prompt", { text: 1 });
// @ts-expect-error client stream names are exact
result.openStream("audio", { contentType: "audio/pcm", rate: 24_000 });
// @ts-expect-error client stream metadata is inferred
result.openStream("photo", { contentType: "image/png" });
const badOn: RealtimeOn<typeof assistant> = {
  event: {
    // @ts-expect-error server event payloads are inferred in handler maps
    transcript: (value: { readonly text: number }) => value,
  },
};

export { Consumer };
