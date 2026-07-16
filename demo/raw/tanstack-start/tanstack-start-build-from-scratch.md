# TanStack Start project setup

Source: [Build a Project from Scratch](https://tanstack.com/start/latest/docs/framework/react/build-from-scratch)
Collected: 2026-07-16
Published: Unknown

## Focused source notes

- Install `@tanstack/react-start`, `@tanstack/react-router`, React, React DOM, Vite, and the Vite React plugin for the Vite path.
- The documented scripts are `vite dev` and `vite build`.
- The Vite plugin order is significant: `tanstackStart()` first and the React plugin after it.
- The minimum application shape is `src/router.tsx`, `src/routes/__root.tsx`, and the generated `src/routeTree.gen.ts`.
- `routeTree.gen.ts` is generated when Start first runs; application code should not hand-maintain it.
- The root document must render `HeadContent` in `<head>` and `Scripts` in `<body>`.
- Recommended TypeScript settings include bundler module resolution, ESNext modules, ES2022 target, and strict null checks. The guide warns that enabling `verbatimModuleSyntax` can leak server bundles into client bundles.
