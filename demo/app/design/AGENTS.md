# Canvazz project

This repository is a Canvazz design project. Its React and TypeScript source is
the design source of truth: screens are `artboard()` definitions, reusable
elements are `component()` definitions, and visual edits made in Canvazz Studio
write directly to the files under `src/`.

Before creating or editing any Canvazz design file, read and follow
[`Canvazz skill`](.agents/skills/canvazz/SKILL.md). It documents the supported
source shapes, stable IDs, theme and styling model, MCP workflow, validation,
screenshots, and comments.

Run `bun run dev` from the repository root to open Canvazz Studio. Prefer the
project's Canvazz MCP tools for design inspection and mutations when they are
available.
