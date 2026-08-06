import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import {
  parseStudioArguments,
  resolveStudioEntry,
  studioTarget,
  STUDIO_DEFAULT_PORT,
  STUDIO_INSTALL_HINT,
} from "../../src/commands/studio.ts";

const CLI = new URL("../../src/commands/main.ts", import.meta.url).pathname;

const dirs: string[] = [];
const children: Subprocess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill();
    await child.exited;
  }
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "ackerdb-studio-cli-"));
  dirs.push(path);
  return path;
}

/** An app dir with a fake installed @ackerdb/studio whose launcher we control. */
function appWithStudio(launcherSource: string, config?: Record<string, unknown>): string {
  const appDir = directory();
  if (config !== undefined) {
    writeFileSync(join(appDir, ".ackerdb.config.json"), JSON.stringify(config));
  }
  const packageDir = join(appDir, "node_modules", "@ackerdb", "studio");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({
    name: "@ackerdb/studio",
    version: "0.0.0-test",
    type: "module",
    exports: { ".": "./src/server.ts" },
  }));
  mkdirSync(join(packageDir, "src"));
  writeFileSync(join(packageDir, "src", "server.ts"), launcherSource);
  return appDir;
}

describe("parseStudioArguments", () => {
  test("defaults: current directory, port 4680, config-derived target", () => {
    expect(parseStudioArguments([])).toEqual({
      appDir: resolve("."),
      port: STUDIO_DEFAULT_PORT,
    });
  });

  test("accepts app-dir, --url, and --port in any order", () => {
    expect(parseStudioArguments(["./my-app", "--port", "5000", "--url", "https://api.example.com"]))
      .toEqual({ appDir: resolve("./my-app"), url: "https://api.example.com", port: 5000 });
    expect(parseStudioArguments(["--url", "http://127.0.0.1:3999", "some-app"]))
      .toEqual({ appDir: resolve("some-app"), url: "http://127.0.0.1:3999", port: STUDIO_DEFAULT_PORT });
  });

  test("rejects malformed invocations with a usage answer", () => {
    expect(parseStudioArguments(["a", "b"])).toBeNull();
    expect(parseStudioArguments(["--port"])).toBeNull();
    expect(parseStudioArguments(["--port", "nope"])).toBeNull();
    expect(parseStudioArguments(["--port", "0"])).toBeNull();
    expect(parseStudioArguments(["--port", "70000"])).toBeNull();
    expect(parseStudioArguments(["--port", "1", "--port", "2"])).toBeNull();
    expect(parseStudioArguments(["--url"])).toBeNull();
    expect(parseStudioArguments(["--url", "not a url"])).toBeNull();
    expect(parseStudioArguments(["--url", "ftp://example.com"])).toBeNull();
    expect(parseStudioArguments(["--url", "http://a", "--url", "http://b"])).toBeNull();
    expect(parseStudioArguments(["--watch"])).toBeNull();
  });

  test("refuses a --url whose path or query the proxy would drop", () => {
    expect(parseStudioArguments(["--url", "http://example.com/api"])).toBeNull();
    expect(parseStudioArguments(["--url", "http://example.com/?x=1"])).toBeNull();
    expect(parseStudioArguments(["--url", "http://example.com/"]))
      .toEqual({ appDir: resolve("."), url: "http://example.com", port: STUDIO_DEFAULT_PORT });
  });
});

describe("studioTarget", () => {
  test("reads the app port from .ackerdb.config.json", () => {
    const appDir = directory();
    writeFileSync(join(appDir, ".ackerdb.config.json"), JSON.stringify({ port: 4999 }));
    expect(studioTarget({ appDir, port: STUDIO_DEFAULT_PORT })).toBe("http://127.0.0.1:4999");
  });

  test("defaults to the default listener and maps wildcard hosts to loopback", () => {
    const appDir = directory();
    expect(studioTarget({ appDir, port: STUDIO_DEFAULT_PORT })).toBe("http://127.0.0.1:3211");
    writeFileSync(
      join(appDir, ".ackerdb.config.json"),
      JSON.stringify({ hostname: "0.0.0.0", port: 4998 }),
    );
    expect(studioTarget({ appDir, port: STUDIO_DEFAULT_PORT })).toBe("http://127.0.0.1:4998");
  });

  test("an explicit --url wins without reading any config", () => {
    expect(studioTarget({ appDir: join(directory(), "absent"), url: "https://api.example.com", port: 1 }))
      .toBe("https://api.example.com");
  });
});

describe("resolveStudioEntry", () => {
  test("resolves the package from the app's node_modules", () => {
    const appDir = appWithStudio("export function startStudio() {}\n");
    // Resolution may return the canonical (symlink-free) form of the path.
    expect(resolveStudioEntry(appDir)).toEndWith(
      join("node_modules", "@ackerdb", "studio", "src", "server.ts"),
    );
  });

  test("absence errors with the install hint — installing is the opt-in", () => {
    const appDir = directory();
    expect(() => resolveStudioEntry(appDir)).toThrow(STUDIO_INSTALL_HINT);
    expect(() => resolveStudioEntry(appDir)).toThrow(appDir);
  });
});

test("`acker studio` resolves the launcher and passes the config-derived target", async () => {
  const appDir = appWithStudio(
    `export function startStudio(options) {
      console.log("started " + JSON.stringify(options));
      return { url: "http://127.0.0.1:" + options.port + "/", stop() {} };
    }\n`,
    { port: 4997 },
  );
  const child = Bun.spawn([process.execPath, CLI, "studio", appDir, "--port", "4681"], {
    stdout: "pipe",
    stderr: "inherit",
  });
  children.push(child);
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of child.stdout) {
    buffer += decoder.decode(chunk);
    if (buffer.includes("copy the URL")) break;
  }
  expect(buffer).toContain('started {"target":"http://127.0.0.1:4997","port":4681}');
  expect(buffer).toContain("[ackerdb] Studio serving at http://127.0.0.1:4681/ — proxying to http://127.0.0.1:4997");
});

test("`acker studio` without the package installed fails with the hint", async () => {
  const appDir = directory();
  const child = Bun.spawn([process.execPath, CLI, "studio", appDir], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  expect(exitCode).toBe(1);
  expect(stderr).toContain(STUDIO_INSTALL_HINT);
});
