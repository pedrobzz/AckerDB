import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, posix, relative, resolve, sep } from "node:path";
import type { DocumentationVersionCatalog } from "./identity";

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

export interface MutablePublicationRecord {
  kind: PublicationKind;
  commit: string;
  packageVersion: string;
  rootDigest: string;
  files: PublicationArtifactFile[];
  assets: PublicationArtifactFile[];
}

export interface StablePublicationRecord extends MutablePublicationRecord {
  kind: "stable";
  version: string;
  exactVersionDigest: string;
}

export interface PublicationPreActivationState {
  schemaVersion: 1;
  mutable: {
    latest: MutablePublicationRecord;
    canary?: never;
  };
  historical: [];
  catalog?: undefined;
}

export interface ActivePublicationState {
  schemaVersion: 1;
  mutable: {
    latest: MutablePublicationRecord;
    canary: MutablePublicationRecord;
  };
  historical: StablePublicationRecord[];
  catalog: DocumentationVersionCatalog;
}

export type PublicationDeploymentState =
  | PublicationPreActivationState
  | ActivePublicationState;

export type PublicationOperation =
  | {
      kind: "put";
      path: string;
      sourcePath: string;
      sha256: string;
    }
  | {
      kind: "delete";
      path: string;
    }
  | {
      kind: "catalog";
      path: "docs/versions.json";
      catalog: DocumentationVersionCatalog;
    };

export interface PublicationTransition {
  state: PublicationDeploymentState;
  operations: PublicationOperation[];
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

function referenceKey(reference: PublicationRecordReference): string {
  return reference.kind === "mutable"
    ? `mutable:${reference.channel}`
    : `stable:${reference.version}`;
}

function canonicalOwnership(ownership: PublicationFileOwnership): PublicationFileOwnership {
  if (ownership.kind !== "content-addressed") return canonicalReference(ownership);

  const referencedBy = ownership.referencedBy
    .map(canonicalReference)
    .sort((left, right) => referenceKey(left).localeCompare(referenceKey(right)));
  if (
    referencedBy.length === 0 ||
    new Set(referencedBy.map(referenceKey)).size !== referencedBy.length
  ) {
    throw new PublicationInvariantError(
      "Content-addressed files require unique publication record references",
    );
  }
  return { kind: "content-addressed", referencedBy };
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
          (candidate) => referenceKey(candidate) === reference,
        )),
  );
}

function validateManifest(manifest: PublicationArtifactManifest): void {
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

  validateManifest(manifest);
  return manifest;
}

