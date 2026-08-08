/**
 * The framework's own version, read from the package that ships this file.
 *
 * Every AckerDB package moves in lockstep, so one manifest answers for all of
 * them, and reading it is what keeps the answer true without a generated
 * constant somebody has to remember to rewrite at release time. The read is a
 * few hundred bytes beside a manifest the host has already loaded.
 */
import { readFileSync } from "node:fs";

function packagedVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { readonly version?: unknown };
  return typeof manifest.version === "string" ? manifest.version : "0.0.0";
}

export const ACKERDB_VERSION: string = packagedVersion();
