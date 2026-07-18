import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  decode,
  stableEncode,
  type LiveEvent,
  type LiveEventCursor,
  type Outcome,
  type SubscriptionCursor,
  type SubscriptionTransition,
} from "@dbzz/core";
import { DbzzError, isDbzzError } from "./errors.ts";
import { BoundedExecutor, type ExecutorSnapshot } from "./executor.ts";
import { deepFreeze } from "./immutable.ts";
import { PRODUCTION_LIMITS, type ServiceLimits } from "./limits.ts";
import { OrderedPublication, PublicationHandoff, type Publication } from "./publication.ts";

export interface Subscriber {
  sendTransition(subscriptionId: number, transition: SubscriptionTransition): Promise<void>;
  sendEvent(subscriptionId: number, event: LiveEvent): Promise<void>;
  sendError(subscriptionId: number, outcome: Outcome): Promise<void>;
}

export interface QueryEvaluation {
  readonly value: unknown;
  readonly encoded: string;
  readonly readSet: ReadonlySet<string>;
  readonly commitVersion: bigint;
}

export interface QueryEvaluationInput<C> {
  readonly address: string;
  readonly args: unknown;
  readonly policyScopeFingerprint: string;
  readonly fairnessKey: string;
  readonly context: C;
}

export type QueryEvaluator<C> = (input: QueryEvaluationInput<C>) => Promise<QueryEvaluation>;

export interface QuerySubscriptionOptions<C> extends QueryEvaluationInput<C> {
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

export type ReactiveObservationPhase =
  | "initial_evaluation"
  | "invalidation_match"
  | "revalidation_queue"
  | "evaluation"
  | "changed"
  | "unchanged"
  | "fanout"
  | "listener_queue"
  | "delivery"
  | "event_match"
  | "failure";

export type ReactiveObservationOutcome =
  | "ok"
  | "changed"
  | "unchanged"
  | "matched"
  | "unmatched"
  | Outcome["code"];

/** Privacy-safe metadata emitted at the realtime boundary that owns each stage. */
export interface ReactiveObservation {
  readonly kind: "query" | "event";
  readonly phase: ReactiveObservationPhase;
  readonly outcome: ReactiveObservationOutcome;
  readonly durationMs: number;
  readonly address?: string;
  readonly subscriptionId?: number;
  readonly commitVersion?: bigint;
  readonly dependencyCount?: number;
  readonly resultCount?: number;
  readonly byteCount?: number;
}

export type ReactiveObserver = (observation: ReactiveObservation) => unknown;

export interface OrderedReactiveOptions<C> {
  readonly evaluate: QueryEvaluator<C>;
  readonly limits?: ServiceLimits;
  readonly initialVersion?: bigint;
  readonly now?: () => number;
  readonly generation?: () => string;
  readonly observer?: ReactiveObserver;
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

interface QueryListener<C> {
  readonly kind: "query";
  readonly subscriber: Subscriber;
  readonly id: number;
  readonly entry: QueryEntry<C>;
  readonly fairnessKey: string;
  authEpoch: number;
  cursor?: SubscriptionCursor;
  delivery?: Promise<void>;
}

interface EventListener<C> {
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

type Binding<C> = QueryListener<C> | EventListener<C>;

interface QueryEntry<C> {
  readonly key: string;
  readonly identity: string;
  readonly address: string;
  readonly encodedArgs: string;
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
  encoded: string;
  resultBytes: number;
  commitVersion: bigint;
  dirtyVersion: bigint;
  evaluationGeneration: number;
  evaluation?: Promise<DeliveryFailure[]>;
  dormantAtMs?: number;
  removed: boolean;
}

type DependencyOwners<C> = QueryEntry<C> | Set<QueryEntry<C>>;

interface HistoryRecord<C> {
  readonly entry: QueryEntry<C>;
  readonly fromVersion: bigint;
  readonly toVersion: bigint;
  readonly kind: "update" | "checkpoint";
  readonly value?: unknown;
  readonly bytes: number;
  readonly createdAtMs: number;
  previousGlobal?: HistoryRecord<C>;
  nextGlobal?: HistoryRecord<C>;
  active: boolean;
}

interface EventState<C> {
  readonly table: string;
  readonly listeners: Set<EventListener<C>>;
}

interface InstalledEvaluation<C> {
  readonly entry: QueryEntry<C>;
  readonly previousVersion?: bigint;
  readonly changed: boolean;
  readonly forceReset: boolean;
  readonly overflowedListeners?: readonly QueryListener<C>[];
  readonly overloadMessage?: string;
}

const utf8 = new TextEncoder();

export class OrderedReactive<C = unknown> {
  readonly publication: OrderedPublication<ReactiveCommit>;
  readonly limits: ServiceLimits;

  private readonly evaluateQuery: QueryEvaluator<C>;
  // Invariant: application code run on a subscriber's behalf (query
  // re-evaluation, event-listener matching) executes under this pristine async
  // context captured at construction, never a committing caller's context left
  // ambient when a commit lands. Scoped to the app-code calls so the observer
  // bookkeeping around them keeps its ambient trace correlation.
  private readonly root = AsyncLocalStorage.snapshot();
  private readonly now: () => number;
  private readonly nextGeneration: () => string;
  private readonly observer?: ReactiveObserver;
  private readonly revalidation: BoundedExecutor;
  private readonly entries = new Map<string, QueryEntry<C>>();
  private readonly byReadKey = new Map<string, DependencyOwners<C>>();
  private readonly bySubscriber = new Map<Subscriber, Map<number, Binding<C>>>();
  private readonly eventStates = new Map<string, EventState<C>>();
  private historyHead?: HistoryRecord<C>;
  private historyTail?: HistoryRecord<C>;
  private queryListeners = 0;
  private eventListeners = 0;
  private resultBytes = 0;
  private historyBytes = 0;
  private historyTransitions = 0;
  private dependencyEdges = 0;
  private multiOwnerDependencyKeys = 0;
  private eventTail: Promise<void> = Promise.resolve();

