export const NATIVE_ABI = 6;
export const LIVEKIT_REPOSITORY = "https://github.com/livekit/rust-sdks";
export const LIVEKIT_RUST_SDKS_REVISION =
  "06371a336d485cf6b51c75a3fee3d208f8f2eedb";
export const LIBWEBRTC_CRATE_VERSION = "0.3.43";
export const LIBWEBRTC_CRATE_SHA256 =
  "69e6f1851a15d193e5416411fde4d371204f298c5126ee8a4ad68aedd7b22993";
export const WEBRTC_SYS_CRATE_VERSION = "0.3.40";
export const WEBRTC_SYS_CRATE_SHA256 =
  "6b9ff39cb40280566a5c53e1ca93a79f2bf5839a2ef8b7792972a330f967d1e1";
export const LIBWEBRTC_TAG = "webrtc-51ef663";

export const WEBRTC_TARGETS = Object.freeze([
  Object.freeze({
    target: "darwin-arm64",
    archive: "webrtc-mac-arm64-release.zip",
    archiveSha256:
      "f9be49b9fee9cd1588da8a40c85bda21f5ea49c4ed82662dc889b1c919569a08",
  }),
  Object.freeze({
    target: "darwin-x64",
    archive: "webrtc-mac-x64-release.zip",
    archiveSha256:
      "171f1ba0866e5947e0d420ecc1c33814476e1919131b81bb87c8729d45d72127",
  }),
  Object.freeze({
    target: "linux-arm64",
    archive: "webrtc-linux-arm64-release.zip",
    archiveSha256:
      "b55ca62c28b18dc5bb720a7082ae468d78f213ca39bcccf84195f2fe58cfe713",
  }),
  Object.freeze({
    target: "linux-x64",
    archive: "webrtc-linux-x64-release.zip",
    archiveSha256:
      "dce9d9414cd8e2cc9a471c054481851b257ad2a879112ce5be56369b4fefdaed",
  }),
  Object.freeze({
    target: "win32-x64",
    archive: "webrtc-win-x64-release.zip",
    archiveSha256:
      "0a56a5c91b3b7b4222082b8a09388d16a802cde22d67295beb24c55700755b30",
  }),
] as const);

export type WebRtcTarget = (typeof WEBRTC_TARGETS)[number]["target"];

export function webRtcTarget(
  target: string,
): (typeof WEBRTC_TARGETS)[number] {
  const definition = WEBRTC_TARGETS.find((candidate) =>
    candidate.target === target
  );
  if (definition === undefined) {
    throw new Error(`AckerDB has no verified libwebrtc archive for ${target}`);
  }
  return definition;
}
