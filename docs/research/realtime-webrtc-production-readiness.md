# Realtime WebRTC production-hardening record

Updated: 2026-07-30

## Scope and result

This record covers AckerDB's one-client-to-one-handler media session:
authenticated signaling terminates at AckerDB, audio/video remain WebRTC
tracks, typed events and finite byte streams use one internal data channel,
and the user-owned handler may bridge any provider and call procedures, HTTP,
and transactions. It is not an SFU, conferencing system, provider SDK, capture
library, or background-call framework.

The production-hardening implementation now has:

- bounded transient recovery: native grace, one managed ICE restart, then a
  bounded fresh authorized generation;
- independent authorization, configuration, handler, signaling, ICE, DTLS,
  data-channel, and client setup deadlines;
- deployment-owned interface, UDP-range, advertised-address, adapter-filter,
  and native ICE-timing controls;
- coturn REST credentials, a hardened reference deployment, quotas, and a
  real relay-only bidirectional preflight;
- global/per-principal session and handshake admission before native
  allocation;
- finite per-peer, per-generation, and runtime-wide native/media/stream
  ownership, including cloned-track admission;
- W3C-shaped sender, receiver, transceiver, track, configuration, ICE-event,
  and stats behavior, with explicit `NotSupportedError` boundaries;
- low-cardinality setup, recovery, close-reason, path, media, pressure, and
  queue-drop telemetry plus bounded on-demand diagnostics; and
- one reproducible native artifact pipeline whose release gate requires all
  advertised targets in the exact package.

The intended initial production envelope remains single-node, foreground,
application-relayed voice/media. Pedro deliberately deferred physical-device,
provider, network-handoff, TURN-only, churn, and soak acceptance. Those are
empirical envelope evidence, not missing state-machine or package machinery,
and this document does not claim they were executed.

## Prior art applied

### Recovery and lifecycle

LiveKit's higher-level client attempts transport recovery and falls back to a
full reconnect when resumption cannot succeed. mediasoup exposes ICE restart
and connection-state primitives but leaves the application responsible for
signaling them. AckerDB owns signaling and shared-session lifecycle, so the
LiveKit-level behavior is the closer product precedent:

1. `disconnected` starts a finite five-second grace period.
2. Native recovery during grace returns the same peer to `connected`.
3. Expiry refreshes the standard `RTCConfiguration`, calls `restartIce()`,
   and gives that attempt ten seconds.
4. Expiry/failure closes the old peer and enters bounded full-generation
   reconnect with the existing jittered backoff.
5. A replacement offer is marked as recovery, authorizes again, reruns the
   client setup and server handler, and receives a new provider lifecycle.

The deliberate divergence from LiveKit is that AckerDB never republishes or
replays application state automatically. It has no room publication model.
Old typed events and tracks are not emitted again, and partial streams fail
with a transfer-specific `RealtimeStreamInterruptedError`.

Sources:

