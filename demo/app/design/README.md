# @demo/design

A [Canvazz](https://github.com/pedrobzz/canvazz-v2) project — design your React app on an infinite canvas.

## Develop

```bash
bun install
bun run dev
```

This launches the Canvazz Studio. Every `src/**/*.tsx` page shows up in the left
sidebar; open one to see its `artboard()`s and `component()`s rendered on the
canvas. Edits you make visually are written straight back to your `.tsx` source.

## Structure

```
src/
├── screens/      # full screens (Home, Login, …) — artboards live here
│   └── Home.tsx
├── components/   # reusable components used across screens
│   └── Hello.tsx
└── theme.ts      # colors, fonts, spacing
```

## Concepts

- `artboard({ id, width, height, render })` — a frame that holds your nodes.
- `component({ id, schema, defaultProps, render })` — a reusable, schema-driven
  component. `schema` uses the `cz.*` DSL, which drives both validation and the
  props editor.
- `theme.ts` — `createTheme({...})`; reference tokens with `theme.colors.<token>`.

Bring your own agent (Claude Code, Cursor, Codex, …) and leave comments on the
canvas for it to act on — the source is the single source of truth.

Codex discovers the project MCP server from `.codex/config.toml` after you trust
the repository. Claude Code discovers it from `.mcp.json` and asks for one-time
approval before connecting. Both launch the locally installed `canvazz-mcp`
bound to this repository.

## Running in this monorepo

Canvazz is the `app/design` workspace. Install dependencies from the demo root
so Bun resolves the workspace and its published Verdaccio dependency together:

```bash
cd /path/to/ackerdb/demo
bun install
bun run design:dev
```

The root `design:dev` script delegates to `bun run --cwd app/design dev`. Keep
`canvazz` pinned to an exact Verdaccio version in `app/design/package.json` and
keep the registry in the root `.npmrc`. Do not use `bun link` for Canvazz in
this monorepo.
