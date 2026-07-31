import { writeJsBinding } from "@napi-rs/cli";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
export const WEBRTC_RUNTIME_EXPORTS = [
  "NativeAudioSourceHandle",
  "NativeAudioStreamHandle",
  "NativeDataChannel",
  "NativeGenerationBudget",
  "NativeMediaStream",
  "NativeMediaStreamTrack",
  "NativePeerConnection",
  "NativeRtcEngine",
  "NativeRtpReceiver",
  "NativeRtpSender",
  "NativeRtpTransceiver",
  "NativeTrackEvent",
  "NativeVideoSourceHandle",
  "NativeVideoStreamHandle",
  "nativeAbiVersion",
];

export const WEBRTC_LOADER_REPOSITORY_PATH =
  "packages/realtime/native/webrtc/binding/index.cjs";
export const WEBRTC_LOADER_PATH = join(root, "binding/index.cjs");
export const WEBRTC_LOADER_DECLARATION_PATH = join(
  root,
  "binding/index.d.cts",
);

export async function writeWebRtcLoader(
  version: string,
  outputDir = join(root, "binding"),
): Promise<void> {
  await writeJsBinding({
    platform: true,
    idents: WEBRTC_RUNTIME_EXPORTS,
    jsBinding: "index.cjs",
    binaryName: "ackerdb_webrtc",
    packageName: "@ackerdb/realtime",
    version,
    outputDir,
  });
}