export async function verifyPublicationArtifact(
  directory: string,
  manifest: PublicationArtifactManifest,
): Promise<void> {
  validateManifest(manifest);
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

function mutableRecord(
  manifest: PublicationArtifactManifest,
  channel: MutablePublicationChannel,
): MutablePublicationRecord | undefined {
  const files = manifest.files.filter(
    (file) =>
      file.ownership.kind === "mutable" && file.ownership.channel === channel,
  );
  if (files.length === 0) return undefined;
  return {
    kind: manifest.kind,
    commit: manifest.commit,
    packageVersion: manifest.packageVersion,
    rootDigest: manifest.rootDigest,
    files,
    assets: assetsFor(manifest, { kind: "mutable", channel }),
  };
}

function assetsFor(
  manifest: PublicationArtifactManifest,
  reference: PublicationRecordReference,
): PublicationArtifactFile[] {
  const key = referenceKey(reference);
  return manifest.files.filter(
    (file) =>
      file.ownership.kind === "content-addressed" &&
      file.ownership.referencedBy.some((candidate) => referenceKey(candidate) === key),
  );
}

function catalogFor(
  latest: MutablePublicationRecord,
  historical: readonly StablePublicationRecord[],
): DocumentationVersionCatalog {
  return {
    schemaVersion: 1,
    latest: {
      kind: "latest",
      label: `v${latest.packageVersion} (Latest)`,
      basePath: "/docs",
      version: latest.packageVersion,
    },
    canary: {
      kind: "canary",
      label: "Canary",
      basePath: "/docs/canary",
    },
    historical: historical.map((record) => ({
      kind: "stable",
      label: `v${record.version}`,
      basePath: `/docs/${record.version}`,
      version: record.version,
    })),
  };
}

interface DeployedPath {
  sha256: string;
  owner: "latest" | "canary" | "stable" | "content-addressed";
}

function publicationRecords(
  state: PublicationDeploymentState,
): Array<MutablePublicationRecord | StablePublicationRecord> {
  return [
    state.mutable.latest,
    ...(state.mutable.canary ? [state.mutable.canary] : []),
    ...state.historical,
  ];
}

function referencedAssets(
  state: PublicationDeploymentState,
): Map<string, PublicationArtifactFile> {
  const assets = new Map<string, PublicationArtifactFile>();
  for (const record of publicationRecords(state)) {
    for (const file of record.assets) {
      const existing = assets.get(file.path);
      if (existing && existing.sha256 !== file.sha256) {
        throw new PublicationInvariantError(
          `Deployment records disagree on content-addressed bytes: ${file.path}`,
        );
      }
      assets.set(file.path, file);
    }
  }
  return assets;
}

function deployedPaths(state: PublicationDeploymentState): Map<string, DeployedPath> {
  const paths = new Map<string, DeployedPath>();
  const addRoutes = (
    files: readonly PublicationArtifactFile[],
    owner: DeployedPath["owner"],
  ) => {
    for (const file of files) {
      if (paths.has(file.path)) {
        throw new PublicationInvariantError(
          `Deployment state contains duplicate ownership for ${file.path}`,
        );
      }
      paths.set(file.path, { sha256: file.sha256, owner });
    }
  };

  addRoutes(state.mutable.latest.files, "latest");
  if (state.mutable.canary) addRoutes(state.mutable.canary.files, "canary");
  for (const record of state.historical) addRoutes(record.files, "stable");
  for (const file of referencedAssets(state).values()) {
    const existing = paths.get(file.path);
    if (existing) {
      throw new PublicationInvariantError(
        `Content-addressed path collides with ${existing.owner}: ${file.path}`,
      );
    }
    paths.set(file.path, { sha256: file.sha256, owner: "content-addressed" });
  }
  return paths;
}

function contentAddressedPuts(
  artifact: PublicationArtifactManifest,
  occupied: ReadonlyMap<string, DeployedPath>,
): PublicationOperation[] {
  const puts: PublicationOperation[] = [];

  for (const file of artifact.files) {
    if (file.ownership.kind !== "content-addressed") continue;
    const deployed = occupied.get(file.path);
    if (deployed) {
      if (deployed.owner !== "content-addressed" || deployed.sha256 !== file.sha256) {
        throw new PublicationInvariantError(
          `Published path collision has different ownership or bytes: ${file.path}`,
        );
      }
      continue;
    }
    puts.push({ kind: "put", path: file.path, sourcePath: file.path, sha256: file.sha256 });
  }
  return puts;
}

function orphanedAssetDeletes(
  current: PublicationDeploymentState,
  next: PublicationDeploymentState,
): PublicationOperation[] {
  const retained = referencedAssets(next);
  return [...referencedAssets(current).values()]
    .filter((file) => !retained.has(file.path))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => ({ kind: "delete", path: file.path }));
}

function replaceMutableChannel(
  state: PublicationDeploymentState,
  artifact: PublicationArtifactManifest,
  channel: MutablePublicationChannel,
  occupied: ReadonlyMap<string, DeployedPath>,
): { record: MutablePublicationRecord; puts: PublicationOperation[]; deletes: PublicationOperation[] } {
  const record = mutableRecord(artifact, channel);
  if (!record) {
    throw new PublicationInvariantError(`${channel} publication has no mutable files`);
  }
  const previous = state.mutable[channel];
  const previousFiles = new Map(previous?.files.map((file) => [file.path, file]));
  const nextPaths = new Set(record.files.map((file) => file.path));
  const puts: PublicationOperation[] = [];

  for (const file of record.files) {
    const deployed = occupied.get(file.path);
    if (deployed && deployed.owner !== channel) {
      throw new PublicationInvariantError(
        `Mutable ${channel} path collides with ${deployed.owner}: ${file.path}`,
      );
    }
    if (previousFiles.get(file.path)?.sha256 !== file.sha256) {
      puts.push({ kind: "put", path: file.path, sourcePath: file.path, sha256: file.sha256 });
    }
  }

  const deletes: PublicationOperation[] = (previous?.files ?? [])
    .filter((file) => !nextPaths.has(file.path))
    .map((file) => ({ kind: "delete", path: file.path }));
  return { record, puts, deletes };
}

function compareExactVersionsDescending(left: string, right: string): number {
  const leftParts = left.split(".").map(BigInt);
  const rightParts = right.split(".").map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) return -1;
    if (leftParts[index] < rightParts[index]) return 1;
  }
  return 0;
}

function stableRecord(manifest: PublicationArtifactManifest): StablePublicationRecord {
  if (manifest.kind !== "stable" || !manifest.exactVersionDigest) {
    throw new PublicationInvariantError("Expected a verified stable artifact");
  }
  return {
    kind: "stable",
    version: manifest.packageVersion,
    commit: manifest.commit,
    packageVersion: manifest.packageVersion,
    rootDigest: manifest.rootDigest,
    exactVersionDigest: manifest.exactVersionDigest,
    files: manifest.files.filter((file) => file.ownership.kind === "stable"),
    assets: assetsFor(manifest, { kind: "stable", version: manifest.packageVersion }),
  };
}

