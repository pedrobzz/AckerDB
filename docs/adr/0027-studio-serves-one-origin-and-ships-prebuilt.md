# Studio serves one origin and ships prebuilt

Studio is a client that has to reach an application it does not run inside. The
obvious shape — a static page that asks for a server URL and calls it — costs
three things at once: the application must configure CORS for an origin it
cannot know, the page acquires a mechanism for being pointed anywhere, and an
Admin Credential ends up one typo away from a server nobody chose. The second
obvious shape, embedding the UI in the application process, costs a UI process
running inside production and a boot-order relationship between the two.

The decision: **`acker studio` is one origin.** It serves the Studio bundle and
same-origin-proxies HTTP, WebSocket, and SSE to the application server —
`localhost:<app-port>` from `.ackerdb.config.json`, or the `--url` target. There
is no CORS to configure, no URL field in the UI, and one port to expose.
Exposing it, with whatever reverse proxy and TLS an operator wants, is
deliberately the operator's decision rather than a default.

Because `--url` reaches a deployed application over the network, no UI process
ever has to run inside a production machine. That is what makes it defensible
for Studio to be the only place agent credentials are minted.

## The SPA owns a prefix; it does not guess

Both sides address one flat path namespace. An application names its own HTTP
roots — every API path it declares becomes one — and the framework's protocol
roots sit beside them. So the launcher has to decide, per request, which side a
path belongs to.

The rejected answer is to sniff `Accept: text/html` and serve the shell for
anything HTML-ish that is not a bundled file. It fails in both directions, and
neither failure is visible. Queries answer `GET` as well as `POST`, so a browser
navigation to `/admin/system/info` — or to any GET-able application address —
would silently return the shell instead of the application's answer. And the
SPA's own screen names (`logs`, `database`, `jobs`) live in the same flat space
as application group names, so an application declaring `apiPath: "logs"` would
have that group shadowed by a Studio screen.

Instead the SPA owns exactly one prefix, `/_studio/`, and the shell is served
only under it. The prefix carries the reserved marker — the character an
application may never begin a name with, enforced for API paths and MCP paths
alike — so the collision is closed by the namespace rule rather than by a
convention someone has to remember.

**The fallback inverts: an unknown path is the application's.** That is the
half that matters. The two failures are not symmetric. A path the application
does not serve comes back as its own visible 404, which an operator reads and
acts on. A Studio screen shadowed by a proxied route comes back as a plausible
page nobody ever notices. Sending the unknown to the application puts the
failure where it can be seen.

One carve-out: a `GET` of `/` redirects into the prefix, so the printed URL's
origin opens Studio. It is restricted to navigations because `/` is a legal MCP
endpoint path and MCP speaks `POST` and `OPTIONS` — a redirect answering every
method would be exactly the silent shadow the prefix exists to prevent.

## Sharing an origin is paid for at the proxy

Putting the application on Studio's origin is what removes CORS and the URL
field, and it hands three things back that have to be paid for explicitly.

An application document rendered on the Studio origin would run in the origin
holding the operator's Admin Credential — an application XSS would become
administrative access. Every proxied response therefore carries
`Content-Security-Policy: sandbox`: an opaque origin, no scripting, no access to
Studio's storage. It is a document directive, so the SPA's own `fetch` and
WebSocket calls to those same routes are untouched, and the shell — served from
the bundle, never proxied — keeps its full origin.

Cookies do not cross the hop in either direction. They are scoped by host and
ignore the port, so forwarding them would carry an unrelated local service's
cookie out to a remote `--url` target and land that target's `Set-Cookie` on
every local service sharing the host. AckerDB authenticates with bearer
credentials and sets none, so this costs nothing and closes both directions.

And every request is confined to the configured origin by assignment rather than
resolution: a path beginning with `//` is a scheme-relative URL, so resolving it
against the target would let a request name a host of its own and be dialled
with the caller's headers and body.

## Studio serves while the application does not

