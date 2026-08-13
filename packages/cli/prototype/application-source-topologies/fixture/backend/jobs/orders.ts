import { refs } from "../../_generated/server.ts";
import { job, object, string } from "../../sdk.ts";

export const refresh = job({
  name: "orders.refresh",
  args: object({ id: string() }),
  returns: object({ refreshed: string() }),
  retry: { attempts: 3 },
  handler: async () => refs.functions.orders.read({ id: "1" }),
});

export const calculateRetryDelay = (attempt: number) => attempt * 1_000;
