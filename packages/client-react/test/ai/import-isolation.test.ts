import { describe, expect, test } from "bun:test";

// A browser bundle names every module it included in its section comments
// (e.g. "node_modules/ai/dist/index.js"), so grepping the output is a real
// resolution proof, not a heuristic.
const AI_MARKERS = ["node_modules/ai/", "@ai-sdk/"];

// Bundles in a subprocess: other test files in this process register
// happy-dom's globals, which in-process Bun.build trips over.
function bundle(entry: string): string {
  const result = Bun.spawnSync(
    [process.execPath, "build", "--target=browser", new URL(entry, import.meta.url).pathname],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}

describe("the /ai subpath is isolated from the base entry", () => {
  test("the control graph proves the markers detect a bundled AI SDK", () => {
    const control = bundle("./resolves-ai.entry.ts");
    for (const marker of AI_MARKERS) {
      expect(control).toContain(marker);
    }
  });

  test("the base entry resolves no AI SDK code", () => {
    const base = bundle("../../src/index.ts");
    for (const marker of AI_MARKERS) {
      expect(base).not.toContain(marker);
    }
  });

  test("the /ai subpath itself stays type-only over the ai package", () => {
    // The transport implements the ChatTransport contract without any AI SDK
    // runtime import, so even /ai consumers ship no ai code through dbzz.
    const subpath = bundle("../../src/ai/index.ts");
    for (const marker of AI_MARKERS) {
      expect(subpath).not.toContain(marker);
    }
  });
});