  constructor(options: OrderedReactiveOptions<C>) {
    this.evaluateQuery = options.evaluate;
    this.limits = options.limits ?? PRODUCTION_LIMITS;
    this.now = options.now ?? Date.now;
    this.nextGeneration = options.generation ?? (() => crypto.randomUUID());
    this.observer = options.observer;
    this.revalidation = new BoundedExecutor({
      concurrency: this.limits.revalidationConcurrency,
      discipline: "round-robin",
      limits: this.limits.revalidationQueue,
      resource: "revalidation",
      retryAfterMs: 0,
      now: this.now,
    });
    this.publication = new OrderedPublication<ReactiveCommit>({
      limits: this.limits.publication,
      initialVersion: options.initialVersion,
      now: this.now,
      process: (publication) => this.processPublication(publication),
    });
  }

  async subscribeQuery(options: QuerySubscriptionOptions<C>): Promise<void> {
    this.assertAuthEpoch(options.authEpoch);
    this.assertSubscriptionAdmission(options.subscriber, options.id);
    let entry = this.entryFor(options);
    entry.context = options.context;
    if (entry.listeners.size === 0) entry.ownerFairnessKey = options.fairnessKey;

    try {
      for (;;) {
        await this.ensureCurrent(entry, this.publication.snapshot().highWater);
        let listener: QueryListener<C> | undefined;
        const installed = this.publication.compareAndInstall(entry.commitVersion, () => {
          if (entry.removed) return;
          this.assertSubscriptionAdmission(options.subscriber, options.id);
          listener = {
            kind: "query",
            subscriber: options.subscriber,
            id: options.id,
            entry,
            fairnessKey: options.fairnessKey,
            authEpoch: options.authEpoch,
            cursor: options.cursor,
          };
          this.attach(listener);
        });
        if (!installed || !listener) {
          if (entry.removed) entry = this.entryFor(options);
          continue;
        }
        try {
          await this.deliverQuery(listener, true, false);
        } catch (error) {
          this.detach(listener);
          throw error;
        }
        return;
      }
    } catch (error) {
      if (entry.listeners.size === 0 && !entry.initialized && !entry.evaluation) this.removeEntry(entry);
      throw error;
    }
  }

  async subscribeEvent(options: EventSubscriptionOptions): Promise<void> {
    this.assertAuthEpoch(options.authEpoch);
    this.assertSubscriptionAdmission(options.subscriber, options.id);
    let state = this.eventStates.get(options.table);
    if (!state) {
      state = { table: options.table, listeners: new Set() };
      this.eventStates.set(options.table, state);
    }
    const listener: EventListener<C> = {
      kind: "event",
      subscriber: options.subscriber,
      id: options.id,
      state,
      args: options.args,
      matches: options.matches,
      authEpoch: options.authEpoch,
      cursor: {
        generation: this.generation(),
        commitVersion: this.publication.snapshot().highWater,
        sequence: 0n,
      },
      gapped: false,
    };
    this.attach(listener);
    try {
      await this.sendEvent(listener, { kind: "reset", cursor: listener.cursor });
    } catch (error) {
      this.detach(listener);
      throw error;
    }
  }

  unsubscribe(subscriber: Subscriber, subscriptionId: number): void {
    const binding = this.bySubscriber.get(subscriber)?.get(subscriptionId);
    if (binding) this.detach(binding);
  }

  disconnect(subscriber: Subscriber): void {
    const bindings = this.bySubscriber.get(subscriber);
    if (!bindings) return;
    for (const binding of [...bindings.values()]) this.detach(binding);
  }

  async reset(subscriber: Subscriber, subscriptionId: number, from: SubscriptionCursor): Promise<void> {
    const binding = this.bySubscriber.get(subscriber)?.get(subscriptionId);
    if (!binding) throw new DbzzError("not_found", "Subscription is not active");
    if (binding.kind !== "query") throw new DbzzError("conflict", "Only query subscriptions have reset cursors");
    await this.sendTransition(binding, {
      kind: "reset",
      from,
      to: this.cursor(binding.entry, binding.authEpoch),
      value: binding.entry.value,
    });
  }

  affectedQueryIds(subscriber: Subscriber, writeKeys: ReadonlySet<string>): number[] {
    const affected = this.affectedEntries(writeKeys);
    const ids: number[] = [];
    const bindings = this.bySubscriber.get(subscriber);
    if (!bindings) return ids;
    for (const [id, binding] of bindings) {
      if (binding.kind === "query" && affected.has(binding.entry)) ids.push(id);
    }
    return ids.sort((left, right) => left - right);
  }

  queryIds(subscriber: Subscriber): number[] {
    const ids: number[] = [];
    for (const [id, binding] of this.bySubscriber.get(subscriber) ?? []) {
      if (binding.kind === "query") ids.push(id);
    }
    return ids.sort((left, right) => left - right);
  }

  async converge(subscriber: Subscriber, minimumVersion: bigint): Promise<ReactiveCommitResult> {
    if (typeof minimumVersion !== "bigint" || minimumVersion < 0n) {
      throw new RangeError("minimumVersion must be a non-negative bigint");
    }
    if (minimumVersion > this.publication.snapshot().highWater) {
      throw new DbzzError("convergence_unavailable", "Commit is newer than the publication high-water", {
        committed: true,
        resource: "publication",
      });
    }
    const affectedCallerIds = this.queryIds(subscriber);
    const callerBindings = [...(this.bySubscriber.get(subscriber)?.values() ?? [])]
      .filter((binding): binding is QueryListener<C> => binding.kind === "query");
    const entries = new Set<QueryEntry<C>>();
    for (const binding of callerBindings) {
      if (binding.entry.commitVersion < minimumVersion) entries.add(binding.entry);
    }
    const failures: DeliveryFailure[] = [];
    for (const entry of entries) {
      if (minimumVersion > entry.dirtyVersion) entry.dirtyVersion = minimumVersion;
      try {
        failures.push(...await this.ensureCurrent(entry, minimumVersion));
      } catch (error) {
        failures.push(...await this.failEntry(entry, error));
      }
    }
    for (const binding of callerBindings) {
      if (
        entries.has(binding.entry) ||
        this.bySubscriber.get(subscriber)?.get(binding.id) !== binding ||
        (binding.cursor?.commitVersion ?? -1n) >= minimumVersion
      ) {
        continue;
      }
      try {
        await this.deliverQuery(binding, false, false);
      } catch (error) {
        failures.push(failure(binding, error));
      }
    }
    return Object.freeze({
      affectedCallerIds: Object.freeze(affectedCallerIds),
      deliveryFailures: Object.freeze(failures),
    });
  }

