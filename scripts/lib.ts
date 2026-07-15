// Shared helpers for the local release scripts (bump, merge-guard, publish-local).
export const PACKAGES = ["core", "server", "client", "cli"] as const;

// The repo-root .npmrc is the single source of truth for the registry:
// `bun publish` resolves the @dbzz scope from it (a --registry flag would
// bypass .npmrc auth entirely), so the scripts read the same line.
export async function registryUrl(): Promise<string> {
  const npmrc = Bun.file(".npmrc");
  if (!(await npmrc.exists())) fail('missing repo-root .npmrc with "@dbzz:registry=<url>"');
  const m = /^@dbzz:registry=(.+)$/m.exec(await npmrc.text());
  if (!m) fail('no "@dbzz:registry=<url>" line in the repo-root .npmrc');
  return m[1]!.trim().replace(/\/+$/, "");
}

export function pkgJsonPath(pkg: string): string {
  return `packages/${pkg}/package.json`;
}

export function git(...args: string[]): string {
  const res = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString().trim()}`);
  }
  return res.stdout.toString().trim();
}

export function tryGit(...args: string[]): string | null {
  const res = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  return res.exitCode === 0 ? res.stdout.toString().trim() : null;
}

export function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

// All 4 packages move in lockstep — return the one synced version or fail loudly.
export function syncedVersion(read: (pkg: string) => string): string {
  const parsed = PACKAGES.map((pkg) => {
    const json = JSON.parse(read(pkg));
    if (typeof json.version !== "string") fail(`no "version" field in ${pkgJsonPath(pkg)}`);
    return { pkg, json, version: json.version as string };
  });
  const version = parsed[0]!.version;
  if (parsed.some((p) => p.version !== version)) {
    fail(
      `package versions are out of sync: ${parsed.map((p) => `${p.pkg}=${p.version}`).join(" ")}\n` +
        `  Fix them to a single version (bun run bump always writes all 4 together).`,
    );
  }
  // Inter-deps must stay pinned to the lockstep version: bun publish rewrites
  // "workspace:x.y.z" to the literal x.y.z at pack time. (workspace:* would be
  // resolved from bun.lock's snapshot, which bun does not refresh on
  // version-only edits — tarballs would depend on the previous release.)
  for (const { pkg, json } of parsed) {
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const [name, spec] of Object.entries(json[field] ?? {})) {
        if (name.startsWith("@dbzz/") && spec !== `workspace:${version}`) {
          fail(
            `${pkgJsonPath(pkg)}: ${name} is "${spec}", expected "workspace:${version}"\n` +
              `  Inter-deps stay pinned to the lockstep version (bun run bump rewrites them).`,
          );
        }
      }
    }
  }
  return version;
}

export function parseSemver(version: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) fail(`"${version}" is not a plain x.y.z version`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function semverGt(a: string, b: string): boolean {
  const [aMaj, aMin, aPat] = parseSemver(a);
  const [bMaj, bMin, bPat] = parseSemver(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat > bPat;
}
