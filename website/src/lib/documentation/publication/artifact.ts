import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, posix, relative, resolve, sep } from "node:path";

export type PublicationKind = "latest-bootstrap" | "canary" | "stable";
export type MutablePublicationChannel = "latest" | "canary";

export type PublicationRecordReference =
  | { kind: "mutable"; channel: MutablePublicationChannel }
  | { kind: "stable"; version: string };

export type PublicationFileOwnership =
  | PublicationRecordReference
  | { kind: "content-addressed"; referencedBy: PublicationRecordReference[] };

export interface PublicationArtifactFile {
  path: string;
  sha256: string;
  ownership: PublicationFileOwnership;
}

export interface PublicationArtifactManifest {
  schemaVersion: 1;
  kind: PublicationKind;
  commit: string;
  packageVersion: string;
  rootDigest: string;
  exactVersionDigest?: string;
  files: PublicationArtifactFile[];
}

export interface CreatePublicationArtifactInput {
  directory: string;
  kind: PublicationKind;
  commit: string;
  packageVersion: string;
  ownership: Readonly<Record<string, PublicationFileOwnership>>;
}

const fullCommit = /^[0-9a-f]{40}$/;
const exactVersion = /^\d+\.\d+\.\d+$/;
const canaryVersion = /^\d+\.\d+\.\d+-canary\.(?:0|[1-9]\d*)$/;
const digest = /^[0-9a-f]{64}$/;

export class PublicationInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationInvariantError";
  }
}

function sha256(contents: string | Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function canonicalReference(reference: PublicationRecordReference): PublicationRecordReference {
  if (reference.kind === "mutable") {
    if (reference.channel !== "latest" && reference.channel !== "canary") {
      throw new PublicationInvariantError("Invalid mutable publication channel");
    }
    return { kind: "mutable", channel: reference.channel };
  }
  if (reference.kind === "stable" && exactVersion.test(reference.version)) {
    return { kind: "stable", version: reference.version };
  }
  throw new PublicationInvariantError("Invalid publication record reference");
}

function publicationRecordReferenceKey(
  reference: PublicationRecordReference,
): string {
  return reference.kind === "mutable"
    ? `mutable:${reference.channel}`
    : `stable:${reference.version}`;
}

function canonicalOwnership(ownership: PublicationFileOwnership): PublicationFileOwnership {
  if (ownership.kind !== "content-addressed") return canonicalReference(ownership);

  const referencedBy = ownership.referencedBy
    .map(canonicalReference)
    .sort((left, right) =>
      publicationRecordReferenceKey(left).localeCompare(
        publicationRecordReferenceKey(right),
      ),
    );
  if (
    referencedBy.length === 0 ||
    new Set(referencedBy.map(publicationRecordReferenceKey)).size !== referencedBy.length
  ) {
    throw new PublicationInvariantError(
      "Content-addressed files require unique publication record references",
    );
  }
  return { kind: "content-addressed", referencedBy };
}

export function publicationArtifactAssetsFor(
  manifest: PublicationArtifactManifest,
  reference: PublicationRecordReference,
): PublicationArtifactFile[] {
  const key = publicationRecordReferenceKey(reference);
  return manifest.files.filter(
    (file) =>
      file.ownership.kind === "content-addressed" &&
      file.ownership.referencedBy.some(
        (candidate) => publicationRecordReferenceKey(candidate) === key,
      ),
  );
}

function normalizedArtifactPath(path: string): string {
  const normalized = posix.normalize(path.replaceAll("\\", "/"));
  if (
    path.length === 0 ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    normalized !== path
  ) {
    throw new PublicationInvariantError(`Invalid publication artifact path: ${path}`);
  }
  return normalized;
}

async function filesBelow(directory: string): Promise<string[]> {
  const root = resolve(directory);
  const paths: string[] = [];

  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        paths.push(relative(root, absolute).split(sep).join("/"));
      } else {
        throw new PublicationInvariantError(
          `Publication artifacts may contain only files: ${absolute}`,
        );
      }
    }
  }

  await visit(root);
  return paths.sort();
}

