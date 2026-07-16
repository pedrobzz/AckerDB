---
Source: file:///path/to/canvazz/packages/canvazz
Collected: 2026-07-16
Published: Unknown
---

# Local Canvazz project contract

The checked-out package is named `canvazz`, exposes `canvazz` and
`canvazz-mcp` binaries, and requires Bun 1.3 or newer. Its project creator
copies `packages/canvazz/templates/default`, restores the shipped dotfiles,
replaces the project name and dependency token, and initializes a Git
repository. The creator accepts an internal `--canvazz-dep` argument used to
set a local dependency instead of the published package version.

The generated project runs the Studio through this script:

```json
"dev": "canvazz dev"
```

The Studio resolves the current working directory as the project root, scans
the configured `src` directory, and starts on port 4321 unless another port is
provided. A project contains `src/screens`, `src/components`, and
`src/theme.ts`. Screens export direct `artboard()` calls and reusable elements
export direct `component()` calls.

The package's Vite setup requires a hoisted dependency layout so the Studio
inside the installed package can resolve React and React DOM from the consuming
project.

## Source files

- `/path/to/canvazz/packages/canvazz/package.json`
- `/path/to/canvazz/packages/canvazz/src/cli/create-app.ts`
- `/path/to/canvazz/packages/canvazz/src/cli/dev.ts`
- `/path/to/canvazz/packages/canvazz/templates/default/README.md`
- `/path/to/canvazz/bunfig.toml`
