# Realtime WebRTC production-hardening evidence

Updated: 2026-07-30

## Scope

AckerDB terminates authenticated signaling and gives one user handler one
WebRTC peer. Media stays on native tracks. Typed events and bounded byte streams
use one internal data channel. The handler may bridge any provider and call
procedures, HTTP services, and transactions.

This is not an SFU, conferencing server, provider SDK, capture library, or
background-call framework. The initial envelope is a single AckerDB node
relaying one application session to one handler.

## Prior art and decisions

| Concern | Prior art | AckerDB decision |
| --- | --- | --- |
| Recovery | [LiveKit connection reliability](https://docs.livekit.io/intro/basics/connect/), [mediasoup transport API](https://mediasoup.org/documentation/v3/mediasoup-client/api/), [WebRTC 1.0](https://www.w3.org/TR/webrtc/) | Allow native recovery, attempt one bounded ICE restart, then create a fresh authorized generation with bounded jittered backoff. Never replay application state. |
| Reachability | [Pion `SettingEngine`](https://pkg.go.dev/github.com/pion/webrtc/v4#SettingEngine), [LiveKit ports and firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/), [Janus](https://github.com/meetecho/janus-gateway) | Resolve interface selection, UDP range, host-address mappings, adapter filters, and ICE timing once at deployment scope. |
| TURN | [coturn](https://github.com/coturn/coturn/blob/master/README.turnserver) | Mint standard short-lived shared-secret credentials and ship a hardened reference deployment. Verify it with a real relay-only, bidirectional peer preflight; do not embed another TURN server. |
| Server API | [WebRTC 1.0](https://www.w3.org/TR/webrtc/), [WebRTC Stats](https://www.w3.org/TR/webrtc-stats/) | Preserve the familiar peer, track, stream, sender, receiver, transceiver, data-channel, configuration, and stats model. Reject unsupported options explicitly. AckerDB alone sequences descriptions and remote ICE because it owns signaling. |
| React Native | [react-native-webrtc](https://github.com/react-native-webrtc/react-native-webrtc) | Accept a structural `RTCPeerConnection` factory or registered platform global. Capture, playback, and views remain application-owned. Expo requires a native development/release build, not Expo Go. |
| Resource bounds | [mediasoup](https://mediasoup.org/documentation/v3/mediasoup/api/), [Janus](https://janus.conf.meetecho.com/docs/) | Reject session/handshake growth before peer allocation; bound peers, handlers, streams, buffers, native event queues, media resources, and cloned tracks. Surface saturation instead of growing hidden queues. |
| Diagnostics | [Janus Admin/Monitor API](https://janus.conf.meetecho.com/docs/admin.html), [WebRTC Stats](https://www.w3.org/TR/webrtc-stats/) | Export low-cardinality lifecycle, path, media-quality, pressure, resource, and queue-drop aggregates. Rotate through at most eight peers per existing telemetry interval and provide a separately authorized, redacted per-peer diagnostic. |
| Native distribution | [LiveKit Rust SDKs](https://github.com/livekit/rust-sdks), [node-webrtc](https://github.com/WonderInventions/node-webrtc), [react-native-webrtc](https://github.com/react-native-webrtc/react-native-webrtc) | Build a focused Node-API bridge over LiveKit's low-level libwebrtc crate. Keep only the upstream patches needed for stats, cloning, network controls, and the bridge surface; record their provenance and removal conditions. |
| Isolation | [mediasoup Worker API](https://mediasoup.org/documentation/v3/mediasoup/api/#Worker) | Keep libwebrtc in process while lower copying, IPC, memory, and operational cost outweigh crash isolation. Revisit only with fuzzing, crash, or soak evidence. |

## Implemented hardening

- Independent authorization, configuration, handler, signaling, ICE, DTLS,
  data-channel, and client setup deadlines.
- Per-principal and global admission, finite native/media ownership, bounded
  byte streams, and terminal native queue overflow.
- Standard sender/receiver parameters and stats, mutable encoding parameters,
  track replacement and cloning, transceiver direction and codec preferences,
  selected-track stats, and candidate-pair diagnostics.
- TURN REST credentials, deployment networking controls, and a relay-only
  preflight.
- Reproducible native builds with pinned inputs, hashes, provenance, an ABI
  manifest, SBOM, notices, target-package checks, and a clean packed-consumer
  load test.
- The native engine and server media runtime ship only in
  `@ackerdb/realtime`. `@ackerdb/server` retains the route contract and host
  integration without depending on the optional package, and the CLI resolves
  it only for applications that register realtime routes.

## Deliberate boundaries

- AckerDB is not a LiveKit room or application-server wrapper; LiveKit supplies
  the low-level libwebrtc implementation.
- It does not invent media capture APIs. Web and React Native applications use
  their platform's normal microphone, camera, tracks, and rendering APIs.
- It does not duplicate TURN, SFU, provider, or application-state machinery.
- A native process crash is currently a supervisor restart, not an in-process
  media-worker recovery.

## Verification boundary

Automated evidence covers deterministic client recovery; server admission,
deadlines, authorization, resources, diagnostics, typed events/streams,
procedure/HTTP/transaction calls, and cleanup; real Darwin arm64 data, PCM,
I420, stats, RTP controls, cloning, network mapping, queue, playout, and ABI
tests; compilation and exact-package checks for every advertised target; and a
clean Darwin packed-consumer load.

Pedro deferred these empirical acceptance tests:

- physical iOS/Android and browser matrices;
- provider interoperability beyond the HomeAssistant/xAI proof;
- host, TURN/UDP, TURN/TLS-only, IPv4/IPv6, and restrictive-network matrices;
- network handoff, suspend/resume, Bluetooth, and interruption routing;
- churn, soak, capacity, latency, CPU, memory, thread, descriptor, and TURN
  bandwidth measurements; and
- multi-host failover.

Those limits constrain the proven operating envelope; they do not imply that
the state machine or packaging code ran those tests. Stable releases use the
repository's Hetzner benchmark policy rather than local performance results.
