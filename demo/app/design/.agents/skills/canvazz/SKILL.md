---
name: canvazz
description: How to read and edit a Canvazz project — artboards, components, the cz prop DSL, stable source ids, read-only regions, and the on-canvas comment workflow. Use whenever working in a repo that depends on `canvazz`.
---

# Working in a Canvazz project

Canvazz is a React framework for designing apps on an infinite canvas. **The
`.tsx` source is the single source of truth.** The visual editor (Canvazz Studio,
`canvazz dev`) reads and writes the same files you edit by hand.

## Project shape

```
src/
├── screens/      # full screens — artboards live here
├── components/   # reusable components used across screens
└── theme.ts      # createTheme({ colors, fonts, spacing, radii, breakpoints })
```

Every `src/**/*.tsx` file is a "page". The crawler picks up new folders/files
automatically.

## Definitions

Only two top-level shapes are visually editable, and only in their direct form:

```tsx
export const Home = artboard({ id, width, height, render });
export const Hello = component({ id, schema, defaultProps, render });
```

- `artboard()` — a frame (Figma "Frame") holding nodes. No props; just size.
- `component()` — a reusable, schema-driven component.
- Wrapped/aliased factories, non-exported definitions, and dynamic factory args
  still render but are **code-only** (not visually editable).

## The `cz` prop DSL

`component().schema` uses `cz.*`. One definition drives validation **and** the
props-editor UI. It compiles to Zod internally.

```tsx
schema: {
  title: cz.string().max(40),
  opacity: cz.number().min(0).max(1).step(0.01),
  visible: cz.boolean(),
  fill: cz.color(),                 // hex or theme.colors.<token>
  align: cz.enum(['left', 'center', 'right']),
  padding: cz.object({ top: cz.number(), left: cz.number() }),
  tags: cz.array(cz.string()),
  header: cz.slot(),                // named JSX slot (default: null)
}
```

Rules: every `schema` key must have a matching `defaultProps` key. In v1 every
prop is required (no `cz.optional()`).

## Children & slots

Components wrap content: `render` receives `children` alongside the parsed
props (no schema entry needed), so `<Card>{...}</Card>` renders the instance's
JSX wherever the render places `{children}`. Named slots are ordinary schema
props declared with `cz.slot()` — instances pass JSX
(`header={<b>Hi</b>}`), defaults are usually `null`. In `get-page-model`, a
`{children}` / slot-prop reference inside a component render appears as a
`kind: "slot"` node (tag = slot name, read-only) marking where instance
content lands.

## Stable source ids

Editable JSX nodes carry a durable id used by the canvas, layer tree, comments,
and codemods:

- intrinsic nodes (`div`, `h1`, …) → `data-cz-id="cz_xxxx"`
- Canvazz component instances → reserved `czId="cz_xxxx"` prop

These are added automatically (do not hand-write them). **Never change or
reuse an existing id** — comments and metadata reference it. Duplicates are
invalid (the first occurrence wins).

## Dynamic regions & templates

JSX inside a `{...}` expression is edited at the template level. The common
shapes — `items.map(x => <Card/>)` callback bodies, ternary branches
(`cond ? <A/> : <B/>`), and logical right-hand sides (`cond && <A/>`) —
expose their single source template as an editable node; `get-page-model`
tags it with `template: { kind, label, branch? }`. Style, text, prop, and
structural edits land in the template and propagate to every rendered
instance.

- Per-instance data stays bound: text like `{item.title}` is not inline
  editable — change the binding in code.
- Structural edits cannot cross a region boundary (no dragging into or out of
  a `.map`); moves/wraps *inside* one template are fine.
- Deleting a template root rewrites it to `null` (render nothing); duplicating
  or reordering a template root is rejected — do that to nodes inside it.
- Genuinely opaque expressions (arbitrary calls, render props) stay code-only
  with a `readonlyReason`.

Nodes are also code-only when they use prop spreads, dynamic
`style={variable}`, computed style keys, or when className/Tailwind controls
the same property. Edit those in code.

