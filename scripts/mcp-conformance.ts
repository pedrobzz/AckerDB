import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AckerDBError,
  v,
  defineSchema,
  defineTable,
  Engine,
  reconcile,
  Registry,
  Runtime,
  procedure,
  type McpBuilder,
  type ProcedureBuilder,
} from "@ackerdb/server";
import { listen } from "ackerdb-test-support/listen";
import { mcp, mcpContent, type McpToolResult } from "@ackerdb/server/mcp";

const CONFORMANCE_VERSION = "0.1.16";
const SCENARIOS = [
  "server-initialize",
  "ping",
  "tools-list",
  "tools-call-simple-text",
  "tools-call-image",
  "tools-call-audio",
  "tools-call-embedded-resource",
  "tools-call-mixed-content",
  "tools-call-error",
  "dns-rebinding-protection",
] as const;

interface ConformanceCheck {
  readonly id: string;
  readonly status: "SUCCESS" | "FAILURE" | "WARNING" | "SKIPPED" | "INFO";
  readonly errorMessage?: string;
}

const schema = defineSchema({
  fixtures: defineTable({
    id: v.primaryKey(),
    value: v.string(),
  }),
});
const typedMcp = mcp as McpBuilder<typeof schema>;
const typedProcedure = procedure as ProcedureBuilder<typeof schema>;

const simpleText = typedProcedure({
  description: "Return the official conformance suite's simple text fixture.",
  access: "public",
  returns: mcpContent(),
  args: {},
  handler: (): McpToolResult => ({
    content: [{ type: "text", text: "This is a simple text response for testing." }],
  }),
});

const imageContent = typedProcedure({
  description: "Return a base64 image content block.",
  access: "public",
  returns: mcpContent(),
  args: {},
  handler: (): McpToolResult => ({
    content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
  }),
});

const audioContent = typedProcedure({
  description: "Return a base64 audio content block.",
  access: "public",
  returns: mcpContent(),
  args: {},
  handler: (): McpToolResult => ({
    content: [{ type: "audio", data: "UklGRg==", mimeType: "audio/wav" }],
  }),
});

const embeddedResource = typedProcedure({
  description: "Return an embedded text resource content block.",
  access: "public",
  returns: mcpContent(),
  args: {},
  handler: (): McpToolResult => ({
    content: [{
      type: "resource",
      resource: {
        uri: "test://embedded-resource",
        mimeType: "text/plain",
        text: "This is an embedded resource content.",
      },
    }],
  }),
});

const mixedContent = typedProcedure({
  description: "Return text, image, and embedded resource content blocks.",
  access: "public",
  returns: mcpContent(),
  args: {},
  handler: (): McpToolResult => ({
    content: [
      { type: "text", text: "Multiple content types test:" },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      {
        type: "resource",
        resource: {
          uri: "test://mixed-content-resource",
          mimeType: "application/json",
          text: JSON.stringify({ test: "data", value: 123 }),
        },
      },
    ],
  }),
});

const errorHandling = typedProcedure({
  description: "Return the framework's intentional safe tool error.",
  access: "public",
  returns: mcpContent(),
  args: {},
  handler: () => {
    throw new AckerDBError("conflict", "intentional conformance error");
  },
});

const conformanceMcp = typedMcp({
  name: "conformance",
  instructions: "MCP protocol conformance fixtures for AckerDB release verification.",
  tools: {
    test_audio_content: { fn: audioContent, access: "public" },
    test_embedded_resource: { fn: embeddedResource, access: "public" },
    test_error_handling: { fn: errorHandling, access: "public" },
    test_image_content: { fn: imageContent, access: "public" },
    test_multiple_content_types: { fn: mixedContent, access: "public" },
    test_simple_text: { fn: simpleText, access: "public" },
  },
});

const modules = {
  conformance: {
    conformanceMcp,
  },
};

async function readChecks(outputDir: string): Promise<ConformanceCheck[]> {
  const resultDirs = readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (resultDirs.length !== 1) {
    throw new Error(`official conformance runner wrote ${resultDirs.length} result directories`);
  }
  return await Bun.file(join(outputDir, resultDirs[0]!, "checks.json")).json();
}

async function runScenario(
  binary: string,
  url: string,
  resultsRoot: string,
  scenario: typeof SCENARIOS[number],
): Promise<{ passed: number; warnings: number }> {
  const outputDir = join(resultsRoot, scenario);
  const child = Bun.spawn([
    process.execPath,
    binary,
    "server",
    "--url",
    url,
    "--scenario",
    scenario,
    "--output-dir",
    outputDir,
  ], {
    cwd: resolve(import.meta.dir, ".."),
    env: { ...process.env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const checks = await readChecks(outputDir).catch((error) => {
    throw new Error(
      `${scenario}: could not read official conformance evidence: ${
        error instanceof Error ? error.message : String(error)
      }\n${stdout}${stderr}`,
    );
  });
  const failed = checks.filter((check) => check.status === "FAILURE");
  const warnings = checks.filter((check) => check.status === "WARNING");
  const skipped = checks.filter((check) => check.status === "SKIPPED");
  const passed = checks.filter((check) => check.status === "SUCCESS");
  if (exitCode !== 0 || failed.length > 0 || skipped.length > 0 || passed.length === 0) {
    const details = failed.map((check) =>
      `${check.id}: ${check.errorMessage ?? "failed without an error message"}`
    ).join("\n");
    throw new Error(
      `${scenario}: official conformance did not fully exercise its selected capability ` +
        `(exit ${exitCode}, ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped)\n` +
        `${details}\n${stdout}${stderr}`,
    );
  }
  return {
    passed: passed.length,
    warnings: warnings.length,
  };
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  const manifestPath = join(
    root,
    "node_modules/@modelcontextprotocol/conformance/package.json",
  );
  const manifest = await Bun.file(manifestPath).json() as { version?: unknown };
  if (manifest.version !== CONFORMANCE_VERSION) {
    throw new Error(
      `expected @modelcontextprotocol/conformance ${CONFORMANCE_VERSION}, received ${String(manifest.version)}`,
    );
  }
  const binary = join(root, "node_modules/@modelcontextprotocol/conformance/dist/index.js");
  if (!(await Bun.file(binary).exists())) {
    throw new Error(`official conformance runner is missing at ${binary}`);
  }

  const directory = mkdtempSync(join(tmpdir(), "ackerdb-mcp-conformance-"));
  const resultsRoot = mkdtempSync(join(tmpdir(), "ackerdb-mcp-conformance-results-"));
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const runtime = new Runtime({
    engine,
    registry: new Registry(modules),
  });
  await runtime.start();
  const server = listen(runtime);

  try {
    const url = `http://127.0.0.1:${server.port}${conformanceMcp.path}`;
    let passed = 0;
    let warnings = 0;
    for (const scenario of SCENARIOS) {
      const result = await runScenario(binary, url, resultsRoot, scenario);
      passed += result.passed;
      warnings += result.warnings;
      console.log(`✓ ${scenario}: ${result.passed} passed, ${result.warnings} warnings`);
    }
    console.log(
      `Official MCP conformance ${CONFORMANCE_VERSION}: ${passed} checks passed across ${SCENARIOS.length} supported scenarios, ${warnings} warnings.`,
    );
  } finally {
    await server.drain().catch(() => {});
    await runtime.drain().catch(() => {});
    engine.close("clean");
    rmSync(directory, { recursive: true, force: true });
    rmSync(resultsRoot, { recursive: true, force: true });
  }
}

await main();
