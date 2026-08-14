import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPublicationArtifact,
  type PublicationFileOwnership,
  type PublicationKind,
} from "../../src/lib/documentation/publication/artifact";

export const publicationCommit = "0123456789abcdef0123456789abcdef01234567";

export const latestAsset: PublicationFileOwnership = {
  kind: "content-addressed",
  referencedBy: [{ kind: "mutable", channel: "latest" }],
};

export const canaryAsset: PublicationFileOwnership = {
  kind: "content-addressed",
  referencedBy: [{ kind: "mutable", channel: "canary" }],
};

export function stableAsset(version: string): PublicationFileOwnership {
  return {
    kind: "content-addressed",
    referencedBy: [
      { kind: "mutable", channel: "latest" },
      { kind: "stable", version },
    ],
  };
}

export async function artifactDirectory(
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ackerdb-publication-"));
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), contents);
  }
  return directory;
}

export async function createArtifact(
  kind: PublicationKind,
  packageVersion: string,
  files: Readonly<
    Record<string, { contents: string; ownership: PublicationFileOwnership }>
  >,
) {
  const directory = await artifactDirectory(
    Object.fromEntries(
      Object.entries(files).map(([path, file]) => [path, file.contents]),
    ),
  );
  try {
    return await createPublicationArtifact({
      directory,
      kind,
      commit: publicationCommit,
      packageVersion,
      ownership: Object.fromEntries(
        Object.entries(files).map(([path, file]) => [path, file.ownership]),
      ),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
