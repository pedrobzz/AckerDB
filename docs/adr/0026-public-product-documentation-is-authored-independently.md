# Product documentation is an independently published website

AckerDB's Product documentation is a handwritten application-developer surface
owned by the public website. The root `docs/` tree remains Engineering
documentation for maintainers and agents; internal contracts, research,
handoffs, release machinery, and historical records are never reused or
automatically published as Product documentation.

## Website and navigation

One `website/` application owns the future landing page and `/docs`. It uses
TanStack Start and Fumadocs, prerenders every route as static output, and has no
runtime SSR dependency. Content metadata is the single source of its page tree;
Fumadocs primitives render ordinary documentation behavior, while custom
interactive components use shadcn/ui.

## Experience

The site defaults to a white-on-black grayscale system with one legible
sans-serif monospaced family throughout, sharp geometry, subtle borders, no
shadows, and color reserved for meaningful information. Light mode remains
switchable and functional without becoming an equal visual-polish target.
Interactions must feel instant: CSS transitions are preferred, Framer Motion is
reserved for behavior that earns it, and every initiated animation finishes
within 250 milliseconds.

## Onboarding

Basic Usage starts inside a Bun-workspace monorepo with `apps/server`,
`apps/web`, and one `packages/ackerdb-generated` package. The server's
`.ackerdb.config.json` explicitly places generated code in that package, giving
server declarations and the React frontend one direct contract without
cross-application relative imports, wrappers, or alternative onboarding layouts.

## Version publication

Product documentation is published from the exact commits that publish AckerDB
packages. A successful Canary publication replaces `/docs/canary`; a successful
stable publication replaces `/docs` and preserves the same bytes under immutable
`/docs/X.Y.Z`, with a durable version-to-commit-to-artifact manifest. Content
equality, branch aliases, optional Git tags, and GitHub Releases play no role in
this model.
