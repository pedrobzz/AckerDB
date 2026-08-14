# Realtime WebRTC production-hardening evidence

Updated: 2026-07-31

## Scope

AckerDB terminates authenticated signaling and gives one user handler one
WebRTC peer. Media stays on native tracks. Typed events and bounded byte streams
use one internal data channel. The handler may bridge any provider and call
procedures, HTTP endpoints, and transactions.

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
| Diagnostics | [Janus Admin/Monitor API](https://janus.conf.meetecho.com/docs/admin.html), [WebRTC Stats](https://www.w3.org/TR/webrtc-stats/) | Provide a separately authorized, redacted per-peer diagnostic on demand. |
| Native distribution | [LiveKit Rust SDKs](https://github.com/livekit/rust-sdks), [AckerDB libwebrtc](https://github.com/pedrobzz/ackerdb-libwebrtc), [node-webrtc](https://github.com/WonderInventions/node-webrtc), [react-native-webrtc](https://github.com/react-native-webrtc/react-native-webrtc) | Build a focused Node-API bridge over an immutable AckerDB fork commit based on a recorded LiveKit revision. Keep required stats, cloning, identity, and network-control changes as reviewable fork commits; consume digest-pinned LiveKit native archives as separate Google libwebrtc build inputs. |
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

## Darwin arm64 lifecycle observation (2026-07-31)

Collected on a Darwin 27.0.0 arm64 development host (macOS 27.0, 48 GiB RAM)
with Bun 1.3.14. Three repetitions created one unconnected peer, an audio
source/stream, and a 640×480 video source/stream, then closed every wrapper,
the generation, and the engine.

| Observation | Before | Resources active | Wrappers released | Engine closed |
| --- | ---: | ---: | ---: | ---: |
| Native reserved capacity | 0 B | 17,900,416 B | 0 B | 0 B |
| Global track ownership | 0 | 2 | 0 | 0 |
| Threads | 47–48 | 47–48 | 47–48 | 44–45 |
| File descriptors | 19 | 19 | 19 | 17 |

RSS began between 92.2 MiB and 98.4 MiB and was 101.3 MiB to 105.6 MiB while
the resources were active. It did not immediately fall after release because
the allocator retained process pages; the ownership invariants did return to
zero in all repetitions. The permanent lifecycle test therefore asserts only
those invariants, not a machine-specific RSS, thread, or descriptor threshold.

Three additional 0→32-peer idle sweeps measured 7,847,936 B, 7,798,784 B, and
7,766,016 B of RSS growth respectively: a conservative 245,248 B (239.5 KiB)
per idle native peer. Threads remained within 44–49 and descriptors at 19 for
every peer count. This is a local sizing observation, not a throughput or
connection-capacity claim. The process byte budget separately constrains media
and queue reservations. The defaults therefore allow 1,024 primary sessions
(twice the documented 500-connection design load) and 2,048 auxiliary peers:
at most 3,072 idle native peers, or about 718 MiB at the measured high-water
slope. Together with the 512 MiB process queue budget, about 100 MiB process
base, and 1 GiB OS headroom, that leaves about 1.7 GiB of the 4 GiB default
deployment envelope for the database, application, and runtime. The queue
budget independently bounds burst/media capacity; it is not preallocated for
each session.

Commands used at collection time (the first two were temporary local
diagnostics):

```sh
bun /private/tmp/ackerdb-webrtc-lifecycle.ts
bun /private/tmp/ackerdb-webrtc-idle-peer-capacity.ts
bun test packages/realtime/native/webrtc/test/native-engine.test.ts
```

## Candidate acceptance (2026-07-31)

On the Darwin arm64 host above, the following focused boundaries passed with
Bun 1.3.14. They describe a one-to-one AckerDB session; they are not room,
SFU, provider, device, or Internet-reachability evidence.

| Contract | Evidence | Proven boundary |
| --- | --- | --- |
| Prepared authorization and one-use tickets | `packages/realtime/test/hub.test.ts` and `packages/realtime/test/transport.test.ts` | Rejection releases admission before a peer exists; a ticket is owner-bound, atomically consumed once, expires/drains cleanly, and then reaches the public prepare/offer routes. |
| Offer/answer, HTTP ICE trickle, terminal signaling, and server cleanup | `packages/realtime/test/transport.test.ts` | The listener's public endpoints prepare a session, return an answer, accept a bounded trickle batch, close explicitly, and fail a forbidden candidate before native handling. |
| Shared client lifecycle | `packages/client/test/realtime-session.test.ts` | Equal handler keys share one peer and handler bundle; conflicting keys fail; transient loss recovers through a fresh generation; terminal failures and explicit disconnect prevent unintended recovery; release has one bounded cleanup request. |
| Handler data plane | `packages/realtime/test/transport.test.ts` | A typed event reaches the handler, which performs an HTTP call, registered procedure call, and committed transaction before returning a typed event. |
| Real native public session | `packages/realtime/native/webrtc/test/public-session.test.ts` | A public `AckerDBClient` and bundled server peer exchange a typed event and audio track; the handler performs its procedure/HTTP/transaction flow; release returns active/reserved sessions and owned server resources to zero. |
| Packed consumer | `bun run test:packages` | The current twelve-package working tree was packed, static artifacts were verified, and a clean Bun consumer selected the Darwin arm64 optional native package before completing that same public native-session fixture. CI repeats this boundary from the exact clean-HEAD candidate artifact. |

The real same-host native fixture uses only its runtime's explicit isolated-LAN
`network.allowPrivateCandidateAddresses` opt-in, because the two peers advertise
RFC1918 host candidates. It does not alter the production default: public
deployments still omit private/ULA `typ host` candidates, while malformed and
non-host candidates with nonliteral or permanently forbidden destinations are
terminal. Loopback, link-local, multicast, unspecified, and metadata-service
literals remain forbidden even with that opt-in.

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
tests; compilation and static package checks for every advertised target; and
the Darwin arm64 exact-packed-consumer load recorded above. Other native
targets are build- and artifact-verified, not runtime-verified here.

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
