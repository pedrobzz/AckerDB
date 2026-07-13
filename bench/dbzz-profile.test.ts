import { describe, expect, test } from "bun:test";
import {
  assertDbzzStartup,
  benchmarkExecutionOrder,
  compareProfileMetrics,
  parseDbzzStartup,
} from "./dbzz-profile.ts";

const marker = (telemetry = "enabled", durability = "balanced") =>
  `booting\n@@dbzz-startup {"telemetry":"${telemetry}","durability":"${durability}"}\n[dbz] ready on http://127.0.0.1:3311\n`;

describe("dbzz benchmark startup confirmation", () => {
  test("parses the exact server-confirmed marker before readiness", () => {
    expect(parseDbzzStartup(marker())).toEqual({ telemetry: "enabled", durability: "balanced" });
    expect(assertDbzzStartup(marker("disabled"), { telemetry: "disabled", durability: "balanced" })).toEqual({
      telemetry: "disabled",
      durability: "balanced",
    });
  });

  test("rejects missing, duplicate, late, malformed, and expanded markers", () => {
    expect(() => parseDbzzStartup("[dbz] ready on http://127.0.0.1:3311\n")).toThrow("exactly one");
    expect(() => parseDbzzStartup(`${marker()}@@dbzz-startup {"telemetry":"enabled","durability":"balanced"}\n`)).toThrow(
      "exactly one",
    );
    expect(() =>
      parseDbzzStartup('[dbz] ready on http://127.0.0.1:3311\n@@dbzz-startup {"telemetry":"enabled","durability":"balanced"}\n'),
    ).toThrow("must precede");
    expect(() => parseDbzzStartup("@@dbzz-startup nope\n[dbz] ready on x\n")).toThrow("valid JSON");
    expect(() =>
      parseDbzzStartup(
        '@@dbzz-startup {"telemetry":"enabled","durability":"balanced","source":"env"}\n[dbz] ready on x\n',
      ),
    ).toThrow("exactly telemetry and durability");
  });

  test("rejects invalid and mismatched modes", () => {
    expect(() => parseDbzzStartup(marker("default"))).toThrow("invalid telemetry");
    expect(() => parseDbzzStartup(marker("enabled", "normal"))).toThrow("invalid durability");
    expect(() =>
      assertDbzzStartup(marker(), { telemetry: "disabled", durability: "balanced" }),
    ).toThrow("expected telemetry=disabled");
  });
});

describe("dbzz benchmark profile order", () => {
  test("adds both DBZZ profiles only to full runs and alternates their order", () => {
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
