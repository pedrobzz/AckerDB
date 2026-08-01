import { PRODUCTION_LIMITS, type TelemetryLimits } from "@ackerdb/server";

export type AckerDBTelemetryMode = "enabled" | "disabled";
export type AckerDBDurabilityMode = "production" | "balanced";
export type AckerDBBenchmarkProfile = "enabled" | "exporter" | "disabled";
export type AckerDBBenchmarkExporterMode = "disabled" | "in-process";
export type AckerDBTelemetryProfile = "runtime-default" | "benchmark-exporter" | "disabled";
export type BenchmarkExecutionLeg =
  | "ackerdb-telemetry-enabled"
  | "ackerdb-telemetry-exporter"
  | "ackerdb-telemetry-disabled";

export interface AckerDBStartupMode {
  readonly telemetry: AckerDBTelemetryMode;
  readonly durability: AckerDBDurabilityMode;
  readonly telemetryProfile: AckerDBTelemetryProfile;
  readonly runtimeTelemetry: "omitted" | "options" | "false";
  readonly exporter: "unconfigured" | "benchmark-in-process";
  readonly localSink: "default-console" | "disabled";
  readonly telemetryLimits: TelemetryLimits | null;
  readonly gracefulShutdownMs: number;
}

export const ACKERDB_STARTUP_PREFIX = "@@ackerdb-startup ";

export function benchmarkProfileFromConfig(
  telemetry: AckerDBTelemetryMode,
  exporter: AckerDBBenchmarkExporterMode,
): AckerDBBenchmarkProfile {
  if (telemetry === "disabled") {
    if (exporter !== "disabled") {
      throw new Error("the benchmark exporter requires telemetry to be enabled");
    }
    return "disabled";
  }
  return exporter === "in-process" ? "exporter" : "enabled";
}

export function expectedAckerDBStartupMode(
  profile: AckerDBBenchmarkProfile,
  durability: AckerDBDurabilityMode,
): AckerDBStartupMode {
  const telemetry = profile === "disabled" ? "disabled" : "enabled";
  return Object.freeze({
    telemetry,
    durability,
    telemetryProfile: profile === "enabled"
      ? "runtime-default"
      : profile === "exporter"
        ? "benchmark-exporter"
        : "disabled",
    runtimeTelemetry: profile === "enabled" ? "omitted" : profile === "exporter" ? "options" : "false",
    exporter: profile === "exporter" ? "benchmark-in-process" : "unconfigured",
    localSink: profile === "disabled" ? "disabled" : "default-console",
    telemetryLimits: profile === "disabled" ? null : Object.freeze({ ...PRODUCTION_LIMITS.telemetry }),
    gracefulShutdownMs: PRODUCTION_LIMITS.gracefulShutdownMs,
  });
}

export function benchmarkExecutionOrder(
  ackerDBProfiles: readonly AckerDBBenchmarkProfile[],
  savedRuns: number,
): BenchmarkExecutionLeg[] {
  if (!Number.isSafeInteger(savedRuns) || savedRuns < 0) {
    throw new RangeError("savedRuns must be a non-negative safe integer");
  }
  if (ackerDBProfiles.length === 0) throw new RangeError("at least one AckerDB profile must run");
  // Rotate the profile order across reruns so no profile always pays the
  // cold-cache first slot.
  const rotation = savedRuns % ackerDBProfiles.length;
  const rotated = [...ackerDBProfiles.slice(rotation), ...ackerDBProfiles.slice(0, rotation)];
  return rotated.map((profile) => `ackerdb-telemetry-${profile}` as const);
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
  if (
    Object.keys(record).sort().join(",") !==
      "durability,exporter,gracefulShutdownMs,localSink,runtimeTelemetry,telemetry,telemetryLimits,telemetryProfile"
  ) {
    throw new Error(
      "ackerdb mode marker must contain exactly the benchmark runtime, telemetry, durability, and shutdown profile",
    );
  }
  if (record.telemetry !== "enabled" && record.telemetry !== "disabled") {
    throw new Error("ackerdb mode marker has an invalid telemetry mode");
  }
  if (record.durability !== "production" && record.durability !== "balanced") {
    throw new Error("ackerdb mode marker has an invalid durability mode");
  }
  if (
    record.telemetryProfile !== "runtime-default" &&
    record.telemetryProfile !== "benchmark-exporter" &&
    record.telemetryProfile !== "disabled"
  ) {
    throw new Error("ackerdb mode marker has an invalid telemetry profile");
  }
  const profile: AckerDBBenchmarkProfile = record.telemetryProfile === "runtime-default"
    ? "enabled"
    : record.telemetryProfile === "benchmark-exporter"
      ? "exporter"
      : "disabled";
  const expected = expectedAckerDBStartupMode(profile, record.durability);
  if (
    record.telemetry !== expected.telemetry ||
    record.telemetryProfile !== expected.telemetryProfile ||
    record.runtimeTelemetry !== expected.runtimeTelemetry ||
    record.exporter !== expected.exporter ||
    record.localSink !== expected.localSink ||
    JSON.stringify(record.telemetryLimits) !== JSON.stringify(expected.telemetryLimits) ||
    record.gracefulShutdownMs !== expected.gracefulShutdownMs
  ) {
    throw new Error("ackerdb mode marker does not describe the benchmark telemetry profile exactly");
  }
  return expected;
}

export function assertAckerDBStartup(output: string, expected: AckerDBStartupMode): AckerDBStartupMode {
  const actual = parseAckerDBStartup(output);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `ackerdb started with telemetry=${actual.telemetry}, durability=${actual.durability}, profile=${actual.telemetryProfile}; expected telemetry=${expected.telemetry}, durability=${expected.durability}, profile=${expected.telemetryProfile}`,
    );
  }
  return actual;
}
