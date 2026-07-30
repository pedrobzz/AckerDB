import { expect, test } from "bun:test";
import type {
  NativeMediaStreamTrackBinding,
  NativeRtcEngineBinding,
} from "../../src/realtime/native/binding.ts";
import {
  createServerPeerConnection,
  NativeTrackOwner,
} from "../../src/realtime/native/peer-connection.ts";
import type {
  NativePeerConnectionBinding,
} from "../../src/realtime/native/binding.ts";
import {
  REALTIME_GLOBAL_RESOURCE_DEFAULTS,
  RealtimeGlobalResourceBudget,
} from "../../src/realtime/resources.ts";

function nativeTrack(
  identity: bigint,
  id = "provider-track",
): NativeMediaStreamTrackBinding & { readonly stops: { count: number } } {
  const stops = { count: 0 };
  return {
    identity,
    id,
    kind: "audio",
    enabled: true,
    readyState: "live",
    stops,
    stop: () => {
      stops.count++;
    },
  };
}

test("native track ownership uses physical identity instead of public track ID", () => {
  const resources = new RealtimeGlobalResourceBudget({
    ...REALTIME_GLOBAL_RESOURCE_DEFAULTS,
    maxTracks: 2,
  });
  const owner = new NativeTrackOwner(
    {} as NativeRtcEngineBinding,
    resources,
  );
  const firstNative = nativeTrack(1n);
  const secondNative = nativeTrack(2n);
  const first = owner.wrapTrack(firstNative, owner.createScope());
  const repeated = owner.wrapTrack(
    { ...firstNative },
    owner.createScope(),
  );
  const second = owner.wrapTrack(secondNative, owner.createScope());

  expect(repeated).toBe(first);
  expect(second).not.toBe(first);
  expect(resources.snapshot().active.tracks).toBe(2);

  first.stop();
  expect(firstNative.stops.count).toBe(1);
  expect(secondNative.stops.count).toBe(0);
  expect(second.readyState).toBe("live");
  expect(resources.snapshot().active.tracks).toBe(1);

  second.stop();
  expect(resources.snapshot().active.tracks).toBe(0);
});

test("setConfiguration preserves deployment-owned network policy", () => {
  let configured: unknown;
  const native = {
    connectionState: "new",
    iceConnectionState: "new",
    signalingState: "stable",
    droppedEvents: 0n,
    getConfiguration: () => ({}),
    setConfiguration: (value: unknown) => {
      configured = value;
    },
    nextEvent: async () => undefined,
    close: () => {},
  } as unknown as NativePeerConnectionBinding;
  const resources = new RealtimeGlobalResourceBudget(
    REALTIME_GLOBAL_RESOURCE_DEFAULTS,
  );
  const peer = createServerPeerConnection(
    native,
    new NativeTrackOwner({} as NativeRtcEngineBinding, resources),
    { maxDataChannels: 2, maxSenders: 2, maxTransceivers: 2 },
    [],
    {
      minPort: 40_000,
      maxPort: 40_999,
      iceUnwritableTimeoutMs: 5_000,
    },
  );

  peer.setConfiguration({
    iceServers: [{ urls: "turn:relay.example.test" }],
  });

  expect(configured).toEqual({
    minPort: 40_000,
    maxPort: 40_999,
    iceUnwritableTimeoutMs: 5_000,
    iceServers: [{
      urls: ["turn:relay.example.test"],
    }],
    iceTransportPolicy: "all",
  });
  peer.close();
});
