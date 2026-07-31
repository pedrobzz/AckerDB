# coturn for AckerDB realtime

This baseline exposes TURN/UDP on `3478` and TURN/TLS on `443`, uses coturn’s
REST credential mechanism, keeps relay ports and allocations finite, caps
per-session and total bandwidth, and prevents allocations from reaching
private or special-use peer ranges.

Copy `turnserver.conf`, replace the realm, shared secret, certificates, and
optional one-to-one NAT mapping, then allow:

- inbound UDP/TCP `3478`;
- inbound TCP `443`;
- inbound and outbound UDP `49160–49260`;
- private monitoring access to TCP `9641`.

The relay-port range must match the host and cloud firewalls. Do not expose the
Prometheus listener publicly and do not enable coturn’s
`prometheus-username-labels`: AckerDB REST usernames are intentionally
ephemeral and would create unbounded metric cardinality.

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
```

The preflight creates two real short-lived allocations, requires relay-only
ICE/DTLS, and exchanges application data in both directions. Run it from the
same network namespace and with the same server-network policy as AckerDB.

For secret rotation, prefer coturn’s dynamic `turn_secret` database so old and
new issuers can overlap. With `static-auth-secret`, deploy the new secret to
coturn and AckerDB together and restart coturn; already-issued credentials use
the previous secret until their short TTL expires and cannot survive a
non-overlapping rotation. Keep clocks synchronized because expiry is encoded
in the REST username.

The private-peer deny list is deliberate for an Internet relay. If the actual
WebRTC peer is reachable only at a private address, add the narrowest explicit
`allowed-peer-ip` exception; never remove the entire restriction without
accepting the SSRF exposure.
