import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("server rendering", () => {
  test("returns a deterministic non-ready snapshot without browser globals or a connection", () => {
    const script = join(import.meta.dir, "support", "ssr-check.tsx");
    const result = Bun.spawnSync({ cmd: ["bun", script], stdout: "pipe", stderr: "pipe" });
    const stdout = result.stdout.toString();
    if (result.exitCode !== 0) {
      throw new Error(`ssr-check failed: ${stdout}${result.stderr.toString()}`);
    }
    expect(stdout).toContain("SSR_OK");
    expect(stdout).toContain(">connecting</output>");
  });
});
