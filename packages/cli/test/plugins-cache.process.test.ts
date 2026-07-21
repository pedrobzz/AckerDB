import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { DbzzClient } from "@dbzz/client";
import * as ts from "typescript";
import { makeFixture } from "./fixture.ts";

const CLI = new URL("../src/main.ts", import.meta.url).pathname;
const REPO = new URL("../../..", import.meta.url).pathname;
const TEST_TIMEOUT_MS = 90_000;
const STEP_TIMEOUT_MS = 15_000;
const STATE_A_SHAPE = "marker: v.string().nullable(), // STATE_A_SHAPE";
const UNSAFE_STATE_A_SHAPE = "marker: v.bigint().nullable(), // STATE_A_SHAPE";

const APP = `
import { cachePlugin } from "@dbzz/cache";
import {
  defineApp,
  definePlugin,
  definePluginContract,
  defineSchema,
  defineTable,
  pluginMutation,
  pluginQuery,
  v,
} from "@dbzz/server";

const rootSchema = defineSchema({
  roots: defineTable({
    id: v.primaryKey(),
    value: v.string(),
  }),
});

const stateContract = definePluginContract({
  read: pluginQuery({
    args: { key: v.string() },
    returns: v.string().optional(),
    expose: (call) => (key: string) => call({ key }),
  }),
  write: pluginMutation({
    args: { key: v.string(), value: v.string() },
    returns: v.boolean(),
    expose: (call) => (key: string, value: string) => call({ key, value }),
  }),
});

const stateASchema = defineSchema({
  entries: defineTable({
    id: v.primaryKey(),
    key: v.string(),
    value: v.string(),
    ${STATE_A_SHAPE}
  }).index("by_key", ["key"], { unique: true }),
});

const stateAPlugin = definePlugin({
  id: "@fixture/state-a",
  schema: stateASchema,
  create: ({ query, mutation }) => ({
    exports: {
      read: query(stateContract.read, async (ctx, args) =>
        (await ctx.db.entries.byKey((range) => range.eq("key", args.key)).unique())?.value
      ),
      write: mutation(stateContract.write, async (ctx, args) => {
        const existing = await ctx.db.entries
          .byKey((range) => range.eq("key", args.key))
          .unique();
        if (existing === null) {
          await ctx.db.entries.insert({ ...args, marker: null });
        } else {
          await ctx.db.entries.patch(existing.id, { value: args.value });
        }
        return true;
      }),
    },
  }),
});

const stateBSchema = defineSchema({
  entries: defineTable({
    id: v.primaryKey(),
    key: v.string(),
    value: v.string(),
    marker: v.string().nullable(),
  }).index("by_key", ["key"], { unique: true }),
});

const stateBPlugin = definePlugin({
  id: "@fixture/state-b",
  schema: stateBSchema,
  create: ({ query, mutation }) => ({
    exports: {
      read: query(stateContract.read, async (ctx, args) =>
        (await ctx.db.entries.byKey((range) => range.eq("key", args.key)).unique())?.value
      ),
      write: mutation(stateContract.write, async (ctx, args) => {
        const existing = await ctx.db.entries
          .byKey((range) => range.eq("key", args.key))
          .unique();
        if (existing === null) {
          await ctx.db.entries.insert({ ...args, marker: null });
        } else {
          await ctx.db.entries.patch(existing.id, { value: args.value });
        }
        return true;
      }),
    },
  }),
});

const consumerPlugin = definePlugin({
  id: "@fixture/state-consumer",
  schema: defineSchema({}),
  dependencies: { state: stateContract },
  create: ({ query, mutation }) => ({
    exports: {
      read: query(stateContract.read, (ctx, args) => ctx.state.read(args.key)),
      write: mutation(stateContract.write, (ctx, args) =>
        ctx.state.write(args.key, args.value)
      ),
    },
  }),
});

const stateA = stateAPlugin();
const stateB = stateBPlugin();
const consumer = consumerPlugin({ state: stateA });
const cache = cachePlugin({ namespaces: { values: v.string() } });

export default defineApp({
  schema: rootSchema,
  plugins: { cache, stateA, consumer, stateB },
});
`;

