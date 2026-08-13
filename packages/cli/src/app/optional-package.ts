/**
 * Resolving an AckerDB package the application installs rather than the CLI.
 *
 * The WebRTC runtime works this way: installing it in the application is the
 * opt-in, so the CLI declares no dependency on it.
 *
 * One resolver, because two would eventually disagree about the same tree.
 * Resolution runs from the application's own `package.json` so hoisting and the
 * package's `exports` conditions are read exactly as the application's runtime
 * reads them; a resolver differing in either could report a package missing
 * that the application can plainly import. What an absence *means* is the
 * caller's, which is why this answers with `null` instead of a message.
 */
import { createRequire } from "node:module";
import { join } from "node:path";

/** The entry file of `name` as the application resolves it, or null when absent. */
export function resolveAppPackage(appDir: string, name: string): string | null {
  const require = createRequire(join(appDir, "package.json"));
  try {
    return require.resolve(name);
  } catch {
    return null;
  }
}
