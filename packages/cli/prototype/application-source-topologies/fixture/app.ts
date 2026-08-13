import { defineApp, object, string } from "./sdk.ts";

const table = "orders" as const;

export default defineApp({
  schema: object({
    [table]: object({ id: string(), status: string() }),
  }),
  scopes: ["orders:read", "orders:write"] as const,
  extensions: {
    queues: {
      definition: "@ackerdb/bullmq",
      configuration: "queueConnection",
    },
  },
});