  async rotateAuth(subscriber: Subscriber, nextAuthEpoch: number): Promise<AuthRotationResult> {
    this.assertAuthEpoch(nextAuthEpoch);
    const bindings = [...(this.bySubscriber.get(subscriber)?.values() ?? [])];
    this.assertNewAuthEpoch(bindings, nextAuthEpoch);
    const subscriptions = bindings.map((binding) => Object.freeze({
      id: binding.id,
      address: binding.kind === "query" ? binding.entry.address : `events.${binding.state.table}`,
      args: binding.kind === "query" ? decode(binding.entry.encodedArgs) : binding.args,
    })).sort((left, right) => left.id - right.id);
    const failures: DeliveryFailure[] = [];
    for (const binding of bindings) {
      this.detach(binding);
      if (binding.kind === "query") {
        try {
          await this.sendRevocation(
            binding,
            nextAuthEpoch,
            authOutcome("auth_stale", "Authentication changed"),
          );
        } catch (error) {
          failures.push(failure(binding, error));
        }
      } else {
        // Detach is immediate, but an already-snapshotted publication may still
        // own this delivery. Drain it before a new-epoch binding is installed.
        await binding.delivery;
      }
    }
    return Object.freeze({
      subscriptions: Object.freeze(subscriptions),
      deliveryFailures: Object.freeze(failures),
    });
  }

  async revoke(
    subscriber: Subscriber,
    nextAuthEpoch: number,
    outcome: Outcome = authOutcome("unauthorized", "Access revoked"),
  ): Promise<readonly DeliveryFailure[]> {
    this.assertAuthEpoch(nextAuthEpoch);
    const bindings = [...(this.bySubscriber.get(subscriber)?.values() ?? [])];
    this.assertNewAuthEpoch(bindings, nextAuthEpoch);
    const failures: DeliveryFailure[] = [];
    for (const binding of bindings) {
      this.detach(binding);
      try {
        if (binding.kind === "query") {
          await this.sendRevocation(binding, nextAuthEpoch, outcome);
        } else {
          await this.queue(binding, () => subscriber.sendError(binding.id, outcome));
        }
      } catch (error) {
        failures.push(failure(binding, error));
      }
    }
    return Object.freeze(failures);
  }

  prune(now = this.readNow()): number {
    if (!Number.isFinite(now)) throw new RangeError("now must be finite");
    this.pruneHistory(now);
    let removed = 0;
    for (const entry of [...this.entries.values()]) {
      if (
        entry.listeners.size === 0 &&
        !entry.evaluation &&
        entry.dormantAtMs !== undefined &&
        now - entry.dormantAtMs >= this.limits.resume.maxAgeMs
      ) {
        this.removeEntry(entry);
        removed++;
      }
    }
    return removed;
  }

  snapshot(): ReactiveSnapshot {
    this.prune();
    let dormantEntries = 0;
    let evaluatingEntries = 0;
    for (const entry of this.entries.values()) {
      if (entry.listeners.size === 0) dormantEntries++;
      if (entry.evaluation) evaluatingEntries++;
    }
    return Object.freeze({
      sharedEntries: this.entries.size,
      queryListeners: this.queryListeners,
      eventListeners: this.eventListeners,
      dormantEntries,
      dependencyKeys: this.byReadKey.size,
      dependencyEdges: this.dependencyEdges,
      multiOwnerDependencyKeys: this.multiOwnerDependencyKeys,
      resultBytes: this.resultBytes,
      historyTransitions: this.historyTransitions,
      historyBytes: this.historyBytes,
      evaluatingEntries,
      revalidation: this.revalidation.snapshot(),
    });
  }

  async close(): Promise<void> {
    await this.publication.close();
    this.revalidation.close();
    await Promise.all([this.revalidation.drain(), this.eventTail]);
  }

  private entryFor(input: QueryEvaluationInput<C>): QueryEntry<C> {
    const encodedArgs = stableEncode(input.args);
    const key = stableEncode([input.address, encodedArgs, input.policyScopeFingerprint]);
    const existing = this.entries.get(key);
    if (existing) return existing;
    this.makeEntryCapacity();
    const entry: QueryEntry<C> = {
      key,
      identity: createHash("sha256").update(key).digest("base64url"),
      address: input.address,
      encodedArgs,
      policyScopeFingerprint: input.policyScopeFingerprint,
      revalidationBytes: byteLength(key),
      ownerFairnessKey: input.fairnessKey,
      context: input.context,
      generation: this.generation(),
      readSet: new Set(),
      listeners: new Set(),
      history: [],
      historyBytes: 0,
      initialized: false,
      value: undefined,
      encoded: "",
      resultBytes: 0,
      commitVersion: 0n,
      dirtyVersion: 0n,
      evaluationGeneration: 0,
      removed: false,
    };
    this.entries.set(key, entry);
    return entry;
  }

