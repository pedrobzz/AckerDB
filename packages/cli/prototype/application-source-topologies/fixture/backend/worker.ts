import { lifecycle, topLevelEffect } from "../sdk.ts";

topLevelEffect("UNOWNED top-level timer/BullMQ tripwire");

export const queues = lifecycle({
  owner: "queues",
  resource: "bullmq:orders",
  direction: "inbound+outbound",
  activate: () => "open bullmq:orders",
  quiesce: () => "quiesce bullmq:orders inbound",
  deactivate: () => "close bullmq:orders",
});
