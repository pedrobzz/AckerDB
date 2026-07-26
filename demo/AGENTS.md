# AckerDB Demo — agent instructions

This is the restaurant demo (Admin Panel, Customer App, AckerDB server, Canvazz
design). See [README.md](README.md) for the domain model, the apps, and the
scripts. The repo-root [AGENTS.md](../AGENTS.md) still applies here.

## Gradual Tailwind migration (Admin Panel)

`app/admin-panel` styling is mid-migration: Tailwind v4 is wired with
**preflight OFF** (`app/admin-panel/src/tailwind.css` imports the `theme` and
`utilities` layers only), while the legacy stylesheets in
`app/admin-panel/src/styles/*.css` remain unlayered and still own every current
rule. Because unlayered CSS outranks Tailwind's layered utilities, the two
coexist without fighting and existing pages stay pixel-identical.

Migrate it by attrition, never in a big bang:

- **Touch it, convert it.** Any admin-panel component or page you modify, you
  convert to Tailwind utilities in the *same* change — and delete the legacy
  CSS that those utilities replace (the specific rules/selectors, from the
  relevant `src/styles/*.css`). Don't leave the old class and the utilities
  both defining the same element.
- **New UI is Tailwind-native.** Write new components and pages with utilities
  and the theme tokens from `src/tailwind.css` (the Savoria palette, fonts, and
  radii, plus the shadcn semantic variables) from the start. No new legacy CSS.
- **No big-bang rewrite.** Do not mass-rewrite untouched pages "while you're in
  there." Only what your change already touches.
- **Preflight stays OFF** until the *last* legacy stylesheet under
  `src/styles/` is gone. Only when no legacy CSS remains do you switch the entry
  to the full `@import "tailwindcss"` (which turns preflight on) and drop the
  legacy `@import`s from `src/styles.css`. Never enable preflight while legacy
  CSS still relies on the browser defaults it would reset.

The design tokens live in `app/admin-panel/src/tailwind.css` and mirror
`app/admin-panel/src/styles/foundation.css` and `app/design/src/theme.ts` —
keep those in sync when a palette or type value changes.
