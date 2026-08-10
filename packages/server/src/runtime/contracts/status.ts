import type { Principal } from "../../auth/credentials.ts";
import type { Engine } from "../../database/engine.ts";
import type { RealtimeRuntimeSnapshot } from "../../realtime/host.ts";
import type { OutboundBudget } from "../../subscriptions/delivery/budget.ts";
import type { OrderedReactive } from "../../subscriptions/reactive/ordered.ts";
import type { ExecutorSnapshot } from "../executor.ts";
import type { RuntimeLifecycleState } from "./lifecycle.ts";

interface RuntimeReactiveContext {
  readonly principal: Principal;
}

export interface RuntimeStatus {
  readonly state: RuntimeLifecycleState;
  readonly connections: number;
  readonly activeOperations: number;
  readonly activeOperationCallers: number;
  readonly activeSse: number;
  readonly realtime: RealtimeRuntimeSnapshot | null;
  readonly declaredJobs: number;
  readonly jobsArmed: boolean;
  readonly reader: ExecutorSnapshot;
  readonly writer: ExecutorSnapshot;
  readonly reactive: ReturnType<OrderedReactive<RuntimeReactiveContext>["snapshot"]>;
  readonly publication: ReturnType<
    OrderedReactive<RuntimeReactiveContext>["publication"]["snapshot"]
  >;
  readonly authCaptureBudget: ReturnType<OutboundBudget["snapshot"]>;
  readonly sseBudget: ReturnType<OutboundBudget["snapshot"]>;
  readonly storage: ReturnType<Engine["status"]>;
}
