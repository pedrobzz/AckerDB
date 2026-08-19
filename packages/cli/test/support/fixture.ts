/** Builds a throwaway ackerdb app directory for CLI tests. */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = new URL("../../../..", import.meta.url).pathname;

export function makeFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ackerdb-cli-"));
  // bare "@ackerdb/*" specifiers must resolve from the fixture
  mkdirSync(join(dir, "node_modules", "@ackerdb"), { recursive: true });
  for (const pkg of ["core", "server", "client", "cli"]) {
    symlinkSync(join(REPO, "packages", pkg), join(dir, "node_modules", "@ackerdb", pkg));
  }
  symlinkSync(join(REPO, "fixtures", "test-support"), join(dir, "node_modules", "ackerdb-test-support"));
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

const APP_DEFINITION = `export default defineApp({ schema });`;

export const FIXTURE_APP = `
import { defineApp, defineEventTable, defineSchema, defineTable, v } from "@ackerdb/server";

const role = v.enum("Role", ["admin", "member"]);
const payload = v.union("Payload", {
  text: v.string(),
  nothing: v.tag(),
});

const schema = defineSchema({
  messages: defineTable({
    id: v.primaryKey(),
    channelId: v.bigint(),
    body: v.string(),
    role,
    payload,
  }).index(["channelId"]),
  typingEvents: defineEventTable({
    id: v.primaryKey(),
    channelId: v.bigint(),
  }, {
    args: { channelId: v.bigint() },
    access: "public",
    matches: (row, args) => row.channelId === args.channelId,
  }),
});

${APP_DEFINITION}
`;

export const FIXTURE_MESSAGES = `
import { v } from "@ackerdb/server";
import { mutation, query, sseProcedure } from "../_generated/server.ts";

export const tail = sseProcedure({
  access: "public",
  args: { channelId: v.bigint() },
  yields: v.object({ body: v.string() }),
  handler: async function* (_ctx, args) {
    yield { body: "channel " + args.channelId };
  },
});

export const list = query({
  access: "public",
  args: { channelId: v.bigint() },
  handler: (ctx, args) =>
    ctx.db.messages.query().where((message) => message.channelId.eq(args.channelId)).collect(),
});

export const send = mutation({
  access: "public",
  args: { channelId: v.bigint(), body: v.string() },
  handler: async (ctx, args) => {
    const id = await ctx.db.messages.insert({
      ...args,
      role: "member",
      payload: { tag: "nothing", value: null },
    });
    await ctx.db.typingEvents.insert({ channelId: args.channelId });
    return id;
  },
});

export const enqueueNote = mutation({
  access: "public",
  args: { note: v.string(), at: v.int() },
  handler: (ctx, args) =>
    ctx.jobs.notes.record.enqueue({ note: args.note }, { at: args.at }),
});
`;

export const FIXTURE_JOBS = `
import { v } from "@ackerdb/server";
import { api } from "../_generated/api.ts";
import { job } from "../_generated/server.ts";

export const record = job({
  mode: "mutation",
  args: { note: v.string() },
  handler: async (tx, args) => {
    await tx.db.messages.insert({
      channelId: 0n,
      body: args.note,
      role: "admin",
      payload: { tag: "text", value: "job" },
    });
  },
});

// A server-side caller names a system-only function through the same typed API.
export const sweep = job({
  mode: "procedure",
  args: { channelId: v.bigint() },
  handler: async (ctx, args) => {
    await ctx.step.run(api.admin.users.compact, { channelId: args.channelId });
  },
});
`;

export const FIXTURE_ADMIN_USERS = `
import { v } from "@ackerdb/server";
import { mutation, query } from "../../_generated/server.ts";

export const count = query({
  access: "public",
  args: {},
  handler: (ctx) => ctx.db.messages.query().count(),
});

export const compact = mutation({
  access: "system",
  args: { channelId: v.bigint() },
  handler: (ctx, args) =>
    ctx.db.messages.query().where((m) => m.channelId.eq(args.channelId)).count(),
});
`;
