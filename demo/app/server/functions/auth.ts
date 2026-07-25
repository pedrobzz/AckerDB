import { v } from "@dbzz/server";
import { procedure } from "@demo/dbzz-codegen/server";
import { emailInput, guestNameInput } from "../lib/inputs.ts";
import { issueGuestToken } from "../lib/token.ts";

export const login = procedure({
  access: "public",
  args: {
    name: guestNameInput,
    email: emailInput,
  },
  returns: v.object({
    token: v.string(),
    expiresAt: v.int(),
    name: v.string(),
    email: v.string(),
  }),
  handler: (_ctx, args) => issueGuestToken(args),
});
