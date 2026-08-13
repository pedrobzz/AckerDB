import { defineApp, object, string } from "./sdk.ts";

export default defineApp({
  schema: object({ orders: object({ id: string() }) }),
  extensions:
    process.env.QUEUE_DRIVER === "bullmq"
      ? { queues: { definition: "@ackerdb/bullmq" } }
      : {},
});