## Theme

```tsx
import { theme } from '@theme';
<h1 style={{ color: theme.colors.primary }} />
```
Colors are hex; reference tokens with `theme.colors.<token>`. Add tokens in
`src/theme.ts`. The `breakpoints` category (number map, max-width px) is the
source of truth for responsive layer names — `get-theme` returns every
category, so check it before writing a responsive layer.

## Interaction states & responsive layers (czStyle)

Inline `style={{}}` is the **base** layer. Hover/focus/active states and
responsive overrides live in a static `czStyle` call on the same node:

```tsx
import { czStyle } from 'canvazz';
<button
  style={{ background: '#fff', transition: 'all 200ms ease' }}
  className={czStyle({
    hover: { background: theme.colors.primary },   // :hover override
    md: { padding: '8px 16px' },                   // applies at width <= md
  })}
/>
```

- Layer keys: `hover` / `focus` / `active`, plus breakpoint tokens
  (defaults `sm 640 / md 768 / lg 1024 / xl 1280`, or the theme's
  `breakpoints` map). Breakpoints are **desktop-first max-width** bounds.
- Layer rules always override the base (they are emitted with `!important`);
  a `transition` on the base animates state changes.
- Keep the argument a static object literal — dynamic layers are code-only.
- Responsive layers respond to the artboard's width (container queries), so
  they only apply inside an `artboard()`.

## Editing over MCP (prefer this when the `canvazz` MCP server is connected)

The `canvazz` MCP server exposes the Studio's own edit pipeline as tools. Each
write is validated, goes through the codemod (normalize → Prettier → atomic
write under a per-file lock), returns the fresh page model, and appears live
in a running Studio. Prefer these tools over hand-editing `.tsx` — you get
stable-id handling, read-only guards, and identical behavior to Studio edits.

Typical loop:

1. `list-project` → find pages (`{ files[], hasTheme }`).
2. `list-components` → inspect the design-system index: component ids, source
   files, compiled `cz` prop schemas, constraints/options, and `defaultProps`.
3. `get-page-model` → read a page's tree: stable `czId`s, `editable` /
   `readonlyReason` per node, style models, props, text.
4. Optional: `list-readonly-regions` for a page → compact `{ id, reason }`
   list of nodes produced by spreads or other code-only regions.
5. Mutate with the write tools — every write returns the updated model:
   - `apply-style` / `apply-styles` (batch = one write, one undo step); pass
     `layer: "hover" | "focus" | "active"` or a breakpoint token to edit a
     state/responsive czStyle layer instead of the base inline style
   - `set-text`, `set-prop`, `rename`
   - `insert-node` (pass `ensureImports` for components/icons), `delete`,
     `duplicate`, `reorder`
   - `reparent` — move a node (with its subtree, ids preserved) under a new
     parent container, optionally at a child `index`; refuses invalid targets
     (own subtree, void elements, dynamic regions). `wrap-in-container` — wrap
     one or more siblings in a new container (default `div`); `flow: "row" |
     "column"` writes a flex preset that explicit `style` keys override, and
     the wrapper gets a fresh id.
   - `extract-component` — lift a selection (one node or several siblings)
     into a new `component()` and replace it with an instance; the page
     renders identically. Free references become the minimal schema
     (enclosing-component props copy their cz def, local literal consts get
     an inferred kind, imports stay). Omit `file` to keep the definition in
     the page; pass e.g. `components/Card.tsx` to create/append a module
     (imported via the `@/` alias). Untypeable locals and, cross-file,
     module-level page bindings fail with a reason.
   - `set-artboard-size`, `add-prop`, `remove-prop`, `set-default-prop`
   - `create-page` (scaffold a new `screen` or `component` `.tsx`),
     `duplicate-artboard` (clone a whole root by `defId`; returns the new
     `defId`), `set-asset-src` (point a `staticAsset()`-backed src at another
     `public/` asset path)
   - `get-theme` + `apply-token` (binds a style prop to `theme.colors.<token>`)

