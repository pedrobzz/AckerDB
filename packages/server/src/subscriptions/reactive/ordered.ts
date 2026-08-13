import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  EVENTS_ADDRESS_PREFIX,
  decode,
  stableEncode,
  type LiveEvent,
  type Outcome,
  type SubscriptionCursor,
  type SubscriptionTransition,
} from "@ackerdb/core";
import { AckerDBError } from "../../shared/errors.ts";
import { deepFreeze } from "../../shared/immutable.ts";
import { BoundedExecutor } from "../../runtime/executor.ts";
import { PRODUCTION_LIMITS, type ServiceLimits } from "../../runtime/limits.ts";
import { OrderedPublication, PublicationHandoff, type Publication } from "../publication.ts";
import type {
  AuthRotationResult,
  DeliveryFailure,
  EventSubscriptionOptions,
  OrderedReactiveOptions,
  QueryEvaluation,
  QueryEvaluator,
  QuerySubscriptionOptions,
  ReactiveCommit,
  ReactiveCommitResult,
  ReactiveEvent,
  ReactiveSnapshot,
  Subscriber,
} from "./contract.ts";
import { DependencyIndex } from "./dependencies.ts";
import {
  failure,
  type Binding,
  type EventListener,
  type EventState,
  type QueryEntry,
  type QueryListener,
} from "./entry.ts";
import { TransitionHistory } from "./history.ts";
import {
  authOutcome,
  errorOutcome,
  isAuthFailure,
  overloadOutcome,
  overloaded,
  unavailable,
} from "./outcome.ts";

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
  // ambient when a commit lands.
  private readonly root = AsyncLocalStorage.snapshot();
  private readonly now: () => number;
  private readonly nextGeneration: () => string;
  private readonly revalidation: BoundedExecutor;
  private readonly entries = new Map<string, QueryEntry<C>>();
  private readonly dependencies = new DependencyIndex<C>();
  private readonly bySubscriber = new Map<Subscriber, Map<number, Binding<C>>>();
  private readonly eventStates = new Map<string, EventState<C>>();
  private readonly history: TransitionHistory<C>;
  private queryListeners = 0;
  private eventListeners = 0;
  private resultBytes = 0;
  private dormantEntries = 0;
  private evaluatingEntries = 0;

  constructor(options: OrderedReactiveOptions<C>) {
    this.evaluateQuery = options.evaluate;
    this.limits = options.limits ?? PRODUCTION_LIMITS;
    this.history = new TransitionHistory(this.limits.resume);
    this.now = options.now ?? Date.now;
    this.nextGeneration = options.generation ?? (() => crypto.randomUUID());
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
    this.assertSubscriptionIdentity(options.subscriber, options.id);
    let entry = this.entryFor(options);
    entry.context = options.context;
    if (entry.listeners.size === 0) entry.ownerFairnessKey = options.fairnessKey;

    try {
      for (;;) {
        await this.ensureCurrent(entry, this.publication.snapshot().highWater);
        let listener: QueryListener<C> | undefined;
        const installed = this.publication.compareAndInstall(entry.commitVersion, () => {
          if (entry.removed) return;
          this.assertSubscriptionIdentity(options.subscriber, options.id);
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
    this.assertSubscriptionIdentity(options.subscriber, options.id);
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
    if (!binding) throw new AckerDBError("not_found", "Subscription is not active");
    if (binding.kind !== "query") throw new AckerDBError("conflict", "Only query subscriptions have reset cursors");
    await this.sendTransition(binding, {
      kind: "reset",
      from,
      to: this.cursor(binding.entry, binding.authEpoch),
      value: binding.entry.value,
    });
  }

  affectedQueryIds(subscriber: Subscriber, writeKeys: ReadonlySet<string>): number[] {
    const affected = this.dependencies.affected(writeKeys);
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
      throw new AckerDBError("convergence_unavailable", "Commit is newer than the publication high-water", {
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
      address: binding.kind === "query"
        ? binding.entry.address
        : `${EVENTS_ADDRESS_PREFIX}${binding.state.table}`,
      args: binding.kind === "query" ? binding.entry.args.decoded : binding.args,
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
    this.history.prune(now);
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
    return Object.freeze({
      sharedEntries: this.entries.size,
      queryListeners: this.queryListeners,
      eventListeners: this.eventListeners,
      dormantEntries: this.dormantEntries,
      dependencyKeys: this.dependencies.keys,
      dependencyEdges: this.dependencies.edges,
      multiOwnerDependencyKeys: this.dependencies.multiOwnerKeys,
      resultBytes: this.resultBytes,
      historyTransitions: this.history.transitions,
      historyBytes: this.history.bytes,
      evaluatingEntries: this.evaluatingEntries,
      revalidation: this.revalidation.snapshot(),
    });
  }

  async close(): Promise<void> {
    await this.publication.close();
    this.revalidation.close();
    await this.revalidation.drain();
  }

  private entryFor(input: QuerySubscriptionOptions<C>): QueryEntry<C> {
    const encodedArgs = stableEncode(input.args);
    const key = stableEncode([input.address, encodedArgs, input.policyScopeFingerprint]);
    const existing = this.entries.get(key);
    if (existing) return existing;
    this.makeEntryCapacity();
    const entry: QueryEntry<C> = {
      key,
      identity: createHash("sha256").update(key).digest("base64url"),
      address: input.address,
      args: Object.freeze({
        decoded: deepFreeze(decode(encodedArgs)),
        encoded: encodedArgs,
        bytes: byteLength(encodedArgs),
      }),
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
    const execution = this.revalidation.submit(
      () => this.evaluateOnce(entry, fairnessKey, context),
      {
        bytes: entry.revalidationBytes,
        fairnessKey,
      },
    ).catch(async (error): Promise<DeliveryFailure[]> => {
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
      if (entry.evaluation === owned) {
        entry.evaluation = undefined;
        this.evaluatingEntries--;
      }
      if (entry.listeners.size === 0 && entry.initialized && entry.dormantAtMs === undefined) {
        entry.dormantAtMs = this.readNow();
        this.dormantEntries++;
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
    this.evaluatingEntries++;
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
      let evaluated: QueryEvaluation;
      try {
        evaluated = await this.root(() => this.evaluateQuery({
          address: entry.address,
          args: entry.args.decoded,
          requestBytes: entry.args.bytes,
          policyScopeFingerprint: entry.policyScopeFingerprint,
          fairnessKey,
          context,
        }));
        this.validateEvaluation(evaluated);
        const highWater = this.publication.snapshot().highWater;
        if (evaluated.commitVersion > highWater) {
          throw new AckerDBError("internal", "Query observed a future commit");
        }
      } catch (error) {
        throw error;
      }
      let installed: InstalledEvaluation<C> | undefined;
      let current: boolean;
      try {
        current = this.publication.compareAndInstall(evaluated.commitVersion, () => {
          if (entry.removed || entry.evaluationGeneration !== evaluationGeneration) return;
          installed = this.installEvaluation(entry, evaluated);
        });
      } catch (error) {
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
    const changed =
      !entry.initialized ||
      entry.encoded !== evaluated.encoded ||
      (entry.applicationError === undefined) !== (evaluated.applicationError === undefined);
    this.dependencies.replace(entry, evaluated.readSet);
    this.resultBytes += resultBytes - entry.resultBytes;
    entry.value = evaluated.value;
    entry.applicationError = evaluated.applicationError;
    entry.encoded = evaluated.encoded;
    entry.resultBytes = resultBytes;
    entry.commitVersion = evaluated.commitVersion;
    entry.initialized = true;
    let forceReset = false;
    if (previousVersion !== undefined && evaluated.commitVersion > previousVersion) {
      forceReset = !this.history.retain(entry, {
        entry,
        fromVersion: previousVersion,
        toVersion: evaluated.commitVersion,
        kind: changed ? "update" : "checkpoint",
        ...(changed && evaluated.applicationError !== undefined
          ? { applicationError: evaluated.applicationError }
          : changed
            ? { value: evaluated.value }
            : {}),
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
      const chain = this.history.chain(entry, from.commitVersion, target.commitVersion);
      if (chain) {
        let cursor = from;
        for (const record of chain) {
          const to = { ...cursor, commitVersion: record.toVersion };
          const transition: SubscriptionTransition = record.kind === "update"
            ? record.applicationError === undefined
              ? { kind: "update", from: cursor, to, value: record.value }
              : { kind: "application-error", from: cursor, to, error: record.applicationError }
            : { kind: "checkpoint", from: cursor, to };
          await this.sendTransition(listener, transition);
          cursor = to;
        }
        return;
      }
    }
    await this.sendTransition(
      listener,
      entry.applicationError === undefined
        ? { kind: "reset", from: from ?? null, to: target, value: entry.value }
        : {
            kind: "application-error",
            from: from ?? null,
            to: target,
            error: entry.applicationError,
          },
    );
  }

  private async sendTransition(
    listener: QueryListener<C>,
    transition: SubscriptionTransition,
  ): Promise<void> {
    await this.queue(
      listener,
      () => listener.subscriber.sendTransition(listener.id, transition),
    );
    listener.cursor = transition.to;
  }

  private processPublication(publication: Publication<ReactiveCommit>): PublicationHandoff {
    const commit = publication.value;
    const affected = this.dependencies.affected(commit.writeKeys);
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
    return Promise.all(events.map((event) => this.publishEvent(commitVersion, event)))
      .then((failures) => failures.flat());
  }

  private publishEvent(commitVersion: bigint, event: ReactiveEvent): Promise<DeliveryFailure[]> {
    const state = this.eventStates.get(event.table);
    if (!state) return Promise.resolve([]);
    const deliveries: Promise<DeliveryFailure | undefined>[] = [];
    for (const listener of [...state.listeners]) {
      try {
        const matched = this.root(() => listener.matches(event.row, listener.args)) === true;
        if (!matched) continue;
      } catch (error) {
        deliveries.push(this.sequence(listener, () => {
          listener.gapped = true;
        }).then(() => failure(listener, error)));
        continue;
      }
      deliveries.push(this.sendPublishedEvent(listener, commitVersion, event.row).then(
        () => undefined,
        (error) => failure(listener, error),
      ));
    }
    return Promise.all(deliveries).then((failures) =>
      failures.filter((item): item is DeliveryFailure => item !== undefined));
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
    if (entry.dormantAtMs !== undefined) this.dormantEntries--;
    if (entry.evaluation !== undefined) {
      entry.evaluation = undefined;
      this.evaluatingEntries--;
    }
    this.resultBytes -= entry.resultBytes;
    this.history.clear(entry);
    this.dependencies.detach(entry);
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
      if (binding.entry.dormantAtMs !== undefined) this.dormantEntries--;
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
        if (binding.entry.dormantAtMs === undefined) {
          binding.entry.dormantAtMs = this.readNow();
          this.dormantEntries++;
        }
      }
    } else {
      binding.state.listeners.delete(binding);
      this.eventListeners--;
      if (binding.state.listeners.size === 0) this.eventStates.delete(binding.state.table);
    }
  }

  private assertSubscriptionIdentity(subscriber: Subscriber, id: number): void {
    if (!Number.isSafeInteger(id) || id <= 0) throw new RangeError("subscription id must be positive");
    const mine = this.bySubscriber.get(subscriber);
    if (mine?.has(id)) throw new AckerDBError("conflict", "Subscription id is already active");
  }

  private validateEvaluation(evaluation: QueryEvaluation): void {
    if (typeof evaluation.encoded !== "string") throw new AckerDBError("internal", "Query encoding is invalid");
    if (typeof evaluation.commitVersion !== "bigint" || evaluation.commitVersion < 0n) {
      throw new AckerDBError("internal", "Query commit version is invalid");
    }
    if (!(evaluation.readSet instanceof Set)) throw new AckerDBError("internal", "Query read set is invalid");
    for (const key of evaluation.readSet) {
      if (typeof key !== "string") throw new AckerDBError("internal", "Query read set contains a non-string key");
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
  ): Promise<void> {
    return this.sequence(binding, send);
  }

  private sequence(binding: Binding<C>, work: () => void | Promise<void>): Promise<void> {
    const previous = binding.delivery;
    const reserved = Promise.withResolvers<void>();
    binding.delivery = reserved.promise;
    let delivery: Promise<void>;
    if (previous) {
      delivery = previous.then(work);
    } else {
      try {
        delivery = Promise.resolve(work());
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

  private sendPublishedEvent(
    listener: EventListener<C>,
    commitVersion: bigint,
    row: unknown,
  ): Promise<void> {
    return this.queue(listener, async () => {
      const cursor = {
        ...listener.cursor,
        commitVersion,
        sequence: listener.cursor.sequence + 1n,
      };
      const event: LiveEvent = listener.gapped
        ? { kind: "gap", cursor }
        : { kind: "row", cursor, row };
      try {
        await listener.subscriber.sendEvent(listener.id, event);
      } catch (error) {
        listener.gapped = true;
        throw error;
      }
      listener.cursor = cursor;
      listener.gapped = false;
    });
  }

  private async sendEvent(listener: EventListener<C>, event: LiveEvent): Promise<void> {
    await this.queue(
      listener,
      () => listener.subscriber.sendEvent(listener.id, event),
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
