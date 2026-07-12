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
import { defineEventTable, defineSchema, defineTable, dbz } from "@dbzz/server";

const role = dbz.enum("Role", ["admin", "member"]);
const payload = dbz.union("Payload", {
  text: dbz.string(),
  nothing: dbz.tag(),
});

export default defineSchema({
  messages: defineTable({
    id: dbz.primaryKey(),
    channelId: dbz.bigint(),
    body: dbz.string(),
    role,
    payload,
  }).index("by_channel", ["channelId"]),
  jobs: defineTable({
    id: dbz.primaryKey(),
    note: dbz.string(),
    at: dbz.scheduleAt(),
  }).scheduled("messages.runJob"),
  typingEvents: defineEventTable({
    id: dbz.primaryKey(),
    channelId: dbz.bigint(),
  }),
});
`;

export const FIXTURE_MESSAGES = `
import { dbz } from "@dbzz/server";
import { mutation, query } from "../_generated/server.ts";

export const list = query({
  args: { channelId: dbz.bigint() },
  handler: (ctx, args) =>
    ctx.db.messages.byChannel((q) => q.eq("channelId", args.channelId)).collect(),
});

export const send = mutation({
  args: { channelId: dbz.bigint(), body: dbz.string() },
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
  args: { id: dbz.bigint(), note: dbz.string(), at: dbz.number() },
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
import { dbz } from "@dbzz/server";
import { query } from "../../_generated/server.ts";

export const count = query({
  args: {},
  handler: (ctx) => ctx.db.messages.scan().count(),
});
`;
