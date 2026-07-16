# TanStack Start Admin-Panel Runtime

Sources: TanStack — Unknown; npm Registry — 2026-07-16 snapshot
Raw: [Project setup](../../raw/tanstack-start/tanstack-start-build-from-scratch.md); [Execution boundaries](../../raw/tanstack-start/tanstack-start-execution-boundaries.md); [Hosting and entry points](../../raw/tanstack-start/tanstack-start-hosting-and-entry-points.md); [Package versions](../../raw/framework-versions/2026-07-16-official-npm-latest-tags.md)
Updated: 2026-07-16

## Current package baseline

As of 2026-07-16, the official npm latest tags are:

| Package | Version |
| --- | --- |
| `@tanstack/react-start` | 1.168.28 |
| `@tanstack/react-router` | 1.170.18 |
| `vite` | 8.1.5 |
| `@vitejs/plugin-react` | 6.0.3 |
| `nitro` | 3.0.260610-beta |

The Start and Router version numbers intentionally differ. Start 1.168.28 directly depends on Router 1.170.18, so those exact pins form a coherent current set. Start remains documented as release-candidate software.

## Recommended runtime model for this demo

The admin panel is an authenticated, realtime application whose authoritative data and mutations already live in the separate dbzz server. It has no SEO requirement. Use **TanStack Start SPA mode** so the document shell is generated once and the dbzz React provider runs only in the browser.

This avoids two incorrect architectures:

- Do not proxy ordinary dbzz reads/writes through TanStack server functions. That adds a second network and authorization path and breaks the direct realtime client model.
- Do not make isomorphic route loaders create browser-only dbzz clients. TanStack loaders can execute in both environments.

If a future public route needs SSR, keep SPA mode as an explicit product decision or switch deliberately to selective SSR and place only the browser-dependent provider subtree behind `ClientOnly`/`ssr: false`. Do not scatter environment checks through query code.

## Vite and document setup

- Configure `tanstackStart()` before all adapters, and put the React plugin last.
- Without a production adapter: `[tanstackStart(...), viteReact()]`.
- With Nitro: `[tanstackStart(...), nitro(...), viteReact()]`.
- Keep the generated `routeTree.gen.ts` generated; do not edit it manually.
- The root route owns the HTML document and must include `HeadContent` and `Scripts`.
- Leave `verbatimModuleSyntax` disabled per the Start guide's server-code leakage warning.

## Server/client boundary

- `VITE_DBZZ_URL` is intentionally public client configuration. Never put secrets behind a `VITE_` prefix.
- Keep authentication credentials in the dbzz client's intended credential transport; do not duplicate them in a TanStack cookie/session unless a real server-rendered flow requires it.
- Server functions are same-origin RPC endpoints for Start code, not a generic backend. Use them only for genuinely Start-owned server behavior.
- Server routes are for raw/external HTTP endpoints; the demo already has a dbzz backend and should not add parallel APIs.
- Custom `src/client.tsx` and `src/server.ts` are optional. Keep the defaults unless the app needs custom hydration, error boundaries, request context, or server rendering behavior.

## Build and serving choices

For the preferred SPA-only admin panel, `vite dev` and `vite build` are sufficient; serve the generated shell/assets with a static server that rewrites application routes to the SPA shell.

If the demo retains Nitro for a local production server or later adds Start server features:

- Nitro's integration is still under active development and its current npm `latest` version is explicitly beta.
- Configure the Bun preset when Bun is the target runtime.
- The documented Node/Nitro production entry is `.output/server/index.mjs` after `vite build`.
- Keep adapter code out until the hosting/runtime requirement is concrete.

## See also

- [Expo SDK 57 runtime baseline](../expo/expo-sdk-57-runtime-baseline.md)
- [Expo UI and Native Tabs](../expo/expo-ui-and-native-tabs.md)
