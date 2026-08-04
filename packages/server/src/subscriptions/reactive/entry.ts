import type {
  ApplicationError,
  LiveEventCursor,
  SubscriptionCursor,
} from "@ackerdb/core";
import type { DeliveryFailure, Subscriber } from "./contract.ts";
import type { HistoryRecord } from "./history.ts";

export interface QueryListener<C> {
  readonly kind: "query";
  readonly subscriber: Subscriber;
  readonly id: number;
  readonly entry: QueryEntry<C>;
  readonly fairnessKey: string;
  authEpoch: number;
  cursor?: SubscriptionCursor;
  delivery?: Promise<void>;
}

export interface EventListener<C> {
  readonly kind: "event";
  readonly subscriber: Subscriber;
  readonly id: number;
  readonly state: EventState<C>;
  readonly args: unknown;
  readonly matches: (row: unknown, args: unknown) => boolean;
  authEpoch: number;
  cursor: LiveEventCursor;
  gapped: boolean;
  delivery?: Promise<void>;
}

export type Binding<C> = QueryListener<C> | EventListener<C>;

interface CanonicalQueryEnvelope {
  readonly decoded: unknown;
  readonly encoded: string;
  readonly bytes: number;
}

export interface QueryEntry<C> {
  readonly key: string;
  readonly identity: string;
  readonly address: string;
  readonly args: CanonicalQueryEnvelope;
  readonly policyScopeFingerprint: string;
  readonly revalidationBytes: number;
  /** Oldest active listener owns shared work; an admitted evaluation snapshots this key. */
  ownerFairnessKey: string;
  context: C;
  generation: string;
  readSet: Set<string>;
  listeners: Set<QueryListener<C>>;
  history: HistoryRecord<C>[];
  historyBytes: number;
  initialized: boolean;
  value: unknown;
  applicationError?: ApplicationError;
  encoded: string;
  resultBytes: number;
  commitVersion: bigint;
  dirtyVersion: bigint;
  evaluationGeneration: number;
  evaluation?: Promise<DeliveryFailure[]>;
  dormantAtMs?: number;
  removed: boolean;
}

export interface EventState<C> {
  readonly table: string;
  readonly listeners: Set<EventListener<C>>;
}

export function failure<C>(
  binding: Binding<C>,
  error: unknown,
  phase: DeliveryFailure["phase"] = "delivery",
): DeliveryFailure {
  return Object.freeze({
    subscriber: binding.subscriber,
    subscriptionId: binding.id,
    kind: binding.kind,
    phase,
    error,
  });
}