function inventoryDigest(files: readonly PublicationArtifactFile[]): string {
  return sha256(
    JSON.stringify(
      files.map((file) => ({
        path: file.path,
        sha256: file.sha256,
        ownership: canonicalOwnership(file.ownership),
      })),
    ),
  );
}

function validateArtifactIdentity(input: CreatePublicationArtifactInput): void {
  if (
    input.kind !== "latest-bootstrap" &&
    input.kind !== "canary" &&
    input.kind !== "stable"
  ) {
    throw new PublicationInvariantError("Unsupported publication artifact kind");
  }
  if (!fullCommit.test(input.commit)) {
    throw new PublicationInvariantError(
      "Publication artifacts require a full lowercase Git commit",
    );
  }
  if (input.packageVersion.length === 0) {
    throw new PublicationInvariantError("Publication artifacts require a package version");
  }
  if (
    (input.kind === "latest-bootstrap" || input.kind === "stable") &&
    !exactVersion.test(input.packageVersion)
  ) {
    throw new PublicationInvariantError(
      `${input.kind} artifacts require an exact stable package version`,
    );
  }
  if (input.kind === "canary" && !canaryVersion.test(input.packageVersion)) {
    throw new PublicationInvariantError(
      "Canary artifacts require an exact x.y.z-canary.N package version",
    );
  }
}

function exactVersionFiles(
  files: readonly PublicationArtifactFile[],
  version: string,
): PublicationArtifactFile[] {
  const reference = `stable:${version}`;
  return files.filter(
    (file) =>
      (file.ownership.kind === "stable" && file.ownership.version === version) ||
      (file.ownership.kind === "content-addressed" &&
        file.ownership.referencedBy.some(
          (candidate) => publicationRecordReferenceKey(candidate) === reference,
        )),
  );
}