  private ensureCurrent(entry: QueryEntry<C>, targetVersion: bigint): Promise<DeliveryFailure[]> {
    if (entry.removed) throw unavailable("Subscription entry was evicted");
    if (targetVersion > entry.dirtyVersion) entry.dirtyVersion = targetVersion;
    if (entry.initialized && entry.commitVersion >= targetVersion) return Promise.resolve([]);
    if (entry.evaluation) return entry.evaluation;
    const wasInitialized = entry.initialized;
    const fairnessKey = entry.ownerFairnessKey;
    const context = entry.context;
    const queuedAt = this.observer ? this.observationNow() : undefined;
    let started = false;
    const execution = this.revalidation.submit(
      () => {
        started = true;
        if (this.observer) {
          this.observe(queuedAt, {
            kind: "query",
            phase: "revalidation_queue",
            outcome: "ok",
            address: entry.address,
            commitVersion: targetVersion,
            dependencyCount: entry.readSet.size,
            byteCount: entry.revalidationBytes,
          });
        }
        return this.evaluateOnce(entry, fairnessKey, context);
      },
      {
        operation: "subscription",
        bytes: entry.revalidationBytes,
        fairnessKey,
      },
    ).catch(async (error): Promise<DeliveryFailure[]> => {
      if (!started && this.observer) {
        const outcome = observationOutcome(error);
        const metadata = {
          kind: "query" as const,
          address: entry.address,
          commitVersion: targetVersion,
          dependencyCount: entry.readSet.size,
          byteCount: entry.revalidationBytes,
        };
        this.observe(queuedAt, {
          ...metadata,
          phase: "revalidation_queue",
          outcome,
        });
        this.observe(queuedAt, { ...metadata, phase: "failure", outcome });
      }
      if (!wasInitialized) {
        this.removeEntry(entry);
        throw error;
      }
      if (entry.listeners.size === 0) {
        this.removeEntry(entry);
        return [];
      }
      return this.failEntry(entry, error);
    });
    let owned!: Promise<DeliveryFailure[]>;
    const release = () => {
      if (entry.evaluation === owned) entry.evaluation = undefined;
      if (entry.listeners.size === 0 && entry.initialized && entry.dormantAtMs === undefined) {
        entry.dormantAtMs = this.readNow();
      }
    };
    owned = execution.then(
      async (failures) => {
        release();
        if (!entry.removed && entry.commitVersion < entry.dirtyVersion) {
          const newer = await this.ensureCurrent(entry, entry.dirtyVersion);
          return failures.length === 0 ? newer : [...failures, ...newer];
        }
        return failures;
      },
      (error) => {
        release();
        throw error;
      },
    );
    entry.evaluation = owned;
    return owned;
  }

  private async evaluateOnce(
    entry: QueryEntry<C>,
    fairnessKey: string,
    context: C,
  ): Promise<DeliveryFailure[]> {
    const failures: DeliveryFailure[] = [];
    if (!entry.removed && (!entry.initialized || entry.commitVersion < entry.dirtyVersion)) {
      const evaluationGeneration = ++entry.evaluationGeneration;
      const initial = !entry.initialized;
      const evaluatedAt = this.observer ? this.observationNow() : undefined;
      let evaluated: QueryEvaluation;
      try {
        evaluated = await this.root(() => this.evaluateQuery({
          address: entry.address,
          args: decode(entry.encodedArgs),
          policyScopeFingerprint: entry.policyScopeFingerprint,
          fairnessKey,
          context,
        }));
        this.validateEvaluation(evaluated);
        const highWater = this.publication.snapshot().highWater;
        if (evaluated.commitVersion > highWater) {
          throw new DbzzError("internal", "Query observed a future commit");
        }
      } catch (error) {
        if (this.observer) {
          const outcome = observationOutcome(error);
          const metadata = {
            kind: "query" as const,
            address: entry.address,
            commitVersion: entry.dirtyVersion,
            dependencyCount: entry.readSet.size,
          };
          this.observe(evaluatedAt, {
            ...metadata,
            phase: initial ? "initial_evaluation" : "evaluation",
            outcome,
          });
          this.observe(evaluatedAt, { ...metadata, phase: "failure", outcome });
        }
        throw error;
      }
      if (this.observer) {
        this.observe(evaluatedAt, {
          kind: "query",
          phase: initial ? "initial_evaluation" : "evaluation",
          outcome: "ok",
          address: entry.address,
          commitVersion: evaluated.commitVersion,
          dependencyCount: evaluated.readSet.size,
          byteCount: byteLength(evaluated.encoded),
        });
      }
      let installed: InstalledEvaluation<C> | undefined;
      const installedAt = this.observer ? this.observationNow() : undefined;
      let current: boolean;
      try {
        current = this.publication.compareAndInstall(evaluated.commitVersion, () => {
          if (entry.removed || entry.evaluationGeneration !== evaluationGeneration) return;
          installed = this.installEvaluation(entry, evaluated);
        });
      } catch (error) {
        if (this.observer) {
          this.observe(installedAt, {
            kind: "query",
            phase: "failure",
            outcome: observationOutcome(error),
            address: entry.address,
            commitVersion: evaluated.commitVersion,
            dependencyCount: evaluated.readSet.size,
            byteCount: byteLength(evaluated.encoded),
          });
        }
        throw error;
      }
      if (!current || !installed) {
        const newest = this.publication.snapshot().highWater;
        if (newest > entry.dirtyVersion) entry.dirtyVersion = newest;
        if (entry.removed) throw unavailable("Subscription entry was evicted");
        return failures;
      }
      if (installed.overflowedListeners) {
        const message = installed.overloadMessage ?? "Shared query result capacity is full";
        const outcome = overloadOutcome(message);
        const convergenceError = overloaded(message);
        if (this.observer) {
          this.observe(installedAt, {
            kind: "query",
            phase: "failure",
            outcome: "overloaded",
            address: entry.address,
            commitVersion: evaluated.commitVersion,
            dependencyCount: evaluated.readSet.size,
            resultCount: installed.overflowedListeners.length,
            byteCount: byteLength(evaluated.encoded),
          });
        }
        for (const listener of installed.overflowedListeners) {
          failures.push(failure(listener, convergenceError, "convergence"));
          try {
            await this.queue(listener, () => listener.subscriber.sendError(listener.id, outcome));
          } catch (error) {
            failures.push(failure(listener, error));
          }
        }
        return failures;
      }
      if (this.observer) {
        this.observe(installedAt, {
          kind: "query",
          phase: installed.changed ? "changed" : "unchanged",
          outcome: installed.changed ? "changed" : "unchanged",
          address: entry.address,
          commitVersion: entry.commitVersion,
          dependencyCount: entry.readSet.size,
          resultCount: 1,
          byteCount: entry.resultBytes,
        });
      }
      failures.push(...await this.deliverInstalled(installed));
      const newest = this.publication.snapshot().highWater;
      if (newest > entry.dirtyVersion) entry.dirtyVersion = newest;
    }
    if (entry.removed) throw unavailable("Subscription entry was evicted");
    return failures;
  }

