# Realtime media sessions

Realtime media sessions are AckerDB-relayed WebRTC peer connections. The
application keeps the standard WebRTC mental model:

- audio and video travel as WebRTC tracks: clients receive platform
  `MediaStreamTrack` objects and server handlers receive native-backed,
  W3C-shaped tracks;
- clients receive their platform `RTCPeerConnection`, while server handlers
  receive the familiar supported peer surface backed by bundled native
  libwebrtc;
- typed control events use one reliable ordered internal data channel;
- large finite values such as photos use typed byte streams; and
- the application owns capture, playback, provider bridges, tracks,
  transceivers, senders, and any extra raw data channels.

There is no direct/provider mode, provider adapter, media WebSocket, automatic
capture, or AckerDB media-player API.

The client and React hooks remain in `@ackerdb/client` and
`@ackerdb/client-react`. Only applications that declare realtime handlers install
`@ackerdb/realtime`; the ordinary server package contains no native WebRTC
binary or media runtime.

## Define a realtime route

```ts
import { realtime, v } from "../_generated/server";

export const live = realtime({
  args: {
    assistantId: v.string(),
  },
  clientEvents: {
    prompt: v.object({ text: v.string() }),
    cancel: v.object({}),
  },
  serverEvents: {
    transcript: v.object({
      text: v.string(),
      final: v.boolean(),
    }),
  },
  clientStreams: {
    photo: {
      metadata: v.object({ contentType: v.literal("image/jpeg") }),
      maxBytes: 8 * 1024 * 1024,
    },
  },
  serverStreams: {},
  access: "authenticated",
  authorize: async (ctx, args) => {
    const assistant = await loadAssistant(ctx, args.assistantId);
    return { assistant };
  },
  handler(ctx) {
    const provider = connectRealtimeProvider(ctx.state.assistant);
    const providerAudio = ctx.media.audioSource({
      sampleRate: 24_000,
      channels: 1,
      queueSizeMs: 500,
    });
    ctx.peerConnection.addTrack(providerAudio.track);

    ctx.peerConnection.addEventListener("track", (event) => {
      if (event.track.kind !== "audio") return;
      const audio = ctx.media.audioStream(event.track, {
        sampleRate: 24_000,
        channels: 1,
      });
      void (async () => {
        try {
          for await (const frame of audio) provider.sendAudio(frame);
        } finally {
          audio.close();
        }
      })();
    });
    // The application/provider integration owns one finite serialized pump
    // into captureFrame(). Never create one detached promise per audio frame.
    provider.pipeOutputTo(providerAudio);

    ctx.on("prompt", ({ text }) => {
      provider.sendText(text);
    });
    ctx.on("cancel", () => {
      provider.cancelTurn();
    });
    ctx.onStream("photo", async ({ metadata, readable, abortSignal }) => {
      await provider.sendPhoto(readable, metadata.contentType, abortSignal);
    });
    ctx.abortSignal.addEventListener("abort", () => provider.close(), {
      once: true,
    });
  },
});
```

The handler runs once per authorized peer generation before answer
negotiation. It receives the authenticated procedure context, validated
arguments, authorization state, generation `AbortSignal`, and native-backed
server peer. `ctx.on`/`ctx.send` and `ctx.onStream`/`ctx.openStream` are
inferred from the declaration. Returning from `handler` does not close the
session.

## Call procedures, HTTP services, and transactions

Realtime handlers receive the same procedure capabilities as ordinary
procedures and `sseProcedure` handlers. Registered procedures remain directly
callable—there is no string address or transport round trip:

```ts
import { enrichTurn } from "../procedures/enrichTurn";

handler(ctx) {
  ctx.on("prompt", async ({ text }) => {
    const enriched = await enrichTurn(ctx, { text });

    await ctx.tx((tx) =>
      tx.db.turns.insert({
        assistantId: ctx.state.assistant.id,
        text: enriched.data,
      })
    );

    ctx.send("transcript", {
      text: enriched.data,
      final: true,
    });
  });
}
```

