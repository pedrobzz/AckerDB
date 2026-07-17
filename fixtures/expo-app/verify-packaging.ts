// Cross-runtime packaging proof for @dbzz/client-react (ISSUE-10).
//
// Runs against the real packed tarballs — not workspace links — in a throwaway
// consumer copy of this fixture, and asserts:
//
//   1. Metro (headless `expo export`) selects the `react-native` conditional
//      entry: the bundle sourcemap contains `index.native.ts` and the Expo
//      capability module, and the export succeeds (so `expo/fetch` and
//      `expo-crypto` resolved).
//   2. TypeScript resolves the same conditional entry under Expo's
//      `customConditions: ["react-native"]`, and the browser entry without it
//      (checked via `--traceResolution`), with `tsc --noEmit` passing.
//   3. A browser bundle (`bun build --target=browser`) of the packed package
//      contains no AI SDK, Expo, or React Native module code.
//   4. The optional `@dbzz/client-react/ai` subpath resolves from the packed
//      artifact, typechecks against the supported AI SDK, bundles for the
//      browser, and retains the same runtime import isolation.
//   5. Removing a mandatory native peer (`expo-crypto`) fails the next Metro
//      bundle with a clear resolution error naming the module.
//
// Usage, from the repo root:  bun fixtures/expo-app/verify-packaging.ts
// (network required: the throwaway consumer installs Expo and AI SDK from npm)

import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = new URL("../..", import.meta.url).pathname;
const fixtureDir = join(repoRoot, "fixtures/expo-app");
const work = mkdtempSync(join(tmpdir(), "dbzz-expo-packaging-"));
console.log(`work dir: ${work}`);

const clientReactManifest = JSON.parse(
  readFileSync(join(repoRoot, "packages/client-react/package.json"), "utf8"),
) as { devDependencies: { ai: string } };
const supportedAiVersion = clientReactManifest.devDependencies.ai;

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function run(
  cmd: string[],
  cwd: string,
  options: { allowFailure?: boolean } = {},
): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "1" } });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0 && !options.allowFailure) {
    console.error(stdout, stderr);
    throw new Error(`command failed (${exitCode}): ${cmd.join(" ")}`);
  }
  return { exitCode, output: stdout + stderr };
}

// --- 0. Pack the real tarballs -----------------------------------------------