export function validatePublicationArtifactManifest(manifest: PublicationArtifactManifest): void {
  if (manifest.schemaVersion !== 1) {
    throw new PublicationInvariantError("Unsupported publication artifact schema");
  }
  validateArtifactIdentity({
    directory: "",
    kind: manifest.kind,
    commit: manifest.commit,
    packageVersion: manifest.packageVersion,
    ownership: {},
  });

  const paths = new Set<string>();
  let previousPath: string | undefined;
  let ownsLatest = false;
  let ownsCanary = false;
  let ownsExactVersion = false;

  for (const file of manifest.files) {
    normalizedArtifactPath(file.path);
    if (file.path === "docs/versions.json") {
      throw new PublicationInvariantError(
        "docs/versions.json is owned by the publication catalog operation",
      );
    }
    if (!digest.test(file.sha256)) {
      throw new PublicationInvariantError(`Invalid SHA-256 for ${file.path}`);
    }
    if (paths.has(file.path) || (previousPath !== undefined && previousPath > file.path)) {
      throw new PublicationInvariantError(
        "Publication artifact files must be unique and sorted by path",
      );
    }
    paths.add(file.path);
    previousPath = file.path;

    if (file.ownership.kind === "mutable") {
      ownsLatest ||= file.ownership.channel === "latest";
      ownsCanary ||= file.ownership.channel === "canary";
    } else if (file.ownership.kind === "stable") {
      if (file.ownership.version !== manifest.packageVersion) {
        throw new PublicationInvariantError(
          `Stable file ${file.path} does not belong to ${manifest.packageVersion}`,
        );
      }
      ownsExactVersion = true;
    }
  }

  for (const file of manifest.files) {
    if (file.ownership.kind !== "content-addressed") continue;
    const ownership = canonicalOwnership(file.ownership);
    if (ownership.kind !== "content-addressed") continue;
    for (const reference of ownership.referencedBy) {
      const exists =
        (reference.kind === "mutable" &&
          reference.channel === "latest" &&
          ownsLatest) ||
        (reference.kind === "mutable" &&
          reference.channel === "canary" &&
          ownsCanary) ||
        (reference.kind === "stable" &&
          reference.version === manifest.packageVersion &&
          ownsExactVersion);
      if (!exists) {
        throw new PublicationInvariantError(
          `Content-addressed file ${file.path} references a record outside its artifact`,
        );
      }
    }
  }

  if (manifest.rootDigest !== inventoryDigest(manifest.files)) {
    throw new PublicationInvariantError("Publication artifact root digest is invalid");
  }

  if (manifest.kind === "latest-bootstrap") {
    if (!ownsLatest || ownsCanary || ownsExactVersion) {
      throw new PublicationInvariantError(
        "Latest bootstrap artifacts must own only Latest mutable files",
      );
    }
    if (manifest.exactVersionDigest !== undefined) {
      throw new PublicationInvariantError(
        "Latest bootstrap artifacts cannot have an exact-version digest",
      );
    }
    return;
  }

  if (manifest.kind === "canary") {
    if (!ownsCanary || ownsLatest || ownsExactVersion) {
      throw new PublicationInvariantError(
        "Canary artifacts may replace only Canary mutable files",
      );
    }
    if (manifest.exactVersionDigest !== undefined) {
      throw new PublicationInvariantError("Canary artifacts cannot have historical state");
    }
    return;
  }

  if (!exactVersion.test(manifest.packageVersion)) {
    throw new PublicationInvariantError(
      "Stable publication artifacts require an exact package version",
    );
  }
  if (!ownsLatest || ownsCanary || !ownsExactVersion) {
    throw new PublicationInvariantError(
      "Stable artifacts must own Latest and their exact version, but not Canary",
    );
  }
  const historicalFiles = exactVersionFiles(manifest.files, manifest.packageVersion);
  if (manifest.exactVersionDigest !== inventoryDigest(historicalFiles)) {
    throw new PublicationInvariantError("Stable artifact exact-version digest is invalid");
  }
}

export async function createPublicationArtifact(
  input: CreatePublicationArtifactInput,
): Promise<PublicationArtifactManifest> {
  validateArtifactIdentity(input);
  const diskPaths = await filesBelow(input.directory);
  const ownedPaths = Object.keys(input.ownership).map(normalizedArtifactPath).sort();

  if (JSON.stringify(diskPaths) !== JSON.stringify(ownedPaths)) {
    throw new PublicationInvariantError(
      "Publication ownership must describe every artifact file exactly once",
    );
  }

  const files: PublicationArtifactFile[] = [];
  for (const path of diskPaths) {
    files.push({
      path,
      sha256: await sha256File(join(input.directory, path)),
      ownership: canonicalOwnership(input.ownership[path]),
    });
  }

  const manifest: PublicationArtifactManifest = {
    schemaVersion: 1,
    kind: input.kind,
    commit: input.commit,
    packageVersion: input.packageVersion,
    rootDigest: inventoryDigest(files),
    files,
  };

  if (input.kind === "stable") {
    manifest.exactVersionDigest = inventoryDigest(
      exactVersionFiles(files, input.packageVersion),
    );
  }

  validatePublicationArtifactManifest(manifest);
  return manifest;
}

export async function verifyPublicationArtifact(
  directory: string,
  manifest: PublicationArtifactManifest,
): Promise<void> {
  validatePublicationArtifactManifest(manifest);
  const verified = await createPublicationArtifact({
    directory,
    kind: manifest.kind,
    commit: manifest.commit,
    packageVersion: manifest.packageVersion,
    ownership: Object.fromEntries(
      manifest.files.map((file) => [file.path, file.ownership]),
    ),
  });

  if (JSON.stringify(verified) !== JSON.stringify(manifest)) {
    throw new PublicationInvariantError(
      "Publication artifact does not match its manifest",
    );
  }
}
