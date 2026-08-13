import { refs } from "../_generated/server.ts";
import { mutation, object, query, string } from "../sdk.ts";

const version = "v1" as const;
const resource = "orders" as const;
const route = `/${version}/${resource}` as const;
const order = object({ id: string(), status: string() });

const descriptor = {
  route,
  access: "protected",
  args: object({ id: string() }),
  returns: order,
  handler: async () => ({ id: "1", status: "open" }),
} as const;

export const read = query<typeof descriptor, { id: string; status: string }>(
  descriptor,
);

export const submit = mutation({
  route: `${route}/submit` as const,
  access: "protected",
  args: object({ id: string() }),
  returns: object({ accepted: string() }),
  handler: async () => refs.jobs.orders.refresh({ id: "1" }),
});

export const formatOrderId = (id: string) => `order:${id}`;
