import { describe, expect, test } from "bun:test";
import { accumulatedLevel, assertReleasePolicy, exactNextLevel } from "./release-policy.ts";

describe("release version policy", () => {
  test("topic branches declare exactly one semantic-version step", () => {
    expect(exactNextLevel("0.13.1", "0.13.2")).toBe("patch");
    expect(exactNextLevel("0.13.1", "0.14.0")).toBe("minor");
    expect(exactNextLevel("0.13.1", "1.0.0")).toBe("major");
    expect(exactNextLevel("0.13.1", "0.13.3")).toBeNull();
    expect(exactNextLevel("0.13.1", "0.14.1")).toBeNull();
  });

  test("canary promotion accepts the accumulated forward release", () => {
    expect(accumulatedLevel("0.13.1", "0.13.4")).toBe("patch");
    expect(accumulatedLevel("0.13.1", "0.15.2")).toBe("minor");
    expect(accumulatedLevel("0.13.1", "2.1.7")).toBe("major");
    expect(accumulatedLevel("0.13.1", "0.13.1")).toBeNull();
    expect(accumulatedLevel("0.13.1", "0.12.9")).toBeNull();
  });

  test("a canary pull request may keep the current source version", async () => {
    const result = await assertReleasePolicy({
      baseBranch: "canary",
      headBranch: "topic/no-bump",
      baseSha: "HEAD",
      headSha: "HEAD",
      author: "anyone",
      urgent: false,
    });
    expect(result.level).toBeNull();
  });

  test("an urgent hotfix into main still declares exactly one step", async () => {
    await expect(
      assertReleasePolicy({
        baseBranch: "main",
        headBranch: "hotfix/regression",
        baseSha: "HEAD",
        headSha: "HEAD",
        author: "pedrobzz",
        urgent: true,
      }),
    ).rejects.toThrow(/not exactly one/);
  });
});
