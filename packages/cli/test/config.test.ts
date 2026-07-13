import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

describe("production profile configuration", () => {
  test("defaults to production durability with telemetry enabled", () => {
    expect(loadConfig(".", {})).toMatchObject({
      durability: "production",
      telemetry: "enabled",
    });
  });

  test("accepts only the named durability and telemetry profiles", () => {
    expect(loadConfig(".", {
      DBZZ_DURABILITY: "balanced",
      DBZZ_TELEMETRY: "disabled",
    })).toMatchObject({
      durability: "balanced",
      telemetry: "disabled",
    });
  });

  test("rejects an unknown durability profile without normalization", () => {
    expect(() => loadConfig(".", { DBZZ_DURABILITY: "Production" })).toThrow(
      'DBZZ_DURABILITY must be exactly production or balanced; received "Production"',
    );
  });

  test("rejects an unknown telemetry profile without normalization", () => {
    expect(() => loadConfig(".", { DBZZ_TELEMETRY: "off" })).toThrow(
      'DBZZ_TELEMETRY must be exactly enabled or disabled; received "off"',
    );
  });
});
