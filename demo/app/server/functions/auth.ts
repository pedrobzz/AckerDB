import { v } from "@dbzz/server";
import { procedure } from "@demo/dbzz-codegen/server";
import { issueGuestToken } from "../lib/token.ts";

export const login = procedure({
  access: "public",
  args: {
    name: v.string(),
    email: v.string(),
  },
  handler: (_ctx, args) => issueGuestToken(args),
});
