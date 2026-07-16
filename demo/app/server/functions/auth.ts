import { dbz } from "@dbzz/server";
import { procedure } from "@demo/dbzz-codegen/server";
import { issueGuestToken } from "../lib/token.ts";

export const login = procedure({
  access: "public",
  args: {
    name: dbz.string(),
    email: dbz.string(),
  },
  handler: (_ctx, args) => issueGuestToken(args),
});