  private installEvaluation(entry: QueryEntry<C>, evaluated: QueryEvaluation): InstalledEvaluation<C> {
    const resultBytes = byteLength(evaluated.encoded);
    const overloadMessage = this.makeResultCapacity(entry, resultBytes);
    if (overloadMessage) {
      if (entry.listeners.size === 0) {
        this.removeEntry(entry);
        throw overloaded(overloadMessage);
      }
      const listeners = [...entry.listeners];
      this.removeEntry(entry);
      return {
        entry,
        changed: false,
        forceReset: true,
        overflowedListeners: listeners,
        overloadMessage,
      };
    }

    const previousVersion = entry.initialized ? entry.commitVersion : undefined;
    const changed = !entry.initialized || entry.encoded !== evaluated.encoded;
    this.replaceReadSet(entry, evaluated.readSet);
    this.resultBytes += resultBytes - entry.resultBytes;
    entry.value = evaluated.value;
    entry.encoded = evaluated.encoded;
    entry.resultBytes = resultBytes;
    entry.commitVersion = evaluated.commitVersion;
    entry.initialized = true;
    let forceReset = false;
    if (previousVersion !== undefined && evaluated.commitVersion > previousVersion) {
      forceReset = !this.retainHistory(entry, {
        entry,
        fromVersion: previousVersion,
        toVersion: evaluated.commitVersion,
        kind: changed ? "update" : "checkpoint",
        ...(changed ? { value: evaluated.value } : {}),
        bytes: changed ? resultBytes : 32,
        createdAtMs: this.readNow(),
        active: true,
      });
      if (forceReset) entry.generation = this.generation();
    }
    return { entry, previousVersion, changed, forceReset };
  }

  private async deliverInstalled(installed: InstalledEvaluation<C>): Promise<DeliveryFailure[]> {
    if (installed.previousVersion === undefined) return [];
    const listeners = [...installed.entry.listeners];
    const startedAt = this.observer ? this.observationNow() : undefined;
    const deliveries = listeners.map(async (listener) => {
      try {
        await this.deliverQuery(listener, false, installed.forceReset);
        return undefined;
      } catch (error) {
        return failure(listener, error);
      }
    });
    const failures = (await Promise.all(deliveries))
      .filter((result): result is DeliveryFailure => result !== undefined);
    if (this.observer) {
      this.observe(startedAt, {
        kind: "query",
        phase: "fanout",
        outcome: failures.length === 0 ? "ok" : "unavailable",
        address: installed.entry.address,
        commitVersion: installed.entry.commitVersion,
        dependencyCount: installed.entry.readSet.size,
        resultCount: listeners.length,
        byteCount: installed.entry.resultBytes,
      });
    }
    return failures;
  }

  private async deliverQuery(
    listener: QueryListener<C>,
    positiveResume: boolean,
    forceReset: boolean,
  ): Promise<void> {
    const entry = listener.entry;
    const target = this.cursor(entry, listener.authEpoch);
    const from = listener.cursor;
    if (from && cursorEquals(from, target)) {
      if (positiveResume) {
        await this.sendTransition(listener, { kind: "resume", from, to: target });
      }
      return;
    }
    if (!forceReset && from && this.cursorBelongsTo(from, entry, listener.authEpoch)) {
      const chain = this.historyChain(entry, from.commitVersion, target.commitVersion);
      if (chain) {
        let cursor = from;
        for (const record of chain) {
          const to = { ...cursor, commitVersion: record.toVersion };
          const transition: SubscriptionTransition = record.kind === "update"
            ? { kind: "update", from: cursor, to, value: record.value }
            : { kind: "checkpoint", from: cursor, to };
          await this.sendTransition(listener, transition);
          cursor = to;
        }
        return;
      }
    }
    await this.sendTransition(listener, { kind: "reset", from: from ?? null, to: target, value: entry.value });
  }

  private async sendTransition(
    listener: QueryListener<C>,
    transition: SubscriptionTransition,
  ): Promise<void> {
    await this.queue(
      listener,
      () => listener.subscriber.sendTransition(listener.id, transition),
      transition.to.commitVersion,
    );
    listener.cursor = transition.to;
  }

  private historyChain(
    entry: QueryEntry<C>,
    fromVersion: bigint,
    toVersion: bigint,
  ): readonly HistoryRecord<C>[] | undefined {
    if (fromVersion >= toVersion) return undefined;
    const chain: HistoryRecord<C>[] = [];
    let version = fromVersion;
    for (const record of entry.history) {
      if (!record.active || record.fromVersion < version) continue;
      if (record.fromVersion !== version) return undefined;
      chain.push(record);
      version = record.toVersion;
      if (version === toVersion) return chain;
      if (version > toVersion) return undefined;
    }
    return undefined;
  }

  private processPublication(publication: Publication<ReactiveCommit>): PublicationHandoff {
    const commit = publication.value;
    const matchedAt = this.observer ? this.observationNow() : undefined;
    const affected = this.affectedEntries(commit.writeKeys);
    if (this.observer && commit.writeKeys.size > 0 && this.entries.size > 0) {
      this.observe(matchedAt, {
        kind: "query",
        phase: "invalidation_match",
        outcome: affected.size === 0 ? "unmatched" : "matched",
        commitVersion: publication.version,
        dependencyCount: commit.writeKeys.size,
        resultCount: affected.size,
      });
    }
    const required: Promise<DeliveryFailure[]>[] = [];
    for (const entry of affected) {
      if (entry.removed || entry.commitVersion >= publication.version) continue;
      if (publication.version > entry.dirtyVersion) entry.dirtyVersion = publication.version;
      const convergence = this.ensureCurrent(entry, publication.version);
      required.push(convergence);
    }
    const eventDelivery = this.scheduleEvents(publication.version, commit.events);
    return new PublicationHandoff(Promise.all([...required, eventDelivery]).then((results) => {
      commit.result = Object.freeze({
        affectedCallerIds: commit.affectedCallerIds,
        deliveryFailures: Object.freeze(results.flat()),
      });
      this.prune();
    }));
  }

  private scheduleEvents(
    commitVersion: bigint,
    events: readonly ReactiveEvent[],
  ): Promise<DeliveryFailure[]> {
    const delivery = this.eventTail.then(async () => {
      const failures: DeliveryFailure[] = [];
      for (const event of events) failures.push(...await this.publishEvent(commitVersion, event));
      return failures;
    });
    this.eventTail = delivery.then(() => undefined, () => undefined);
    return delivery;
  }

