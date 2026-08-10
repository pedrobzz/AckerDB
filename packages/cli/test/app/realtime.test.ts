import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { RealtimeRuntimeModule } from "@ackerdb/server";
import { runCodegen } from "../../src/app/codegen.ts";
import { loadConfig } from "../../src/app/config.ts";
import { startApp } from "../../src/app/start.ts";
import { FIXTURE_APP, makeFixture } from "../support/fixture.ts";
import { freePort } from "../support/port.ts";

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
        port: await freePort(),
        realtime: "./realtime.ts",
      }),
    });

    await expect(startApp(loadConfig(dir, { })))
      .rejects.toThrow("configured realtime selected");
  });

  test("reports missing and malformed configured modules at startup", async () => {
    const missing = fixture({
      "app.ts": FIXTURE_APP,
      "functions/live.ts": REALTIME_DECLARATION,
      ".ackerdb.config.json": JSON.stringify({
        port: await freePort(),
        realtime: "./missing-realtime.ts",
      }),
    });
    await expect(startApp(loadConfig(missing, { })))
      .rejects.toThrow(
        `.ackerdb.config.json "realtime" module not found at ${join(missing, "missing-realtime.ts")}`,
      );

    const malformed = fixture({
      "app.ts": FIXTURE_APP,
      "functions/live.ts": REALTIME_DECLARATION,
      "realtime.ts": "export default {};",
      ".ackerdb.config.json": JSON.stringify({
        port: await freePort(),
        realtime: "./realtime.ts",
      }),
    });
    await expect(startApp(loadConfig(malformed, { })))
      .rejects.toThrow(
        `.ackerdb.config.json "realtime" module at ${join(malformed, "realtime.ts")} must default-export the result of createRealtimeRuntime(...)`,
      );

    const failedImport = fixture({
      "app.ts": FIXTURE_APP,
      "functions/live.ts": REALTIME_DECLARATION,
      "realtime.ts": `throw new Error("missing TURN_SECRET");`,
      ".ackerdb.config.json": JSON.stringify({
        port: await freePort(),
        realtime: "./realtime.ts",
      }),
    });
    await expect(startApp(loadConfig(failedImport, { })))
      .rejects.toThrow(
        `failed to import .ackerdb.config.json "realtime" module at ${join(failedImport, "realtime.ts")}: missing TURN_SECRET`,
      );
  });

  test("uses the packaged default runtime when no module is configured", async () => {
    const dir = fixture({
      "app.ts": FIXTURE_APP,
      "functions/live.ts": REALTIME_DECLARATION,
      "node_modules/@ackerdb/realtime/package.json": JSON.stringify({
        name: "@ackerdb/realtime",
        type: "module",
        exports: "./index.ts",
      }),
      "node_modules/@ackerdb/realtime/index.ts": `
        export function createRealtimeRuntime() {
          return {
            create: () => { throw new Error("packaged default realtime selected"); },
          };
        }
      `,
      ".ackerdb.config.json": JSON.stringify({ port: await freePort() }),
    });

    await expect(startApp(loadConfig(dir, { })))
      .rejects.toThrow("packaged default realtime selected");
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
        port: await freePort(),
        realtime: "./missing-realtime.ts",
      }),
    });

    const running = await startApp(loadConfig(dir, { }));
    await running.drain();
  });

  test("uses the programmatic override without importing the configured module", async () => {
    const dir = fixture({
      "app.ts": FIXTURE_APP,
      "functions/live.ts": REALTIME_DECLARATION,
      "realtime.ts": `throw new Error("configured realtime imported");`,
      ".ackerdb.config.json": JSON.stringify({
        port: await freePort(),
        realtime: "./realtime.ts",
      }),
    });
    const realtime: RealtimeRuntimeModule = {
      create: () => {
        throw new Error("programmatic realtime selected");
      },
    };

    await expect(startApp(
      loadConfig(dir, { }),
      { realtime },
    )).rejects.toThrow("programmatic realtime selected");
  });
});
