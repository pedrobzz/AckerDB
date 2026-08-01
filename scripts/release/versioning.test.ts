import { describe, expect, test } from "bun:test";
import {
  bootstrapCanaryVersion,
  canaryPattern,
  nextBetaVersion,
  publicVersion,
} from "./versioning.ts";

describe("release versioning", () => {
  test("maps protected branches to stable and deterministic canary versions", () => {
    expect(publicVersion("main", "1.2.3")).toBe("1.2.3");
    expect(publicVersion("canary", "1.2.3", "47")).toBe("1.2.3-canary.47");
    expect(() => publicVersion("canary", "1.2.3", "rerun")).toThrow("numeric GitHub run");
  });

  test("reserves canary zero for the one interactive npm bootstrap", () => {
    expect(bootstrapCanaryVersion("1.2.3")).toBe("1.2.3-canary.0");
    expect(() => bootstrapCanaryVersion("1.2.3-beta.1")).toThrow("stable x.y.z");
  });

  test("allocates repeatable local beta numbers from registry state", () => {
    expect(nextBetaVersion("1.2.3", [])).toBe("1.2.3-beta.1");
    expect(nextBetaVersion("1.2.3", [
      "1.2.3-beta.2",
      "1.2.3-canary.99",
      "1.2.2-beta.40",
      "1.2.3-beta.7",
    ])).toBe("1.2.3-beta.8");
  });

  test("matches only canaries for the promoted source version", () => {
    const pattern = canaryPattern("1.2.3");
    expect(pattern.test("1.2.3-canary.4")).toBe(true);
    expect(pattern.test("1.2.4-canary.4")).toBe(false);
    expect(pattern.test("1.2.3-beta.4")).toBe(false);
  });
});
