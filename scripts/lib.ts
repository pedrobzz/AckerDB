// Shared package, lockfile, registry, and git invariants for release tooling.
export const PUBLIC_PACKAGES = [
  "core",
  "server",
  "realtime",
  "cache",
  "client",
  "client-react",
  "cli",
] as const;

export const NATIVE_PACKAGES = [
  "realtime-darwin-arm64",
  "realtime-darwin-x64",
  "realtime-linux-arm64-gnu",
  "realtime-linux-x64-gnu",
  "realtime-win32-x64-msvc",
] as const;

export const PACKAGES = [
  "core",
  "server",
  ...NATIVE_PACKAGES,
  "realtime",
  "cache",
  "client",
  "client-react",
  "cli",
] as const;

type BunLock = {
  readonly workspaces: Record<string, Record<string, unknown>>;
  readonly packages: Record<string, unknown>;
};

const WORKSPACE_FIELDS = [
  "name",
  "version",
  "bin",
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/** Fail with a start-the-registry hint unless the registry answers a ping. */
export async function assertRegistryReachable(registry: string): Promise<void> {
  try {
    const ping = await fetch(`${registry}/-/ping`);
    if (!ping.ok) throw new Error(`ping returned ${ping.status}`);
  } catch {
    fail(`registry ${registry} is not reachable — start it in another terminal: bun run registry`);
  }
}

/** Working-tree prereleases assemble and verify every advertised native target. */
export function assertWebRtcDistribution(): void {
  const result = Bun.spawnSync(
    ["bun", "packages/realtime/native/webrtc/package.ts"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      "the WebRTC package is not assembled from all verified target builds:\n" +
        result.stdout.toString() +
        result.stderr.toString(),
    );
  }
}

export function packageDirectory(pkg: string): string {
  const platform = pkg.startsWith("realtime-")
    ? pkg.slice("realtime-".length)
    : undefined;
  return platform === undefined
    ? `packages/${pkg}`
    : `packages/realtime-native/${platform}`;
}

export function pkgJsonPath(pkg: string): string {
  return `${packageDirectory(pkg)}/package.json`;
}

export async function readBunLock(): Promise<BunLock> {
  let parsed: unknown;
  try {
    parsed = Bun.JSONC.parse(await Bun.file("bun.lock").text());
  } catch (error) {
    fail(`cannot parse bun.lock: ${error instanceof Error ? error.message : String(error)}`);
  }
  const lock = parsed as Partial<BunLock>;
  if (!lock.workspaces || !lock.packages) fail("bun.lock is missing its workspace or package graph");
  return lock as BunLock;
}

export function assertWorkspaceLock(lock: BunLock, read: (pkg: string) => string): void {
  for (const pkg of PACKAGES) {
    const manifest = JSON.parse(read(pkg)) as Record<string, unknown>;
    const expected: Record<string, unknown> = {};
    for (const field of WORKSPACE_FIELDS) {
      if (manifest[field] !== undefined) expected[field] = manifest[field];
    }
    const optionalPeers = Object.entries(
      (manifest.peerDependenciesMeta ?? {}) as Record<string, { optional?: boolean }>,
    )
      .filter(([, metadata]) => metadata.optional)
      .map(([name]) => name)
      .sort();
    if (optionalPeers.length > 0) expected.optionalPeers = optionalPeers;

    if (!Bun.deepEquals(lock.workspaces[packageDirectory(pkg)], expected)) {
      fail(
        `bun.lock workspace snapshot for @ackerdb/${pkg} does not match ${pkgJsonPath(pkg)}\n` +
          `  Run bun run release:prepare <patch|minor|major> so manifests and the lock graph move together.`,
      );
    }
  }
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

// All public and host-specific packages move in lockstep.
export function syncedVersion(
  read: (pkg: string) => string,
  packages: readonly string[] = PACKAGES,
): string {
  if (packages.length === 0) fail("release package set cannot be empty");
  const parsed = packages.map((pkg) => {
    const json = JSON.parse(read(pkg));
    if (typeof json.version !== "string") fail(`no "version" field in ${pkgJsonPath(pkg)}`);
    return { pkg, json, version: json.version as string };
  });
  const version = parsed[0]!.version;
  if (parsed.some((p) => p.version !== version)) {
    fail(
      `package versions are out of sync: ${parsed.map((p) => `${p.pkg}=${p.version}`).join(" ")}\n` +
        `  Fix them to a single version (bun run release:prepare writes the complete set).`,
    );
  }
  // Inter-deps must stay pinned to the lockstep version: bun publish rewrites
  // "workspace:x.y.z" to the literal x.y.z at pack time. (workspace:* would be
  // resolved from bun.lock's snapshot, which bun does not refresh on
  // version-only edits — tarballs would depend on the previous release.)
  for (const { pkg, json } of parsed) {
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const [name, spec] of Object.entries(json[field] ?? {})) {
        if (name.startsWith("@ackerdb/") && spec !== `workspace:${version}`) {
          fail(
            `${pkgJsonPath(pkg)}: ${name} is "${spec}", expected "workspace:${version}"\n` +
              `  Inter-deps stay pinned to the lockstep version (release:prepare rewrites them).`,
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
