# TanStack Start hosting and entry points

Source: [Hosting](https://tanstack.com/start/latest/docs/framework/react/guide/hosting); [Server entry point](https://tanstack.com/start/latest/docs/framework/react/guide/server-entry-point); [Client entry point](https://tanstack.com/start/latest/docs/framework/react/guide/client-entry-point)
Collected: 2026-07-16
Published: Unknown

## Focused source notes

- Client and server entry files are optional. Start supplies defaults; create `src/client.tsx` or `src/server.ts` only when initialization, error handling, request context, or rendering behavior must be customized.
- A custom client entry hydrates `StartClient` with React's `hydrateRoot`.
- A custom server entry exposes a universal fetch handler through `createServerEntry`; it handles SSR, server routes, and server-function requests.
- Nitro deployment requires the `nitro/vite` plugin after `tanstackStart()` and before the React plugin. TanStack warns that Nitro's Vite integration is under active development.
- The documented Node/Nitro production shape uses `vite build` and `node .output/server/index.mjs`.
- For Bun deployment with Nitro, the guide shows `nitro({ preset: "bun" })` and requires React 19+.
- A pure SPA with no Start server features can be served as static assets and does not require adding a server adapter merely for local development.
