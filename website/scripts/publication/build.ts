import { spawnSync } from "node:child_process";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import corePackage from "../../../packages/core/package.json";
import {
  documentationLocation,
  type DocumentationIdentity,
} from "../../src/lib/documentation/identity";
import {
  parseDocumentationPublicationPlan,
  publicationOwnsIdentity,
  type DocumentationPublicationPlan,
} from "../../src/lib/documentation/plan";
import {
  createPublicationArtifact,
  type PublicationArtifactManifest,
  type PublicationFileOwnership,
  type PublicationKind,
  type PublicationRecordReference,
} from "../../src/lib/documentation/publication/artifact";

interface PublicationBuildArguments {
  commit: string;
  kind: PublicationKind;
  latestVersion?: string;
  output: string;
  packageVersion: string;
}

const websiteDirectory = fileURLToPath(new URL("../..", import.meta.url));
const repositoryDirectory = resolve(websiteDirectory, "..");
const cacheDirectory = "__tsr/staticServerFnCache/";

function argumentMap(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Expected --name value arguments, received: ${argv.join(" ")}`);
    }
    if (values.has(name)) throw new Error(`Duplicate argument: ${name}`);
    values.set(name, value);
  }
  return values;
}

function requiredArgument(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`Missing required argument: ${name}`);
  return value;
}

function parseArguments(argv: string[]): PublicationBuildArguments {
  const values = argumentMap(argv);
  const supported = new Set([
    "--kind",
    "--commit",
    "--package-version",
    "--latest-version",
    "--out",
  ]);
  for (const name of values.keys()) {
    if (!supported.has(name)) throw new Error(`Unknown argument: ${name}`);
  }

  const kind = requiredArgument(values, "--kind");
  if (kind !== "latest-bootstrap" && kind !== "canary" && kind !== "stable") {
    throw new Error(`Unknown publication kind: ${kind}`);
  }

  const latestVersion = values.get("--latest-version");
  if (kind === "canary" && !latestVersion) {
    throw new Error("Canary publication requires --latest-version");
  }
  if (kind !== "canary" && latestVersion) {
    throw new Error("--latest-version belongs only to Canary publication");
  }

  return {
    kind,
    commit: requiredArgument(values, "--commit"),
    packageVersion: requiredArgument(values, "--package-version"),
    latestVersion,
    output: resolve(process.cwd(), requiredArgument(values, "--out")),
  };
}

function publicationPlan(
  input: PublicationBuildArguments,
): Exclude<DocumentationPublicationPlan, { kind: "preview" }> {
  const plan = parseDocumentationPublicationPlan(
    {
      VITE_DOCS_PUBLICATION_KIND: input.kind,
      VITE_DOCS_PACKAGE_VERSION: input.packageVersion,
      VITE_DOCS_LATEST_VERSION: input.latestVersion,
      VITE_GIT_COMMIT: input.commit,
    },
    corePackage.version,
  );
  if (plan.kind === "preview") throw new Error("Preview builds are not publishable");
  return plan;
}

function gitOutput(arguments_: string[]): string {
  const result = spawnSync("git", arguments_, {
    cwd: repositoryDirectory,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${arguments_.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function verifySourceIdentity(commit: string): void {
  const head = gitOutput(["rev-parse", "HEAD"]);
  if (head !== commit) {
    throw new Error(`Publication commit ${commit} does not match HEAD ${head}`);
  }

  const changes = gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (changes) {
    throw new Error(
      "Public Documentation artifacts require a clean worktree so the commit identifies every byte",
    );
  }
}

async function outputFiles(directory: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        files.push(relative(directory, absolute).split(sep).join("/"));
      } else {
        throw new Error(`Static build output may contain only files: ${absolute}`);
      }
    }
  }

  await visit(directory);
  return files.sort();
}

function serializedCurrentUrl(value: unknown): string {
  const urls = new Set<string>();

  function visit(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const properties = record.p;
    if (properties && typeof properties === "object") {
      const propertyRecord = properties as Record<string, unknown>;
      if (Array.isArray(propertyRecord.k) && Array.isArray(propertyRecord.v)) {
        for (let index = 0; index < propertyRecord.k.length; index += 1) {
          if (propertyRecord.k[index] !== "currentUrl") continue;
          const serialized = propertyRecord.v[index];
          if (
            serialized &&
            typeof serialized === "object" &&
            typeof (serialized as Record<string, unknown>).s === "string"
          ) {
            urls.add((serialized as { s: string }).s);
          }
        }
      }
    }
    for (const child of Object.values(record)) visit(child);
  }

  visit(value);
  if (urls.size !== 1) {
    throw new Error(
      `Expected one route identity in static-function cache, found ${urls.size}`,
    );
  }
  return [...urls][0];
}

function ownershipForIdentity(
  plan: Exclude<DocumentationPublicationPlan, { kind: "preview" }>,
  identity: DocumentationIdentity,
): PublicationFileOwnership {
  if (!publicationOwnsIdentity(plan, identity)) {
    throw new Error(
      `${plan.kind} build emitted a ${identity.kind} Documentation dependency`,
    );
  }
  if (identity.kind === "stable") {
    return { kind: "stable", version: identity.version };
  }
  return { kind: "mutable", channel: identity.kind };
}

function identityForSearchPath(path: string): DocumentationIdentity {
  const version = path.slice("api/search/".length);
  if (version === "latest") return documentationLocation([]).identity;
  return documentationLocation([version]).identity;
}

function assetReferences(
  plan: Exclude<DocumentationPublicationPlan, { kind: "preview" }>,
): PublicationRecordReference[] {
  if (plan.kind === "canary") {
    return [{ kind: "mutable", channel: "canary" }];
  }
  if (plan.kind === "stable") {
    return [
      { kind: "mutable", channel: "latest" },
      { kind: "stable", version: plan.packageVersion },
    ];
  }
  return [{ kind: "mutable", channel: "latest" }];
}

async function ownershipForOutput(
  plan: Exclude<DocumentationPublicationPlan, { kind: "preview" }>,
  publicDirectory: string,
  path: string,
): Promise<PublicationFileOwnership | undefined> {
  if (path.startsWith("assets/")) {
    return { kind: "content-addressed", referencedBy: assetReferences(plan) };
  }

  if (path.startsWith(cacheDirectory)) {
    const cache = JSON.parse(await readFile(join(publicDirectory, path), "utf8")) as unknown;
    const currentUrl = serializedCurrentUrl(cache);
    const segments = new URL(currentUrl, "https://ackerdb.dev")
      .pathname.slice("/docs".length)
      .split("/")
      .filter(Boolean);
    return ownershipForIdentity(plan, documentationLocation(segments).identity);
  }

  if (path === "docs/versions.json") {
    throw new Error("The version catalog is deployment state, not build output");
  }
  if (path === "docs/index.html" || path === "docs/index.md" || path.startsWith("docs/")) {
    const segments = path
      .slice("docs/".length)
      .replace(/(?:\/index)?\.html$|\.md$|\/routes\.json$/, "")
      .split("/")
      .filter(Boolean);
    return ownershipForIdentity(plan, documentationLocation(segments).identity);
  }
  if (path.startsWith("api/search/")) {
    return ownershipForIdentity(plan, identityForSearchPath(path));
  }

  // Root pages, LLM indexes, favicons, and other non-versioned public files are
  // owned by Latest. Nitro may copy them during a Canary-only build, but that
  // artifact must leave the already-deployed global website untouched.
  if (plan.kind === "canary") return undefined;
  return { kind: "mutable", channel: "latest" };
}

async function runStaticBuild(
  plan: Exclude<DocumentationPublicationPlan, { kind: "preview" }>,
  outputDirectory: string,
): Promise<void> {
  const environment: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === "string") environment[name] = value;
  }
  environment.DOCS_BUILD_OUTPUT_DIR = outputDirectory;
  environment.VITE_DOCS_PUBLICATION_KIND = plan.kind;
  environment.VITE_DOCS_PACKAGE_VERSION = plan.packageVersion;
  environment.VITE_GIT_COMMIT = plan.commit;
  if (plan.kind === "canary") {
    environment.VITE_DOCS_LATEST_VERSION = plan.latestVersion;
  } else {
    delete environment.VITE_DOCS_LATEST_VERSION;
  }

  const build = Bun.spawnSync([process.execPath, "run", "build"], {
    cwd: websiteDirectory,
    env: environment,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (build.exitCode !== 0) {
    throw new Error(`Static Documentation build exited with ${build.exitCode}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

export async function buildPublication(
  input: PublicationBuildArguments,
): Promise<PublicationArtifactManifest> {
  const plan = publicationPlan(input);
  verifySourceIdentity(plan.commit);
  if (await pathExists(input.output)) {
    throw new Error(`Publication output already exists: ${input.output}`);
  }

  const buildRoot = await mkdtemp(join(tmpdir(), "ackerdb-docs-build-"));
  let stagingRoot: string | undefined;
  try {
    const rawOutput = join(buildRoot, "output");
    await runStaticBuild(plan, rawOutput);
    const publicDirectory = join(rawOutput, "public");
    await access(publicDirectory);

    await mkdir(dirname(input.output), { recursive: true });
    stagingRoot = await mkdtemp(
      join(dirname(input.output), `.${basename(input.output)}-staging-`),
    );
    const stagedPublic = join(stagingRoot, "public");
    await mkdir(stagedPublic);

    const ownership: Record<string, PublicationFileOwnership> = {};
    for (const path of await outputFiles(publicDirectory)) {
      const fileOwnership = await ownershipForOutput(plan, publicDirectory, path);
      if (!fileOwnership) continue;
      const destination = join(stagedPublic, ...path.split(posix.sep));
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(publicDirectory, ...path.split(posix.sep)), destination);
      ownership[path] = fileOwnership;
    }

    const manifest = await createPublicationArtifact({
      directory: stagedPublic,
      kind: plan.kind,
      commit: plan.commit,
      packageVersion: plan.packageVersion,
      ownership,
    });
    await writeFile(
      join(stagingRoot, "publication-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx" },
    );
    await rename(stagingRoot, input.output);
    stagingRoot = undefined;
    return manifest;
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
    if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const manifest = await buildPublication(parseArguments(process.argv.slice(2)));
  process.stdout.write(
    `${manifest.kind} Documentation artifact ${manifest.rootDigest} (${manifest.files.length} files)\n`,
  );
}
