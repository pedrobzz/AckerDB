import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("useEvent server rendering", () => {
  test("renders without a subscription, a socket, or React warnings", () => {
    const script = join(import.meta.dir, "support", "ssr-event-check.tsx");
    const result = Bun.spawnSync({ cmd: ["bun", script], stdout: "pipe", stderr: "pipe" });
    const stdout = result.stdout.toString();
    if (result.exitCode !== 0) {
      throw new Error(`ssr-event-check failed: ${stdout}${result.stderr.toString()}`);
    }
    expect(stdout).toContain("SSR_EVENT_OK");
    expect(stdout).toContain(">listening</output>");
  });
});
