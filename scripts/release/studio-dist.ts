// The @ackerdb/studio SPA bundle. `dist/` is git-ignored and built at release
// time: release:prepare proves the bundle builds, and every packing path —
// publish (beta and npm) and the packed-package gate — builds it before the
// tarball is produced, so the published package always ships a fresh bundle.
import { existsSync } from "node:fs";
import { join } from "node:path";

export const STUDIO_DIRECTORY = "packages/studio";
export const STUDIO_DIST_DIRECTORY = join(STUDIO_DIRECTORY, "dist");

export function buildStudioDist(): void {
  const result = Bun.spawnSync(["bun", "run", "build"], {
    cwd: STUDIO_DIRECTORY,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `the @ackerdb/studio bundle failed to build:\n${result.stdout.toString()}${result.stderr.toString()}`,
    );
  }
  if (!existsSync(join(STUDIO_DIST_DIRECTORY, "index.html"))) {
    throw new Error("the @ackerdb/studio build produced no dist/index.html");
  }
}
