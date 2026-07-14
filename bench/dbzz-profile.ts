import { PRODUCTION_LIMITS, type TelemetryLimits } from "@dbzz/server";
import type { BenchmarkConfig, SystemName } from "./benchmark.ts";

export type DbzzTelemetryMode = "enabled" | "disabled";
export type DbzzDurabilityMode = "production" | "balanced";
export type DbzzTelemetryProfile = "runtime-default" | "disabled";
export type BenchmarkExecutionLeg =
  | "dbzz-telemetry-enabled"
  | "dbzz-telemetry-disabled"
  | "convex"
  | "spacetimedb";

export interface DbzzStartupMode {
  readonly telemetry: DbzzTelemetryMode;
  readonly durability: DbzzDurabilityMode;
  readonly telemetryProfile: DbzzTelemetryProfile;
  readonly runtimeTelemetry: "omitted" | "false";
  readonly exporter: "unconfigured";
  readonly localSink: "default-console" | "disabled";
  readonly telemetryLimits: TelemetryLimits | null;
  readonly gracefulShutdownMs: number;
}

export interface ProfileMetric {
  readonly label: string;
  readonly value: number;
  readonly lowerIsBetter: boolean;
}

export interface PairedProfileMetric {
  readonly label: string;
  readonly enabled: number;
  readonly disabled: number;
  readonly enabledVsDisabledPercent: number | null;
  readonly lowerIsBetter: boolean;
}

export type BenchmarkRunPolicy =
  | { readonly pairedDbzz: true; readonly acceptAndSave: true; readonly diagnosticMessage: null }
  | { readonly pairedDbzz: boolean; readonly acceptAndSave: false; readonly diagnosticMessage: string };

export const DBZZ_STARTUP_PREFIX = "@@dbzz-startup ";

export function benchmarkRunPolicy(
  systems: readonly SystemName[],
  profile: BenchmarkConfig["profile"],
): BenchmarkRunPolicy {
  const allSystems = systems.length === 3 &&
    (["dbzz", "convex", "spacetimedb"] as const).every((system) => systems.includes(system));
  if (!allSystems) {
    return {
      pairedDbzz: false,
      acceptAndSave: false,
      diagnosticMessage:
        `partial ${profile} diagnostic run: performance acceptance skipped; result not saved (only the default all-system profile is eligible)`,
    };
  }
  if (profile !== "default") {
    return {
      pairedDbzz: true,
      acceptAndSave: false,
      diagnosticMessage:
        `${profile} all-system diagnostic run: performance acceptance skipped; result not saved (only the default all-system profile is eligible)`,
    };
  }
  return { pairedDbzz: true, acceptAndSave: true, diagnosticMessage: null };
}

export function expectedDbzzStartupMode(
  telemetry: DbzzTelemetryMode,
  durability: DbzzDurabilityMode,
): DbzzStartupMode {
  return Object.freeze({
    telemetry,
    durability,
    telemetryProfile: telemetry === "enabled" ? "runtime-default" : "disabled",
    runtimeTelemetry: telemetry === "enabled" ? "omitted" : "false",
    exporter: "unconfigured",
    localSink: telemetry === "enabled" ? "default-console" : "disabled",
    telemetryLimits: telemetry === "enabled" ? Object.freeze({ ...PRODUCTION_LIMITS.telemetry }) : null,
    gracefulShutdownMs: PRODUCTION_LIMITS.gracefulShutdownMs,
  });
}

export function benchmarkExecutionOrder(
  systemOrder: readonly SystemName[],
  pairedDbzz: boolean,
  savedRuns: number,
): BenchmarkExecutionLeg[] {
  if (!Number.isSafeInteger(savedRuns) || savedRuns < 0) {
    throw new RangeError("savedRuns must be a non-negative safe integer");
  }
  const dbzzModes: DbzzTelemetryMode[] = !pairedDbzz
    ? ["enabled"]
    : savedRuns % 2 === 0
      ? ["enabled", "disabled"]
      : ["disabled", "enabled"];
  return systemOrder.flatMap((system) =>
    system === "dbzz"
      ? dbzzModes.map((telemetry) => `dbzz-telemetry-${telemetry}` as const)
      : [system],
  );
}

export function compareProfileMetrics(
  enabled: readonly ProfileMetric[],
  disabled: readonly ProfileMetric[],
): PairedProfileMetric[] {
  const disabledByLabel = new Map<string, ProfileMetric>();
  for (const metric of disabled) {
    if (disabledByLabel.has(metric.label)) throw new Error(`disabled profile duplicates ${metric.label}`);
    disabledByLabel.set(metric.label, metric);
  }
  const seen = new Set<string>();
  const paired = enabled.map((metric) => {
    if (seen.has(metric.label)) throw new Error(`enabled profile duplicates ${metric.label}`);
    seen.add(metric.label);
    const reference = disabledByLabel.get(metric.label);
    if (reference === undefined) throw new Error(`disabled profile is missing ${metric.label}`);
    if (reference.lowerIsBetter !== metric.lowerIsBetter) {
      throw new Error(`profiles disagree on metric direction for ${metric.label}`);
    }
    return {
      label: metric.label,
      enabled: metric.value,
      disabled: reference.value,
      enabledVsDisabledPercent:
        reference.value === 0 ? null : ((metric.value - reference.value) / reference.value) * 100,
      lowerIsBetter: metric.lowerIsBetter,
    };
  });
  if (seen.size !== disabledByLabel.size) {
    const extra = [...disabledByLabel.keys()].find((label) => !seen.has(label))!;
    throw new Error(`enabled profile is missing ${extra}`);
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
  const expected = expectedDbzzStartupMode(record.telemetry, record.durability);
  if (
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
