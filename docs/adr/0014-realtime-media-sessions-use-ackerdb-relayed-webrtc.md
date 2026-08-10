# Realtime media sessions use AckerDB-relayed WebRTC

- Status: accepted
- Date: 2026-07-28

## Context

AckerDB must support voice, video, camera frames, typed messages, finite binary
transfers, provider bridges, and custom realtime systems without forcing an
application to operate another backend. WebSocket application channels remain
appropriate for typed text and base64-encoded bytes, but they do not replace
WebRTC's media transport, congestion control, codecs, jitter handling, or track
model.

The public API must remain familiar to developers migrating from browser,
React Native, or server WebRTC. AckerDB therefore owns the backend boundary and
the parts that require framework coordination, while applications retain the
standard media objects and provider protocols they already use.

## Decision

One realtime definition establishes one authenticated, AckerDB-relayed WebRTC
session between the application client and an AckerDB server handler.

AckerDB owns:

- authentication, authorization, admission, signaling, and perfect
  negotiation;
- one internal reliable ordered data channel for typed events, typed finite
  byte streams, and post-connect signaling control;
- shared client demand, bounded recovery, and generation cleanup; and
- a native server peer based on the focused LiveKit Rust libwebrtc binding.

Applications own:

- microphone and camera permission, capture, push-to-talk, continuous mode,
  playback, rendering, and device routing;
- standard tracks, transceivers, senders, and additional raw data channels;
- provider WebSocket or WebRTC protocols and provider-side state; and
- transcript history and other durable or shared application state.

There is no direct-provider mode, provider adapter layer, media WebSocket mode,
or AckerDB-specific media-object model.

## Public contract

A realtime definition declares validated arguments, optional authorization,
typed client/server events, and typed client/server byte streams. Its handler
runs once per authorized peer generation and receives:

- the native-backed server `RTCPeerConnection`;
- `ctx.on` and `ctx.send` for typed events;
- `ctx.onStream` and `ctx.openStream` for bounded finite byte transfers;
- `ctx.media` for explicitly decoded PCM16/I420 streams and generated media
  sources;
- `ctx.createPeerConnection` for generic provider or custom WebRTC bridges;
- the normal procedure context, including HTTP calls and transactions; and
- a generation abort signal for application-owned resource cleanup.

Audio and video use ordinary WebRTC tracks. An atomic typed event may contain
binary values but is bounded to 16 KiB. Larger finite values use standard
`ReadableStream<Uint8Array>` and `WritableStream<Uint8Array>` surfaces with
bounded buffering, cancellation, size limits, and no replay. Continuous media
never travels through the typed byte-stream protocol.

Client and server event sends report only whether the current local transport
accepted the frame. They do not acknowledge remote receipt, handler
completion, or durability.

## Client ownership

The framework-neutral client and `useRealtime` share one session by client,
realtime reference, and canonical arguments. Session retention and handler
observation are separate: repeated calls unconditionally retain the same peer,
while each committed caller registers and releases its own `on` observation.
Events and peer lifecycle notifications fan out to active observations; each
incoming byte stream has one deterministic matching observer so it never gains
unbounded buffering through stream fan-out.

`on.peerConnection` runs before initial negotiation for each generation and may
await native media setup or return generation cleanup. `on.connected`,
`on.track`, `on.stateChange`, `on.event`, and `on.stream` report future work
only; lifecycle history and application state are never replayed. The hook
snapshot is the source of current connection state.

Committed demand owns the shared session. `release` removes one owner and the
handler observations registered through that retained handle.
`disconnect` closes the session for every owner and suppresses recovery, and
`reconnect` starts a fresh generation. Closing the native peer is also an
explicit disconnect. The React `skip` sentinel creates no demand.

The client boundary accepts a structurally compatible platform
`RTCPeerConnection`. Browser WebRTC and the original `react-native-webrtc`
package are the documented defaults; AckerDB does not require a LiveKit React
Native client.

## Signaling and recovery

Initial offer, answer, and ICE trickle use bounded authenticated HTTP
POST/PATCH requests. Once the internal data channel opens, descriptions and
candidates use reserved control frames on that channel. There is no second
WebSocket or permanent HTTP polling loop.

Each locally gathered candidate wakes one serialized PATCH only when that
candidate cannot use the internal data channel. The final end-of-candidates
PATCH may wait for a server candidate, server completion, data-channel
readiness, request cancellation, or generation close; connection deadlines
remain the owner of a failed pre-connect generation.