function isActivePublicationState(
  state: PublicationDeploymentState,
): state is ActivePublicationState {
  return state.catalog !== undefined && state.mutable.canary !== undefined;
}

export function transitionPublication(
  current: PublicationDeploymentState | undefined,
  artifact: PublicationArtifactManifest,
): PublicationTransition {
  validateManifest(artifact);
  if (current === undefined && artifact.kind !== "latest-bootstrap") {
    throw new PublicationInvariantError(
      "The first documentation publication must establish Latest",
    );
  }
  if (current && artifact.kind === "latest-bootstrap") {
    throw new PublicationInvariantError(
      "Latest bootstrap is allowed only before Latest and history exist",
    );
  }

  if (current && artifact.kind === "canary") {
    const occupied = deployedPaths(current);
    const assetPuts = contentAddressedPuts(artifact, occupied);
    const canary = replaceMutableChannel(current, artifact, "canary", occupied);
    const catalog = catalogFor(current.mutable.latest, current.historical);
    const state: ActivePublicationState = {
      schemaVersion: 1,
      mutable: { latest: current.mutable.latest, canary: canary.record },
      historical: current.historical,
      catalog,
    };
    const activation = !isActivePublicationState(current);
    return {
      state,
      operations: [
        ...assetPuts,
        ...canary.puts,
        ...canary.deletes,
        ...(activation
          ? [{ kind: "catalog", path: "docs/versions.json", catalog } as const]
          : []),
        ...orphanedAssetDeletes(current, state),
      ],
    };
  }

  if (current && artifact.kind === "stable") {
    if (!isActivePublicationState(current)) {
      throw new PublicationInvariantError(
        "Canary must activate the documentation catalog before stable publication",
      );
    }
    const occupied = deployedPaths(current);
    const assetPuts = contentAddressedPuts(artifact, occupied);
    const historicalRecord = stableRecord(artifact);
    const candidateLatest = mutableRecord(artifact, "latest");
    const existingHistorical = current.historical.find(
      (record) => record.version === historicalRecord.version,
    );
    if (existingHistorical) {
      if (
        JSON.stringify(existingHistorical) === JSON.stringify(historicalRecord) &&
        JSON.stringify(current.mutable.latest) === JSON.stringify(candidateLatest)
      ) {
        return { state: current, operations: [] };
      }
      throw new PublicationInvariantError(
        `Stable documentation version collision: ${historicalRecord.version}`,
      );
    }
    if (
      compareExactVersionsDescending(
        historicalRecord.version,
        current.mutable.latest.packageVersion,
      ) !== -1
    ) {
      throw new PublicationInvariantError(
        `Stable documentation must advance Latest beyond ${current.mutable.latest.packageVersion}`,
      );
    }
    const latest = replaceMutableChannel(current, artifact, "latest", occupied);
    const stablePuts: PublicationOperation[] = [];

    for (const file of historicalRecord.files) {
      const deployed = occupied.get(file.path);
      if (deployed) {
        throw new PublicationInvariantError(
          `Immutable stable path already exists: ${file.path}`,
        );
      }
      stablePuts.push({
        kind: "put",
        path: file.path,
        sourcePath: file.path,
        sha256: file.sha256,
      });
    }

    const historical = [...current.historical, historicalRecord].sort((left, right) =>
      compareExactVersionsDescending(left.version, right.version),
    );
    const catalog = catalogFor(latest.record, historical);
    const state: ActivePublicationState = {
      schemaVersion: 1,
      mutable: { latest: latest.record, canary: current.mutable.canary },
      historical,
      catalog,
    };
    return {
      state,
      operations: [
        ...assetPuts,
        ...latest.puts,
        ...stablePuts,
        ...latest.deletes,
        { kind: "catalog", path: "docs/versions.json", catalog },
        ...orphanedAssetDeletes(current, state),
      ],
    };
  }

  if (current !== undefined) {
    throw new PublicationInvariantError("Publication transition is not implemented");
  }

  const latest = mutableRecord(artifact, "latest");
  if (!latest) {
    throw new PublicationInvariantError("Latest bootstrap did not contain Latest files");
  }
  return {
    state: {
      schemaVersion: 1,
      mutable: { latest },
      historical: [],
    },
    operations: [
      ...artifact.files
        .filter((file) => file.ownership.kind === "content-addressed")
        .map((file): PublicationOperation => ({
          kind: "put",
          path: file.path,
          sourcePath: file.path,
          sha256: file.sha256,
        })),
      ...latest.files.map((file): PublicationOperation => ({
        kind: "put",
        path: file.path,
        sourcePath: file.path,
        sha256: file.sha256,
      })),
    ],
  };
}
