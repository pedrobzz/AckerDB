import type { Principal } from "../../auth/credentials.ts";
import type { Engine } from "../../database/engine.ts";
import type { RealtimeRuntimeSnapshot } from "../../realtime/host.ts";
import type { OutboundBudget } from "../../subscriptions/delivery/budget.ts";
import type { OrderedReactive } from "../../subscriptions/reactive/ordered.ts";
import type {
  TelemetryExportersSnapshot,
} from "../../telemetry/application-signals/exporters.ts";
import type {
  TelemetryJournalSnapshot,
} from "../../telemetry/application-signals/journal.ts";
import type {
  TelemetryAggregateSnapshot,
  TelemetrySnapshot,
} from "../../telemetry/telemetry.ts";
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
  readonly scheduledHandlers: number;
  readonly schedulerArmed: boolean;
  readonly reader: ExecutorSnapshot;
  readonly writer: ExecutorSnapshot;
  readonly reactive: ReturnType<OrderedReactive<RuntimeReactiveContext>["snapshot"]>;
  readonly publication: ReturnType<
    OrderedReactive<RuntimeReactiveContext>["publication"]["snapshot"]
  >;
  readonly authCaptureBudget: ReturnType<OutboundBudget["snapshot"]>;
  readonly sseBudget: ReturnType<OutboundBudget["snapshot"]>;
  readonly telemetry: TelemetrySnapshot;
  readonly telemetryAggregates: TelemetryAggregateSnapshot;
  readonly telemetryJournal: TelemetryJournalSnapshot;
  readonly telemetryExporters: TelemetryExportersSnapshot | null;
  readonly storage: ReturnType<Engine["status"]>;
}