  private async publishEvent(commitVersion: bigint, event: ReactiveEvent): Promise<DeliveryFailure[]> {
    const state = this.eventStates.get(event.table);
    if (!state) return [];
    const failures: DeliveryFailure[] = [];
    for (const listener of [...state.listeners]) {
      const matchedAt = this.observer ? this.observationNow() : undefined;
      try {
        const matched = this.root(() => listener.matches(event.row, listener.args)) === true;
        if (this.observer) {
          this.observe(matchedAt, {
            kind: "event",
            phase: "event_match",
            outcome: matched ? "matched" : "unmatched",
            address: event.table,
            subscriptionId: listener.id,
            commitVersion,
            resultCount: matched ? 1 : 0,
          });
        }
        if (!matched) continue;
      } catch (error) {
        if (this.observer) {
          const outcome = observationOutcome(error);
          const metadata = {
            kind: "event" as const,
            address: event.table,
            subscriptionId: listener.id,
            commitVersion,
            resultCount: 0,
          };
          this.observe(matchedAt, { ...metadata, phase: "event_match", outcome });
          this.observe(matchedAt, { ...metadata, phase: "failure", outcome });
        }
        listener.gapped = true;
        failures.push(failure(listener, error));
        continue;
      }
      const cursor = {
        ...listener.cursor,
        commitVersion,
        sequence: listener.cursor.sequence + 1n,
      };
      try {
        if (listener.gapped) {
          await this.sendEvent(listener, { kind: "gap", cursor });
          listener.gapped = false;
        } else {
          await this.sendEvent(listener, { kind: "row", cursor, row: event.row });
        }
      } catch (error) {
        listener.gapped = true;
        failures.push(failure(listener, error));
      }
    }
    return failures;
  }

  private async failEntry(entry: QueryEntry<C>, error: unknown): Promise<DeliveryFailure[]> {
    if (entry.removed) return [];
    const listeners = [...entry.listeners];
    this.removeEntry(entry);
    const outcome = errorOutcome(error);
    const failures: DeliveryFailure[] = [];
    for (const listener of listeners) {
      failures.push(failure(listener, error, "convergence"));
      try {
        if (isAuthFailure(outcome)) {
          await this.sendRevocation(listener, listener.authEpoch, outcome);
        } else {
          await this.queue(listener, () => listener.subscriber.sendError(listener.id, outcome));
        }
      } catch (deliveryError) {
        failures.push(failure(listener, deliveryError));
      }
    }
    return failures;
  }

  private affectedEntries(writeKeys: ReadonlySet<string>): Set<QueryEntry<C>> {
    const affected = new Set<QueryEntry<C>>();
    for (const key of writeKeys) {
      const owners = this.byReadKey.get(key);
      if (owners instanceof Set) {
        for (const entry of owners) affected.add(entry);
      } else if (owners) {
        affected.add(owners);
      }
    }
    return affected;
  }

  private replaceReadSet(entry: QueryEntry<C>, next: ReadonlySet<string>): void {
    for (const key of entry.readSet) {
      if (next.has(key)) continue;
      this.removeReadOwner(key, entry);
    }
    for (const key of next) {
      if (entry.readSet.has(key)) continue;
      this.addReadOwner(key, entry);
    }
    entry.readSet = new Set(next);
  }

  private addReadOwner(key: string, entry: QueryEntry<C>): void {
    const owners = this.byReadKey.get(key);
    if (!owners) {
      this.byReadKey.set(key, entry);
      this.dependencyEdges++;
      return;
    }
    if (owners === entry) return;
    if (owners instanceof Set) {
      if (owners.has(entry)) return;
      owners.add(entry);
      this.dependencyEdges++;
      return;
    }
    this.byReadKey.set(key, new Set([owners, entry]));
    this.dependencyEdges++;
    this.multiOwnerDependencyKeys++;
  }

  private removeReadOwner(key: string, entry: QueryEntry<C>): void {
    const owners = this.byReadKey.get(key);
    if (owners === entry) {
      this.byReadKey.delete(key);
      this.dependencyEdges--;
      return;
    }
    if (!(owners instanceof Set) || !owners.delete(entry)) return;
    this.dependencyEdges--;
    if (owners.size !== 1) return;
    this.byReadKey.set(key, owners.values().next().value!);
    this.multiOwnerDependencyKeys--;
  }

  private retainHistory(entry: QueryEntry<C>, record: HistoryRecord<C>): boolean {
    const now = record.createdAtMs;
    this.pruneHistory(now);
    if (
      record.bytes > this.limits.resume.maxBytesPerStream ||
      record.bytes > this.limits.resume.maxBytes
    ) {
      this.clearHistory(entry);
      return false;
    }
    while (
      entry.history.length >= this.limits.resume.maxTransitionsPerStream ||
      record.bytes > this.limits.resume.maxBytesPerStream - entry.historyBytes
    ) {
      this.removeHistory(entry.history[0]!);
    }
    while (record.bytes > this.limits.resume.maxBytes - this.historyBytes && this.historyHead) {
      this.removeHistory(this.historyHead);
    }
    if (record.bytes > this.limits.resume.maxBytes - this.historyBytes) {
      this.clearHistory(entry);
      return false;
    }
    entry.history.push(record);
    entry.historyBytes += record.bytes;
    this.historyBytes += record.bytes;
    this.historyTransitions++;
    if (this.historyTail) {
      this.historyTail.nextGlobal = record;
      record.previousGlobal = this.historyTail;
    } else {
      this.historyHead = record;
    }
    this.historyTail = record;
    return true;
  }

  private pruneHistory(now: number): void {
    while (this.historyHead && now - this.historyHead.createdAtMs >= this.limits.resume.maxAgeMs) {
      this.removeHistory(this.historyHead);
    }
  }

