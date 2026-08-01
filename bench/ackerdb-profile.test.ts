import { describe, expect, test } from "bun:test";
import {
  assertAckerDBStartup,
  benchmarkExecutionOrder,
  benchmarkProfileFromConfig,
  expectedAckerDBStartupMode,
  parseAckerDBStartup,
  type AckerDBBenchmarkProfile,
  type AckerDBDurabilityMode,
} from "./ackerdb-profile.ts";

const marker = (
  profile: AckerDBBenchmarkProfile = "enabled",
  durability: AckerDBDurabilityMode = "balanced",
) =>
  `booting\n@@ackerdb-startup ${JSON.stringify(expectedAckerDBStartupMode(profile, durability))}\n[ackerdb] ready on http://127.0.0.1:3311\n`;

describe("ackerdb benchmark startup confirmation", () => {
  test("parses the exact server-confirmed marker before readiness", () => {
    expect(parseAckerDBStartup(marker())).toEqual({
      ...expectedAckerDBStartupMode("enabled", "balanced"),
      telemetryProfile: "runtime-default",
      runtimeTelemetry: "omitted",
      localSink: "default-console",
      exporter: "unconfigured",
    });
    expect(
      assertAckerDBStartup(marker("disabled"), expectedAckerDBStartupMode("disabled", "balanced")),
    ).toEqual(expectedAckerDBStartupMode("disabled", "balanced"));
    expect(parseAckerDBStartup(marker("exporter"))).toEqual({
      ...expectedAckerDBStartupMode("exporter", "balanced"),
      telemetryProfile: "benchmark-exporter",
      runtimeTelemetry: "options",
      localSink: "default-console",
      exporter: "benchmark-in-process",
    });
  });

  test("rejects missing, duplicate, late, malformed, and expanded markers", () => {
    expect(() => parseAckerDBStartup("[ackerdb] ready on http://127.0.0.1:3311\n")).toThrow("exactly one");
    expect(() =>
      parseAckerDBStartup(
        `${marker()}@@ackerdb-startup ${JSON.stringify(expectedAckerDBStartupMode("enabled", "balanced"))}\n`,
      )
    ).toThrow("exactly one");
    expect(() =>
      parseAckerDBStartup(`[ackerdb] ready on http://127.0.0.1:3311\n@@ackerdb-startup ${JSON.stringify(expectedAckerDBStartupMode("enabled", "balanced"))}\n`),
    ).toThrow("must precede");
    expect(() => parseAckerDBStartup("@@ackerdb-startup nope\n[ackerdb] ready on x\n")).toThrow("valid JSON");
    const expanded = { ...expectedAckerDBStartupMode("enabled", "balanced"), source: "env" };
    expect(() =>
      parseAckerDBStartup(`@@ackerdb-startup ${JSON.stringify(expanded)}\n[ackerdb] ready on x\n`),
    ).toThrow("must contain exactly");
  });

  test("rejects invalid, modified, and mismatched modes", () => {
    expect(() => parseAckerDBStartup(marker().replace('"telemetry":"enabled"', '"telemetry":"default"'))).toThrow(
      "invalid telemetry",
    );
    expect(() => parseAckerDBStartup(marker().replace('"durability":"balanced"', '"durability":"normal"'))).toThrow(
      "invalid durability",
    );
    expect(() => parseAckerDBStartup(marker().replace('"maxRecords":2048', '"maxRecords":2047'))).toThrow(
      "does not describe",
    );
    expect(() => parseAckerDBStartup(marker().replace('"runtimeTelemetry":"omitted"', '"runtimeTelemetry":"false"'))).toThrow(
      "does not describe",
    );
    expect(() => parseAckerDBStartup(marker("exporter").replace('"telemetry":"enabled"', '"telemetry":"disabled"')))
      .toThrow("does not describe");
    expect(() =>
      assertAckerDBStartup(marker(), expectedAckerDBStartupMode("disabled", "balanced")),
    ).toThrow("expected telemetry=disabled");
  });
});

describe("ackerdb benchmark profile order", () => {
  test("rotates requested telemetry profiles across reruns", () => {
    expect(benchmarkExecutionOrder(["enabled", "exporter", "disabled"], 0)).toEqual([
      "ackerdb-telemetry-enabled",
      "ackerdb-telemetry-exporter",
      "ackerdb-telemetry-disabled",
    ]);
    expect(benchmarkExecutionOrder(["enabled", "exporter", "disabled"], 1)).toEqual([
      "ackerdb-telemetry-exporter",
      "ackerdb-telemetry-disabled",
      "ackerdb-telemetry-enabled",
    ]);
    expect(benchmarkExecutionOrder(["disabled"], 2)).toEqual([
      "ackerdb-telemetry-disabled",
    ]);
    expect(() => benchmarkExecutionOrder([], 0)).toThrow("at least one AckerDB profile");
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
