import { createRequire } from "node:module";
import type * as Generated from "../../native/webrtc/binding/index.cjs";

export type NativeIceServerBinding = Generated.NativeIceServer;
export type NativeRtcConfigurationBinding = Generated.NativeRtcConfiguration;
export type NativeSessionDescriptionBinding =
  Generated.NativeSessionDescription;
export type NativeIceCandidateBinding = Generated.NativeIceCandidate;
export type NativePeerEventBinding = Generated.NativePeerEvent;
export type NativeDataChannelEventBinding = Generated.NativeDataChannelEvent;
export type NativeMediaStreamTrackBinding = Generated.NativeMediaStreamTrack;
export type NativeMediaStreamBinding = Generated.NativeMediaStream;
export type NativeRtpSenderBinding = Generated.NativeRtpSender;
export type NativeRtpReceiverBinding = Generated.NativeRtpReceiver;
export type NativeRtpEncodingParametersBinding =
  Generated.NativeRtpEncodingParameters;
export type NativeRtpCodecParametersBinding =
  Generated.NativeRtpCodecParameters;
export type NativeRtpHeaderExtensionParametersBinding =
  Generated.NativeRtpHeaderExtensionParameters;
export type NativeRtcpParametersBinding = Generated.NativeRtcpParameters;
export type NativeRtpParametersBinding = Generated.NativeRtpParameters;
export type NativeRtpCodecCapabilityBinding =
  Generated.NativeRtpCodecCapability;
export type NativeRtpHeaderExtensionCapabilityBinding =
  Generated.NativeRtpHeaderExtensionCapability;
export type NativeRtpCapabilitiesBinding = Generated.NativeRtpCapabilities;
export type NativeRtpTransceiverBinding = Generated.NativeRtpTransceiver;
export type NativeTrackEventBinding = Generated.NativeTrackEvent;
export type NativeDataChannelBinding = Generated.NativeDataChannel;
export type NativePeerConnectionBinding = Generated.NativePeerConnection;
export type NativeAudioSourceBinding = Generated.NativeAudioSourceHandle;
export type NativeAudioStreamBinding = Generated.NativeAudioStreamHandle;
export type NativeVideoSourceBinding = Generated.NativeVideoSourceHandle;
export type NativeVideoStreamBinding = Generated.NativeVideoStreamHandle;
export type NativeGenerationBudgetBinding = Generated.NativeGenerationBudget;
export type NativeRtcEngineBinding = Generated.NativeRtcEngine;

type NativeBinding = typeof import(
  "../../native/webrtc/binding/index.cjs"
);

let loaded: NativeBinding | undefined;

export function loadNativeBinding(): NativeBinding {
  if (loaded !== undefined) return loaded;
  const target = `${process.platform}-${process.arch}`;
  try {
    const binding = createRequire(import.meta.url)(
      "../../native/webrtc/binding/index.cjs",
    ) as NativeBinding;
    if (binding.nativeAbiVersion() !== 6) {
      throw new Error("unsupported native WebRTC ABI");
    }
    loaded = binding;
    return binding;
  } catch (cause) {
    throw new Error(
      `AckerDB has no usable WebRTC engine for ${target}. ` +
        "Ensure optional dependencies are installed, or run " +
        "`bun run build:webrtc` in a source checkout.",
      { cause },
    );
  }
}
