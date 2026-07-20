import { createHash } from "node:crypto";
import { git, tryGit } from "./lib";

export const RELEASE_EVIDENCE_SCHEMA_VERSION = 10;

interface ReleaseEvidence {
  readonly schemaVersion?: unknown;
  readonly timestamp?: unknown;
  readonly release?: {
    readonly version?: unknown;
    readonly previousVersion?: unknown;
    readonly host?: unknown;
  };
  readonly git?: {
    readonly commit?: unknown;
    readonly dirty?: unknown;
    readonly sourceHash?: unknown;
  };
  readonly machine?: unknown;
  readonly systems?: unknown;
  readonly validation?: unknown;
}

interface ExpectedReleaseEvidence {
  readonly path: string;
  readonly version: string;
  readonly previousVersion: string | null;
  /** A git ref or `:` for the index assembled by a merge. */
  readonly productRef: string;
}

function benchmarkSourcesAt(ref: string): string[] {
  const listed = ref === ":"
    ? git("ls-files", "--", "bench", "packages", "package.json", "bun.lock")
    : git("ls-tree", "-r", "--name-only", ref, "--", "bench", "packages", "package.json", "bun.lock");
  return listed
    .split("\n")
    .filter(Boolean)
    .filter(
      (file) =>
        !file.startsWith("bench/results/") &&
        file !== "bench/README.md" &&
        !file.endsWith(".test.ts") &&
        !file.split("/").some((part) => part.startsWith(".")) &&
        !file.includes("/.stdb-data/") &&
        !file.includes("/.convex/"),
    )
    .sort();
}

function gitBlobs(specs: readonly string[]): Uint8Array[] {
  const result = Bun.spawnSync(["git", "cat-file", "--batch"], {
    stdin: Buffer.from(`${specs.join("\n")}\n`),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git cat-file --batch failed: ${result.stderr.toString().trim()}`);
  }
  const output = result.stdout;
  const blobs: Uint8Array[] = [];
  let offset = 0;
  for (const spec of specs) {
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd === -1) throw new Error(`git did not return ${spec}`);
    const header = output.subarray(offset, headerEnd).toString();
    const size = Number(header.split(" ").at(-1));
    if (!Number.isSafeInteger(size)) throw new Error(`git could not read ${spec}: ${header}`);
    const start = headerEnd + 1;
    blobs.push(output.subarray(start, start + size));
    offset = start + size + 1;
  }
  return blobs;
}

/** Hash the versioned product and harness sources relevant to a Hetzner run. */
export function benchmarkSourceHashAt(ref: string): string {
  const hash = createHash("sha256");
  const files = benchmarkSourcesAt(ref);
  const blobs = gitBlobs(files.map((file) => ref === ":" ? `:${file}` : `${ref}:${file}`));
  for (const [index, file] of files.entries()) {
    hash.update(file);
    hash.update("\0");
    hash.update(blobs[index]!);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Validate provenance only. Benchmark observations are deliberately opaque to
 * release automation: deciding whether they are acceptable is a human review.
 */
export function assertReleaseEvidence(source: string, expected: ExpectedReleaseEvidence): void {
  let evidence: ReleaseEvidence;
  try {
    evidence = JSON.parse(source) as ReleaseEvidence;
  } catch {
    throw new Error(`${expected.path} is not valid JSON`);
  }

  if (
    evidence.schemaVersion !== RELEASE_EVIDENCE_SCHEMA_VERSION ||
    evidence.release?.version !== expected.version ||
    evidence.release?.previousVersion !== expected.previousVersion ||
    evidence.release?.host !== "hetzner"
  ) {
    const relation = expected.previousVersion === null
      ? "a baseline with no predecessor"
      : `a comparison against v${expected.previousVersion}`;
    throw new Error(
      `${expected.path} is not schema ${RELEASE_EVIDENCE_SCHEMA_VERSION} Hetzner evidence for ` +
        `v${expected.version} (${relation})`,
    );
  }

  const systems = evidence.systems;
  const validation = evidence.validation;
  const hasObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const hasSystem = (name: string): boolean =>
    hasObject(systems) && Object.hasOwn(systems, name) && hasObject(systems[name]);
  if (
    typeof evidence.timestamp !== "string" ||
    !hasObject(evidence.machine) ||
    !hasSystem("dbzz") ||
    !hasSystem("convex") ||
    !hasSystem("spacetimedb") ||
    !hasObject(validation) ||
    !Array.isArray(validation.failures) ||
    !Array.isArray(validation.integrityAnomalies)
  ) {
    throw new Error(`${expected.path} is missing raw benchmark observation sections`);
  }

  const sourceCommit = evidence.git?.commit;
  const sourceHash = evidence.git?.sourceHash;
  if (
    typeof sourceCommit !== "string" ||
    !/^[0-9a-f]{40,64}$/.test(sourceCommit) ||
    evidence.git?.dirty !== false ||
    typeof sourceHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(sourceHash)
  ) {
    throw new Error(`${expected.path} has invalid or dirty source provenance`);
  }
  if (tryGit("rev-parse", "--verify", `${sourceCommit}^{commit}`) === null) {
    throw new Error(`${expected.path} names an unavailable benchmark source commit ${sourceCommit}`);
  }

  const recordedHash = benchmarkSourceHashAt(sourceCommit);
  const productHash = benchmarkSourceHashAt(expected.productRef);
  if (sourceHash !== recordedHash || sourceHash !== productHash) {
    throw new Error(
      `${expected.path} was measured from different product or benchmark sources; run bun run bench:hetzner again`,
    );
  }
}
