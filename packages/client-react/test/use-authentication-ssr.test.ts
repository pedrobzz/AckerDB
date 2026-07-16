import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("useAuthentication server rendering", () => {
  test("renders the configured credential kind without a client, socket, or warnings", () => {
    const script = join(import.meta.dir, "support", "ssr-authentication-check.tsx");
    const result = Bun.spawnSync({ cmd: ["bun", script], stdout: "pipe", stderr: "pipe" });
    const stdout = result.stdout.toString();
    if (result.exitCode !== 0) {
      throw new Error(`ssr-authentication-check failed: ${stdout}${result.stderr.toString()}`);
    }
    expect(stdout).toContain("SSR_AUTHENTICATION_OK");
    expect(stdout).toContain("authenticating");
    expect(stdout).toContain("bearer");
  });
});
