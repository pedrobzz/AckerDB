/**
 * The `@ackerdb/studio` SPA bundle: the one built artifact this repository
 * publishes.
 *
 * Every other package ships TypeScript source, so packing has never needed a
 * build. Studio does, and the pipeline that publishes it disables lifecycle
 * scripts everywhere — `bunfig.toml`'s `ignoreScripts`, the release install's
 * `--ignore-scripts`, and `bun pm pack --ignore-scripts` — by design, because a
 * packer that runs arbitrary scripts is a supply-chain hole. A `prepack` hook
 * would therefore never fire, and re-enabling one for a single package would
 * trade that posture away. So the build is an explicit, ordered stage instead:
 * `bun scripts/release/studio-dist.ts` runs before `publish.ts` in
 * `release.yml`, and every path that packs calls {@link buildStudioDist} first.
 *
 * **The stage proves reproducibility, not just success.** An existing public
 * version is skipped only when its tarball is byte-identical, and a different
 * one is a hard collision (docs/releases.md) — so a bundle that changed for no
 * reason would turn a resumed or re-dispatched publication into an unrecoverable
 * failure. Building twice into two tarballs and comparing digests is what makes
 * that rule hold for a built artifact.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fail } from "../lib.ts";
import { withPackageLicense } from "./package-license.ts";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");

export const STUDIO_DIRECTORY = join(REPOSITORY_ROOT, "packages/studio");
export const STUDIO_DIST_DIRECTORY = join(STUDIO_DIRECTORY, "dist");

/**
 * Build the bundle from this tree, replacing whatever was there.
 *
 * The previous `dist/` is removed first: the directory is git-ignored, so a
 * stale asset from an earlier branch would otherwise survive into the tarball
 * as a file nothing references and nothing rebuilt.
 */
export function buildStudioDist(): void {
  rmSync(STUDIO_DIST_DIRECTORY, { recursive: true, force: true });
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

/** The digest of a `@ackerdb/studio` tarball packed exactly as a release packs it. */
async function packedDigest(destination: string): Promise<string> {
  mkdirSync(destination, { recursive: true });
  const result = await withPackageLicense("studio", (directory) => Bun.spawnSync(
    ["bun", "pm", "pack", "--destination", destination, "--ignore-scripts", "--quiet"],
    { cwd: directory, stdout: "pipe", stderr: "pipe" },
  ));
  if (result.exitCode !== 0) {
    throw new Error(`packing @ackerdb/studio failed:\n${result.stderr.toString().trim()}`);
  }
  const tarball = result.stdout.toString().trim().split("\n").at(-1)?.trim();
  if (tarball === undefined || tarball === "") {
    throw new Error("bun pm pack did not report a @ackerdb/studio tarball");
  }
  return createHash("sha256").update(readFileSync(tarball)).digest("hex");
}

/**
 * Build and pack twice, and refuse a bundle whose tarball differs between the
 * two. It leaves a freshly built `dist/` behind, which is the state the
 * publication that follows expects.
 *
 * `publish.ts` calls this *after* retargeting manifests to the version being
 * released, so the tarballs it compares are the artifact that run will publish
 * rather than a same-shaped stand-in. The release workflow calls it first as
 * well, to fail before any manifest has moved.
 */
export async function assertStudioDistReproducible(): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), "ackerdb-studio-reproducible-"));
  try {
    buildStudioDist();
    const first = await packedDigest(join(scratch, "first"));
    buildStudioDist();
    const second = await packedDigest(join(scratch, "second"));
    if (first !== second) {
      throw new Error(
        "two builds of @ackerdb/studio produced different tarballs " +
          `(${first} then ${second}) — publication requires byte-identity, so an ` +
          "unchanged republication of this version would be a hard collision",
      );
    }
    return first;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const digest = await assertStudioDistReproducible();
    console.log(`@ackerdb/studio packs reproducibly: sha256 ${digest}`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
