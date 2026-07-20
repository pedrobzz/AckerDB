import { v } from "@dbzz/server";
import { mutation, query } from "@demo/dbzz-codegen/server";
import { staffAccess } from "../../lib/access.ts";
import { invalid } from "../../lib/domain.ts";
import { admin } from "./mcp.ts";

/**
 * Staff-gated wrappers over the framework's owner-token operations for the
 * Admin MCP. Every operation runs as the shared staff user identity, so all
 * staff see and manage the same token vault. Guests and anonymous callers are
 * denied by `staffAccess`; the one-time-secret reveal on create and the
 * revocation semantics come from the framework, not the demo.
 */

export const list = query({
  access: staffAccess,
  args: {},
  handler: (ctx) => admin.tokens.list(ctx),
});

export const create = mutation({
  access: staffAccess,
  args: { name: v.string(), scopes: v.array(admin.scopes) },
  handler: (ctx, args) =>
    admin.tokens.create(ctx, { name: args.name, scopes: args.scopes }),
});

export const update = mutation({
  access: staffAccess,
  args: {
    id: v.string(),
    name: v.string().optional(),
    scopes: v.array(admin.scopes).optional(),
  },
  handler: (ctx, args) => {
    if (args.name === undefined && args.scopes === undefined) {
      invalid("Provide a new name or scopes to update the token");
    }
    if (args.name !== undefined) admin.tokens.update(ctx, args.id, { name: args.name });
    if (args.scopes !== undefined) admin.tokens.updateScopes(ctx, args.id, args.scopes);
    return args.id;
  },
});

export const revoke = mutation({
  access: staffAccess,
  args: { id: v.string() },
  handler: (ctx, args) => {
    admin.tokens.revoke(ctx, args.id);
    return args.id;
  },
});
