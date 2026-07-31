export const NATIVE_ABI = 6;
export const ACKERDB_LIBWEBRTC_REPOSITORY =
  "https://github.com/pedrobzz/ackerdb-libwebrtc";
export const ACKERDB_LIBWEBRTC_REVISION =
  "e36dad0cbc6fcbf833b98286600823f1e1538244";
export const LIVEKIT_NATIVE_REPOSITORY =
  "https://github.com/livekit/rust-sdks";
export const LIVEKIT_UPSTREAM_REVISION =
  "06371a336d485cf6b51c75a3fee3d208f8f2eedb";
export const LIBWEBRTC_TAG = "webrtc-51ef663";

export const WEBRTC_TARGETS = Object.freeze([
  Object.freeze({
    host: "darwin-arm64",
    rustTarget: "aarch64-apple-darwin",
    platformArchABI: "darwin-arm64",
    packageName: "@ackerdb/realtime-darwin-arm64",
    archive: "webrtc-mac-arm64-release.zip",
    archiveSha256:
      "f9be49b9fee9cd1588da8a40c85bda21f5ea49c4ed82662dc889b1c919569a08",
  }),
  Object.freeze({
    host: "darwin-x64",
    rustTarget: "x86_64-apple-darwin",
    platformArchABI: "darwin-x64",
    packageName: "@ackerdb/realtime-darwin-x64",
    archive: "webrtc-mac-x64-release.zip",
    archiveSha256:
      "171f1ba0866e5947e0d420ecc1c33814476e1919131b81bb87c8729d45d72127",
  }),
  Object.freeze({
    host: "linux-arm64",
    rustTarget: "aarch64-unknown-linux-gnu",
    platformArchABI: "linux-arm64-gnu",
    packageName: "@ackerdb/realtime-linux-arm64-gnu",
    archive: "webrtc-linux-arm64-release.zip",
    archiveSha256:
      "b55ca62c28b18dc5bb720a7082ae468d78f213ca39bcccf84195f2fe58cfe713",
  }),
  Object.freeze({
    host: "linux-x64",
    rustTarget: "x86_64-unknown-linux-gnu",
    platformArchABI: "linux-x64-gnu",
    packageName: "@ackerdb/realtime-linux-x64-gnu",
    archive: "webrtc-linux-x64-release.zip",
    archiveSha256:
      "dce9d9414cd8e2cc9a471c054481851b257ad2a879112ce5be56369b4fefdaed",
  }),
  Object.freeze({
    host: "win32-x64",
    rustTarget: "x86_64-pc-windows-msvc",
    platformArchABI: "win32-x64-msvc",
    packageName: "@ackerdb/realtime-win32-x64-msvc",
    archive: "webrtc-win-x64-release.zip",
    archiveSha256:
      "0a56a5c91b3b7b4222082b8a09388d16a802cde22d67295beb24c55700755b30",
  }),
] as const);

export type WebRtcHost = (typeof WEBRTC_TARGETS)[number]["host"];

export function webRtcTarget(
  host: string,
): (typeof WEBRTC_TARGETS)[number] {
  const definition = WEBRTC_TARGETS.find((candidate) =>
    candidate.host === host
  );
  if (definition === undefined) {
    throw new Error(`AckerDB has no verified libwebrtc archive for ${host}`);
  }
  return definition;
}
