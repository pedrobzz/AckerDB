# Studio's interface is vendored and dark only

Studio needs about twelve screens of dense operational interface — filterable
tables, a span waterfall, level-stacked histograms, JSON and stack-trace
viewers, generated argument forms — and this repository had no frontend at all
before it. The root lockfile named no bundler, no CSS framework and no component
library, and the one working Vite build in the tree belongs to the demo
workspace, which has its own lockfile and is pinned to a published version.

So the question was not which component library to add. It was what kind of
relationship to have with one.

The decision: **Studio's components are vendored — copied into this repository
to be modified and maintained by hand — and Studio has exactly one theme, which
is dark.**

## Copying is the relationship, not a shortcut to one

A dependency on a component library is a dependency on someone's release
cadence, their idea of a breaking change, and their willingness to keep shipping.
The chart family Studio wants is at `0.1.1`. The AND-chip filter builder,
time-range picker and detail sheet come from an observability company's registry
built for a log viewer — close enough to Studio's screens to be worth having,
and certain to need changes.

Both are distributed the way the shadcn/ui registry is: as source you copy. That
is the entire mechanism, and it is what makes the immaturity of a `0.1.x` chart
library a non-issue. Once copied the code is ours. We restyle it, delete the
parts we do not use, and update it when we choose rather than when someone
publishes.

The cost is real and is accepted: an upstream fix does not arrive on its own.
For sub-thousand-line interface code with no framework coupling, that is the
cheaper side of the trade — the alternative is a version bump that restyles
twelve screens.

**Vendored files say so.** Each names its origin and licence in its header and
records what was changed. Studio's button, for instance, drops the registry's
`asChild` and the `radix-ui` `Slot` behind it, because the one place a button
and a link want the same shape is the navigation, which styles its router links
directly — shipping a dependency for a polymorphism nothing asks for is exactly
what vendoring exists to avoid.

**Vendoring removes the registry, not the runtime.** Tailwind, the icon set, the
router, the table, the chart family: each is a real install, and every one obeys
the repository's seven-day dependency quarantine at the version it is pinned to.
The quarantine's waiver list is for advisory-driven security floors, and a
convenience waiver would be redefining the rule rather than applying it.

**A component is vendored by the screen that renders it.** The stack is decided
in full, but nothing is copied in ahead of a screen that uses it. Vendored code
is code we maintain; carrying a filter builder that filters nothing would be
maintaining an unrendered guess about a screen not yet designed, and the first
pull request that meets the real query shape would rewrite it anyway.

## One theme, and it is dark

A light theme is not half the work of a dark one — it is a second visual review
of every screen, every state, and every chart, for a tool that runs beside a
terminal. Studio ships dark only, with no toggle and no `prefers-color-scheme`
branch, so a token is a single fact rather than a pair that has to agree.

The token *names* are the registry's, deliberately, so copied components drop in
unmodified. Their values are the dark ones directly, which is why every `dark:`
variant is stripped from vendored files as they are copied: with no `.dark`
class ever set, those utilities could only be dead weight in the stylesheet and
a lie to the next reader.

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
