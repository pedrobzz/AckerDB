# coturn for AckerDB realtime

This baseline exposes TURN/UDP on `3478` and TURN/TLS on `443`, uses coturn’s
REST credential mechanism, keeps relay ports and allocations finite, caps
per-session and total bandwidth, and prevents allocations from reaching
private or special-use peer ranges.

Copy `turnserver.conf`, replace the realm, a cryptographically random shared
secret of at least 32 bytes, certificates, and optional one-to-one NAT mapping,
then allow:

- inbound UDP/TCP `3478`;
- inbound TCP `443`;
- inbound and outbound UDP `49160–49260`;
- local monitoring access to TCP `9641`.

The relay-port range must match the host and cloud firewalls. The baseline
binds Prometheus to loopback; use a private monitoring address plus a firewall
rule if an external collector needs it. Do not expose that listener publicly
and do not enable coturn’s
`prometheus-username-labels`: AckerDB REST usernames are intentionally
ephemeral and would create unbounded metric cardinality.

Put AckerDB's public HTTP API behind a standard, trusted HTTPS terminator. The
terminator is responsible for public TLS and must be configured as AckerDB's
trusted proxy boundary; do not expose plaintext application HTTP directly.
`turns:` remains TURN-over-TLS, not HTTPS: coturn terminates that TLS listener
itself (or a TURN-aware TCP/TLS proxy preserves it). An ordinary HTTP reverse
proxy cannot carry TURN/UDP relay traffic.

Set the same secret in AckerDB:

```ts
import { createRealtimeRuntime } from "@ackerdb/realtime";

const runtime = new Runtime({
  engine,
  registry,
  realtime: createRealtimeRuntime({
    turn: {
      urls: [
        "turn:relay.example.com:3478?transport=udp",
        "turns:relay.example.com:443?transport=tcp",
      ],
      secret: process.env.TURN_SECRET!,
      ttlSeconds: 600,
    },
  }),
});
```

Before taking traffic, prove the data path—not merely the coturn process:

```ts
import { preflightRealtimeTurn } from "@ackerdb/realtime";

const result = await preflightRealtimeTurn({
  urls: [
    "turn:relay.example.com:3478?transport=udp",
    "turns:relay.example.com:443?transport=tcp",
  ],
  secret: process.env.TURN_SECRET!,
  ttlSeconds: 600,
});

if (!result.udp.ok || !result.tls.ok) {
  throw new Error("TURN deployment preflight failed");
}
```

UDP and TLS are separate probes with separate absolute deadlines. Each creates
two real short-lived allocations, requires the expected relay path, completes
ICE/DTLS, inspects bounded diagnostics, and exchanges application data in both
directions. A failure returns a stable code and never the underlying credential
or native error. Run the preflight from the same network namespace and with the
same server-network policy as AckerDB.

For secret rotation, prefer coturn’s dynamic `turn_secret` database so old and
new issuers can overlap. With `static-auth-secret`, deploy the new secret to
coturn and AckerDB together and restart coturn; already-issued credentials use
the previous secret until their short TTL expires and cannot survive a
non-overlapping rotation. Keep clocks synchronized because expiry is encoded
in the REST username.

The private-peer deny list is deliberate for an Internet relay. AckerDB omits
private/ULA and nonliteral `typ host` remote candidates by default (including
browser mDNS) without DNS resolution, matching the [W3C treatment of
administratively prohibited candidates](https://www.w3.org/TR/webrtc/#dom-rtcpeerconnection-addicecandidate).
A deliberately isolated LAN deployment may opt in once, at runtime
configuration, with `network.allowPrivateCandidateAddresses: true`; it admits
classified private/ULA candidates but still rejects loopback, link-local,
multicast, unspecified, and metadata-service addresses. Non-host candidates
with a nonliteral or permanently forbidden target remain terminal. Pair that
opt-in with the narrowest coturn `allowed-peer-ip` exception needed for the
LAN. Never remove the entire restriction from a public deployment: it would
turn the relay into an SSRF path into private infrastructure.
