# react-web fixture

Minimal browser consumer for `@ackerdb/client-react`: a real AckerDB server plus a
React page that connects through `AckerDBProvider` and renders
`useConnectionState` until it shows `ready`.

```sh
bun fixtures/react-web/server.ts
```

Then open <http://localhost:3210>. Bun bundles `app.tsx` through the HTML
import in `server.ts`; there is no separate build step. Stop and restart the
process to watch the connection state move between `ready` and `reconnecting`.

This fixture is a manual demo — the automated proof for provider behavior
lives in `packages/client-react/test`.
