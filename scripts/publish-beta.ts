// bun run publish:beta [--demo]
// Publishes the WORKING TREE — any branch, dirty is fine — to the local
// Verdaccio as @dbzz/*@<base>-beta.N under the `beta` dist-tag. None of the
// release gates apply: no main-only, no clean tree, no bench evidence, and no
// git tag. The registry's own version list is the beta counter, so every run
// takes a fresh N and re-running after a failure just works.
//
// --demo additionally repins the demo's @dbzz dependencies (those at the
// current base version) to the fresh beta and reinstalls, so the demo runs
// the unmerged code. Restore the demo pins by hand (or with git) when done.
import { existsSync, readdirSync } from "node:fs";
import {
  PACKAGES,
  assertRegistryReachable,
  fail,
  pkgJsonPath,
  registryUrl,
  syncedVersion,
} from "./lib";

const demoMode = process.argv.includes("--demo");

const REGISTRY = await registryUrl();
await assertRegistryReachable(REGISTRY);

const sources = new Map<string, string>();
for (const pkg of PACKAGES) sources.set(pkg, await Bun.file(pkgJsonPath(pkg)).text());
const base = syncedVersion((pkg) => sources.get(pkg)!);

// One past the highest -beta.N of this base anywhere in the registry, so the
// lockstep set stays whole even after a partially failed earlier run.
let highest = 0;
const BETA = new RegExp(`^${base.replaceAll(".", "\\.")}-beta\\.(\\d+)$`);
for (const pkg of PACKAGES) {
  const res = await fetch(`${REGISTRY}/@dbzz/${pkg}`);
  if (res.status === 404) continue;
  if (!res.ok) fail(`registry query for @dbzz/${pkg} failed with ${res.status}`);
  for (const v of Object.keys(((await res.json()) as { versions?: Record<string, unknown> }).versions ?? {})) {
    const m = BETA.exec(v);
    if (m) highest = Math.max(highest, Number(m[1]));
  }
}
const version = `${base}-beta.${highest + 1}`;
console.log(`publishing the working tree as @dbzz/*@${version} (dist-tag: beta) → ${REGISTRY}`);

// Manifests are rewritten in place for the pack and restored byte-for-byte on
// every exit path — no git involved, so uncommitted package.json edits survive.
const restore = async () => {
  for (const pkg of PACKAGES) await Bun.write(pkgJsonPath(pkg), sources.get(pkg)!);
};

try {
  for (const pkg of PACKAGES) {
    const json = JSON.parse(sources.get(pkg)!) as Record<string, any>;
    json.version = version;
    // Inter-deps ride as workspace:<beta> — bun publish rewrites that to the
    // literal version at pack time, exactly as in the release flow.
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      const deps = json[field] as Record<string, string> | undefined;
      if (!deps) continue;
      for (const name of Object.keys(deps)) {
        if (name.startsWith("@dbzz/")) deps[name] = `workspace:${version}`;
      }
    }
    await Bun.write(pkgJsonPath(pkg), JSON.stringify(json, null, 2) + "\n");
  }

  for (const pkg of PACKAGES) {
    console.log(`\npublishing @dbzz/${pkg}@${version}`);
    // no --registry flag: it would bypass .npmrc and lose the auth token.
    const res = Bun.spawnSync(["bun", "publish", "--tag", "beta"], {
      cwd: `packages/${pkg}`,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (res.exitCode !== 0) {
      throw new Error(
        `publishing @dbzz/${pkg}@${version} failed — fix the cause and re-run; the next run takes a fresh beta number.`,
      );
    }
  }
} catch (error) {
  await restore();
  fail(error instanceof Error ? error.message : String(error));
}
await restore();
console.log(`\n✔ published ${PACKAGES.map((p) => `@dbzz/${p}`).join(", ")} at ${version}`);

if (!demoMode) {
  console.log(`\ntest it in the demo: bun run publish:beta --demo (repins the demo and reinstalls)`);
  process.exit(0);
}

// -- demo repin ---------------------------------------------------------------

// The demo root plus every workspace it declares (app/*, packages/*).
const demoManifests = ["demo/package.json"];
const demoRoot = JSON.parse(await Bun.file("demo/package.json").text()) as { workspaces?: string[] };
for (const ws of demoRoot.workspaces ?? []) {
  const baseDir = `demo/${ws.replace(/\/\*$/, "")}`;
  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    const manifest = `${baseDir}/${entry.name}/package.json`;
    if (entry.isDirectory() && existsSync(manifest)) demoManifests.push(manifest);
  }
}

const repinned: string[] = [];
const leftAlone: string[] = [];
for (const path of demoManifests) {
  const json = JSON.parse(await Bun.file(path).text()) as Record<string, any>;
  let changed = false;
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = json[field] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (!name.startsWith("@dbzz/")) continue;
      // Pins at the current base — or at any of its earlier betas — follow the
      // fresh beta; anything else is a deliberate divergence to surface, not
      // overwrite.
      if (spec === base || BETA.test(spec)) {
        if (spec !== version) {
          deps[name] = version;
          changed = true;
        }
      } else {
        leftAlone.push(`${path}: ${name}@${spec}`);
      }
    }
  }
  if (changed) {
    await Bun.write(path, JSON.stringify(json, null, 2) + "\n");
    repinned.push(path);
  }
}

// A beta is created moments before this install. Bun's manifest cache can
// still describe the previous registry state and reject the exact fresh
// version even though Verdaccio already serves it, so this boundary must fetch
// current registry metadata.
const install = Bun.spawnSync(["bun", "install", "--no-cache"], {
  cwd: "demo",
  stdout: "inherit",
  stderr: "inherit",
});
if (install.exitCode !== 0) {
  fail(`demo bun install failed — the pins are already at ${version}; fix the cause and re-run bun install in demo/`);
}

console.log(`\n✔ demo repinned to ${version} (${repinned.join(", ")}) and reinstalled`);
if (leftAlone.length > 0) {
  console.log(`left alone (not at the ${base} base):\n${leftAlone.map((l) => `  ${l}`).join("\n")}`);
}
console.log("restore the demo pins when done testing (they are ordinary tracked edits).");
