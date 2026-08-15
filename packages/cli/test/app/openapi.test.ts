import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/app/config.ts";
import { exportOpenApi } from "../../src/app/openapi.ts";
import { FIXTURE_APP, makeFixture } from "../support/fixture.ts";

const CLI = new URL("../../src/commands/main.ts", import.meta.url).pathname;

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const EXPOSED_MESSAGES = `
import { v } from "@ackerdb/server";
import { mutation, query, sseProcedure } from "../_generated/server.ts";

export const list = query({
  access: "public",
  http: true,
  title: "List messages",
  description: "List the newest messages in a channel.",
  args: { channelId: v.bigint() },
  handler: (ctx, args) =>
    ctx.db.messages.query().where((message) => message.channelId.eq(args.channelId)).collect(),
});

export const send = mutation({
  access: "public",
  http: true,
  args: { channelId: v.bigint(), body: v.string() },
  returns: v.bigint(),
  handler: (ctx, args) => ctx.db.messages.insert({
    ...args,
    role: "member",
    payload: { tag: "nothing", value: null },
  }),
});

export const purge = mutation({
  access: "public",
  http: { openapi: false },
  args: { channelId: v.bigint() },
  handler: () => 0n,
});

export const tail = sseProcedure({
  access: "public",
  http: true,
  args: { channelId: v.bigint() },
  yields: v.object({ body: v.string() }),
  handler: async function* (_ctx, args) {
    yield { body: "channel " + args.channelId };
  },
});

export const secret = query({
  access: "public",
  args: {},
  handler: () => 1,
});
`;

const fixture = (files: Record<string, string> = {}) => {
  const dir = makeFixture({
    "app.ts": FIXTURE_APP,
    "functions/messages.ts": EXPOSED_MESSAGES,
    ...files,
  });
  dirs.push(dir);
  return dir;
};

// The document is plain JSON; navigating it in tests is not a typed contract.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

const read = (file: string): Ctx => JSON.parse(readFileSync(file, "utf8")) as Ctx;

describe("acker openapi", () => {
  test("writes the exposed surface, codegenning the app on the way", async () => {
    const dir = fixture({
      "package.json": JSON.stringify({ name: "savoria-server", version: "3.4.5" }),
    });
    const file = join(dir, "openapi.json");
    const report = await exportOpenApi(loadConfig(dir), file);

    expect(report).toEqual({ file, operations: 4 });
    const document = read(file);
    expect(document.openapi).toBe("3.1.1");
    expect(document.info).toEqual({ title: "savoria-server", version: "3.4.5" });
    expect(Object.keys(document.paths)).toEqual([
      "/api/messages/list",
      "/api/messages/send",
      "/api/messages/tail",
    ]);
    expect(Object.keys(document.paths["/api/messages/list"])).toEqual(["get", "post"]);
    expect(document.paths["/api/messages/send"].post.parameters[0].name).toBe("Idempotency-Key");
    expect(Object.keys(document.paths["/api/messages/tail"].post.responses["200"].content))
      .toEqual(["text/event-stream"]);
    // Hidden from the document, and never exposed at all.
    expect(document.paths["/api/messages/purge"]).toBeUndefined();
    expect(document.paths["/api/messages/secret"]).toBeUndefined();
  });

  test("two exports of one app are byte-identical", async () => {
    const dir = fixture();
    const first = join(dir, "first.json");
    const second = join(dir, "second.json");
    await exportOpenApi(loadConfig(dir), first);
    await exportOpenApi(loadConfig(dir), second);
    expect(readFileSync(second, "utf8")).toBe(readFileSync(first, "utf8"));
  });

  test("the command writes the document and reports it", async () => {
    const dir = fixture();
    const file = join(dir, "openapi.json");
    const child = Bun.spawn([process.execPath, CLI, "openapi", file, dir], {
      stdout: "pipe",
      stderr: "inherit",
    });
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    expect(output).toContain("4 operation(s)");
    expect(Object.keys(read(file).paths)).toHaveLength(3);
  });
});
