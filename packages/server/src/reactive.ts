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
import { deepFreeze } from "./immutable.ts";
import { PRODUCTION_LIMITS, type ServiceLimits } from "./limits.ts";
import { OrderedPublication, type Publication } from "./publication.ts";

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
  result?: ReactiveCommitResult;

  constructor(
    writeKeys: ReadonlySet<string>,
    events: readonly ReactiveEvent[] = [],
    readonly caller?: Subscriber,
  ) {
    this.writeKeys = new Set(writeKeys);
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
  readonly resultBytes: number;
  readonly historyTransitions: number;
  readonly historyBytes: number;
  readonly evaluatingEntries: number;
}

export interface AuthRotationResult {
  readonly queryIds: readonly number[];
  readonly eventIds: readonly number[];
  readonly deliveryFailures: readonly DeliveryFailure[];
}

interface QueryListener<C> {
  readonly kind: "query";
  readonly subscriber: Subscriber;
  readonly id: number;
  readonly entry: QueryEntry<C>;
  authEpoch: number;
  cursor?: SubscriptionCursor;
  tail: Promise<void>;
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
  tail: Promise<void>;
}

type Binding<C> = QueryListener<C> | EventListener<C>;

interface QueryEntry<C> {
  readonly key: string;
  readonly identity: string;
  readonly address: string;
  readonly encodedArgs: string;
  readonly policyScopeFingerprint: string;
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
  private readonly now: () => number;
  private readonly nextGeneration: () => string;
  private readonly entries = new Map<string, QueryEntry<C>>();
  private readonly byReadKey = new Map<string, Set<QueryEntry<C>>>();
  private readonly bySubscriber = new Map<Subscriber, Map<number, Binding<C>>>();
  private readonly eventStates = new Map<string, EventState<C>>();
  private historyHead?: HistoryRecord<C>;
  private historyTail?: HistoryRecord<C>;
  private queryListeners = 0;
  private eventListeners = 0;
  private resultBytes = 0;
  private historyBytes = 0;
  private historyTransitions = 0;

