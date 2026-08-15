import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANDIDATE_MANIFEST_SCHEMA_VERSION,
  TARGET_MANIFEST_SCHEMA_VERSION,
  TARGET_EVIDENCE_FILES,
} from "../evidence.ts";
import {
  ACKERDB_LIBWEBRTC_REVISION,
  NATIVE_ABI,
  WEBRTC_TARGETS,
} from "../provenance.ts";
import {
  WEBRTC_RUNTIME_EXPORTS,
  writeWebRtcLoader,
} from "../generate-loader.ts";

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly main?: string;
  readonly files: readonly string[];
  readonly cpu?: readonly string[];
  readonly os?: readonly string[];
  readonly libc?: readonly string[];
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly napi?: {
    readonly binaryName?: string;
    readonly packageName?: string;
    readonly targets?: readonly string[];
  };
}

const nativeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(nativeRoot, "../../../..");
const realtime = readManifest("packages/realtime/package.json");
const loader = readFileSync(join(nativeRoot, "binding/index.cjs"), "utf8");

const platform = {
  "darwin-arm64": { os: "darwin", cpu: "arm64" },
  "darwin-x64": { os: "darwin", cpu: "x64" },
  "linux-arm64-gnu": { os: "linux", cpu: "arm64", libc: "glibc" },
  "linux-x64-gnu": { os: "linux", cpu: "x64", libc: "glibc" },
  "win32-x64-msvc": { os: "win32", cpu: "x64" },
} as const;

function readManifest(path: string): PackageManifest {
  return JSON.parse(
    readFileSync(join(repositoryRoot, path), "utf8"),
  ) as PackageManifest;
}

describe("WebRTC package topology", () => {
  test("defines the exact evidence payload and candidate schema", () => {
    expect(CANDIDATE_MANIFEST_SCHEMA_VERSION).toBe(2);
    expect(TARGET_MANIFEST_SCHEMA_VERSION).toBe(4);
    expect(TARGET_EVIDENCE_FILES).toEqual([
      "manifest.json",
      "THIRD_PARTY_NOTICES.txt",
      "PROVENANCE.md",
      "licenses",
    ]);
  });

  test("binds the packaged provenance record to the immutable fork revision", () => {
    const provenance = readFileSync(join(nativeRoot, "PROVENANCE.md"), "utf8");
    expect(provenance).toContain(
      `at immutable commit \`${ACKERDB_LIBWEBRTC_REVISION}\`.`,
    );
  });

  test("advertises exactly the five verified N-API targets", () => {
    expect(NATIVE_ABI).toBe(6);
    expect(realtime.napi).toEqual({
      binaryName: "ackerdb_webrtc",
      packageName: "@ackerdb/realtime",
      targets: WEBRTC_TARGETS.map((target) => target.rustTarget),
    });
    expect<string[]>(WEBRTC_TARGETS.map((target) => target.platformArchABI)).toEqual(
      Object.keys(platform),
    );
  });

  test("keeps the root package binary-free and selects exact platform packages", () => {
    expect(realtime.files.some((file) => file.endsWith(".node"))).toBe(false);
    expect(realtime.files.some((file) => file.includes("prebuild"))).toBe(false);
    expect(realtime.files).toContain("native/webrtc/binding/index.cjs");
    expect(realtime.files).toContain("native/webrtc/binding/index.d.cts");

    const expectedDependencies = Object.fromEntries(
      WEBRTC_TARGETS.map((target) => [
        target.packageName,
        `workspace:${realtime.version}`,
      ]),
    );
    expect(realtime.optionalDependencies).toEqual(expectedDependencies);

    for (const target of WEBRTC_TARGETS) {
      expect(loader).toContain(`require('${target.packageName}')`);
      expect(loader).toContain(
        `require('${target.packageName}/package.json').version`,
      );
    }
    const expectedVersions = [...loader.matchAll(
      /bindingPackageVersion !== '([^']+)'/g,
    )].map((match) => match[1]);
    expect(expectedVersions.length).toBeGreaterThan(0);
    expect(new Set(expectedVersions)).toEqual(new Set([realtime.version]));
  });

  test("regenerates the complete loader surface from the native declarations", async () => {
    const declarations = [...readFileSync(join(nativeRoot, "binding/index.d.cts"), "utf8")
      .matchAll(/^export declare (?:class|function) (\w+)/gm)]
      .map((match) => match[1]!);
    expect(WEBRTC_RUNTIME_EXPORTS).toEqual(declarations);

    const outputDir = mkdtempSync(join(tmpdir(), "ackerdb-webrtc-loader-"));
    try {
      await writeWebRtcLoader(realtime.version, outputDir);
      expect(readFileSync(join(outputDir, "index.cjs"), "utf8")).toBe(loader);
    } finally {
      rmSync(outputDir, { force: true, recursive: true });
    }
  });

  test("gates every platform payload with npm host metadata and evidence", () => {
    const expectedFiles = [
      ...TARGET_EVIDENCE_FILES,
    ];
    for (const target of WEBRTC_TARGETS) {
      const manifest = readManifest(
        `packages/realtime-native/${target.platformArchABI}/package.json`,
      );
      const expectedPlatform = platform[target.platformArchABI];
      const binary = `ackerdb_webrtc.${target.platformArchABI}.node`;
      expect(manifest.name).toBe(target.packageName);
      expect(manifest.version).toBe(realtime.version);
      expect(manifest.main).toBe(binary);
      expect(manifest.os).toEqual([expectedPlatform.os]);
      expect(manifest.cpu).toEqual([expectedPlatform.cpu]);
      expect(manifest.libc).toEqual(
        "libc" in expectedPlatform ? [expectedPlatform.libc] : undefined,
      );
      expect(manifest.files).toEqual([binary, ...expectedFiles]);
    }
  });

  test("stages generated evidence beside the current host binary", () => {
    const target = WEBRTC_TARGETS.find((candidate) =>
      candidate.host === `${process.platform}-${process.arch}`
    );
    expect(target).toBeDefined();
    if (target === undefined) return;

    const directory = join(
      repositoryRoot,
      "packages/realtime-native",
      target.platformArchABI,
    );
    for (const file of TARGET_EVIDENCE_FILES) {
      expect(existsSync(join(directory, file))).toBe(true);
    }
    expect(readdirSync(join(directory, "licenses"))).toEqual([
      "Google-WebRTC-LICENSE.md",
    ]);
  });
});