The nested procedure revalidates its arguments and access policy and keeps the
same authenticated principal, abort signal, Plugin capabilities, result
contract and transaction-poisoning rules. Generated realtime
contexts include the application's procedure capabilities and their
transaction counterparts, so procedures using mounted Plugins remain callable
without casts.

HTTP calls use ordinary `fetch`; pass `ctx.abortSignal` so disconnecting the
generation cancels the request:

```ts
const response = await fetch(providerUrl, {
  method: "POST",
  body,
  signal: ctx.abortSignal,
});
```

As with every procedure, perform external I/O outside `ctx.tx`. HTTP effects
cannot be rolled back with SQLite, and AckerDB rejects `fetch` while a writer
transaction is open. Fetch first, then open the shortest transaction that
commits the resulting application state. SSE procedures themselves remain
transport-owned streams and are not callable in-process.

Provider callbacks fire outside AckerDB's transport dispatch. Route any
callback that needs the procedure context through `ctx.run`:

```ts
provider.onToolCall((call) => {
  ctx.run(async () => {
    const result = await executeTypedTool(ctx, call);
    provider.sendToolResult(call.id, result);
  });
});
```

`ctx.run(work)` is intentionally fire-and-own, not a promise-returning task
API. The work runs under this session's authenticated invocation context,
abort lifecycle, concurrency limit, and fatal-error boundary.
Provider media pumps that do not touch procedure capabilities can stay on
their bounded native/application queue and report terminal failures through
`ctx.run(() => { throw error; })`.

Use standard peer APIs for track forwarding. When an upstream provider is
itself WebRTC, create a session-owned auxiliary peer and bridge ordinary
tracks:

```ts
const upstream = ctx.createPeerConnection({
  iceServers: providerIceServers,
});
ctx.peerConnection.addEventListener("track", ({ track }) => {
  upstream.addTrack(track);
});
upstream.addEventListener("track", ({ track }) => {
  ctx.peerConnection.addTrack(track);
});
await signalProviderPeer(upstream, providerCredential);
```

`createPeerConnection()` is generic: AckerDB does not know which provider the
peer connects to or how that provider signals. Auxiliary peers, frame streams,
and media sources close automatically with the client session and may also be
closed explicitly.

Frame access is lazy. Forwarding a track with `addTrack()` does not deliver
decoded frames to JavaScript. `ctx.media.audioStream()` and
`ctx.media.videoStream()` explicitly activate bounded decoded delivery;
`audioSource()` and `videoSource()` create native outbound tracks for PCM or
I420 produced by the application.

An audio source exposes native playout controls:

```ts
await output.captureFrame(frame);
console.log(output.queuedDuration); // native buffered seconds remaining
await output.waitForPlayout();

// Barge-in:
output.clearQueue(); // also releases waitForPlayout()
```

`captureFrame()` is serialized in the native binding. Its libwebrtc queue is
finite, while `queuedDuration` and `waitForPlayout()` use monotonic native
accounting rather than a second JavaScript scheduler. Each capture contains
whole 10 ms PCM blocks (480 samples per channel at 48 kHz); a zero-length queue
accepts exactly one block per call.

## Configure server ICE and TURN

`@ackerdb/realtime` bundles the optional server WebRTC engine. Reachability and
capacity options belong to the runtime deployment, never to a realtime route
or React hook. Applications using `acker dev` or `acker start` name one
serving-only module in `.ackerdb.config.json`:

```json
{
  "realtime": "./realtime.ts"
}
```

That module directly default-exports the configured runtime:

