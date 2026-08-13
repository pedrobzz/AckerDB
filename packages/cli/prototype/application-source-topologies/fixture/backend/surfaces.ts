import {
  channel,
  mcp,
  object,
  rawHttp,
  realtime,
  string,
} from "../sdk.ts";

export const webhook = rawHttp({ method: "POST", route: "/webhooks/orders" });
export const updates = channel({
  clientEvents: object({ subscribe: string() }),
  serverEvents: object({ changed: string() }),
});
export const calls = realtime({
  clientEvents: object({ speak: string() }),
  serverEvents: object({ transcript: string() }),
});
export const tools = mcp({ name: "orders", route: "/mcp/orders" });
export const surfaceHelper = { visibleOnlyToServer: true };
