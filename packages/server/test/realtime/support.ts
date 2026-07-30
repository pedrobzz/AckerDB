import type {
  NativeRTCConfiguration,
  NativeRTCPeerConnection,
  PortableRTCPeerConnection,
} from "@ackerdb/core";
import type { RealtimePeerEngine } from "../../src/realtime/engine.ts";

function unused(): never {
  throw new Error("unexpected realtime media operation");
}

export function testRealtimeEngine(
  createPeerConnection: (
    configuration?: NativeRTCConfiguration,
  ) => NativeRTCPeerConnection,
): RealtimePeerEngine {
  return {
    close: () => {},
    createPeerConnection: (configuration) =>
      createPeerConnection(
        configuration as NativeRTCConfiguration,
      ) as unknown as PortableRTCPeerConnection,
    createAudioStream: unused,
    createAudioSource: unused,
    createVideoStream: unused,
    createVideoSource: unused,
  };
}
