import { defineApp, object, string } from "./sdk.ts";

declare const selectApplicationInput: <Values extends readonly string[]>(
  name: string,
  values: Values,
) => Values[number];

const driver = selectApplicationInput("QUEUE_DRIVER", ["none", "bullmq"] as const);

export default defineApp({
  schema: object({ orders: object({ id: string() }) }),
  extensions:
    driver === "bullmq"
      ? { queues: { definition: "@ackerdb/bullmq" } }
      : {},
});