  private removeHistory(record: HistoryRecord<C>): void {
    if (!record.active) return;
    record.active = false;
    const index = record.entry.history.indexOf(record);
    if (index >= 0) record.entry.history.splice(index, 1);
    record.entry.historyBytes -= record.bytes;
    this.historyBytes -= record.bytes;
    this.historyTransitions--;
    if (record.previousGlobal) record.previousGlobal.nextGlobal = record.nextGlobal;
    else this.historyHead = record.nextGlobal;
    if (record.nextGlobal) record.nextGlobal.previousGlobal = record.previousGlobal;
    else this.historyTail = record.previousGlobal;
    record.previousGlobal = undefined;
    record.nextGlobal = undefined;
  }

  private clearHistory(entry: QueryEntry<C>): void {
    for (const record of [...entry.history]) this.removeHistory(record);
  }

  private makeEntryCapacity(): void {
    if (this.entries.size < this.limits.maxSharedSubscriptions) return;
    this.prune();
    while (this.entries.size >= this.limits.maxSharedSubscriptions) {
      const dormant = this.oldestDormant();
      if (!dormant) throw overloaded("Shared query entry capacity is full");
      this.removeEntry(dormant);
    }
  }

  private makeResultCapacity(entry: QueryEntry<C>, nextBytes: number): string | undefined {
    if (nextBytes > this.limits.maxFrameBytes) return "Query result exceeds maxFrameBytes";
    if (nextBytes > this.limits.maxSharedResultBytes) return "Shared query result capacity is full";
    while (nextBytes > this.limits.maxSharedResultBytes - (this.resultBytes - entry.resultBytes)) {
      const dormant = this.oldestDormant(entry);
      if (!dormant) return "Shared query result capacity is full";
      this.removeEntry(dormant);
    }
    return undefined;
  }

  private oldestDormant(exclude?: QueryEntry<C>): QueryEntry<C> | undefined {
    let oldest: QueryEntry<C> | undefined;
    for (const entry of this.entries.values()) {
      if (entry === exclude || entry.listeners.size !== 0 || entry.evaluation || entry.dormantAtMs === undefined) {
        continue;
      }
      if (!oldest || entry.dormantAtMs < oldest.dormantAtMs!) oldest = entry;
    }
    return oldest;
  }

  private removeEntry(entry: QueryEntry<C>): void {
    if (entry.removed) return;
    entry.removed = true;
    entry.evaluationGeneration++;
    this.entries.delete(entry.key);
    this.resultBytes -= entry.resultBytes;
    this.clearHistory(entry);
    for (const key of entry.readSet) this.removeReadOwner(key, entry);
    for (const listener of [...entry.listeners]) this.detach(listener);
  }

  private attach(binding: Binding<C>): void {
    let mine = this.bySubscriber.get(binding.subscriber);
    if (!mine) this.bySubscriber.set(binding.subscriber, (mine = new Map()));
    mine.set(binding.id, binding);
    if (binding.kind === "query") {
      if (binding.entry.listeners.size === 0) {
        binding.entry.ownerFairnessKey = binding.fairnessKey;
      }
      binding.entry.listeners.add(binding);
      binding.entry.dormantAtMs = undefined;
      this.queryListeners++;
    } else {
      binding.state.listeners.add(binding);
      this.eventListeners++;
    }
  }

  private detach(binding: Binding<C>): void {
    const mine = this.bySubscriber.get(binding.subscriber);
    if (mine?.get(binding.id) !== binding) return;
    mine.delete(binding.id);
    if (mine.size === 0) this.bySubscriber.delete(binding.subscriber);
    if (binding.kind === "query") {
      binding.entry.listeners.delete(binding);
      this.queryListeners--;
      const oldest = binding.entry.listeners.values().next().value;
      if (oldest !== undefined) binding.entry.ownerFairnessKey = oldest.fairnessKey;
      if (binding.entry.listeners.size === 0 && !binding.entry.removed) {
        binding.entry.dormantAtMs = this.readNow();
      }
    } else {
      binding.state.listeners.delete(binding);
      this.eventListeners--;
      if (binding.state.listeners.size === 0) this.eventStates.delete(binding.state.table);
    }
  }

  private assertSubscriptionAdmission(subscriber: Subscriber, id: number): void {
    if (!Number.isSafeInteger(id) || id <= 0) throw new RangeError("subscription id must be positive");
    const mine = this.bySubscriber.get(subscriber);
    if (mine?.has(id)) throw new DbzzError("conflict", "Subscription id is already active");
    if ((mine?.size ?? 0) >= this.limits.maxSubscriptionsPerConnection) {
      throw overloaded("Per-connection subscription capacity is full");
    }
    if (this.queryListeners + this.eventListeners >= this.limits.maxSubscriptions) {
      throw overloaded("Global subscription capacity is full");
    }
  }

  private validateEvaluation(evaluation: QueryEvaluation): void {
    if (typeof evaluation.encoded !== "string") throw new DbzzError("internal", "Query encoding is invalid");
    if (typeof evaluation.commitVersion !== "bigint" || evaluation.commitVersion < 0n) {
      throw new DbzzError("internal", "Query commit version is invalid");
    }
    if (!(evaluation.readSet instanceof Set)) throw new DbzzError("internal", "Query read set is invalid");
    for (const key of evaluation.readSet) {
      if (typeof key !== "string") throw new DbzzError("internal", "Query read set contains a non-string key");
    }
  }

  private cursor(entry: QueryEntry<C>, authEpoch: number): SubscriptionCursor {
    return {
      generation: entry.generation,
      commitVersion: entry.commitVersion,
      authEpoch,
      identity: entry.identity,
    };
  }

  private cursorBelongsTo(cursor: SubscriptionCursor, entry: QueryEntry<C>, authEpoch: number): boolean {
    return cursor.generation === entry.generation && cursor.identity === entry.identity && cursor.authEpoch === authEpoch;
  }

