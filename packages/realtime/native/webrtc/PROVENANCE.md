# WebRTC native provenance

AckerDB’s server addon is a focused N-API boundary over LiveKit’s low-level
Rust `libwebrtc` and `webrtc-sys` crates. It is not a LiveKit server, room, SFU,
or client wrapper.

## Pinned inputs

- Rust toolchain: `1.94.0`.
- Bun: `1.3.14`.
- LiveKit Rust SDK source commit:
  `06371a336d485cf6b51c75a3fee3d208f8f2eedb`. Both published crates below
  carry this value in `.cargo_vcs_info.json`; it is also the object behind
  tags `libwebrtc/v0.3.43` and `webrtc-sys/v0.3.40`.
- Published `libwebrtc` crate `0.3.43`, SHA-256
  `69e6f1851a15d193e5416411fde4d371204f298c5126ee8a4ad68aedd7b22993`,
  downloaded from crates.io and patched by `patches/libwebrtc.patch`.
- Published `webrtc-sys` crate `0.3.40`, SHA-256
  `6b9ff39cb40280566a5c53e1ca93a79f2bf5839a2ef8b7792972a330f967d1e1`,
  downloaded from crates.io and patched by `patches/webrtc-sys.patch`.
- LiveKit libwebrtc binary release: `webrtc-51ef663`.
- The five accepted archive SHA-256 digests are owned and verified by
  `build.ts` before extraction.

The crates were selected from the LiveKit Rust SDK repository under the
Apache-2.0 license. The build downloads their exact published archives,
verifies both AckerDB-owned digests, and applies the two narrow committed
patches before Cargo resolves the local sources. The native libwebrtc archives
are produced by that same repository from Google WebRTC and carry their
upstream license corpus.

A fresh comparison with the two digest-verified crate archives must report
only the files in the table below; the functional source delta is exhausted by
the two patch files.

## Complete AckerDB patch inventory

AckerDB keeps the two patches because its small server boundary requires
upstream functionality that the published crates do not expose:

| Vendored file | AckerDB delta |
| --- | --- |
| `libwebrtc/src/native/peer_connection.rs` | Carry the configured UDP range and ICE timing values into `webrtc-sys`; expose the complete native stats JSON without losing unknown report fields. |
| `libwebrtc/src/peer_connection.rs` | Expose the complete native stats JSON on the public Rust wrapper. |
| `libwebrtc/src/native/peer_connection_factory.rs` | Construct a factory with ignored interfaces and a network-ignore mask; clone an audio or video track from its native source. |
| `libwebrtc/src/peer_connection_factory.rs` | Add the network policy, UDP range, ICE timing, and media-track clone surface to the public Rust wrapper. |
| `libwebrtc/src/media_stream_track.rs` | Expose the stable native track pointer identity required to preserve JavaScript wrapper and resource ownership identity even when public track IDs collide. |
| `libwebrtc/src/native/rtp_receiver.rs` | Expose stable native receiver identity and complete native receiver stats JSON; turn malformed JSON into an error instead of panicking. |
| `libwebrtc/src/rtp_receiver.rs` | Expose native identity and complete receiver stats JSON on the public Rust wrapper. |
| `libwebrtc/src/native/rtp_sender.rs` | Expose stable native sender identity and complete native sender stats JSON; turn malformed JSON into an error instead of panicking. |
| `libwebrtc/src/rtp_sender.rs` | Expose native identity and complete sender stats JSON on the public Rust wrapper. |
| `libwebrtc/src/rtp_parameters.rs` | Expose the opaque transaction ID read-only so AckerDB can verify faithful `getParameters()`/`setParameters()` round trips. |
| `libwebrtc/src/native/rtp_transceiver.rs` | Expose stable native transceiver identity and native direction mutation. |
| `libwebrtc/src/rtp_transceiver.rs` | Expose native identity and transceiver direction mutation on the public Rust wrapper. |
| `webrtc-sys/include/livekit/media_stream_track.h` | Declare stable identity for the underlying libwebrtc media-track interface rather than the short-lived LiveKit wrapper. |
| `webrtc-sys/include/livekit/peer_connection_factory.h` | Declare the network-aware factory and native audio/video track clone operations. |
| `webrtc-sys/include/livekit/rtp_receiver.h` | Declare stable identity for the underlying libwebrtc RTP receiver. |
| `webrtc-sys/include/livekit/rtp_sender.h` | Declare stable identity for the underlying libwebrtc RTP sender. |
| `webrtc-sys/include/livekit/rtp_transceiver.h` | Declare stable identity for the underlying libwebrtc RTP transceiver. |
| `webrtc-sys/src/media_stream_track.cpp` | Return the underlying libwebrtc media-track pointer as its process-local identity. |
| `webrtc-sys/src/media_stream_track.rs` | Carry media-track identity across the C++/Rust bridge. |
| `webrtc-sys/src/peer_connection.cpp` | Apply the UDP range and ICE timing fields to libwebrtc’s `RTCConfiguration`. |
| `webrtc-sys/src/peer_connection.rs` | Carry the UDP range and ICE timing fields across the Rust/C++ bridge. |
| `webrtc-sys/src/peer_connection_factory.cpp` | Install libwebrtc’s interface ignore list and adapter mask before factory creation; clone native audio/video tracks from their sources. |
| `webrtc-sys/src/peer_connection_factory.rs` | Carry factory network policy and track-clone calls across the Rust/C++ bridge. |
| `webrtc-sys/src/rtp_receiver.cpp` | Return the underlying libwebrtc RTP-receiver pointer as its process-local identity. |
| `webrtc-sys/src/rtp_receiver.rs` | Carry RTP-receiver identity across the C++/Rust bridge. |
| `webrtc-sys/src/rtp_sender.cpp` | Return the underlying libwebrtc RTP-sender pointer as its process-local identity. |
| `webrtc-sys/src/rtp_sender.rs` | Carry RTP-sender identity across the C++/Rust bridge. |
| `webrtc-sys/src/rtp_transceiver.cpp` | Return the underlying libwebrtc RTP-transceiver pointer as its process-local identity. |
| `webrtc-sys/src/rtp_transceiver.rs` | Carry RTP-transceiver identity across the C++/Rust bridge. |

The addon itself adds N-API ownership, observable bounded event queues, media
source and decoded-stream budgets, type conversion, and deterministic close
behavior. Patches stay narrow and preserve libwebrtc’s native congestion
control, codecs, jitter buffers, packet-loss recovery, and synchronization.

The root native `Cargo.toml` resolves `libwebrtc` and `webrtc-sys` to the
verified, patched build cache. This is build wiring rather than an upstream
source delta.

## Refresh and removal condition

Refresh the source commit, both published crate archives, and the libwebrtc
binary release together. Verify the crate SHA-256 values and
`.cargo_vcs_info.json`, compare every inventory row with the new upstream
source before carrying it, rebuild all advertised targets, update archive
digests, regenerate the package manifest/SBOM, and execute the native suite on
Darwin arm64.

Delete a patch as soon as the pinned published LiveKit crate exposes
the required behavior with the same ownership and error semantics. Stop
patching a crate entirely when AckerDB can consume the digest-pinned published
revision without losing the required server API.