```ts
import { createRealtimeRuntime } from "@ackerdb/realtime";

export default createRealtimeRuntime({
  network: {
    interfaces: { include: ["en0"] },
    udpPortRange: { min: 50_000, max: 51_000 },
    advertisedAddressMappings: [{
      privateAddress: "10.0.0.4",
      publicAddress: "203.0.113.4",
    }],
    ignoreAdapterTypes: ["loopback", "vpn"],
    ice: {
      unwritableTimeoutMs: 5_000,
      inactiveTimeoutMs: 15_000,
    },
  },
  configuration: async (principal) => ({
    iceServers: await turnCredentials.for(principal),
  }),
  maxSessions: 1_024,
  maxSessionsPerPrincipal: 16,
  maxHandshakesPerWindow: 32,
  handshakeWindowMs: 10_000,
  sessionLimits: {
    maxQueuedBytes: 32 * 1024 * 1024,
    maxAuxiliaryPeers: 4,
    maxDecodedStreams: 8,
    maxMediaSources: 8,
    maxDataChannelsPerPeer: 16,
    maxSendersPerPeer: 32,
    maxTransceiversPerPeer: 32,
  },
  resourceLimits: {
    maxAuxiliaryPeers: 2_048,
    maxDecodedStreams: 32_768,
    maxMediaSources: 32_768,
    maxTracks: 131_072,
  },
  authorizationTimeoutMs: 10_000,
  configurationTimeoutMs: 10_000,
  handlerTimeoutMs: 10_000,
  signalingTimeoutMs: 10_000,
  iceTimeoutMs: 10_000,
  dtlsTimeoutMs: 10_000,
  dataChannelTimeoutMs: 20_000,
  diagnosticTimeoutMs: 5_000,
});
```

Interface names and advertised private addresses are checked against the host
at startup. The effective status exposes only the interface policy, UDP range,
and mapping count—not mapped addresses, SDP, or credentials. Omit fields to
retain native libwebrtc defaults. Size and open the UDP range for the declared
session envelope.

