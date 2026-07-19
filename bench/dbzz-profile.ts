import { PRODUCTION_LIMITS, type TelemetryLimits } from "@dbzz/server";
import type { SystemName } from "./benchmark.ts";

export type DbzzTelemetryMode = "enabled" | "disabled";
export type DbzzDurabilityMode = "production" | "balanced";
export type DbzzBenchmarkProfile = "enabled" | "exporter" | "disabled";
export type DbzzBenchmarkExporterMode = "disabled" | "in-process";
export type DbzzTelemetryProfile = "runtime-default" | "benchmark-exporter" | "disabled";
export type BenchmarkExecutionLeg =
  | "dbzz-telemetry-enabled"
  | "dbzz-telemetry-exporter"
  | "dbzz-telemetry-disabled"
  | "convex"
  | "spacetimedb";

export interface DbzzStartupMode {
  readonly telemetry: DbzzTelemetryMode;
  readonly durability: DbzzDurabilityMode;
  readonly telemetryProfile: DbzzTelemetryProfile;
  readonly runtimeTelemetry: "omitted" | "options" | "false";
  readonly exporter: "unconfigured" | "benchmark-in-process";
  readonly localSink: "default-console" | "disabled";
  readonly telemetryLimits: TelemetryLimits | null;
  readonly gracefulShutdownMs: number;
}

export interface ProfileMetric {
  readonly label: string;
  readonly value: number;
  readonly lowerIsBetter: boolean;
}

export interface ProfileComparisonMetric {
  readonly label: string;
  readonly measuredProfile: DbzzTelemetryProfile;
  readonly measured: number;
  readonly referenceProfile: DbzzTelemetryProfile;
  readonly reference: number;
  readonly measuredVsReferencePercent: number | null;
  readonly lowerIsBetter: boolean;
}

export const DBZZ_STARTUP_PREFIX = "@@dbzz-startup ";

export function benchmarkProfileFromConfig(
  telemetry: DbzzTelemetryMode,
  exporter: DbzzBenchmarkExporterMode,
): DbzzBenchmarkProfile {
  if (telemetry === "disabled") {
    if (exporter !== "disabled") {
      throw new Error("the benchmark exporter requires telemetry to be enabled");
    }
    return "disabled";
  }
  return exporter === "in-process" ? "exporter" : "enabled";
}

export function expectedDbzzStartupMode(
  profile: DbzzBenchmarkProfile,
  durability: DbzzDurabilityMode,
): DbzzStartupMode {
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
  systemOrder: readonly SystemName[],
  dbzzProfiles: readonly DbzzBenchmarkProfile[],
  savedRuns: number,
): BenchmarkExecutionLeg[] {
  if (!Number.isSafeInteger(savedRuns) || savedRuns < 0) {
    throw new RangeError("savedRuns must be a non-negative safe integer");
  }
  if (dbzzProfiles.length === 0) throw new RangeError("at least one DBZZ profile must run");
  // Rotate the profile order across reruns so no profile always pays the
  // cold-cache first slot.
  const rotation = savedRuns % dbzzProfiles.length;
  const rotated = [...dbzzProfiles.slice(rotation), ...dbzzProfiles.slice(0, rotation)];
  return systemOrder.flatMap((system) =>
    system === "dbzz"
      ? rotated.map((profile) => `dbzz-telemetry-${profile}` as const)
      : [system],
  );
}

