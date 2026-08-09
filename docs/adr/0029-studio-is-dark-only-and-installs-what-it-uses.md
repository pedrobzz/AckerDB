# Studio is dark only and installs what it uses

Studio needs about twelve screens of dense operational interface — filterable
tables, a span waterfall, level-stacked histograms, JSON and stack-trace
viewers, generated argument forms — and this repository had no frontend at all
before it. The root lockfile named no bundler, no CSS framework and no component
library, and the one working Vite build in the tree belongs to the demo
workspace, which has its own lockfile and is pinned to a published version.

The decision: **Studio has exactly one theme, which is dark, and it carries no
component it does not render.**

## Components come from a registry, because that is how they are published

Studio's components come from the shadcn/ui registry, and the openstatus
registry supplies the filter builder, time-range picker and detail sheet. A
registry publishes source: `shadcn add button` writes the component into the
project. That is the tool's design, not a choice made here — there is no package
to import instead.

Everything else is an ordinary pinned dependency: Tailwind, the router, the icon
set, the table, the chart family. Each obeys the repository's seven-day
dependency quarantine at the version it is pinned to. The quarantine's waiver
list is for advisory-driven security floors, and a convenience waiver would be
redefining the rule rather than applying it.

Registry code arrives as a starting point rather than a black box, so Studio
trims it to what it renders. The button drops the registry's `asChild` and the
`radix-ui` `Slot` behind it: the one place a button and a link want the same
shape is the navigation, which styles its router links directly, and a
dependency for a polymorphism nothing asks for is weight no reader can justify.
Each file names where it came from and what changed, so the next person can diff
it against upstream instead of guessing.

## Nothing arrives before the screen that renders it

The stack is chosen in full, but a component enters when a screen needs it.
Carrying a filter builder that filters nothing is an unrendered guess about a
screen not yet designed, and the first pull request that meets the real query
shape would rewrite it anyway.

## One theme, and it is dark

A light theme is not half the work of a dark one — it is a second visual review
of every screen, every state, and every chart, for a tool that runs beside a
terminal. Studio ships dark only, with no toggle and no `prefers-color-scheme`
branch, so a token is a single fact rather than a pair that has to agree.

The token *names* are the registry's, deliberately, so components drop in
unmodified. Their values are the dark ones directly, which is why every `dark:`
variant is stripped as a component is trimmed: with no `.dark` class ever set,
those utilities could only be dead weight in the stylesheet and a lie to the
next reader.

**The accent scale is the chart family's seed palette, to the byte.** The
observability screens paint ordered-dither fills from those exact values, so a
chart shares its hues with the interface around it instead of sitting in the
page as a differently-coloured rectangle. The level meanings the Logs screen
fixes ride the same tokens — error red, warn orange, info blue, debug grey, and
framework purple, which is also Studio's primary. This is the whole reason the
component layer and the chart layer were chosen as one piece rather than
separately.

## Consequences

- `@ackerdb/studio` is the first package here with a browser toolchain: its own
  TypeScript project with `jsx`, wired into `bun run typecheck`, and a test
  directory that must run in the same `bun test` invocation as
  `@ackerdb/client-react` because registering a DOM is process-wide.
- The DOM registrar those suites share moved to `ackerdb-test-support/dom`,
  since two packages now need it and a test harness reaching into another
  package's test tree is not a seam.
- Studio's tests assert what a DOM without layout can honestly answer. React's
  `onChange` does not fire under happy-dom even with the event and the value
  tracker both demonstrably correct, so the connect form's submit path is
  proven against a real browser and a real server instead of simulated.
- A light theme, if it ever ships, is one file's worth of change plus a full
  visual review. That review is the cost being deferred, and it is the whole
  reason for deferring it.