const FUNCTIONS = `
import { v } from "@dbzz/server";
import { mutation } from "../_generated/server.ts";

export const seed = mutation({
  access: "public",
  args: {
    root: v.string(),
    stateA: v.string(),
    stateB: v.string(),
    cache: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.roots.insert({ value: args.root });
    await ctx.consumer.write("shared", args.stateA);
    await ctx.stateB.write("shared", args.stateB);
    return ctx.cache.values.set("persist", args.cache);
  },
});

export const raceCache = mutation({
  access: "public",
  args: { value: v.string() },
  handler: (ctx, args) =>
    ctx.cache.values.set("race", args.value, { if: "missing" }),
});

export const snapshot = mutation({
  access: "public",
  args: {},
  handler: async (ctx) => {
    const root = (await ctx.db.roots.scan().collect())[0];
    return {
      root: root?.value ?? null,
      stateA: (await ctx.consumer.read("shared")) ?? null,
      stateADirect: (await ctx.stateA.read("shared")) ?? null,
      stateB: (await ctx.stateB.read("shared")) ?? null,
      cache: (await ctx.cache.values.get("persist")) ?? null,
      race: (await ctx.cache.values.get("race")) ?? null,
    };
  },
});
`;

type ManagedProcess = Pick<Subprocess, "exited" | "kill">;
type Snapshot = {
  root: string | null;
  stateA: string | null;
  stateADirect: string | null;
  stateB: string | null;
  cache: string | null;
  race: string | null;
};

const dirs: string[] = [];
const clients = new Set<DbzzClient>();
const children = new Set<ManagedProcess>();
let commandNumber = 0;

afterEach(async () => {
  for (const client of clients) client.close();
  clients.clear();
  await Promise.all([...children].map(async (child) => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
    await child.exited.catch(() => {});
  }));
  children.clear();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(
      () => reject(new Error(`timed out waiting for ${label}`)),
      STEP_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(handle));
}

async function eventually(assertion: () => void | Promise<void>, label: string): Promise<void> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(25);
    }
  }
  throw new Error(`timed out waiting for ${label}`, { cause: lastError });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    server.close();
    throw new Error("port reservation has no address");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  return address.port;
}

function spawnServer(dir: string, port: number) {
  const child = Bun.spawn([process.execPath, CLI, "start", dir], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      DBZZ_DURABILITY: "production",
      DBZZ_TELEMETRY: "disabled",
    },
  });
  children.add(child);
  return {
    child,
    waitReady: () => eventually(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/ready`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ready: true, state: "ready" });
    }, "server ready"),
  };
}

async function stopServer(server: ReturnType<typeof spawnServer>, label: string): Promise<void> {
  server.child.kill("SIGTERM");
  expect(await withTimeout(server.child.exited, `${label} graceful exit`)).toBe(0);
  children.delete(server.child);
}

async function runCli(args: string[]) {
  const appDir = args.at(-1);
  if (appDir === undefined) throw new Error("CLI test command requires an app directory");
  const id = commandNumber++;
  const stdoutPath = join(appDir, `.cli-command-${id}.stdout`);
  const stderrPath = join(appDir, `.cli-command-${id}.stderr`);
  writeFileSync(stdoutPath, "");
  writeFileSync(stderrPath, "");
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    stdin: "ignore",
    stdout: Bun.file(stdoutPath),
    stderr: Bun.file(stderrPath),
    env: {
      ...process.env,
      DBZZ_DURABILITY: "production",
      DBZZ_TELEMETRY: "disabled",
    },
  });
  children.add(child);
  const code = await withTimeout(child.exited, `dbzz ${args.join(" ")}`);
  children.delete(child);
  const stdout = readFileSync(stdoutPath, "utf8");
  const stderr = readFileSync(stderrPath, "utf8");
  rmSync(stdoutPath, { force: true });
  rmSync(stderrPath, { force: true });
  return { stdout, stderr, code, output: `${stdout}\n${stderr}` };
}

function typecheckFixture(dir: string): string {
  const configPath = join(dir, "tsconfig.json");
  writeFileSync(configPath, JSON.stringify({
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "bundler",
      lib: ["ESNext"],
      types: ["bun"],
      typeRoots: [join(REPO, "node_modules", "@types")],
      strict: true,
      noUncheckedIndexedAccess: true,
      verbatimModuleSyntax: true,
      skipLibCheck: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      baseUrl: REPO,
      paths: {
        "@dbzz/core": ["packages/core/src/index.ts"],
        "@dbzz/server": ["packages/server/src/index.ts"],
        "@dbzz/cache": ["packages/cache/src/index.ts"],
      },
    },
    include: ["./**/*.ts"],
  }));
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  return ts.formatDiagnostics([
    ...(config.error === undefined ? [] : [config.error]),
    ...parsed.errors,
    ...ts.getPreEmitDiagnostics(program),
  ], {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => dir,
    getNewLine: () => "\n",
  });
}

function clientFor(port: number, clientSessionId: string): DbzzClient {
  const client = new DbzzClient({
    url: `http://127.0.0.1:${port}`,
    credential: { kind: "anonymous" },
    clientSessionId,
    reconnect: { baseDelayMs: 20, maxDelayMs: 100, stableOpenMs: 100 },
  });
  clients.add(client);
  return client;
}

