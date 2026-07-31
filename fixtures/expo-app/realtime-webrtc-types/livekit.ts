import {
  RTCPeerConnection,
  mediaDevices,
} from "@livekit/react-native-webrtc";
import {
  AckerDBClient,
  type AckerDBPeerConnectionFactory,
  type AckerDBRealtimeOn,
} from "@ackerdb/client";
import type { EventMap, RealtimeStreamMap } from "@ackerdb/core";

type ServerEvents = {
  readonly transcript: { readonly text: string };
};

type ServerStreams = RealtimeStreamMap;

const createPeerConnection: AckerDBPeerConnectionFactory = (configuration) =>
  new RTCPeerConnection(configuration);

const client = new AckerDBClient({
  url: "https://ackerdb.example.test",
  credential: { kind: "anonymous" },
  createPeerConnection,
});

const on: AckerDBRealtimeOn<ServerEvents & EventMap, ServerStreams> = {
  async peerConnection(peer) {
    const local = await mediaDevices.getUserMedia({ audio: true, video: true });
    const track = local.getAudioTracks()[0];
    if (track !== undefined) {
      const sender = peer.addTrack(track, local);
      await sender.replaceTrack(track);
    }

    for (const sender of peer.getSenders()) {
      await sender.replaceTrack(sender.track);
    }
    for (const receiver of peer.getReceivers()) receiver.getParameters();
    for (const transceiver of peer.getTransceivers()) {
      transceiver.direction = "recvonly";
    }

    // AckerDB has already reserved its typed-event channel before this hook.
    // This ordinary channel remains owned by the application.
    const applicationChannel = peer.createDataChannel("application", {
      ordered: true,
    });
    applicationChannel.send("hello");
    const received = (event: { readonly data: unknown }) => {
      void event.data;
    };
    applicationChannel.addEventListener("message", received);
    applicationChannel.removeEventListener("message", received);
    const connectionChanged = (event: { readonly type: string }) => {
      void event.type;
    };
    peer.addEventListener("connectionstatechange", connectionChanged);
    peer.removeEventListener("connectionstatechange", connectionChanged);

    const stats = await peer.getStats();
    stats.forEach((stat) => stat.type);
    stats.get("transport")?.type;
    for (const stat of stats.values()) void stat.type;
    return () => local.getTracks().forEach((mediaTrack) => mediaTrack.stop());
  },
  track(event) {
    if (event.track !== null) event.track.enabled = true;
    if (event.receiver !== null) event.receiver.getParameters();
    event.streams.forEach((stream) => stream.getTracks());
    event.transceiver.direction = "sendrecv";
  },
};

void [client, on];
