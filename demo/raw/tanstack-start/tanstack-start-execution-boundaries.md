# TanStack Start execution boundaries

Source: [TanStack Start overview](https://tanstack.com/start/latest/docs/framework/react/overview); [Code execution patterns](https://tanstack.com/start/latest/docs/framework/react/guide/code-execution-patterns); [SPA mode](https://tanstack.com/start/latest/docs/framework/react/guide/spa-mode); [Server functions](https://tanstack.com/start/latest/docs/framework/react/guide/server-functions)
Collected: 2026-07-16
Published: Unknown

## Focused source notes

- TanStack Start is currently documented as release-candidate software: feature-complete with an API considered stable, but not yet final v1.
- Application modules and route loaders are isomorphic by default. A loader can run on the server for the first request and in the browser during client navigation.
- `createServerFn` creates a same-origin RPC boundary. The build replaces its browser implementation with an RPC stub; server code is not shipped to the client.
- Server functions are for calls from the Start app. Public or external HTTP consumers should use server routes.
- `createServerOnlyFn`, `createClientOnlyFn`, `createIsomorphicFn`, route SSR settings, and `ClientOnly` establish explicit execution boundaries.
- SPA mode is intended for applications that do not need SEO/SSR. It emits a prerendered shell, keeps client rendering simple, and can still coexist with server functions/routes or external APIs.
- Secrets belong inside server-only handlers. Public client configuration uses the build tool's public environment-variable prefix.
