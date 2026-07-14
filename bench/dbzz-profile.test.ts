import { describe, expect, test } from "bun:test";
import {
  assertDbzzStartup,
  benchmarkExecutionOrder,
  benchmarkRunPolicy,
  compareProfileMetrics,
  expectedDbzzStartupMode,
  parseDbzzStartup,
  type DbzzDurabilityMode,
  type DbzzTelemetryMode,
} from "./dbzz-profile.ts";

const marker = (
  telemetry: DbzzTelemetryMode = "enabled",
  durability: DbzzDurabilityMode = "balanced",
) =>
  `booting\n@@dbzz-startup ${JSON.stringify(expectedDbzzStartupMode(telemetry, durability))}\n[dbz] ready on http://127.0.0.1:3311\n`;

describe("dbzz benchmark startup confirmation", () => {
  test("parses the exact server-confirmed marker before readiness", () => {
    expect(parseDbzzStartup(marker())).toEqual({
      ...expectedDbzzStartupMode("enabled", "balanced"),
      telemetryProfile: "runtime-default",
      runtimeTelemetry: "omitted",
      localSink: "default-console",
      exporter: "unconfigured",
    });
    expect(
      assertDbzzStartup(marker("disabled"), expectedDbzzStartupMode("disabled", "balanced")),
    ).toEqual(expectedDbzzStartupMode("disabled", "balanced"));
  });

  test("rejects missing, duplicate, late, malformed, and expanded markers", () => {
    expect(() => parseDbzzStartup("[dbz] ready on http://127.0.0.1:3311\n")).toThrow("exactly one");
    expect(() =>
      parseDbzzStartup(
        `${marker()}@@dbzz-startup ${JSON.stringify(expectedDbzzStartupMode("enabled", "balanced"))}\n`,
      )
    ).toThrow("exactly one");
    expect(() =>
      parseDbzzStartup(`[dbz] ready on http://127.0.0.1:3311\n@@dbzz-startup ${JSON.stringify(expectedDbzzStartupMode("enabled", "balanced"))}\n`),
    ).toThrow("must precede");
    expect(() => parseDbzzStartup("@@dbzz-startup nope\n[dbz] ready on x\n")).toThrow("valid JSON");
    const expanded = { ...expectedDbzzStartupMode("enabled", "balanced"), source: "env" };
    expect(() =>
      parseDbzzStartup(`@@dbzz-startup ${JSON.stringify(expanded)}\n[dbz] ready on x\n`),
    ).toThrow("must contain exactly");
  });

  test("rejects invalid, modified, and mismatched modes", () => {
    expect(() => parseDbzzStartup(marker().replace('"telemetry":"enabled"', '"telemetry":"default"'))).toThrow(
      "invalid telemetry",
    );
    expect(() => parseDbzzStartup(marker().replace('"durability":"balanced"', '"durability":"normal"'))).toThrow(
      "invalid durability",
    );
    expect(() => parseDbzzStartup(marker().replace('"maxRecords":2048', '"maxRecords":2047'))).toThrow(
      "does not describe",
    );
    expect(() => parseDbzzStartup(marker().replace('"runtimeTelemetry":"omitted"', '"runtimeTelemetry":"false"'))).toThrow(
      "does not describe",
    );
    expect(() =>
      assertDbzzStartup(marker(), expectedDbzzStartupMode("disabled", "balanced")),
    ).toThrow("expected telemetry=disabled");
  });
});

describe("dbzz benchmark profile order", () => {
  test("adds both DBZZ profiles only to all-system runs and alternates their order", () => {
    expect(benchmarkExecutionOrder(["convex", "dbzz", "spacetimedb"], true, 0)).toEqual([
      "convex",
      "dbzz-telemetry-enabled",
      "dbzz-telemetry-disabled",
      "spacetimedb",
    ]);
    expect(benchmarkExecutionOrder(["dbzz", "convex", "spacetimedb"], true, 1)).toEqual([
      "dbzz-telemetry-disabled",
      "dbzz-telemetry-enabled",
      "convex",
      "spacetimedb",
    ]);
    expect(benchmarkExecutionOrder(["dbzz", "convex"], false, 2)).toEqual([
      "dbzz-telemetry-enabled",
      "convex",
    ]);
  });
});

describe("benchmark acceptance and persistence policy", () => {
  const allSystems = ["dbzz", "convex", "spacetimedb"] as const;

  test("accepts and saves only the default all-system profile", () => {
    expect(benchmarkRunPolicy(allSystems, "default")).toEqual({
      pairedDbzz: true,
      acceptAndSave: true,
      diagnosticMessage: null,
    });
  });

  test("keeps all-system quick and stress profiles paired but diagnostic", () => {
    for (const profile of ["quick", "stress"] as const) {
      expect(benchmarkRunPolicy(allSystems, profile)).toEqual({
        pairedDbzz: true,
        acceptAndSave: false,
        diagnosticMessage:
          `${profile} all-system diagnostic run: performance acceptance skipped; result not saved (only the default all-system profile is eligible)`,
      });
    }
  });

  test("keeps every partial profile unpaired and diagnostic", () => {
    for (const profile of ["quick", "default", "stress"] as const) {
      expect(benchmarkRunPolicy(["dbzz", "convex"], profile)).toEqual({
        pairedDbzz: false,
        acceptAndSave: false,
        diagnosticMessage:
          `partial ${profile} diagnostic run: performance acceptance skipped; result not saved (only the default all-system profile is eligible)`,
      });
    }
  });
});

describe("dbzz telemetry cost", () => {
  test("pairs exact metric labels and preserves a zero denominator as unavailable", () => {
    expect(
      compareProfileMetrics(
        [
          { label: "TPS", value: 90, lowerIsBetter: false },
          { label: "CPU", value: 0.5, lowerIsBetter: true },
        ],
        [
          { label: "TPS", value: 100, lowerIsBetter: false },
          { label: "CPU", value: 0, lowerIsBetter: true },
        ],
      ),
    ).toEqual([
      {
        label: "TPS",
        enabled: 90,
        disabled: 100,
        enabledVsDisabledPercent: -10,
        lowerIsBetter: false,
      },
      {
        label: "CPU",
        enabled: 0.5,
        disabled: 0,
        enabledVsDisabledPercent: null,
        lowerIsBetter: true,
      },
    ]);
  });

  test("rejects missing, duplicate, and direction-mismatched metrics", () => {
    const metric = { label: "TPS", value: 1, lowerIsBetter: false };
    expect(() => compareProfileMetrics([metric], [])).toThrow("disabled profile is missing TPS");
    expect(() => compareProfileMetrics([metric, metric], [metric])).toThrow("enabled profile duplicates TPS");
    expect(() => compareProfileMetrics([metric], [metric, metric])).toThrow("disabled profile duplicates TPS");
    expect(() => compareProfileMetrics([metric], [{ ...metric, lowerIsBetter: true }])).toThrow(
      "disagree on metric direction",
    );
  });
});
