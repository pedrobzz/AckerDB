import type {
  ApplicationError,
  LiveEvent,
  Outcome,
  SubscriptionCursor,
  SubscriptionTransition,
} from "@ackerdb/core";
import { deepFreeze } from "../../shared/immutable.ts";
import type { ExecutorSnapshot } from "../../runtime/executor.ts";
import type { ServiceLimits } from "../../runtime/limits.ts";

export interface Subscriber {
  sendTransition(subscriptionId: number, transition: SubscriptionTransition): Promise<void>;
  sendEvent(subscriptionId: number, event: LiveEvent): Promise<void>;
  sendError(subscriptionId: number, outcome: Outcome): Promise<void>;
}

export interface QueryEvaluation {
  readonly value: unknown;
  readonly applicationError?: ApplicationError;
  readonly encoded: string;
  readonly readSet: ReadonlySet<string>;
  readonly commitVersion: bigint;
}

export interface QueryEvaluationInput<C> {
  readonly address: string;
  readonly args: unknown;
  readonly requestBytes: number;
  readonly policyScopeFingerprint: string;
  readonly fairnessKey: string;
  readonly context: C;
}

export type QueryEvaluator<C> = (input: QueryEvaluationInput<C>) => Promise<QueryEvaluation>;

export interface QuerySubscriptionOptions<C> extends Omit<QueryEvaluationInput<C>, "requestBytes"> {
  readonly subscriber: Subscriber;
  readonly id: number;
  readonly authEpoch: number;
  readonly cursor?: SubscriptionCursor;
}

export interface EventSubscriptionOptions {
  readonly subscriber: Subscriber;
  readonly id: number;
  readonly table: string;
  readonly authEpoch: number;
  readonly args: unknown;
  readonly matches: (row: unknown, args: unknown) => boolean;
}

export interface ReactiveEvent {
  readonly table: string;
  readonly row: unknown;
}

export interface DeliveryFailure {
  readonly subscriber: Subscriber;
  readonly subscriptionId: number;
  readonly kind: "query" | "event";
  readonly phase: "convergence" | "delivery";
  readonly error: unknown;
}

export interface ReactiveCommitResult {
  readonly affectedCallerIds: readonly number[];
  readonly deliveryFailures: readonly DeliveryFailure[];
}

export class ReactiveCommit {
  readonly writeKeys: ReadonlySet<string>;
  readonly events: readonly ReactiveEvent[];
  readonly affectedCallerIds: readonly number[];
  result?: ReactiveCommitResult;

  constructor(
    writeKeys: ReadonlySet<string>,
    events: readonly ReactiveEvent[] = [],
    affectedCallerIds: readonly number[] = [],
  ) {
    this.writeKeys = new Set(writeKeys);
    this.affectedCallerIds = Object.freeze([...affectedCallerIds]);
    this.events = Object.freeze(events.map((event) => Object.freeze({
      table: event.table,
      row: deepFreeze(structuredClone(event.row)),
    })));
  }
}

export interface OrderedReactiveOptions<C> {
  readonly evaluate: QueryEvaluator<C>;
  readonly limits?: ServiceLimits;
  readonly initialVersion?: bigint;
  readonly now?: () => number;
  readonly generation?: () => string;
}

export interface ReactiveSnapshot {
  readonly sharedEntries: number;
  readonly queryListeners: number;
  readonly eventListeners: number;
  readonly dormantEntries: number;
  readonly dependencyKeys: number;
  readonly dependencyEdges: number;
  readonly multiOwnerDependencyKeys: number;
  readonly resultBytes: number;
  readonly historyTransitions: number;
  readonly historyBytes: number;
  readonly evaluatingEntries: number;
  readonly revalidation: ExecutorSnapshot;
}

export interface AuthRotationResult {
  readonly subscriptions: readonly {
    readonly id: number;
    readonly address: string;
    readonly args: unknown;
  }[];
  readonly deliveryFailures: readonly DeliveryFailure[];
}
