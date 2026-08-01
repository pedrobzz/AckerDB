export function assertStableVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${version} is not a stable x.y.z source version`);
  }
}

export function canaryPattern(sourceVersion: string): RegExp {
  assertStableVersion(sourceVersion);
  return new RegExp(`^${sourceVersion.replaceAll(".", "\\.")}-canary\\.(\\d+)$`);
}

export function publicVersion(
  branch: "main" | "canary",
  sourceVersion: string,
  runNumber?: string,
): string {
  assertStableVersion(sourceVersion);
  if (branch === "main") return sourceVersion;
  if (!runNumber || !/^\d+$/.test(runNumber)) {
    throw new Error("a numeric GitHub run number is required for canary publication");
  }
  return `${sourceVersion}-canary.${runNumber}`;
}

export function bootstrapCanaryVersion(sourceVersion: string): string {
  assertStableVersion(sourceVersion);
  return `${sourceVersion}-canary.0`;
}

export function nextBetaVersion(
  sourceVersion: string,
  existingVersions: Iterable<string>,
): string {
  assertStableVersion(sourceVersion);
  const pattern = new RegExp(
    `^${sourceVersion.replaceAll(".", "\\.")}-beta\\.(\\d+)$`,
  );
  let highest = 0;
  for (const version of existingVersions) {
    const match = pattern.exec(version);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${sourceVersion}-beta.${highest + 1}`;
}
