# Studio

Studio is the opt-in observability and administration client for one AckerDB
application. It runs outside the application's process, authenticates with an
Admin Credential rather than as an application user, and consumes only the
[Admin API](admin-api.md).

It is a client, not a component of the server. Nothing about it is compiled into
your application, and an application that never installs it is unchanged in
every way.

## Installing and running it

```sh
bun add -d @ackerdb/studio
acker studio            # or: acker studio ./my-app --url https://app.example.com --port 4680
```

Installing the package **is** the opt-in. The `acker` CLI declares no dependency
on it: `acker studio` resolves `@ackerdb/studio` from the application's own
`node_modules` at run time and, when it is absent, prints the install hint and
stops.

The command prints a URL and never opens a browser — it is as likely to run over
SSH as on a laptop:

```
[ackerdb] Studio serving at http://127.0.0.1:4680/_studio/ — proxying to http://127.0.0.1:3211
[ackerdb] copy the URL into a browser; Ctrl+C stops Studio
```

| argument | what it does |
| --- | --- |
| `[app-dir]` | Where `.ackerdb.config.json` is read from. Defaults to `.` |
| `--url <origin>` | Proxy to this origin instead of the configured listener. Must be a bare `http`/`https` origin |
| `--port <n>` | Studio's own port. Defaults to `4680` |

Without `--url`, the target is the application's configured `hostname` and
`port`. A wildcard bind (`0.0.0.0`, `::`) is an interface list rather than an
address to dial, so it becomes loopback.

## One origin

The `acker studio` process serves the Studio bundle **and** proxies HTTP,
WebSocket, and SSE to the application. The browser only ever talks to the origin
it loaded from, which means:

- **No CORS.** The application needs no configuration to be viewed in Studio.
- **No URL field, ever.** The connect screen asks for a credential and nothing
  else. A field naming a server would put an Admin Credential one typo away from
  an origin nobody chose.
- **One port to expose.** Reaching Studio from elsewhere is one port, and
  exposing it — reverse proxy, TLS, network policy — is deliberately your
  decision, not a default.

Because `--url` reaches a deployed application over the network, nobody ever has
to run a UI process inside a production machine.

### What belongs to which side

Studio serves the bundle under one path prefix, `/_studio/`, and proxies
everything else. The prefix carries the reserved `_` marker, the character an
application may never begin a name with, so no application can collide with it
by declaring an API path or an MCP path.

The rule runs the other way too, and deliberately: **a path neither side
recognizes goes to the application.** An application group named `logs` or
`database` therefore keeps answering through Studio's origin, and a path nobody
serves comes back as the application's own 404. The alternative — treating
anything HTML-ish as a Studio route — hides a shadowed application route behind
a plausible-looking page nobody notices.

The single exception is a browser landing on the bare origin: a `GET` of `/`
redirects into `/_studio/`. It is restricted to navigations because `/` is a
legal MCP endpoint path and MCP speaks `POST`.

Every request is confined to the one origin `acker studio` was pointed at,
whatever its path claims. Sharing an origin also has two consequences the proxy
holds deliberately:

- **Every proxied response carries `Content-Security-Policy: sandbox`**, so an
  application document rendered on the Studio origin runs in an opaque origin
  with scripting off and cannot read the credential Studio holds. It is a
  document directive: the SPA's own `fetch` and WebSocket calls to those same
  routes are untouched, and the shell — served from the bundle, never proxied —
  keeps its full origin.
- **Cookies do not cross the hop in either direction.** They are host-scoped and
  ignore the port, so forwarding them would carry another local service's cookie
  out to a remote `--url` target and land that target's `Set-Cookie` on every
  local service sharing the host. AckerDB authenticates with bearer credentials
  and sets no cookies, so nothing is lost.

### While the application is down

Studio serves anyway. The shell loads, the connect screen shows *application
unreachable*, proxied HTTP answers `502` and proxied WebSockets close with
`1011`, and the client reconnects on its own when the application comes up.
There is no boot-order requirement between the two processes, and an operator
who typed the wrong port reads a diagnosis instead of finding a dead port.

## Signing in

Studio authenticates with an **Admin Credential** — an identity credential whose
grant covers the framework's reserved vocabulary. Nothing else opens the Admin
API: the most generous application grant, a bare `*`, deliberately excludes
every `_admin:` scope. See [Scopes and identity credentials](scopes.md).

