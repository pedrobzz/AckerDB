/** Builds a throwaway dbzz app directory for CLI tests. */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = new URL("../../..", import.meta.url).pathname;

export function makeFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "dbzz-cli-"));
  // bare "@dbzz/*" specifiers must resolve from the fixture
  mkdirSync(join(dir, "node_modules", "@dbzz"), { recursive: true });
  for (const pkg of ["core", "server", "client"]) {
    symlinkSync(join(REPO, "packages", pkg), join(dir, "node_modules", "@dbzz", pkg));
  }
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

export const FIXTURE_SCHEMA = `
import { defineEventTable, defineSchema, defineTable, v } from "@dbzz/server";

const role = v.enum("Role", ["admin", "member"]);
const payload = v.union("Payload", {
  text: v.string(),
  nothing: v.tag(),
});

export default defineSchema({
  messages: defineTable({
    id: v.primaryKey(),
    channelId: v.bigint(),
    body: v.string(),
    role,
    payload,
  }).index("by_channel", ["channelId"]),
  jobs: defineTable({
    id: v.primaryKey(),
    note: v.string(),
    at: v.scheduleAt(),
  }).scheduled("messages.runJob"),
  typingEvents: defineEventTable({
    id: v.primaryKey(),
    channelId: v.bigint(),
  }, {
    args: { channelId: v.bigint() },
    access: "public",
    matches: (row, args) => row.channelId === args.channelId,
  }),
});
`;

export const FIXTURE_MESSAGES = `
import { v } from "@dbzz/server";
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
    ctx.db.messages.byChannel((q) => q.eq("channelId", args.channelId)).collect(),
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

export const runJob = mutation({
  access: "system",
  args: { id: v.bigint(), note: v.string(), at: v.int() },
  handler: async (ctx, args) => {
    await ctx.db.messages.insert({
      channelId: 0n,
      body: args.note,
      role: "admin",
      payload: { tag: "text", value: "job" },
    });
  },
});
`;

export const FIXTURE_ADMIN_USERS = `
import { v } from "@dbzz/server";
import { query } from "../../_generated/server.ts";

export const count = query({
  access: "public",
  args: {},
  handler: (ctx) => ctx.db.messages.scan().count(),
});
`;
