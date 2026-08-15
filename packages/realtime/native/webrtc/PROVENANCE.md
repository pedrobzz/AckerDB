# WebRTC native provenance

AckerDB’s realtime native addon is a focused N-API boundary over its maintained
`ackerdb-libwebrtc` Rust/C++ source, derived from LiveKit’s proven low-level
bindings. It is not a LiveKit server, room, SFU, or client wrapper.

## Pinned inputs

- Rust toolchain: `1.94.0`.
- Bun: `1.3.14`.
- AckerDB binding source:
  [`pedrobzz/ackerdb-libwebrtc`](https://github.com/pedrobzz/ackerdb-libwebrtc)
  at immutable commit `e36dad0cbc6fcbf833b98286600823f1e1538244`.
- LiveKit upstream base:
  [`livekit/rust-sdks`](https://github.com/livekit/rust-sdks) commit
  `06371a336d485cf6b51c75a3fee3d208f8f2eedb`, the object behind tags
  `libwebrtc/v0.3.43` and `webrtc-sys/v0.3.40`.
- Native Google libwebrtc build: LiveKit release `webrtc-51ef663`. The five
  accepted archive names and SHA-256 digests are defined in `provenance.ts`
  and verified by `build.ts` before extraction.

`Cargo.toml` consumes the fork by full Git commit, so Cargo resolves
`libwebrtc` and its sibling workspace dependencies from one immutable source
checkout. AckerDB does not stage LiveKit crates.io source archives, apply local
patch files, or vendor the LiveKit repository. The fork’s commits are the
canonical reviewable source delta from the recorded LiveKit base; source tags
and releases are navigation aids, not dependency pins.

The fork carries only the binding behavior required by the server boundary:

- complete native stats JSON with malformed JSON returned as an error;
- deployment-owned interface filters, adapter masks, UDP ranges, and ICE
  timing values;
- native audio/video track cloning and process-local identity for tracks,
  senders, receivers, and transceivers;
- RTP transaction identity and transceiver direction mutation; and
- bounded decoded audio/video streams with native dropped-frame counters,
  whole-10-ms audio admission, and deterministic clear/close across source
  clones.

These are Rust and C++ binding changes. They do not modify or rebuild the
Google WebRTC engine. The target-specific native archives remain independent,
digest-pinned inputs built and published by LiveKit from Google WebRTC. They
carry the upstream native license corpus and are paired with the pinned fork
revision only after AckerDB’s build and runtime verification.

The addon itself owns N-API conversion and lifetime, bounded event queues,
media-source and decoded-stream budgets, and deterministic close behavior. It
continues to use libwebrtc’s congestion control, codecs, jitter buffers,
packet-loss recovery, and synchronization.

`@ackerdb/realtime` contains the NAPI-RS generated loader and declarations but
no native binary. Five optional `@ackerdb/realtime-*` packages each own one
target binary, target manifest, notices, provenance record, and license
corpus. Their npm host metadata selects Darwin arm64/x64, Linux GNU arm64/x64,
or Windows x64 at install time. Stable and prerelease publication assemble and
verify all five packages before publishing any unit.

The candidate checks the locked Cargo graph with `cargo-deny`; each target then
emits third-party Rust notices with `cargo-about`. The verified `LICENSE.md` from the target's native archive is
the packaged Google WebRTC license evidence. The target manifest binds those
inputs to the binary, Rust-source digest, and generated loader digests.

Stable candidates are packed before their detached candidate manifest is
written. That manifest records the clean AckerDB commit and binds every target
manifest and final tarball digest; verification re-reads the package bytes,
proves the root package has no native binary, and checks that all target
manifests attest the same generated loader.

## Verification and refresh

The fork workflow formats and checks its source across every AckerDB target and
runs its Rust tests on Darwin arm64. AckerDB’s native workflow then builds the
addon for Darwin arm64/x64, Linux arm64/x64, and Windows x64, assembles the
verified package, and runs native and exact-packed runtime tests on Darwin
arm64.

To refresh the binding source, start from an explicit LiveKit upstream commit,
reapply only still-required behavior as ordinary fork commits, pass the fork
workflow, and pin the resulting full commit in AckerDB. Update this record and the
package manifest with both the new fork revision and its upstream base. Delete fork code when upstream provides the same ownership and error
semantics; do not restore local patches or a compatibility path.

Refresh a native archive deliberately and separately: verify the official
LiveKit release asset digest, update the accepted digest, rebuild every
advertised target, regenerate the package manifest, and execute the native
suite. The binding source revision and native binary tag are distinct
inputs; every supported pair must pass the complete AckerDB boundary above.