A server whose vault holds none issues one at startup and prints the plaintext
once; that is the value to paste into the connect screen. `acker credential
reset` is the recourse if it was never copied. See
[Boot-mint](admin-api.md#boot-mint).

The credential is held in `sessionStorage`, in the tab you typed it into. A
reload does not ask again; closing the tab forgets it. It is never written to
`localStorage`, to a cookie, or into a URL.

It reaches the client as a **credential source** rather than a fixed credential,
which is what makes signing in and later rotations reconnect nothing: a fixed
credential would make the React provider close its client and construct a new
one on every change, dropping every live subscription.

The connect screen has six honest states:

| state | what it means | what to do |
| --- | --- | --- |
| connecting | nothing has settled yet | wait |
| application unreachable | the application is not answering Studio | start it, or check the target |
| sign in | the application answers and Studio holds no credential | sign in |
| credential refused | the credential was rejected, or holds no admin grant | use another credential |
| signed in, no session | the credential opens the Admin API and Studio still cannot hold a session — a Studio on a different AckerDB version than the application is the cause this reaches in practice | install the Studio matching the application's AckerDB |
| connected | signed in, showing what `admin.system.info` named | proceed |

Reachability is read before anything about credentials, because a stopped
application makes every statement about a credential unknowable.

The verdict comes from an **authenticated probe** — one request to
`admin.system.info` on the Studio origin — rather than from a live subscription,
because it has to answer *before* a session exists. A client that has never
connected reports "connecting" indefinitely, which is exactly the
application-down case the screen must diagnose; the proxy's own `502` is a
first-class answer instead of a silence. It is also why the probe rather than
the handshake decides refusal: a credential can authenticate perfectly and hold
no `_admin:` grant.

"Connected" needs both facts, though. A request answers before a socket does, so
the probe alone would report connected while the session is still being
established — or never is. When the two disagree the screen names which half
failed, because "your credential was refused" and "Studio cannot hold a session
with a credential that plainly works" send you to entirely different places.

The second of those has one cause in practice, and the screen names it outright:
the Admin API answers over plain HTTP, which carries no version, while the
socket refuses a frame from any build but its own. `admin.system.info` already
reported the application's AckerDB version, and that version is the whole
compatibility contract, so a Studio built from a different one names the exact
package to install rather than passing along whatever the transport called the
failure.

## The shell

Once Studio is connected, every screen renders inside one frame: the navigation
on the left, the connected application across the top, and the screen itself in
the rest.

**The header names the application, and it reads `admin.system.info` to do it.**
Nothing on the wire identifies an application — the welcome frame describes
authentication — and Studio shares an origin with what it proxies, so
`window.location` names the proxy. It is a live query rather than the connect
probe's answer: the probe's copy is a snapshot from before the session existed
and stops refreshing once Studio is connected, and a header still claiming the
version from before a deploy is a header you learn to distrust.

**Each screen is its own route, and the gate wraps the shell rather than
redirecting to a connect page.** A link to a screen is therefore a link to that
screen even in a tab holding no credential yet: you sign in and arrive where the
link pointed. The same property is what filters will need when they become
search parameters — the address bar is the state, so a screen can be sent to
someone else instead of described.

**Each screen also gets its own error boundary**, keyed by route, so a screen
that throws leaves the navigation and the header standing and you can walk out
of it. One boundary around everything would be the same amount of code and turn
any screen's bug into a blank page.

Screens whose feature has not landed say what they will hold rather than that
they are missing. A page reading only "coming soon" teaches an operator that
Studio is a promise; naming what will be there is both honest and the most
useful thing an empty page can say.

## How Studio is built

**Everything Studio displays comes through `@ackerdb/client-react`**, against the
typed Admin API tree `@ackerdb/core` exports. There is no second data stack and
no privileged side channel: Studio is an ordinary client of the same public
surface an application uses, which is what makes awkwardness in it a framework
gap to fix rather than a reason to reach past it. The one deliberate exception
is the connect probe, and it exists because it has to answer before a session
does — see above.

**Interface components are vendored, not depended on.** Code from the
[shadcn/ui](https://ui.shadcn.com) registry is copied into `src/app/ui/` to be
modified and maintained by hand; each file names its origin and licence in its
header and records what was changed and why. Copying costs an update we perform
deliberately and buys freedom from anyone's release cadence — and the freedom to
delete what we do not use, which is why Studio's button carries no polymorphic
`asChild` and no Radix dependency behind it.

**Dark only.** There is no theme toggle and no `prefers-color-scheme` branch. A
second theme doubles visual review over every screen for a tool that runs beside
a terminal; it ships when it is worth that, and until then a token is a fact
rather than a pair. `src/app/theme.css` holds every value, under shadcn's own
token names so registry code drops in unmodified.

The accent scale is [dither-kit](https://tripwire.sh/dither-kit)'s seed palette
to the byte. The observability screens paint their charts from those exact
fills, so a chart shares its hues with the interface around it rather than
sitting in the page as a differently-coloured rectangle.

Dependencies arrive with the screen that needs them rather than ahead of it: the
stack decided in the UI-stack resolution — the data-table registry, the chart
family, the code and JSON viewers, the form library — is installed and vendored
by the pull request that first renders one. Nothing is carried in the bundle for
a screen that does not exist yet.

### Bounded tables and a grow-only window

`usePaginatedQuery` grows and never shrinks: `loadMore` extends the window, and
there is no page count, no jump-to-page, and no way to release a loaded page.
That is the right model for the infinite-scrolling streams the observability
screens are, and it is the whole model Studio uses.

Two consequences are accepted deliberately. A screen reports how much it has
loaded and whether the sequence is `exhausted` — never "N of M", because the
count does not exist and inventing one would mean a second query answering a
question nobody asked. And a table resets its window whenever its filters
change, which the argument key already does for free, so a long session cannot
accumulate depth across filters.

Studio does not put a windowing layer on top. If bounded windows turn out to be
genuinely needed, that is a change to the framework's paginated query, not
something Studio should reimplement beside it.

## What the application sees

Every request arrives from the `acker studio` process, so the application
attributes it to that hop's address rather than to the operator's browser.
Studio forwards no client address and sets no forwarding header — the server
honours `X-Forwarded-For` only behind a configured `trustedProxy`, which
`.ackerdb.config.json` has no key for. Studio's traffic is one authenticated
administrative identity on a trusted hop, so loopback attribution is the honest
description of what actually made the request.

## Building it inside the monorepo

`packages/studio/dist/` is git-ignored and produced at release time; see
[Releases](releases.md#the-studio-build-stage). Working on Studio locally:

```sh
cd packages/studio
bun run build   # produce dist/, which `acker studio` serves
bun run dev     # the Vite dev server, for developing Studio itself
```
