import { Err, Status } from "@ackerdb/core";
import { v } from "@ackerdb/server";
import { mutation, query } from "@demo/ackerdb-codegen/server";
import { staffAccess } from "../../lib/access.ts";
import { tokenNameInput } from "../../lib/inputs.ts";
import { adminAuth } from "./mcp.ts";

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
  handler: (ctx) => adminAuth.tokens.list(ctx),
});

export const create = mutation({
  access: staffAccess,
  args: { name: tokenNameInput, scopes: v.array(adminAuth.scopes).min(1) },
  handler: (ctx, args) =>
    adminAuth.tokens.create(ctx, { name: args.name, scopes: args.scopes }),
});

export const update = mutation({
  access: staffAccess,
  args: {
    id: v.string().min(1),
    name: tokenNameInput.optional(),
    scopes: v.array(adminAuth.scopes).min(1).optional(),
  },
  handler: (ctx, args) => {
    if (args.name === undefined && args.scopes === undefined) {
      return Err("token.update-empty", {}, Status.BadRequest);
    }
    if (args.name !== undefined) adminAuth.tokens.update(ctx, args.id, { name: args.name });
    if (args.scopes !== undefined) adminAuth.tokens.updateScopes(ctx, args.id, args.scopes);
    return args.id;
  },
});

export const revoke = mutation({
  access: staffAccess,
  args: { id: v.string().min(1) },
  handler: (ctx, args) => {
    adminAuth.tokens.revoke(ctx, args.id);
    return args.id;
  },
});
