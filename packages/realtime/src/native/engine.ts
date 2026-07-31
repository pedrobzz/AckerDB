import type {
  PortableMediaStreamTrack,
  PortableRTCConfiguration,
  PortableRTCPeerConnection,
} from "@ackerdb/core";
import type { RealtimePeerEngine, RealtimePeerLimits } from "../engine.ts";
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
import {
  resolveRealtimeServerNetwork,
  type ResolvedRealtimeServerNetwork,
} from "../network.ts";
import {
  REALTIME_GLOBAL_RESOURCE_DEFAULTS,
  RealtimeGlobalResourceBudget,
} from "../resources.ts";
import { loadNativeBinding } from "./binding.ts";
import { NativeMediaFactory } from "./media.ts";
import {
  createServerPeerConnection,
  NativeTrackOwner,
  normalizeConfiguration,
  ServerMediaStreamTrack,
} from "./peer-connection.ts";

class BundledRealtimeEngine implements RealtimePeerEngine {
  private readonly native;
  private readonly owner;
  private readonly media;

  constructor(
    private readonly network: ResolvedRealtimeServerNetwork,
    resources: RealtimeGlobalResourceBudget,
  ) {
    this.native = new (loadNativeBinding().NativeRtcEngine)({
      ignoredInterfaces: [...network.ignoredInterfaces],
      ignoredAdapterTypes: [...network.ignoredAdapterTypes],
    });
    this.owner = new NativeTrackOwner(this.native, resources);
    this.media = new NativeMediaFactory(this.native, this.owner);
  }

  close(): void {
    this.native.close();
  }

  createPeerConnection(
    configuration: PortableRTCConfiguration = {},
    limits: RealtimePeerLimits = {
      maxDataChannels: 16,
      maxSenders: 32,
      maxTransceivers: 32,
    },
  ): PortableRTCPeerConnection {
    return createServerPeerConnection(
      this.native.createPeerConnection(normalizeConfiguration(
        configuration,
        this.network.nativeConfiguration,
      )),
      this.owner,
      limits,
      this.network.addressMappings,
      this.network.nativeConfiguration,
    );
  }

  createAudioStream(
    track: PortableMediaStreamTrack,
    options?: RealtimeAudioStreamOptions,
  ): RealtimeAudioStream {
    return this.media.audioStream(this.track(track), options);
  }

  createAudioSource(
    options?: RealtimeAudioSourceOptions,
  ): RealtimeAudioSource {
    return this.media.audioSource(options);
  }

  createVideoStream(
    track: PortableMediaStreamTrack,
    options?: RealtimeVideoStreamOptions,
  ): RealtimeVideoStream {
    return this.media.videoStream(this.track(track), options);
  }

  createVideoSource(
    options: RealtimeVideoSourceOptions,
  ): RealtimeVideoSource {
    return this.media.videoSource(options);
  }

  private track(track: PortableMediaStreamTrack): ServerMediaStreamTrack {
    if (!(track instanceof ServerMediaStreamTrack)) {
      throw new TypeError("track belongs to a different WebRTC engine");
    }
    if (!track.belongsTo(this.owner)) {
      throw new TypeError("track belongs to a different WebRTC engine");
    }
    return track;
  }
}

export function createBundledRealtimeEngine(
  network: ResolvedRealtimeServerNetwork = resolveRealtimeServerNetwork(),
  resources = new RealtimeGlobalResourceBudget(
    REALTIME_GLOBAL_RESOURCE_DEFAULTS,
  ),
): RealtimePeerEngine {
  return new BundledRealtimeEngine(network, resources);
}
