import { PRODUCTION_LIMITS } from "@ackerdb/server";

export type AckerDBDurabilityMode = "production" | "balanced";
export type AckerDBBenchmarkProfile = "default";

export interface AckerDBStartupMode {
  readonly durability: AckerDBDurabilityMode;
  readonly gracefulShutdownMs: number;
}

export const ACKERDB_STARTUP_PREFIX = "@@ackerdb-startup ";

export function expectedAckerDBStartupMode(
  durability: AckerDBDurabilityMode,
): AckerDBStartupMode {
  return Object.freeze({
    durability,
    gracefulShutdownMs: PRODUCTION_LIMITS.gracefulShutdownMs,
  });
}

/** Parse the one server-confirmed mode marker that must precede readiness. */
export function parseAckerDBStartup(output: string): AckerDBStartupMode {
  const lines = output.split(/\r?\n/);
  const readyIndex = lines.findIndex((line) => line.includes("ready on"));
  if (readyIndex === -1) throw new Error("ackerdb startup output has no readiness line");
  const markers = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.startsWith(ACKERDB_STARTUP_PREFIX));
  if (markers.length !== 1) {
    throw new Error(`ackerdb startup output must contain exactly one mode marker; found ${markers.length}`);
  }
  const marker = markers[0]!;
  if (marker.index >= readyIndex) throw new Error("ackerdb mode marker must precede readiness");

  let value: unknown;
  try {
    value = JSON.parse(marker.line.slice(ACKERDB_STARTUP_PREFIX.length));
  } catch (error) {
    throw new Error("ackerdb mode marker is not valid JSON", { cause: error });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ackerdb mode marker must be an object");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "durability,gracefulShutdownMs") {
    throw new Error("ackerdb mode marker must contain exactly the durability and shutdown mode");
  }
  if (record.durability !== "production" && record.durability !== "balanced") {
    throw new Error("ackerdb mode marker has an invalid durability mode");
  }
  const expected = expectedAckerDBStartupMode(record.durability);
  if (record.gracefulShutdownMs !== expected.gracefulShutdownMs) {
    throw new Error("ackerdb mode marker does not describe the benchmark mode exactly");
  }
  return expected;
}

export function assertAckerDBStartup(
  output: string,
  expected: AckerDBStartupMode,
): AckerDBStartupMode {
  const actual = parseAckerDBStartup(output);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `ackerdb started with durability=${actual.durability}; expected durability=${expected.durability}`,
    );
  }
  return actual;
}
