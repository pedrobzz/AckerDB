# Local Canvazz integration

Sources: Local Canvazz source tree, 2026-07-16
Raw: [Local Canvazz project contract](../../raw/canvazz/2026-07-16-local-canvazz-project-contract.md)
Updated: 2026-07-16

## Contract

The design workspace should be created with Canvazz's own project creator so
its Studio configuration, MCP setup, theme, source conventions, and embedded
skill stay aligned with the checked-out package. The dependency should be a Bun
link named `canvazz`, registered from the local package directory.

The demo root uses Bun's hoisted linker because Canvazz Studio is shipped
inside the package and resolves React and React DOM from its consumer. The root
`design:dev` command delegates to the generated design workspace, whose `dev`
script runs `canvazz dev` from the correct current working directory.

## Verification boundary

- `bun install` must resolve `canvazz` to the local registered link.
- The design package must pass strict TypeScript checking.
- `bun design:dev` must resolve the Canvazz CLI and reach Studio startup.
