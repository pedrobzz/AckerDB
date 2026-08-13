/**
 * The AckerDB build this code belongs to, read from the manifest that ships it.
 *
 * Every AckerDB package moves in lockstep and the release tooling rewrites all
 * thirteen manifests immediately before packing, so `@ackerdb/core`'s own
 * `version` field is the build's identity — including the `-canary.N` and
 * `-beta.N` suffixes a prepared source version publishes under, which are
 * separate builds and must compare as such. Importing that field rather than
 * generating a constant beside it is what leaves nothing to disagree: there is
 * no second place a release step could forget to move.
 *
 * The import is a module import and not a filesystem read because both sides of
 * the wire need this fact. AckerDB ships TypeScript source, so a browser or
 * React Native client reaches core through a bundler, which resolves and inlines
 * the manifest; a Bun or Node server resolves the same specifier at runtime. A
 * `readFileSync` would answer on the server and be unbundleable on the client,
 * which is precisely the asymmetry that would put the client's version
 * somewhere else.
 */
import manifest from "../package.json" with { type: "json" };

export const ACKERDB_VERSION: string = manifest.version;
