import {
  createDocumentationVersionCatalog,
  type DocumentationVersionCatalog,
} from "../identity";
import {
  type MutablePublicationChannel,
  type PublicationArtifactFile,
  type PublicationArtifactManifest,
  type PublicationKind,
  PublicationInvariantError,
  publicationArtifactAssetsFor,
  validatePublicationArtifactManifest,
} from "./artifact";

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
    assets: publicationArtifactAssetsFor(manifest, { kind: "mutable", channel }),
  };
}

function catalogFor(
  latest: MutablePublicationRecord,
  historical: readonly StablePublicationRecord[],
): DocumentationVersionCatalog {
  return createDocumentationVersionCatalog({
    latestVersion: latest.packageVersion,
    historicalVersions: historical.map((record) => record.version),
  });
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
): {
  record: MutablePublicationRecord;
  puts: PublicationOperation[];
  deletes: PublicationOperation[];
} {
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
    assets: publicationArtifactAssetsFor(manifest, {
      kind: "stable",
      version: manifest.packageVersion,
    }),
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
  validatePublicationArtifactManifest(artifact);
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