`disconnected` first receives a finite native grace period. Continued failure
causes one managed ICE restart with the current generation configuration and a
deadline. If that fails, AckerDB closes the generation and uses bounded
backoff to create a fresh generation whose `/prepare` call obtains current
deployment configuration. A replacement authorizes again, reruns client setup
and the server handler, and never replays events, media, partial streams, or
provider state.

Network, ICE/DTLS, temporary signaling, draining, and overload failures may
recover. Authorization, validation, protocol, unsupported-capability, and
handler failures are terminal until an explicit reconnect or relevant input
change.

## Deployment and finite ownership

Runtime configuration, never a route or hook, owns host interfaces, adapter
filters, UDP range, advertised-address mappings, ICE timing, and TURN.
Configuration is validated before accepting traffic. Direct UDP remains
preferred; standard coturn REST credentials provide fallback relay access.

The standard CLI configuration may name a serving-only module whose default
export is the result of `createRealtimeRuntime(options)`. The CLI imports that
module only when the assembled application declares realtime handlers; schema,
code-generation, migration, backup, and other manifest consumers never import
it. When no module is configured, an application with realtime handlers keeps
the default `createRealtimeRuntime()` behavior. An explicitly supplied
programmatic runtime overrides the configured module without importing it.
This keeps deployment secrets and native network policy outside `defineApp`
without requiring an application-owned process bootstrap.

Remote candidate admission parses and charges every candidate before native
WebRTC sees it. Consistent with the [W3C `addIceCandidate` behavior for an
administratively prohibited candidate](https://www.w3.org/TR/webrtc/#dom-rtcpeerconnection-addicecandidate), AckerDB omits unusable `typ host`
addresses (including browser mDNS/nonliteral and default-denied host
addresses) without DNS resolution or a terminal session failure. A malformed
candidate, or a non-host candidate that targets a nonliteral or permanently
forbidden address, remains terminal. The isolated-LAN private-address opt-in
admits classified RFC1918/ULA candidates while loopback, link-local,
multicast, unspecified, and metadata destinations remain prohibited.

Admission occurs before native allocation and bounds global sessions,
per-principal sessions, and handshake rate. Per-peer limits bound data
channels, senders, and transceivers. Per-generation and process-wide budgets
bound handlers, streams, buffers, auxiliary peers, decoded media, sources,
tracks, and native queues. Explicit close and generation cleanup release each
claim exactly once; saturation produces typed outcomes instead of hidden
growth.

The coturn deployment contract uses short-lived credentials, TLS on port 443,
allocation and bandwidth quotas, a bounded relay range, restricted peer
networks, and a real relay-only allocation/data preflight.

## Server compatibility and diagnostics

The server exposes the useful W3C-shaped peer subset: tracks and streams,
senders/receivers/transceivers, parameter and statistics access, sender
parameter updates, codec preferences and capabilities, ICE state and candidate
errors, configuration, cloning, and raw data channels. A deliberately
unsupported standard capability throws `NotSupportedError`; it is never a
silent stub.

A bounded authorized diagnostic snapshot exposes redacted standard stats for
one session. It contains no credentials, addresses, SDP, or payloads and runs
only when explicitly requested.

## Native distribution

`@ackerdb/realtime` contains the generated NAPI-RS loader and declarations but
no native binary. Five optional packages each own one Darwin arm64/x64, Linux
GNU arm64/x64, or Windows x64 binary from the same pinned binding source and
native binary revisions; npm host metadata selects the consumer’s package.
The binding source is an immutable commit from AckerDB’s focused
`ackerdb-libwebrtc` fork, based on a recorded LiveKit upstream revision.
Target-specific Google libwebrtc archives remain digest-verified LiveKit build
inputs. Manifests, notices, licenses, provenance, and an SBOM ship with the
root distribution record and each platform package.

Every advertised target must build and enter the assembled package. Native and
packed runtime execution is currently proven only on Darwin arm64; other
targets are compile-and-package claims until separately tested. Libwebrtc
stays in process, so an unrecoverable native crash relies on external process
supervision and fresh client generations.

## Consequences

The common flow stays small and familiar while retaining the capabilities of a
custom WebRTC backend. AckerDB deliberately does not add rooms, multiparty
routing, conferencing, recording, provider adapters, background calling, or
custom transport algorithms in this decision. A future realtime-room design
remains possible because signaling and session identity do not encode a
permanent no-room assumption.

Detailed API examples live in [the realtime guide](../realtime-media.md).
Domain terms live in [`CONTEXT.md`](../../CONTEXT.md). The OSS comparisons,
production evidence, and deliberate divergences live in
[the production-hardening research record](../research/realtime-webrtc-production-readiness.md).