const tarballs = join(work, "tarballs");
mkdirSync(tarballs);
const packed: Record<string, string> = {};
for (const pkg of ["core", "client", "client-react"]) {
  const { output } = await run(["bun", "pm", "pack", "--destination", tarballs], join(repoRoot, "packages", pkg));
  const name = output.split("\n").find((line) => line.trim().endsWith(".tgz"))?.trim();
  if (!name) throw new Error(`no tarball name in bun pm pack output for ${pkg}:\n${output}`);
  packed[pkg] = join(tarballs, name.replace(/^.*\//, ""));
}
console.log("packed:", Object.values(packed).map((p) => p.replace(/^.*\//, "")).join(", "));

// --- 1. Materialize the throwaway consumer -----------------------------------

const consumer = join(work, "consumer");
mkdirSync(consumer);
for (const file of ["app.json", "index.ts", "App.tsx", "tsconfig.json"]) {
  cpSync(join(fixtureDir, file), join(consumer, file));
}
const manifest = JSON.parse(readFileSync(join(fixtureDir, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
manifest.dependencies["@dbzz/client-react"] = `file:${packed["client-react"]}`;
// Root-level file: entries satisfy the tarball's pinned @dbzz/* version ranges.
manifest.dependencies["@dbzz/client"] = `file:${packed["client"]}`;
manifest.dependencies["@dbzz/core"] = `file:${packed["core"]}`;
manifest.dependencies["ai"] = supportedAiVersion;
manifest.devDependencies["typescript"] = "~5.9.0";
writeFileSync(join(consumer, "package.json"), JSON.stringify(manifest, null, 2));

// npm, not bun: npm dedupes the tarball's pinned `@dbzz/*` dependency ranges
// against the root `file:` entries; bun would try to resolve them from the
// public registry, where dbzz is intentionally not published.
await run(["npm", "install", "--no-audit", "--no-fund"], consumer);
console.log("consumer installed");
const installedAiVersion = (
  JSON.parse(readFileSync(join(consumer, "node_modules/ai/package.json"), "utf8")) as {
    version: string;
  }
).version;
check(
  "the supported optional AI SDK peer is installed",
  installedAiVersion === supportedAiVersion,
  installedAiVersion,
);

// --- 2. Metro proof: headless expo export selects the native entry ------------

await run(
  ["./node_modules/.bin/expo", "export", "--platform", "ios", "--platform", "android", "--source-maps", "--output-dir", "dist"],
  consumer,
);
const jsDir = join(consumer, "dist/_expo/static/js");
const maps: string[] = [];
for (const platform of readdirSync(jsDir)) {
  for (const file of readdirSync(join(jsDir, platform))) {
    if (file.endsWith(".map")) maps.push(join(jsDir, platform, file));
  }
}
check("expo export produced sourcemaps for both platforms", maps.length >= 2, `${maps.length} maps`);
for (const map of maps) {
  const sources = (JSON.parse(readFileSync(map, "utf8")) as { sources: string[] }).sources.join("\n");
  const platform = map.includes("/ios/") ? "ios" : "android";
  check(`[${platform}] native conditional entry bundled`, sources.includes("src/index.native.ts"));
  check(`[${platform}] Expo capability module bundled`, sources.includes("src/native/capabilities.ts"));
  check(`[${platform}] named expo/fetch implementation bundled`, sources.includes("winter/fetch"));
  check(`[${platform}] expo-crypto bundled`, sources.includes("expo-crypto"));
  check(`[${platform}] shared provider bundled from the tarball`, sources.includes("src/provider.tsx"));
}

// --- 3. TypeScript resolution proof -------------------------------------------

function packageResolution(traceOutput: string, specifier = "@dbzz/client-react"): string {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const resolved = traceOutput.matchAll(
    new RegExp(`Module name '${escaped}' was successfully resolved to '([^']+)'`, "g"),
  );
  return [...resolved].map((match) => match[1]).join("\n");
}

const tsc = join(consumer, "node_modules/.bin/tsc");
const nativeTrace = await run([tsc, "-p", "tsconfig.json", "--noEmit", "--traceResolution"], consumer);
check("tsc --noEmit passes with customConditions react-native", nativeTrace.exitCode === 0);
check(
  "TS resolves @dbzz/client-react to the native entry under the condition",
  packageResolution(nativeTrace.output).includes("index.native.ts"),
);

// Browser-side TS: same consumer, no react-native condition.
writeFileSync(
  join(consumer, "browser-check.ts"),
  `import * as dbzz from "@dbzz/client-react";\nconsole.log(Object.keys(dbzz).length);\n`,
);
writeFileSync(
  join(consumer, "ai-check.ts"),
  [
    `import type { SseRef } from "@dbzz/client";`,
    `import { useChatTransport, type DbzzChatArgs } from "@dbzz/client-react/ai";`,
    `import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";`,
    `declare const chat: SseRef<DbzzChatArgs<UIMessage>, UIMessageChunk>;`,
    `const transport: ChatTransport<UIMessage> = useChatTransport(chat);`,
    `console.log(useChatTransport.name, transport);`,
    "",
  ].join("\n"),
);
writeFileSync(
  join(consumer, "tsconfig.browser.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ESNext",
        module: "preserve",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        lib: ["DOM", "ESNext"],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
      },
      include: ["browser-check.ts", "ai-check.ts"],
    },
    null,
    2,
  ),
);
const browserTrace = await run([tsc, "-p", "tsconfig.browser.json", "--noEmit", "--traceResolution"], consumer);
const browserResolution = packageResolution(browserTrace.output);
check("tsc --noEmit passes for the browser consumer", browserTrace.exitCode === 0);
check(
  "TS resolves @dbzz/client-react to the browser entry without the condition",
  browserResolution.includes("src/index.ts") && !browserResolution.includes("index.native.ts"),
);
check(
  "TS resolves @dbzz/client-react/ai from the packed artifact",
  packageResolution(browserTrace.output, "@dbzz/client-react/ai").includes("src/ai/index.ts"),
);

// --- 4. Browser bundle purity proof --------------------------------------------

writeFileSync(
  join(consumer, "browser-entry.ts"),
  // Namespace-key usage retains every export, defeating tree-shaking, so the
  // scan covers the complete browser entry graph of the packed tarball.
  `import * as dbzz from "@dbzz/client-react";\nconsole.log(Object.keys(dbzz).join(","));\n`,
);
const bundle = await run(
  ["bun", "build", "browser-entry.ts", "--target=browser", "--outfile", "dist-browser/bundle.js"],
  consumer,
);
check("bun build --target=browser succeeds", bundle.exitCode === 0);
const bundleText = readFileSync(join(consumer, "dist-browser/bundle.js"), "utf8");
const isolatedRuntimeMarkers = [
  "node_modules/ai/",
  "@ai-sdk/",
  "expo/fetch",
  "expo-crypto",
  "react-native",
  "index.native",
  "withExpoCapabilities",
];
for (const marker of isolatedRuntimeMarkers) {
  check(`browser bundle contains no "${marker}"`, !bundleText.includes(marker));
}
check(
  "browser bundle contains the shared provider",
  bundleText.includes("requires a <DbzzProvider> ancestor"),
);

// --- 5. Packed AI subpath proof --------------------------------------------------

const aiBundle = await run(
  ["bun", "build", "ai-check.ts", "--target=browser", "--outfile", "dist-ai/bundle.js"],
  consumer,
);
check("packed @dbzz/client-react/ai browser bundle succeeds", aiBundle.exitCode === 0);
const aiBundleText = readFileSync(join(consumer, "dist-ai/bundle.js"), "utf8");
check(
  "packed AI bundle contains useChatTransport",
  aiBundleText.includes("useChatTransport"),
);
for (const marker of isolatedRuntimeMarkers) {
  check(`packed AI bundle contains no "${marker}"`, !aiBundleText.includes(marker));
}

// --- 6. Missing mandatory native peer fails at bundle resolution ----------------

rmSync(join(consumer, "node_modules/expo-crypto"), { recursive: true, force: true });
const broken = await run(
  ["./node_modules/.bin/expo", "export", "--platform", "ios", "--output-dir", "dist-broken"],
  consumer,
  { allowFailure: true },
);
check("expo export fails without expo-crypto", broken.exitCode !== 0);
check(
  "the failure names expo-crypto (clear resolution error)",
  broken.output.includes("expo-crypto"),
  broken.output.split("\n").find((line) => line.includes("expo-crypto"))?.trim().slice(0, 120) ?? "no matching line",
);

// --- Result --------------------------------------------------------------------

if (failures === 0) {
  console.log("\nall packaging checks passed");
  rmSync(work, { recursive: true, force: true });
} else {
  console.error(`\n${failures} packaging check(s) failed — work dir kept at ${work}`);
  process.exit(1);
}
