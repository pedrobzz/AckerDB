import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { RealtimeRuntimeModule } from "@ackerdb/server";
import { runCodegen } from "../../src/app/codegen.ts";
import { loadConfig } from "../../src/app/config.ts";
import { startApp } from "../../src/app/start.ts";
import { FIXTURE_APP, makeFixture } from "../support/fixture.ts";

const REALTIME_DECLARATION = `
import { realtime } from "@ackerdb/server";

export const live = realtime({
  args: {},
  clientEvents: {},
  serverEvents: {},
  clientStreams: {},
  serverStreams: {},
  access: "public",
  handler: () => {},
});
`;

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

function fixture(files: Record<string, string>): string {
  const dir = makeFixture(files);
  dirs.push(dir);
  return dir;
}

describe("configured realtime runtime", () => {
  test("loads the configured module when the application declares realtime", async () => {
    const dir = fixture({
      "app.ts": FIXTURE_APP,
      "functions/live.ts": REALTIME_DECLARATION,
      "realtime.ts": `
        export default {
          create: () => { throw new Error("configured realtime selected"); },
        };
      `,
      ".ackerdb.config.json": JSON.stringify({
        port: freePort(),
        realtime: "./realtime.ts",
      }),
    });

    await expect(startApp(loadConfig(dir, { ACKERDB_TELEMETRY: "disabled" })))
      .rejects.toThrow("configured realtime selected");
  });

  test("reports missing and malformed configured modules at startup", async () => {
    const missing = fixture({
      "app.ts": FIXTURE_APP,
      "functions/live.ts": REALTIME_DECLARATION,
      ".ackerdb.config.json": JSON.stringify({
        port: freePort(),
        realtime: "./missing-realtime.ts",
      }),
    });
    await expect(startApp(loadConfig(missing, { ACKERDB_TELEMETRY: "disabled" })))
      .rejects.toThrow(
        `realtime module configured by "realtime" not found at ${join(missing, "missing-realtime.ts")}`,
      );

    const malformed = fixture({
      "app.ts": FIXTURE_APP,
      "functions/live.ts": REALTIME_DECLARATION,
      "realtime.ts": "export default {};",
      ".ackerdb.config.json": JSON.stringify({
        port: freePort(),
        realtime: "./realtime.ts",
      }),
    });
    await expect(startApp(loadConfig(malformed, { ACKERDB_TELEMETRY: "disabled" })))
      .rejects.toThrow(
        `realtime module configured by "realtime" at ${join(malformed, "realtime.ts")} must default-export createRealtimeRuntime(...)`,
      );

    const failedImport = fixture({
      "app.ts": FIXTURE_APP,
      "functions/live.ts": REALTIME_DECLARATION,
      "realtime.ts": `throw new Error("missing TURN_SECRET");`,
      ".ackerdb.config.json": JSON.stringify({
        port: freePort(),
        realtime: "./realtime.ts",
      }),
    });
    await expect(startApp(loadConfig(failedImport, { ACKERDB_TELEMETRY: "disabled" })))
      .rejects.toThrow(
        `failed to import realtime module configured by "realtime" at ${join(failedImport, "realtime.ts")}: missing TURN_SECRET`,
      );
  });

  test("codegen never imports the serving-only realtime module", async () => {
    const dir = fixture({
      "app.ts": FIXTURE_APP,
      "functions/live.ts": REALTIME_DECLARATION,
      "realtime.ts": `throw new Error("codegen imported realtime");`,
      ".ackerdb.config.json": JSON.stringify({ realtime: "./realtime.ts" }),
    });

    await expect(runCodegen(loadConfig(dir, {}))).resolves.toMatchObject({
      written: expect.any(Array),
    });
  });

  test("does not import configured realtime when the application declares none", async () => {
    const dir = fixture({
      "app.ts": FIXTURE_APP,
      ".ackerdb.config.json": JSON.stringify({
        port: freePort(),
        realtime: "./missing-realtime.ts",
      }),
    });

    const running = await startApp(loadConfig(dir, { ACKERDB_TELEMETRY: "disabled" }));
    await running.drain();
  });

  test("uses the programmatic override without importing the configured module", async () => {
    const dir = fixture({
      "app.ts": FIXTURE_APP,
      "functions/live.ts": REALTIME_DECLARATION,
      "realtime.ts": `throw new Error("configured realtime imported");`,
      ".ackerdb.config.json": JSON.stringify({
        port: freePort(),
        realtime: "./realtime.ts",
      }),
    });
    const realtime: RealtimeRuntimeModule = {
      create: () => {
        throw new Error("programmatic realtime selected");
      },
    };

    await expect(startApp(
      loadConfig(dir, { ACKERDB_TELEMETRY: "disabled" }),
      { realtime },
    )).rejects.toThrow("programmatic realtime selected");
  });
});