- [LiveKit connection reliability](https://docs.livekit.io/intro/basics/connect/)
- [mediasoup-client transport API](https://mediasoup.org/documentation/v3/mediasoup-client/api/)
- [WebRTC 1.0 ICE restart and connection state](https://www.w3.org/TR/webrtc/)

### Server reachability

Pion's `SettingEngine`, Janus deployment options, and LiveKit's firewall
contract all place interface selection, port allocation, address rewriting,
and ICE timing at server/deployment scope. AckerDB follows that ownership:
`Runtime.realtime.network` is resolved once, validated against the host before
traffic, passed to native libwebrtc, and summarized without publishing mapped
addresses.

AckerDB supports an explicit UDP range rather than a UDP mux because the
selected low-level binding exposes the former. It supports one-to-one host
candidate rewriting, interface include/exclude policy, adapter-class filters,
and the native ICE timing controls the binding actually implements. It does
not add route or hook copies of these options.

Sources:

- [Pion `SettingEngine`](https://pkg.go.dev/github.com/pion/webrtc/v4#SettingEngine)
- [LiveKit ports and firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/)
- [Janus configuration source](https://github.com/meetecho/janus-gateway)

### TURN

coturn already implements allocation, authentication, relay, TLS, quotas,
bandwidth caps, peer restrictions, and Prometheus. AckerDB therefore does not
embed a TURN server. It mints standard time-bound shared-secret credentials
and ships a reference coturn configuration with:

- TURN/UDP on 3478 and TURN/TLS on 443;
- `use-auth-secret`, a bounded credential TTL, and rotation procedure;
- a finite relay port range and matching firewall policy;
- per-user/total allocation and per-session/total bandwidth caps;
- denied private, loopback, link-local, multicast, and other unsafe peer
  ranges unless the deployment deliberately needs them;
- bounded-cardinality Prometheus settings; and
- disabled administrative CLI.

`preflightRealtimeTurn()` creates two real relay-only peer allocations,
negotiates ICE/DTLS, exchanges data both directions, and verifies that both
selected paths use relay candidates. This is intentionally stronger than a
port/process health check.

Source: [coturn server reference](https://github.com/coturn/coturn/blob/master/README.turnserver).

### Familiar server WebRTC API

WebRTC 1.0 and WebRTC Stats are the vocabulary source. The bundled server peer
now exposes standard-shaped:

- peer/signaling/ICE states and events, including `icecandidateerror`;
- tracks, streams, senders, receivers, transceivers, and data channels;
- sender/receiver parameters and stats;
- mutable sender encoding/degradation parameters;
- track replacement and independent cloning;
- transceiver direction, send encodings, capabilities, and codec preferences;
- peer and selected-track stats; and
- selected candidate-pair diagnostics.

Read-only RTP parameter changes report `InvalidModificationError`; unsupported
configuration fields report `NotSupportedError`; capacity reports
`QuotaExceededError`; native operation failures report `OperationError`.
AckerDB does not silently accept a W3C option that the binding cannot honor.

The deliberate limitation is ownership, not a renamed API: AckerDB sequences
session descriptions and remote ICE candidates because it owns signaling.
Applications retain the familiar track, sender, transceiver, data-channel,
configuration, and event model.

Sources:

- [W3C WebRTC 1.0](https://www.w3.org/TR/webrtc/)
- [W3C WebRTC Stats](https://www.w3.org/TR/webrtc-stats/)
- [mediasoup API and stats surfaces](https://mediasoup.org/documentation/v3/mediasoup/api/)

### React Native and Expo

The client accepts a structural `RTCPeerConnection` factory or a registered
platform global. The documented standalone default is the original
`react-native-webrtc` implementation: its `RTCPeerConnection`,
`mediaDevices`, `MediaStream`, `MediaStreamTrack`, sender, transceiver, and
view APIs remain application-owned. AckerDB does not require
`@livekit/react-native-webrtc` and does not wrap the client in a LiveKit room.

This keeps Expo migration additive: install the native WebRTC module in a
development/release build, inject its constructor once, and use its normal
capture/playback APIs inside the keyed AckerDB hook. Expo Go remains outside
the native-module boundary.

Source: [react-native-webrtc](https://github.com/react-native-webrtc/react-native-webrtc).

### Resource ownership and saturation

mediasoup and Janus expose explicit worker/session resources rather than
allowing hidden unbounded growth. AckerDB uses a smaller single-process model
but preserves that invariant:

- global and per-principal session counts plus per-principal handshake windows
  reject before peer allocation;
- every peer bounds data channels, senders, and transceivers;
- each generation bounds auxiliary peers, decoded streams, media sources,
  handlers, concurrent typed streams, buffered bytes, and stream lifetime;
- one runtime budget bounds auxiliary peers, decoded streams, media sources,
  and every native track wrapper/clone;
- native event queues are finite and become terminal after overflow;
- decoded live media drops the oldest queued frame instead of accumulating
  latency; and
- saturation is a typed outcome or standard `QuotaExceededError`, never an
  unbounded hidden queue.

Tracks belong to either their peer or source scope. Explicit `stop()` releases
one track; closing a peer/source releases every remaining clone in its scope.
The same runtime budget is shared by the bundled engine and AckerDB hub, so
status reflects the native ownership that actually exists.

### Observability

Janus's first-media, slow-link, hangup, and admin diagnostics and standard
WebRTC stats informed the split between aggregate metrics and an on-demand
per-peer snapshot.

The runtime records:

- completed/failed/timed-out counts and duration for authorization,
  configuration, handler, signaling, ICE, DTLS, and data-channel stages;
- recovery attempts/outcomes/duration and fixed close-reason counters;
- active/reserved sessions, active principals, handshake windows, resource
  ownership, and saturation;
- direct/relay and UDP/TCP selected path counts;
- first inbound/outbound audio/video;
- RTT, jitter, loss, packets, available bitrate, and buffered amount; and
- native event drops, stream pressure, and handler/resource saturation.

Sampling rotates over at most eight active peers per interval and never starts
its own permanent timer. Closed generations leave the sampling set in O(1).
Metrics contain no principal/session/track IDs, addresses, SDP, arguments,
credentials, or media/provider payloads. `realtimeDiagnostic()` is separately
authorized, on demand, bounded to 4,096 stat entries, and redacts candidate
addresses.

Sources:

- [Janus Admin/Monitor API](https://janus.conf.meetecho.com/docs/admin.html)
- [W3C WebRTC Stats](https://www.w3.org/TR/webrtc-stats/)

### Native engine and package supply chain

AckerDB uses LiveKit's low-level Rust libwebrtc crates as an implementation
dependency. It is not a LiveKit application/server wrapper. Two focused
patches add raw stats, track cloning, network controls, and the Node-API
surface without committing the complete upstream crates; their exact
provenance and removal conditions are recorded in
`packages/server/native/webrtc/PROVENANCE.md`.

The build boundary:

1. pins Bun, Rust, GitHub Actions, LiveKit crate revisions, and one libwebrtc
   release tag;
2. downloads the target archive to disk and verifies an Acker-owned SHA-256
   before extraction;
3. builds with Cargo's locked dependency graph;
4. produces a target manifest containing the binary digest and upstream
   artifact identity;
5. requires Darwin arm64/x64, Linux arm64/x64, and Windows x64 before assembly;
6. independently rechecks target provenance and binary hashes;
7. emits an aggregate ABI manifest, SPDX SBOM, and notices;
8. packs the exact `@ackerdb/server` boundary and statically checks every
   target; and
9. installs that assembled package in a clean Darwin arm64 consumer and loads
   the actual addon.

Stable, alpha, and beta publishing all run the same assembly gate before the
first package is sent. This closes the prior gap where a publisher workstation
could accidentally ship only its own architecture.

node-webrtc and react-native-webrtc establish the normal expectation that
native support is an explicit OS/architecture matrix. AckerDB deliberately
executes runtime/native/package tests only on Pedro's Darwin arm64 target for
this milestone; other targets must compile and package successfully but are
not described as runtime-tested.

Sources:

- [LiveKit Rust SDKs](https://github.com/livekit/rust-sdks)
- [node-webrtc](https://github.com/WonderInventions/node-webrtc)
- [react-native-webrtc](https://github.com/react-native-webrtc/react-native-webrtc)

### Process isolation

mediasoup isolates media workers and makes worker death explicit. AckerDB keeps
libwebrtc in process because its initial relay model values the lower IPC,
copying, memory, and operational cost. Ordinary operation/handler/protocol
failures are generation-contained. A native process crash is a supervisor
event: restart AckerDB and let retained client demand create a fresh authorized
generation.

This is a deliberate evidence threshold, not an accidental omission.
Worker-process isolation should be added only if fuzzing, crash, or soak
evidence shows that containment justifies the permanent extra machinery.

Source: [mediasoup Worker API](https://mediasoup.org/documentation/v3/mediasoup/api/#Worker).

## Verification boundary

Automated completion evidence is:

- deterministic public-boundary client recovery tests;
- server admission, deadline, authorization, handler, resource, telemetry,
  diagnostic, typed-event/stream, HTTP/procedure/transaction, and cleanup
  tests;
- real Darwin arm64 peer-pair data, PCM audio, I420 video, stats, sender,
  receiver, transceiver, codec, clone, network-range/address-map, queue,
  playout, and ABI tests;
- clean packed-consumer loading of the Darwin addon;
- successful compilation of every advertised target;
- static exact-package presence and digest checks for every target; and
- source-level comparison with the primary implementations/specifications
  above.

The following remain Pedro's later empirical acceptance work and are not
claimed here:

- physical iOS/Android and browser matrices;
- real provider WebSocket/WebRTC interoperability beyond the existing
  HomeAssistant/xAI proof;
- host, TURN/UDP, TURN/TLS-only, IPv4/IPv6, and restrictive-network matrices;
- Wi-Fi/cellular handoff, suspend/resume, Bluetooth and interruption routing;
- sustained churn, soak, capacity, tail latency, CPU, RSS/native heap, thread,
  descriptor, and TURN-bandwidth measurements; and
- multi-host failover.

No local performance benchmark is evidence. A versioned stable release uses
the repository's Hetzner release benchmark policy; beta validation uses the
functional boundaries above.