  constructor(options: OrderedReactiveOptions<C>) {
    this.evaluateQuery = options.evaluate;
    this.limits = options.limits ?? PRODUCTION_LIMITS;
    this.now = options.now ?? Date.now;
    this.nextGeneration = options.generation ?? (() => crypto.randomUUID());
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
            authEpoch: options.authEpoch,
            cursor: options.cursor,
            tail: Promise.resolve(),
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
      tail: Promise.resolve(),
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
    const queryIds: number[] = [];
    const eventIds: number[] = [];
    const failures: DeliveryFailure[] = [];
    for (const binding of bindings) {
      this.detach(binding);
      if (binding.kind === "query") {
        queryIds.push(binding.id);
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
        eventIds.push(binding.id);
        // Detach is immediate, but an already-snapshotted publication may still
        // own this tail. Drain it before a new-epoch binding is installed.
        await binding.tail;
      }
    }
    return Object.freeze({
      queryIds: Object.freeze(queryIds.sort((a, b) => a - b)),
      eventIds: Object.freeze(eventIds.sort((a, b) => a - b)),
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
      resultBytes: this.resultBytes,
      historyTransitions: this.historyTransitions,
      historyBytes: this.historyBytes,
      evaluatingEntries,
    });
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

  private async ensureCurrent(entry: QueryEntry<C>, targetVersion: bigint): Promise<DeliveryFailure[]> {
    if (entry.removed) throw unavailable("Subscription entry was evicted");
    if (targetVersion > entry.dirtyVersion) entry.dirtyVersion = targetVersion;
    if (entry.initialized && entry.commitVersion >= targetVersion) return [];
    if (entry.evaluation) return entry.evaluation;
    const task = this.evaluateUntilCurrent(entry);
    entry.evaluation = task;
    try {
      return await task;
    } finally {
      if (entry.evaluation === task) entry.evaluation = undefined;
      if (entry.listeners.size === 0 && entry.initialized && entry.dormantAtMs === undefined) {
        entry.dormantAtMs = this.readNow();
      }
    }
  }

  private async evaluateUntilCurrent(entry: QueryEntry<C>): Promise<DeliveryFailure[]> {
    const failures: DeliveryFailure[] = [];
    while (!entry.removed && (!entry.initialized || entry.commitVersion < entry.dirtyVersion)) {
      const evaluationGeneration = ++entry.evaluationGeneration;
      const evaluated = await this.evaluateQuery({
        address: entry.address,
        args: decode(entry.encodedArgs),
        policyScopeFingerprint: entry.policyScopeFingerprint,
        context: entry.context,
      });
      this.validateEvaluation(evaluated);
      const highWater = this.publication.snapshot().highWater;
      if (evaluated.commitVersion > highWater) throw new DbzzError("internal", "Query observed a future commit");
      let installed: InstalledEvaluation<C> | undefined;
      const current = this.publication.compareAndInstall(evaluated.commitVersion, () => {
        if (entry.removed || entry.evaluationGeneration !== evaluationGeneration) return;
        installed = this.installEvaluation(entry, evaluated);
      });
      if (!current || !installed) continue;
      if (installed.overflowedListeners) {
        const message = installed.overloadMessage ?? "Shared query result capacity is full";
        const outcome = overloadOutcome(message);
        const convergenceError = overloaded(message);
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
    const failures: DeliveryFailure[] = [];
    for (const listener of [...installed.entry.listeners]) {
      try {
        await this.deliverQuery(listener, false, installed.forceReset);
      } catch (error) {
        failures.push(failure(listener, error));
      }
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
    await this.queue(listener, () => listener.subscriber.sendTransition(listener.id, transition));
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

  private async processPublication(publication: Publication<ReactiveCommit>): Promise<void> {
    const commit = publication.value;
    const affectedCallerIds = commit.caller ? this.affectedQueryIds(commit.caller, commit.writeKeys) : [];
    const failures: DeliveryFailure[] = [];
    const affected = this.affectedEntries(commit.writeKeys);
    for (const entry of affected) {
      if (entry.removed || entry.commitVersion >= publication.version) continue;
      if (publication.version > entry.dirtyVersion) entry.dirtyVersion = publication.version;
      try {
        failures.push(...await this.ensureCurrent(entry, publication.version));
      } catch (error) {
        failures.push(...await this.failEntry(entry, error));
      }
    }
    for (const event of commit.events) {
      failures.push(...await this.publishEvent(publication.version, event));
    }
    commit.result = Object.freeze({
      affectedCallerIds: Object.freeze(affectedCallerIds),
      deliveryFailures: Object.freeze(failures),
    });
    this.prune();
  }

  private async publishEvent(commitVersion: bigint, event: ReactiveEvent): Promise<DeliveryFailure[]> {
    const state = this.eventStates.get(event.table);
    if (!state) return [];
    const failures: DeliveryFailure[] = [];
    for (const listener of [...state.listeners]) {
      try {
        if (listener.matches(event.row, listener.args) !== true) continue;
      } catch (error) {
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
      for (const entry of this.byReadKey.get(key) ?? []) affected.add(entry);
    }
    return affected;
  }

  private replaceReadSet(entry: QueryEntry<C>, next: ReadonlySet<string>): void {
    for (const key of entry.readSet) {
      if (next.has(key)) continue;
      const entries = this.byReadKey.get(key);
      entries?.delete(entry);
      if (entries?.size === 0) this.byReadKey.delete(key);
    }
    for (const key of next) {
      if (entry.readSet.has(key)) continue;
      let entries = this.byReadKey.get(key);
      if (!entries) this.byReadKey.set(key, (entries = new Set()));
      entries.add(entry);
    }
    entry.readSet = new Set(next);
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
    for (const key of entry.readSet) {
      const entries = this.byReadKey.get(key);
      entries?.delete(entry);
      if (entries?.size === 0) this.byReadKey.delete(key);
    }
    for (const listener of [...entry.listeners]) this.detach(listener);
  }

  private attach(binding: Binding<C>): void {
    let mine = this.bySubscriber.get(binding.subscriber);
    if (!mine) this.bySubscriber.set(binding.subscriber, (mine = new Map()));
    mine.set(binding.id, binding);
    if (binding.kind === "query") {
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

  private queue(binding: Binding<C>, send: () => Promise<void>): Promise<void> {
    const delivery = binding.tail.then(send);
    binding.tail = delivery.catch(() => {});
    return delivery;
  }

  private async sendEvent(listener: EventListener<C>, event: LiveEvent): Promise<void> {
    await this.queue(listener, () => listener.subscriber.sendEvent(listener.id, event));
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
