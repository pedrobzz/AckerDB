---
status: accepted
---

# Application channels use one multiplexed typed transport

AckerDB application channels are typed bidirectional application streams
multiplexed over the client's existing application connection. They may opt
into PartyKit-style rooms, and preserve native WebSocket expectations: live
delivery, explicit failure, and no hidden outbound queue or replay.

Channel events carry text-oriented typed application values; binary values
remain supported through AckerDB's existing base64 wire encoding.

## Contracts and rooms

A channel declares named, validated client-to-server and server-to-client event
maps. A roomless channel has no room option. A roomed channel requires exactly
one validated room for each subscription, has no all-rooms wildcard, and uses
separate logical subscriptions over the same physical connection when a client
joins multiple rooms.

React observers receive server events through one `on` property, using either a
handler map keyed by event name or one handler receiving the derived
discriminated union. Consumers that need both forms create two observers; this
does not duplicate the underlying subscription.

## Sharing and local observers

Within one client lifetime, equal channel references, canonical arguments, and
optional canonical rooms share one server subscription and one received and
validated delivery. Each committed hook call remains an independent observer
whose current handlers run once. Independent handlers run together by default;
equal optional `handlerKey` values coalesce only the corresponding local
handler execution within that shared subscription.

## Membership and delivery audiences

A channel may authorize each join under the current authenticated principal.
No authorization callback means allow; a callback may return a typed rejection
or typed ephemeral membership state. Reconnect and authentication changes
discard that state and authorize the restored membership again.

A server handler uses `ctx.send` for its current member, `ctx.publish` for every
member of its current channel or room including the sender, and the explicit
server-only `ctx.channels.publish` to target another typed channel
subscription. Client events cannot independently select an arbitrary channel
or room.

## Delivery semantics

Sending reports only whether the current local transport accepted the event; it
does not acknowledge server receipt or handler completion. Application outcomes
return through explicit server events, while durable request-response work uses
mutations or procedures. Unavailable or backpressured sends fail immediately
with a typed outcome. Reconnect restores memberships but never queues or
replays outbound channel events.
