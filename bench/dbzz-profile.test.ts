import { describe, expect, test } from "bun:test";
import {
  assertDbzzStartup,
  benchmarkExecutionOrder,
  benchmarkProfileFromConfig,
  expectedDbzzStartupMode,
  parseDbzzStartup,
  type DbzzBenchmarkProfile,
  type DbzzDurabilityMode,
} from "./dbzz-profile.ts";

const marker = (
  profile: DbzzBenchmarkProfile = "enabled",
  durability: DbzzDurabilityMode = "balanced",
) =>
  `booting\n@@dbzz-startup ${JSON.stringify(expectedDbzzStartupMode(profile, durability))}\n[dbzz] ready on http://127.0.0.1:3311\n`;

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
    expect(parseDbzzStartup(marker("exporter"))).toEqual({
      ...expectedDbzzStartupMode("exporter", "balanced"),
      telemetryProfile: "benchmark-exporter",
      runtimeTelemetry: "options",
      localSink: "default-console",
      exporter: "benchmark-in-process",
    });
  });

  test("rejects missing, duplicate, late, malformed, and expanded markers", () => {
    expect(() => parseDbzzStartup("[dbzz] ready on http://127.0.0.1:3311\n")).toThrow("exactly one");
    expect(() =>
      parseDbzzStartup(
        `${marker()}@@dbzz-startup ${JSON.stringify(expectedDbzzStartupMode("enabled", "balanced"))}\n`,
      )
    ).toThrow("exactly one");
    expect(() =>
      parseDbzzStartup(`[dbzz] ready on http://127.0.0.1:3311\n@@dbzz-startup ${JSON.stringify(expectedDbzzStartupMode("enabled", "balanced"))}\n`),
    ).toThrow("must precede");
    expect(() => parseDbzzStartup("@@dbzz-startup nope\n[dbzz] ready on x\n")).toThrow("valid JSON");
    const expanded = { ...expectedDbzzStartupMode("enabled", "balanced"), source: "env" };
    expect(() =>
      parseDbzzStartup(`@@dbzz-startup ${JSON.stringify(expanded)}\n[dbzz] ready on x\n`),
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
    expect(() => parseDbzzStartup(marker("exporter").replace('"telemetry":"enabled"', '"telemetry":"disabled"')))
      .toThrow("does not describe");
    expect(() =>
      assertDbzzStartup(marker(), expectedDbzzStartupMode("disabled", "balanced")),
    ).toThrow("expected telemetry=disabled");
  });
});

describe("dbzz benchmark profile order", () => {
  test("expands the requested DBZZ profiles in place and rotates their order across reruns", () => {
    expect(benchmarkExecutionOrder(["convex", "dbzz", "spacetimedb"], ["enabled", "exporter", "disabled"], 0)).toEqual([
      "convex",
      "dbzz-telemetry-enabled",
      "dbzz-telemetry-exporter",
      "dbzz-telemetry-disabled",
      "spacetimedb",
    ]);
    expect(benchmarkExecutionOrder(["dbzz", "convex", "spacetimedb"], ["enabled", "exporter", "disabled"], 1)).toEqual([
      "dbzz-telemetry-exporter",
      "dbzz-telemetry-disabled",
      "dbzz-telemetry-enabled",
      "convex",
      "spacetimedb",
    ]);
    // The release run's single profile: rotation is a no-op, so every saved-run
    // count measures the same apples-to-apples leg.
    expect(benchmarkExecutionOrder(["dbzz", "convex", "spacetimedb"], ["disabled"], 2)).toEqual([
      "dbzz-telemetry-disabled",
      "convex",
      "spacetimedb",
    ]);
    expect(() => benchmarkExecutionOrder(["dbzz"], [], 0)).toThrow("at least one DBZZ profile");
  });

  test("selects the explicit exporter profile only with enabled telemetry", () => {
    expect(benchmarkProfileFromConfig("enabled", "disabled")).toBe("enabled");
    expect(benchmarkProfileFromConfig("enabled", "in-process")).toBe("exporter");
    expect(benchmarkProfileFromConfig("disabled", "disabled")).toBe("disabled");
    expect(() => benchmarkProfileFromConfig("disabled", "in-process")).toThrow(
      "requires telemetry to be enabled",
    );
  });
});