function closeClient(client: DbzzClient): void {
  client.close();
  clients.delete(client);
}

async function snapshot(client: DbzzClient): Promise<Snapshot> {
  return withTimeout(
    client.mutation<Record<string, never>, Snapshot>("state.snapshot", {}),
    "state snapshot",
  );
}

describe("Plugins + built-in Cache real process lifecycle", () => {
  test("keeps mounts isolated and resets only the unsafe Plugin scope", async () => {
    const port = await freePort();
    const dir = makeFixture({
      "app.ts": APP,
      "functions/state.ts": FUNCTIONS,
      ".dbzz.config.json": JSON.stringify({ port }),
    });
    dirs.push(dir);

    const generated = await runCli(["codegen", dir]);
    expect(generated.code).toBe(0);
    expect(typecheckFixture(dir)).toBe("");

    const first = spawnServer(dir, port);
    await first.waitReady();
    const seed = clientFor(port, "plugins-cache-seed");
    expect(await withTimeout(seed.mutation<{
      root: string;
      stateA: string;
      stateB: string;
      cache: string;
    }, boolean>("state.seed", {
      root: "root-value",
      stateA: "state-a-value",
      stateB: "state-b-value",
      cache: "cache-value",
    }), "seed state")).toBe(true);

    const racerA = clientFor(port, "plugins-cache-race-a");
    const racerB = clientFor(port, "plugins-cache-race-b");
    const attempts = await withTimeout(Promise.all([
      racerA.mutation<{ value: string }, boolean>("state.raceCache", { value: "racer-a" }),
      racerB.mutation<{ value: string }, boolean>("state.raceCache", { value: "racer-b" }),
    ]), "concurrent if-missing writes");
    expect([...attempts].sort()).toEqual([false, true]);
    const winner = attempts[0] ? "racer-a" : "racer-b";

    expect(await snapshot(seed)).toEqual({
      root: "root-value",
      stateA: "state-a-value",
      stateADirect: "state-a-value",
      stateB: "state-b-value",
      cache: "cache-value",
      race: winner,
    });
    closeClient(seed);
    closeClient(racerA);
    closeClient(racerB);
    await stopServer(first, "initial server");

    const second = spawnServer(dir, port);
    await second.waitReady();
    const persisted = clientFor(port, "plugins-cache-persisted");
    expect(await snapshot(persisted)).toEqual({
      root: "root-value",
      stateA: "state-a-value",
      stateADirect: "state-a-value",
      stateB: "state-b-value",
      cache: "cache-value",
      race: winner,
    });
    closeClient(persisted);
    await stopServer(second, "persistence restart");

    const originalApp = readFileSync(join(dir, "app.ts"), "utf8");
    expect(originalApp).toContain(STATE_A_SHAPE);
    writeFileSync(join(dir, "app.ts"), originalApp.replace(STATE_A_SHAPE, UNSAFE_STATE_A_SHAPE));

    const unsafeCodegen = await runCli(["codegen", dir]);
    expect(unsafeCodegen.code).toBe(0);
    expect(typecheckFixture(dir)).toBe("");

    const refused = await runCli(["start", dir]);
    expect(refused.code).toBe(1);
    expect(refused.output).toContain(`dbzz plugin reset stateA ${dir}`);

    const reset = await runCli(["plugin", "reset", "stateA", dir]);
    expect(reset.code).toBe(0);
    expect(reset.stdout).toContain('reset Plugin storage mount "stateA"');

    const third = spawnServer(dir, port);
    await third.waitReady();
    const afterReset = clientFor(port, "plugins-cache-after-reset");
    expect(await snapshot(afterReset)).toEqual({
      root: "root-value",
      stateA: null,
      stateADirect: null,
      stateB: "state-b-value",
      cache: "cache-value",
      race: winner,
    });
    closeClient(afterReset);
    await stopServer(third, "post-reset server");
  }, TEST_TIMEOUT_MS);
});
