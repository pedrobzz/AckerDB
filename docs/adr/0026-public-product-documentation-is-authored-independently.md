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

## Version publication contract

The website builds three independent public artifact kinds from a clean checkout
whose exact commit matches the requested publication identity. Latest bootstrap
establishes `/` and `/docs` without inventing history. Canary replaces only
`/docs/canary`. Stable publication advances `/docs` and adds immutable
`/docs/X.Y.Z` output generated from the same source commit and content build.
Route-specific HTML may differ because canonical URLs, links, and labels name
different public prefixes.

Every artifact inventories its owned routes and route-specific TanStack caches,
hashes every file, and records the hashed Vite assets referenced by Latest,
current Canary, or an immutable stable version. The host-neutral state transition
preserves stable history, rejects byte collisions and stable downgrades, removes
obsolete mutable files and unreferenced Canary assets, and activates the public
version catalog only after independently built Latest and Canary artifacts both
exist. A durable state record maps every stable SemVer to its commit and exact
historical artifact digest. Canary never enters history.

The existing npm workflow does not yet deploy these artifacts. A static host and
durable state store must be selected before adding the final adapter that applies
the generated put, delete, and catalog operations atomically or in a recoverable
order. This is one open deployment boundary, not an alternate publication path.
Content equality, branch aliases, optional Git tags, and GitHub Releases play no
role in the contract.