A down application is an answer, not a crash: the shell loads, proxied HTTP
answers `502` naming the target, proxied WebSockets close with `1011`, and the
connect screen shows *application unreachable*. There is no boot-order
requirement between the two processes, and an operator who typed the wrong port
reads a diagnosis instead of finding a dead port.

This is also why the bundle is required at start. A Studio that served without
a shell would be a port that answers and shows nothing — the failure the rule
above exists to avoid, arrived at from the other side.

## The credential is a source, and it lives in the tab

Studio authenticates with an Admin Credential, held in `sessionStorage` in the
tab it was typed into. A reload does not ask again; closing the tab forgets.
Nothing writes it to `localStorage`, to a cookie, or into a URL.

It reaches the client through `credentialSource` rather than as a fixed
`credential`. The React provider's lifetime key includes a bearer token, so a
fixed credential would make signing in — and every later rotation — close the
client and construct a new one, dropping every live subscription for a value the
client is built to re-pull on its own.

The connect state is decided by an authenticated probe against
`admin.system.info` — one request, not a subscription. Deciding whether a
credential can open a session by watching a session open is circular: a client
that has never connected reports "connecting" indefinitely, which is exactly the
stopped application the operator ran the command to diagnose. A request either
comes back or does not, and the proxy's own `502` is part of the answer rather
than a silence. It is also why the probe rather than the handshake decides
refusal: a credential can authenticate perfectly and hold no `_admin:` grant.

Connected needs the client's own authentication phase as well. A request answers
before a socket does, so the probe alone would report connected while the
session is still being established — or never is, which is the plausible-looking
answer this whole design refuses elsewhere. When the two facts disagree the
screen names which half failed, because "your credential was refused" and
"Studio cannot hold a session with a credential that plainly works" send an
operator to entirely different places.

## The bundle is built by an explicit release stage

`@ackerdb/studio` is the first package in this repository that publishes a built
artifact. Every other one ships TypeScript source, so packing has never needed a
build.

It is not a `prepack` hook. The pipeline disables lifecycle scripts in three
places on purpose — `bunfig.toml`'s `ignoreScripts`, the release install's
`--ignore-scripts`, and `bun pm pack --ignore-scripts` — so a hook would never
fire, and re-enabling one for a single package would trade away the
supply-chain posture those flags exist to hold. The build is an explicit,
ordered stage in `release.yml` instead, before `publish.ts` runs.

**The stage proves reproducibility, not just success.** An existing public
version is skipped only when its tarball is byte-identical, and a different one
is a hard collision, so a bundle that changed for no reason would make a resumed
or re-dispatched publication unrecoverable. The stage builds and packs twice and
compares tarball digests. Separately, the packed-package gate asserts that
`dist/index.html` actually shipped and that every asset it references shipped
beside it — `dist` is git-ignored at the repository root, so "the bundle is in
the tarball" is a fact that has to be checked rather than assumed.

## One cost accepted deliberately

**The proxy forwards no client address.** Every request reaches the application
from the `acker studio` process, so the pre-authentication fair-share bucket and
every log attribute it to that hop rather than to the operator's browser. The
honest fix would be a forwarding header plus a `trustedProxy` key in
`.ackerdb.config.json` wired through to the listener — a CLI and server change,
not a Studio one, and one that only means anything once Studio is exposed behind
a real reverse proxy. Until then Studio's traffic is one authenticated
administrative identity on a trusted hop, and loopback attribution describes
what actually made the request. Inventing a header the server has no way to
trust would describe something else.

## Consequences

- `@ackerdb/studio` joins the lockstep package set: thirteen packages, one
  version, one release.
- `docs/releases.md` gains a build stage. It is the authoritative procedure, so
  the stage is recorded there and not only in the workflow.
- The `acker` CLI gains one subcommand and no dependency. Resolution of an
  optional application-installed package now has one implementation shared with
  the WebRTC runtime.
- `/_studio/` is spent. A future framework route may not claim it, and Studio's
  own screens all live beneath it.
