import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// Server rendering has no DOM, no socket, and no client, so every surface is
// proven in a fresh process rather than in this runner's already-configured
// one. Each check script owns the assertions only its own environment can
// make and prints a marker; this file owns what the parent can observe.
function ssrCheck(script: string): string {
  const result = Bun.spawnSync({
    cmd: ["bun", join(import.meta.dir, "support", script)],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  if (result.exitCode !== 0) {
    throw new Error(`${script} failed: ${stdout}${result.stderr.toString()}`);
  }
  return stdout;
}

describe("server rendering", () => {
  test("returns a deterministic non-ready snapshot without browser globals or a connection", () => {
    expect(ssrCheck("ssr-check.tsx")).toContain("SSR_OK");
  });

  test("useAuthentication renders the configured credential kind without a client, socket, or warnings", () => {
    const stdout = ssrCheck("ssr-authentication-check.tsx");
    expect(stdout).toContain("SSR_AUTHENTICATION_OK");
    expect(stdout).toContain("authenticating");
    expect(stdout).toContain("bearer");
  });

  test("useEvent renders without a subscription, a socket, or React warnings", () => {
    const stdout = ssrCheck("ssr-event-check.tsx");
    expect(stdout).toContain("SSR_EVENT_OK");
    expect(stdout).toContain(">listening</output>");
  });
});
