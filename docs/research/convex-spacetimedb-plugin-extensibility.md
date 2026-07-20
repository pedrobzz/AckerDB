# Convex and SpacetimeDB: plugins, extensions, and codegen

**Conclusion:** Convex has a first-class reusable backend extension model named
**Components**. SpacetimeDB does not have an equivalent plugin/module-mounting
model or a supported codegen-plugin API.

## Comparison

| Question | Convex | SpacetimeDB |
| --- | --- | --- |
| Backend plugin-like concept | **Components** — officially named reusable backend modules with their own tables, schema, functions, and isolation boundary. | **No.** A module is the complete deployed backend for one database, not a mountable child extension. |
| How to author | `npx create-convex@latest --component`, then `defineComponent()` in `convex.config.ts`. | Build an ordinary Rust, TypeScript, C#, or C++ module and publish it as the database's backend. |
| How to distribute | Local source or an NPM package that exports its config and generated `ComponentApi`. | Normal language packages compile into the consuming module; publishing deploys/replaces the whole module. |
| How host code consumes it | `defineApp().use(component)` and `components.<instance>` generated references. | There is no install/mount mechanism. |
| Codegen impact | Component-specific `_generated/` output plus a typed host-facing `ComponentApi`; the host's generated API gains the mounted component. | Codegen reads the one module schema and generates bindings for tables, views, reducers, procedures, and types. |
| Custom codegen plugin | No documented public generator-registration hook found. | No supported plugin protocol. The stock CLI accepts only TypeScript, C#, Rust, and Unreal C++ targets. |

## Convex: use Components, not the generic word “plugin”

A Component is more than a shared library: it owns persistent state and an API
boundary. The component author either keeps it local or packages it for NPM.
For a package, generate the Component first, then build and publish the package;
the host imports its `convex.config.js`, mounts it, and runs `convex dev`.

Component codegen makes the isolation visible in types. The component gets its
own `_generated/` tree; its `ComponentApi` is the contract the host imports;
and the host sees it at `components.<instanceName>`. Component functions are
only internally callable by the host, so public browser access requires an
explicit app-owned wrapper. This gives the host control over authentication and
HTTP exposure. [Convex Component authoring](https://docs.convex.dev/components/authoring), [using Components](https://docs.convex.dev/components/using)

Convex also has literal **Agent Plugins** for Codex, Claude Code, and Cursor.
They bundle MCP access, hooks/monitors, and skills for the coding assistant;
they are unrelated to Components and do not add application runtime/codegen
extension points. [Convex Agent Plugins](https://docs.convex.dev/ai/convex-plugins)

## SpacetimeDB: one module, fixed generator targets

SpacetimeDB's module is the application's database schema and server logic.
There is no documented plugin registry, module nesting/mounting, or independent
plugin lifecycle. Reusable source code is an ordinary language dependency that
compiles into the one deployable module. [SpacetimeDB databases and modules](https://spacetimedb.com/docs/databases/), [building and publishing](https://spacetimedb.com/docs/databases/building-publishing/)

`spacetime generate` generates client bindings from that whole module. The
documented targets are TypeScript, C#, Rust, and Unreal C++; the CLI's current
`Language` enum and dispatch are fixed to those targets. A custom generator is
possible only as source-level/fork-maintained work around the `Lang`
trait, not as an installable, supported extension. [Client bindings](https://spacetimedb.com/docs/clients/codegen/), [generation configuration](https://spacetimedb.com/docs/cli-reference/spacetime-json/#generate-configuration), [CLI dispatch](https://github.com/clockworklabs/SpacetimeDB/blob/master/crates/cli/src/subcommands/generate.rs)

The Unreal SDK is distributed as an Unreal Engine plugin, but that is a client
SDK packaging detail—not a plugin system inside SpacetimeDB or a codegen hook.
[Unreal client docs](https://spacetimedb.com/docs/clients/unreal/)

## Practical naming rule

- Say **Convex Component** for a reusable backend extension.
- Say **Convex Agent Plugin** only for the coding-agent integration.
- Say **SpacetimeDB module** for the full application backend.
- Do not call either platform's code-generation pipeline plugin-extensible
  without first designing and supporting a stable generator protocol.