Prop values for `set-prop` / `set-default-prop` use typed `AttrValue` payloads:
`{ kind: "string" | "number" | "boolean", value }`, `{ kind: "expr", code }`,
and recursive `{ kind: "array", value: AttrValue[] }` /
`{ kind: "object", value: Record<string, AttrValue> }`. Nested array/object
props must be static literals in source; spreads, computed keys, or dynamic
items come back read-only with a reason. `add-prop` supports
`string | number | boolean | color | enum | array | object | slot` and writes
matching `schema` + `defaultProps` defaults (`slot` → `cz.slot()` with a
`null` default; instances then pass JSX to it in source).

Errors (missing `czId`, read-only node, unknown token) come back as structured
tool errors — read the message, re-check the model, and retry; nothing is
half-written. Hand-editing `.tsx` remains valid (source of truth), but never
hand-write or change stable ids.

### Seeing your work (screenshots)

With a running Studio (`canvazz dev`) you can capture your work after editing:

- `screenshot` — one node/instance by stable id.
- `screenshot-artboard` — an artboard's full design surface by definition id,
  at 1:1 scale and full content height (even taller than the declared frame).
- `screenshot-canvas` — every frame on a page in one overview image.

Captures wait for fonts, lazy icons, and images to settle, and each result
includes the image's intrinsic pixel size. Review a screenshot after a batch
of edits — don't design blind.

### Verifying changes (diffs)

Before an edit you may capture a reference:

- `capture-change-reference` with `{ page }` stores the current parsed model and
  returns `{ ref, epoch }` for later `what-changed` checks.
- `capture-change-reference` with `{ page, id }` also stores a visual PNG
  baseline for that node/artboard; this requires a running Studio.

After editing:

- `what-changed` with `{ page, sinceEpoch }` returns `{ added, changed,
  deleted }` stable ids from the model diff. Omit `sinceEpoch` to use the
  latest captured reference for that page.
- `visual-diff` with `{ page, id, sinceRef? }` captures the current rendered
  target and returns `changedRegions` plus `pngDiff` (base64 PNG overlay).

### Measuring your work (perception)

Don't guess layout from pixels — measure it:

- `get-geometry` — artboard-local boxes for a subtree with per-node flags:
  `overflow` (extends beyond its parent), `clipped` (cut by an ancestor),
  `textWrapLines` (line count). Use it to catch misalignment, overflowing
  flex children, and unexpected wrapping.
- `get-computed-styles` — the *rendered* values from `getComputedStyle`
  (theme tokens, cascade, and shorthands resolved to real px + hex).
- `check-contrast` — WCAG contrast ratio + level for every text fg/bg pair
  (large-text aware), plus roles, image alt text, and tab order.

A good design pass: edit → `get-geometry` for layout sanity →
`check-contrast` for readability → `screenshot-artboard` for the final look.

## Comments (how the user talks to you)

Comments live in `{Page}.canvas.json` next to each page. Each thread has an id,
`targetNodeIds` (the stable source ids), a `status`, the message list, and a
canvas position. Use the MCP comment tools for the full loop:

- `list-comments` — read all open/resolved threads.
- `reply-comment` — append a reply and keep the thread `pending`.
- `resolve-comment` — append a final reply and mark the thread `resolved`.
- `add-comment` — create a new agent-authored `pending` thread pinned to a
  page/node location.
- `screenshot-comment` — capture the first target node for a thread.

When you act on a thread, read the target nodes first. If you need
clarification, use `reply-comment` so the user still sees the thread as open.
After modifying the `.tsx` source for a request, use `resolve-comment` with a
short summary of what changed. Use `add-comment` to proactively annotate work
the user should review.

The user may reopen a thread (back to `pending`) or delete it.

## What lives where

- JSX, styles, props, schemas → `.tsx` source (edit these).
- Frame positions, labels, comments → `{Page}.canvas.json` (editor metadata only;
  never put JSX/props/styles here).