Remote ICE addresses are a server boundary, not a route option. AckerDB parses
and charges every candidate before native WebRTC sees it, but safely omits an
unusable `typ host` candidate: browser mDNS/nonliteral values are never DNS
resolved, and private/ULA host values are omitted by default. This follows the
[W3C `addIceCandidate` behavior for administratively prohibited
candidates](https://www.w3.org/TR/webrtc/#dom-rtcpeerconnection-addicecandidate): no connection attempt, behaving as though the address did not respond.
Malformed candidates, and non-host candidates that target nonliteral or
permanently forbidden destinations, end the generation. Public deployments
deny RFC1918 IPv4 and IPv6 ULA candidates by default. An isolated LAN may make
the one deployment-level choice `network.allowPrivateCandidateAddresses: true`
to admit classified private/ULA candidates; it still cannot admit loopback,
link-local, multicast, unspecified, or metadata-service addresses. Use public
srflx/relay candidates for ordinary Internet deployments.

Each generation has one cumulative remote-candidate budget across its initial
offer SDP, HTTP trickle patches, and ordered data-channel signaling: 256
candidates and 256 KiB of canonical encoded candidate data by default. Ignored
host candidates consume that budget too. Set `maxRemoteCandidates` or
`maxRemoteCandidateBytes` only at runtime deployment scope. A malformed or
prohibited non-host candidate ends the generation with the typed `malformed`
outcome;
either budget exhaustion ends it with the retryable `overloaded` connection
outcome. No partial batch reaches native WebRTC.

The policy also reduces the standardized IPv4-in-IPv6 transition encodings
(compatible/mapped, the `64:ff9b::/96` NAT64 well-known prefix, 6to4, and
Teredo) to their IPv4 endpoint before applying that same policy. A
deployment-specific NAT64 prefix is not self-describing in an IPv6 literal, so
AckerDB does not guess one or resolve it. If a server network routes a custom
NAT64 prefix, enforce the egress policy at that gateway or use public
srflx/relay candidates instead.

For coturn's standard REST credential mechanism, AckerDB can mint short-lived
credentials directly:

```ts
import { createRealtimeRuntime } from "@ackerdb/realtime";

export default createRealtimeRuntime({
  turn: {
    urls: [
      "turn:relay.example.com:3478?transport=udp",
      "turns:relay.example.com:443?transport=tcp",
    ],
    secret: process.env.TURN_SECRET!,
    ttlSeconds: 3_600,
  },
});
```

Configure coturn with `use-auth-secret` and the same `static-auth-secret` of at
least 32 random bytes. The secret stays on the server; clients receive only a
principal-bound, expiring username and HMAC credential. Use `configuration`
instead when ICE credentials come from another service. The two options are
mutually exclusive.

Omit the options when host candidates are enough:
`createRealtimeRuntime()`. The CLI does this automatically when it finds
realtime handlers and no `realtime` module is configured. Apps without realtime
handlers never import the configured module or resolve the optional package. A
runtime passed directly to `startApp(config, { realtime })` overrides the
configured module without importing it. ICE and TURN configuration belongs at
deployment scope, not on every route or React hook.
The same bundled factory creates client-facing and auxiliary peers, so tracks
can move between them without a second engine or provider adapter.

The hardened coturn configuration, firewall contract, quotas, secret rotation,
and relay-only connectivity check are in
[the coturn deployment guide](deployment/coturn/README.md).
`preflightRealtimeTurn()` checks TURN/UDP and TURN/TLS independently. Each
configured transport gets its own absolute deadline, two real allocations,
relay candidate selection, ICE/DTLS establishment, diagnostics, and
bidirectional data. One healthy transport cannot hide failure of the other;
the returned `udp` and `tls` results contain only stable, secret-safe outcomes.
A listening port alone is not a successful TURN check.

On-demand diagnostics and each periodic health-sampling batch share the
deployment-level `diagnosticTimeoutMs` absolute deadline (5 seconds by
default). A stalled native statistics request becomes a bounded failure; a
late completion cannot mutate the published health snapshot.

## Native WebRTC distribution

The native module is Rust over AckerDB's maintained `libwebrtc` binding,
derived from LiveKit's proven low-level work, and is loaded by Bun through
Node-API. `@ackerdb/realtime` ships the generated NAPI-RS
loader and declarations, but no `.node` file. Its five optional platform
packages carry one binary each and use npm `os`, `cpu`, and Linux `libc`
metadata so an install retains only the matching host payload. Run
`bun run build:webrtc` in a source checkout; `bun run test:webrtc` builds the
host package and proves a real peer pair exchanges a data message, PCM audio,
and I420 video. Production installs must not omit optional dependencies.

The server exposes W3C-shaped `getStats()` reports (including track selectors),
mutable `RTCRtpTransceiver.direction`, `sendEncodings` for simulcast/SVC, and
independent, budgeted server-track cloning. The release workflow builds native
packages for Darwin arm64/x64, Linux GNU arm64/x64, and Windows x64. It executes
native and exact-packed-package tests only on Darwin arm64. The remaining
targets must compile and appear in the verified aggregate manifest, but are
not claimed as runtime-tested.

AckerDB consumes its focused
[`ackerdb-libwebrtc`](https://github.com/pedrobzz/ackerdb-libwebrtc) fork by an
immutable Git commit. Track cloning, complete stats, native identity, and
network controls live there as ordinary source commits based on a recorded
LiveKit revision; AckerDB keeps no local crate patches or vendored SDK copy.
Separately, each target’s compiled Google libwebrtc engine remains a
digest-verified LiveKit release archive. Stable and prerelease publication fail
before publishing any package unless every target binary, per-target manifest,
aggregate manifest, SBOM, and notice file agree.

See the committed [native provenance record](../packages/realtime/native/webrtc/PROVENANCE.md).

Unsupported peer options continue to fail explicitly instead of being silently
ignored. No provider-specific function is part of this boundary.

### Server WebRTC compatibility

The server surface follows WebRTC names and return shapes where the native
binding implements them:

| Surface | Server support |
| --- | --- |
| Peer lifecycle | `connectionState`, `iceConnectionState`, `iceGatheringState`, `signalingState`, ordinary state events, `icecandidate`, `icecandidateerror`, `track`, and `datachannel`. |
| Tracks and negotiation | `addTrack`, `removeTrack`, `addTransceiver`, mutable transceiver `direction`, `stop`, `restartIce`, and AckerDB-sequenced perfect negotiation. |
| RTP control | Sender/receiver `getParameters` and `getStats`; sender `replaceTrack` and `setParameters`; capability queries; transceiver `setCodecPreferences`; `sendEncodings`. |
| Mutable sender fields | `active`, `maxBitrate`, `maxFramerate`, `priority`, `scaleResolutionDownBy`, `scalabilityMode`, and `degradationPreference`. Read-only RTP changes fail with `InvalidModificationError`. |
| Statistics | Peer, selected-track, sender, and receiver `RTCStatsReport` maps; candidate-pair, RTP, RTT, jitter, loss, bitrate, concealment, and frame values remain standard stat fields. |
| Configuration | `iceServers`, `iceTransportPolicy`, `getConfiguration`, and `setConfiguration`. Deployment-only native interface, address, port, and timing controls remain on `Runtime.realtime.network`. |
| Explicitly unsupported | `bundlePolicy`, `certificates`, `iceCandidatePoolSize`, and `rtcpMuxPolicy` currently throw `NotSupportedError` instead of being ignored. |

AckerDB owns `setLocalDescription`, `setRemoteDescription`, and
`addIceCandidate` sequencing for the application-facing peer. Their presence
supports the internal signaling state machine; application code should mutate
tracks, senders, transceivers, configuration, and data channels instead.

### Status, diagnostics, and process failure

`runtime.status().realtime` is a bounded aggregate snapshot. It includes active
and reserved generations, principal/handshake admission, setup and recovery
durations/outcomes, fixed close-reason counters, resource ownership,
saturation, buffer pressure, and native event-queue drops. It performs no
periodic peer sampling and contains no principal, session, track,
candidate-address, SDP, or payload label.

For one authorized connection, `runtime.realtimeDiagnostic(sessionId,
principal)` reads a bounded standard stats report and returns a redacted path
and media-flow snapshot. This is an on-demand troubleshooting surface, not a
retained history or public unauthenticated endpoint.

The native engine intentionally remains in the AckerDB process. A JavaScript
handler, protocol, capacity, or ordinary native-operation error fails its
own generation with a typed outcome. A process-level native crash is handled
by the deployment supervisor: restart the AckerDB process and let clients
create fresh authorized generations. AckerDB does not claim media/event replay
or seamless host failover, and it does not add worker-process IPC before
crash/soak evidence justifies that cost.

## React web

```tsx
import {
  useRealtime,
  type RealtimeOn,
} from "@ackerdb/client-react";
import { api } from "./_generated/api";

type AssistantOn = RealtimeOn<typeof api.assistant.live>;

interface UseAssistantOptions {
  readonly on?: AssistantOn;
}

export function useAssistant(
  assistantId: string,
  options: UseAssistantOptions = {},
) {
  return useRealtime(api.assistant.live, { assistantId }, {
    on: options.on,
  });
}
```

A custom hook that owns microphone setup can keep the same handler bundle in
every component:

```tsx
export function useVoiceAssistant(assistantId: string) {
  return useRealtime(api.assistant.live, { assistantId }, {
    on: {
      async peerConnection(peer) {
        const media = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const track of media.getTracks()) peer.addTrack(track, media);
        return () => media.getTracks().forEach((track) => track.stop());
      },
      event: {
        transcript(value) {
          transcriptStore.append(value);
        },
      },
      track(event) {
        outputPlayer.attach(event.track);
      },
    },
  });
}
```

`on.peerConnection` runs once for each native generation before the initial
offer and may await media permission/setup and return cleanup.
`on.connected` runs after both the peer and internal data channel are ready.
`on.track` receives future native `RTCTrackEvent` values. `on.event` and
`on.stream` each accept either a named handler map or one discriminated-union
handler.

The returned `peerConnection` is also available outside callbacks. Push to
talk can toggle `track.enabled`; camera switching can use
`sender.replaceTrack`; later `addTrack`, `removeTrack`, transceiver, raw data
channel, and `restartIce` operations use ordinary WebRTC and AckerDB-managed
perfect negotiation.

## Expo

The hook API is identical. Metro selects AckerDB's Expo native entry, which
already provides Expo Fetch, cryptographic randomness, WebSocket, and AppState
lifecycle behavior. Expo does not provide WebRTC itself. The documented
standalone default is the original `react-native-webrtc` package:

```tsx
import {
  RTCPeerConnection,
  mediaDevices,
} from "react-native-webrtc";
import { AckerDBClient } from "@ackerdb/client";

const client = new AckerDBClient({
  url: "https://api.example.com",
  credential,
  createPeerConnection(configuration) {
    return new RTCPeerConnection(configuration);
  },
});

const on: RealtimeOn<typeof api.assistant.live> = {
  async peerConnection(peer) {
    const media = await mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
    for (const track of media.getTracks()) {
      peer.addTrack(track, media);
    }
    return () => media.getTracks().forEach((track) => track.stop());
  },
};

const session = client.realtime(api.assistant.live, { assistantId });
const stopObserving = session.observe(on);
// Later: stopObserving(); session.release();
```

`react-native-webrtc` is the default documented integration. AckerDB also
accepts compatible alternatives such as `@livekit/react-native-webrtc`; neither
package is bundled, required, or wrapped by AckerDB. AckerDB validates only the
peer capabilities it needs for its reserved control channel. Capture,
permissions, camera selection, track enablement for push-to-talk, replacement,
playback, and `RTCView` remain the chosen native package’s ordinary APIs. A
custom Expo development or release build must contain that WebRTC native module;
Expo Go is not supported.

## Sharing and handlers

One client, realtime reference, and canonical argument set may have at most
one active peer. Repeated calls retain that peer without an application-chosen
collision key. Each retained base-client handle registers callbacks separately
with `session.observe(on)`; `useRealtime` performs that observation for its own
committed lifetime, so callback changes neither recreate the peer nor overwrite
another component's handlers. Events and peer lifecycle notifications fan out
to every active observation. An incoming byte stream is offered to the first
matching observation only, preserving one bounded consumer instead of creating
hidden `ReadableStream.tee()` buffers. Shared transcript/application state
belongs in the application's store or context and is never replayed by AckerDB.

`RealtimeOn<typeof api.assistant.live>` derives the complete handler type from
the generated reference without separate handler code generation.

## Events, byte streams, and recovery

`send(name, payload)` returns only local data-channel acceptance. It never
queues or replays an event and does not acknowledge remote processing. Typed
event packets are binary MessagePack, preserve `Uint8Array`, and are limited
to 16 KiB.

Use `openStream(name, metadata, { size? })` for large finite binary values.
It returns `{ id, writable: WritableStream<Uint8Array> }`. Incoming handlers
receive `{ id, metadata, size?, readable, abortSignal }`. Streams have finite
size, concurrency, buffered-byte, and idle limits; cancellation propagates
best-effort, and interrupted streams never resume. Continuous audio/video must
remain WebRTC tracks.

Initial offer/answer and ICE trickle use authenticated HTTP signaling. After
the internal data channel opens, later perfect-negotiation descriptions and
candidates travel as reserved in-band control frames—there is no signaling
WebSocket, second socket, or permanent HTTP poll.

A transient `disconnected` state gets a five-second native recovery grace.
If connectivity does not return, AckerDB attempts one managed ICE restart with
the generation's current configuration and a ten-second deadline. Failure
closes that generation and enters the existing bounded fresh-generation
backoff. The replacement calls `/prepare` again, so it receives fresh ICE/TURN
configuration. Every replacement offer is marked as recovery, authorizes
again, reruns `on.peerConnection` and the server handler, and owns fresh tracks
and provider state. Setup itself has a twenty-second client deadline, while
server authorization, configuration, handler, signaling, ICE, DTLS, and
data-channel stages have independent runtime deadlines.

Authorization, validation, capability, protocol, and handler failures are
terminal until explicit `reconnect()`, relevant authentication change, or new
arguments. Explicit `disconnect()` suppresses recovery. Typed events and media
are never replayed; an open byte stream fails with
`RealtimeStreamInterruptedError` carrying its transfer ID and is never resumed
into the replacement generation. Realtime rooms remain deliberately
unimplemented, but session identity does not prevent adding an explicit
server-side room model later.