export function compareProfileMetrics(
  measuredProfile: DbzzTelemetryProfile,
  measured: readonly ProfileMetric[],
  referenceProfile: DbzzTelemetryProfile,
  reference: readonly ProfileMetric[],
): ProfileComparisonMetric[] {
  const referenceByLabel = new Map<string, ProfileMetric>();
  for (const metric of reference) {
    if (referenceByLabel.has(metric.label)) {
      throw new Error(`${referenceProfile} profile duplicates ${metric.label}`);
    }
    referenceByLabel.set(metric.label, metric);
  }
  const seen = new Set<string>();
  const paired = measured.map((metric) => {
    if (seen.has(metric.label)) throw new Error(`${measuredProfile} profile duplicates ${metric.label}`);
    seen.add(metric.label);
    const baseline = referenceByLabel.get(metric.label);
    if (baseline === undefined) throw new Error(`${referenceProfile} profile is missing ${metric.label}`);
    if (baseline.lowerIsBetter !== metric.lowerIsBetter) {
      throw new Error(`profiles disagree on metric direction for ${metric.label}`);
    }
    return {
      label: metric.label,
      measuredProfile,
      measured: metric.value,
      referenceProfile,
      reference: baseline.value,
      measuredVsReferencePercent:
        baseline.value === 0 ? null : ((metric.value - baseline.value) / baseline.value) * 100,
      lowerIsBetter: metric.lowerIsBetter,
    };
  });
  if (seen.size !== referenceByLabel.size) {
    const extra = [...referenceByLabel.keys()].find((label) => !seen.has(label))!;
    throw new Error(`${measuredProfile} profile is missing ${extra}`);
  }
  return paired;
}

/** Parse the one server-confirmed mode marker that must precede readiness. */
export function parseDbzzStartup(output: string): DbzzStartupMode {
  const lines = output.split(/\r?\n/);
  const readyIndex = lines.findIndex((line) => line.includes("ready on"));
  if (readyIndex === -1) throw new Error("dbzz startup output has no readiness line");
  const markers = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.startsWith(DBZZ_STARTUP_PREFIX));
  if (markers.length !== 1) {
    throw new Error(`dbzz startup output must contain exactly one mode marker; found ${markers.length}`);
  }
  const marker = markers[0]!;
  if (marker.index >= readyIndex) throw new Error("dbzz mode marker must precede readiness");

  let value: unknown;
  try {
    value = JSON.parse(marker.line.slice(DBZZ_STARTUP_PREFIX.length));
  } catch (error) {
    throw new Error("dbzz mode marker is not valid JSON", { cause: error });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("dbzz mode marker must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
      "durability,exporter,gracefulShutdownMs,localSink,runtimeTelemetry,telemetry,telemetryLimits,telemetryProfile"
  ) {
    throw new Error(
      "dbzz mode marker must contain exactly the benchmark runtime, telemetry, durability, and shutdown profile",
    );
  }
  if (record.telemetry !== "enabled" && record.telemetry !== "disabled") {
    throw new Error("dbzz mode marker has an invalid telemetry mode");
  }
  if (record.durability !== "production" && record.durability !== "balanced") {
    throw new Error("dbzz mode marker has an invalid durability mode");
  }
  if (
    record.telemetryProfile !== "runtime-default" &&
    record.telemetryProfile !== "benchmark-exporter" &&
    record.telemetryProfile !== "disabled"
  ) {
    throw new Error("dbzz mode marker has an invalid telemetry profile");
  }
  const profile: DbzzBenchmarkProfile = record.telemetryProfile === "runtime-default"
    ? "enabled"
    : record.telemetryProfile === "benchmark-exporter"
      ? "exporter"
      : "disabled";
  const expected = expectedDbzzStartupMode(profile, record.durability);
  if (
    record.telemetry !== expected.telemetry ||
    record.telemetryProfile !== expected.telemetryProfile ||
    record.runtimeTelemetry !== expected.runtimeTelemetry ||
    record.exporter !== expected.exporter ||
    record.localSink !== expected.localSink ||
    JSON.stringify(record.telemetryLimits) !== JSON.stringify(expected.telemetryLimits) ||
    record.gracefulShutdownMs !== expected.gracefulShutdownMs
  ) {
    throw new Error("dbzz mode marker does not describe the benchmark telemetry profile exactly");
  }
  return expected;
}

export function assertDbzzStartup(output: string, expected: DbzzStartupMode): DbzzStartupMode {
  const actual = parseDbzzStartup(output);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `dbzz started with telemetry=${actual.telemetry}, durability=${actual.durability}, profile=${actual.telemetryProfile}; expected telemetry=${expected.telemetry}, durability=${expected.durability}, profile=${expected.telemetryProfile}`,
    );
  }
  return actual;
}
