import { describe, expect, test } from "bun:test";
import {
  assertAckerDBStartup,
  expectedAckerDBStartupMode,
  parseAckerDBStartup,
  type AckerDBDurabilityMode,
} from "./ackerdb-profile.ts";

const marker = (durability: AckerDBDurabilityMode = "balanced") =>
  `booting\n@@ackerdb-startup ${JSON.stringify(expectedAckerDBStartupMode(durability))}\n` +
  "[ackerdb] ready on http://127.0.0.1:3311\n";

describe("ackerdb benchmark startup confirmation", () => {
  test("parses the exact server-confirmed marker before readiness", () => {
    expect(parseAckerDBStartup(marker())).toEqual(expectedAckerDBStartupMode("balanced"));
    expect(assertAckerDBStartup(
      marker("production"),
      expectedAckerDBStartupMode("production"),
    )).toEqual(expectedAckerDBStartupMode("production"));
  });

  test("rejects missing, duplicate, late, malformed, and expanded markers", () => {
    expect(() => parseAckerDBStartup("[ackerdb] ready on http://127.0.0.1:3311\n"))
      .toThrow("exactly one");
    expect(() => parseAckerDBStartup(`${marker()}${marker()}`)).toThrow("exactly one");
    expect(() => parseAckerDBStartup(
      `[ackerdb] ready on x\n@@ackerdb-startup ${JSON.stringify(expectedAckerDBStartupMode("balanced"))}\n`,
    )).toThrow("must precede");
    expect(() => parseAckerDBStartup("@@ackerdb-startup nope\n[ackerdb] ready on x\n"))
      .toThrow("valid JSON");
    const expanded = { ...expectedAckerDBStartupMode("balanced"), source: "env" };
    expect(() => parseAckerDBStartup(
      `@@ackerdb-startup ${JSON.stringify(expanded)}\n[ackerdb] ready on x\n`,
    )).toThrow("must contain exactly");
  });

  test("rejects invalid, modified, and mismatched modes", () => {
    expect(() => parseAckerDBStartup(
      marker().replace('"durability":"balanced"', '"durability":"normal"'),
    )).toThrow("invalid durability");
    expect(() => parseAckerDBStartup(
      marker().replace('"gracefulShutdownMs":10000', '"gracefulShutdownMs":1'),
    )).toThrow("does not describe");
    expect(() => assertAckerDBStartup(
      marker("balanced"),
      expectedAckerDBStartupMode("production"),
    )).toThrow("expected durability=production");
  });
});