  private queue(
    binding: Binding<C>,
    send: () => Promise<void>,
    commitVersion?: bigint,
  ): Promise<void> {
    let deliver = send;
    if (this.observer) {
      const queuedAt = this.observationNow();
      const address = binding.kind === "query" ? binding.entry.address : binding.state.table;
      const version = commitVersion ?? (binding.kind === "query"
        ? binding.entry.commitVersion
        : binding.cursor.commitVersion);
      const dependencyCount = binding.kind === "query" ? binding.entry.readSet.size : undefined;
      const byteCount = binding.kind === "query" ? binding.entry.resultBytes : undefined;
      deliver = async () => {
        this.observe(queuedAt, {
          kind: binding.kind,
          phase: "listener_queue",
          outcome: "ok",
          address,
          subscriptionId: binding.id,
          commitVersion: version,
          dependencyCount,
          resultCount: 1,
          byteCount,
        });
        const deliveredAt = this.observationNow();
        try {
          await send();
          this.observe(deliveredAt, {
            kind: binding.kind,
            phase: "delivery",
            outcome: "ok",
            address,
            subscriptionId: binding.id,
            commitVersion: version,
            dependencyCount,
            resultCount: 1,
            byteCount,
          });
        } catch (error) {
          const outcome = observationOutcome(error);
          const metadata = {
            kind: binding.kind,
            address,
            subscriptionId: binding.id,
            commitVersion: version,
            dependencyCount,
            resultCount: 0,
            byteCount,
          };
          this.observe(deliveredAt, { ...metadata, phase: "delivery", outcome });
          this.observe(deliveredAt, { ...metadata, phase: "failure", outcome });
          throw error;
        }
      };
    }

    const previous = binding.delivery;
    const reserved = Promise.withResolvers<void>();
    binding.delivery = reserved.promise;
    let delivery: Promise<void>;
    if (previous) {
      delivery = previous.then(deliver);
    } else {
      try {
        delivery = deliver();
      } catch (error) {
        delivery = Promise.reject(error);
      }
    }
    const release = () => {
      reserved.resolve();
      if (binding.delivery === reserved.promise) binding.delivery = undefined;
    };
    void delivery.then(release, release);
    return delivery;
  }

  private async sendEvent(listener: EventListener<C>, event: LiveEvent): Promise<void> {
    await this.queue(
      listener,
      () => listener.subscriber.sendEvent(listener.id, event),
      event.cursor.commitVersion,
    );
    listener.cursor = event.cursor;
  }

  private async sendRevocation(
    listener: QueryListener<C>,
    nextAuthEpoch: number,
    outcome: Outcome,
  ): Promise<void> {
    await this.queue(listener, async () => {
      const from = listener.cursor;
      if (!from) {
        await listener.subscriber.sendError(listener.id, outcome);
        return;
      }
      const to = { ...from, generation: this.generation(), authEpoch: nextAuthEpoch };
      await listener.subscriber.sendTransition(listener.id, { kind: "revoked", from, to, outcome });
      listener.cursor = to;
    });
  }

  private assertAuthEpoch(authEpoch: number): void {
    if (!Number.isSafeInteger(authEpoch) || authEpoch < 0) {
      throw new RangeError("authEpoch must be a non-negative safe integer");
    }
  }

  private assertNewAuthEpoch(bindings: readonly Binding<C>[], nextAuthEpoch: number): void {
    if (bindings.some((binding) => nextAuthEpoch <= binding.authEpoch)) {
      throw new RangeError("nextAuthEpoch must be greater than every active auth epoch");
    }
  }

  private generation(): string {
    const generation = this.nextGeneration();
    if (typeof generation !== "string" || generation.length === 0 || generation.length > 512) {
      throw new TypeError("generation must return a non-empty bounded string");
    }
    return generation;
  }

  private observationNow(): number | undefined {
    try {
      const now = this.now();
      return Number.isFinite(now) ? now : undefined;
    } catch {
      return undefined;
    }
  }

  private observe(
    startedAt: number | undefined,
    observation: Omit<ReactiveObservation, "durationMs">,
  ): void {
    const observer = this.observer;
    if (!observer) return;
    const finishedAt = this.observationNow();
    const elapsed = startedAt === undefined || finishedAt === undefined
      ? 0
      : finishedAt - startedAt;
    const durationMs = Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
    const safe = Object.freeze({ ...observation, durationMs });
    try {
      const completion = observer(safe);
      if (
        completion !== null &&
        (typeof completion === "object" || typeof completion === "function") &&
        typeof (completion as PromiseLike<unknown>).then === "function"
      ) {
        void Promise.resolve(completion).catch(() => {});
      }
    } catch {
      // Observability must never affect publication, convergence, or delivery.
    }
  }

  private readNow(): number {
    const now = this.now();
    if (!Number.isFinite(now)) throw new RangeError("now must return a finite number");
    return now;
  }
}

function cursorEquals(left: SubscriptionCursor, right: SubscriptionCursor): boolean {
  return left.generation === right.generation &&
    left.commitVersion === right.commitVersion &&
    left.authEpoch === right.authEpoch &&
    left.identity === right.identity;
}

function byteLength(value: string): number {
  return utf8.encode(value).byteLength;
}

function failure<C>(
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

function observationOutcome(error: unknown): Outcome["code"] {
  return isDbzzError(error) ? error.code : "internal";
}

function isAuthFailure(outcome: Outcome): boolean {
  return outcome.code === "auth_stale" ||
    outcome.code === "auth_unavailable" ||
    outcome.code === "unauthenticated" ||
    outcome.code === "unauthorized";
}

function authOutcome(code: "auth_stale" | "unauthorized", message: string): Outcome {
  return Object.freeze({ code, retryable: false, message });
}

function overloadOutcome(message: string): Outcome {
  return Object.freeze({
    code: "overloaded",
    retryable: true,
    retryAfterMs: 0,
    resource: "subscription",
    message,
  });
}

function errorOutcome(error: unknown): Outcome {
  if (isDbzzError(error)) {
    return Object.freeze({
      code: error.code,
      retryable: error.retryable,
      message: error.message.slice(0, 512),
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      ...(error.resource === undefined ? {} : { resource: error.resource }),
      ...(error.committed === undefined ? {} : { committed: error.committed }),
    });
  }
  return Object.freeze({ code: "internal", retryable: false, message: "Subscription evaluation failed" });
}

function overloaded(message: string): DbzzError {
  return new DbzzError("overloaded", message, {
    retryable: true,
    retryAfterMs: 0,
    resource: "subscription",
  });
}

function unavailable(message: string): DbzzError {
  return new DbzzError("unavailable", message, { resource: "subscription" });
}
