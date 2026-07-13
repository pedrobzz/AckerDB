import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  stableEncode,
  type ErrorMessage,
  type EventMessage,
  type LiveEvent,
  type MutationMessage,
  type MutationOkMessage,
  type Outcome,
  type QueryMessage,
  type QueryOkMessage,
  type ResetRequestMessage,
  type SubscribeMessage,
  type SubscriptionTransition,
  type TransitionMessage,
  type UnsubscribeMessage,
} from "@dbzz/core";
import {
  ANONYMOUS_PRINCIPAL,
  SYSTEM_PRINCIPAL,
  type Principal,
} from "./auth.ts";
import { CommitCoordinator, type CommitResult } from "./coordinator.ts";
import { ValidationError } from "./dbz.ts";
import {
  makeDbReader,
  type ReadRecorder,
  type WriteCollector,
} from "./db.ts";
import { BoundedSseProducer, OutboundBudget } from "./delivery.ts";
import type { Engine } from "./engine.ts";
import { DbzzError, isDbzzError } from "./errors.ts";
import {
  BoundedExecutor,
  type ExecutorSnapshot,
  type ExecutorTaskOptions,
} from "./executor.ts";
import type {
  AnyRegistered,
  ProcedureCtx,
  SseCtx,
  StreamWriter,
  TxCtx,
} from "./functions.ts";
import { authorizeInvocation, invokeFunction } from "./invocation.ts";
import { emitWriteKeys } from "./keys.ts";
import { PRODUCTION_LIMITS, defineServiceLimits, type ServiceLimits } from "./limits.ts";
import { outcomeFromError } from "./outcome.ts";
import {
  OrderedReactive,
  ReactiveCommit,
  type QueryEvaluation,
  type QueryEvaluationInput,
  type Subscriber,
} from "./reactive.ts";
import type { Registry } from "./registry.ts";
import {
  Telemetry,
  type TelemetryOperation,
  type TelemetryOptions,
  type TelemetrySnapshot,
  type TelemetryTraceContext,
} from "./telemetry.ts";
import type {
  RuntimeAuthTransition,
  RuntimeMutationResult,
  RuntimePort,
  RuntimePublication,
  SessionRuntimeContext,
} from "./session.ts";

const utf8 = new TextEncoder();
const SCHEDULER_RETRY_MS = 1_000;

export type RuntimeLifecycleState = "ready" | "draining" | "stopped";

export interface RuntimeOptions {
  readonly engine: Engine;
  readonly registry: Registry;
  readonly limits?: ServiceLimits;
  readonly telemetry?: Telemetry | TelemetryOptions | false;
  readonly now?: () => number;
}

export interface RuntimeProcedureRequest {
  readonly id: number;
  readonly address: string;
  readonly args: unknown;
  readonly principal: Principal;
  readonly signal?: AbortSignal;
  readonly fairnessKey?: string;
}

export interface RuntimeSseRequest extends RuntimeProcedureRequest {}

export interface RuntimeStatus {
  readonly state: RuntimeLifecycleState;
  readonly connections: number;
  readonly activeOperations: number;
  readonly activeSse: number;
  readonly scheduledHandlers: number;
  readonly schedulerArmed: boolean;
  readonly reader: ExecutorSnapshot;
  readonly writer: ExecutorSnapshot;
  readonly reactive: ReturnType<OrderedReactive<ReactiveContext>["snapshot"]>;
  readonly publication: ReturnType<OrderedReactive<ReactiveContext>["publication"]["snapshot"]>;
  readonly sseBudget: ReturnType<OutboundBudget["snapshot"]>;
  readonly telemetry: TelemetrySnapshot;
  readonly storage: ReturnType<Engine["status"]>;
}

interface ReactiveContext {
  readonly principal: Principal;
  readonly fairnessKey: string;
}

interface RuntimeSubscription {
  readonly address: string;
  readonly args: unknown;
  readonly cursor?: SubscribeMessage["cursor"];
}

interface AuthTransitionCapture {
  phase: "revoking" | "reattaching";
  authEpoch: number;
  readonly frames: RuntimePublication[];
  bytes: number;
}

interface RuntimeSession {
  context: SessionRuntimeContext;
  subscriber: Subscriber;
  readonly subscriptions: Map<number, RuntimeSubscription>;
  capture: AuthTransitionCapture | null;
  activeOperations: number;
}

interface ScheduledCandidate {
  readonly table: string;
  readonly address: string;
  readonly primaryKey: unknown;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function byteLength(value: unknown): number {
  return utf8.encode(encode(value)).byteLength;
}

function snapshotValue(value: unknown): unknown {
  return decode(encode(value));
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableEncode(value)).digest("base64url");
}

function convergenceError(message: string): DbzzError {
  return new DbzzError("convergence_unavailable", message, { committed: true });
}

function transportError(error: unknown): unknown {
  return error instanceof ValidationError
    ? new DbzzError("validation", error.message, { cause: error })
    : error;
}

function aborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw isDbzzError(signal.reason)
    ? signal.reason
    : new DbzzError("unavailable", "operation was canceled", {
        resource: "operation",
        cause: signal.reason,
      });
}

function telemetryContext(connectionId?: string, requestId?: string): TelemetryTraceContext {
  return Object.freeze({
    traceId: crypto.randomUUID(),
    spanId: crypto.randomUUID(),
    ...(connectionId === undefined ? {} : { connectionId }),
    ...(requestId === undefined ? {} : { requestId }),
  });
}

/**
 * Owns bounded execution, the only commit coordinator, ordered convergence,
 * authenticated session state, scheduling, SSE production, and runtime drain.
 * Engine lifetime remains with the caller so storage closes exactly once.
 */
export class Runtime implements RuntimePort {
  readonly engine: Engine;
  readonly registry: Registry;
  readonly limits: ServiceLimits;
  readonly telemetry: Telemetry;
  readonly reactive: OrderedReactive<ReactiveContext>;

  private readonly now: () => number;
  private readonly reader: BoundedExecutor;
  private readonly availableReaders: Database[];
  private readonly coordinator: CommitCoordinator<ReactiveCommit>;
  private readonly scheduled: Map<string, string>;
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly sseBudget: OutboundBudget;
  private readonly sseProducers = new Set<BoundedSseProducer>();
  private readonly activeWaiters = new Set<() => void>();
  private readonly ownsTelemetry: boolean;
  private lifecycle: RuntimeLifecycleState = "ready";
  private activeOperations = 0;
  private schedulerGeneration = 0;
  private schedulerTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduledRun: Promise<number> | null = null;
  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private drainPromise: Promise<void> | null = null;
  private lastCpu = process.cpuUsage();
  private lastCpuAt = performance.now();
  private expectedSampleAt = performance.now();

  constructor(options: RuntimeOptions) {
    this.engine = options.engine;
    this.registry = options.registry;
    this.limits = options.limits === undefined ? PRODUCTION_LIMITS : defineServiceLimits(options.limits);
    this.now = options.now ?? Date.now;
    this.scheduled = options.registry.resolveScheduled(options.engine.schema);
    this.ownsTelemetry = !(options.telemetry instanceof Telemetry);
    this.telemetry = options.telemetry instanceof Telemetry
      ? options.telemetry
      : new Telemetry(options.telemetry === false ? { enabled: false } : options.telemetry);
    this.availableReaders = [this.engine.reader];
    this.reader = new BoundedExecutor({
      concurrency: this.limits.revalidationConcurrency,
      discipline: "round-robin",
      limits: this.limits.readQueue,
      resource: "reader",
      retryAfterMs: 0,
      now: this.now,
    });
    this.reactive = new OrderedReactive<ReactiveContext>({
      limits: this.limits,
      initialVersion: this.engine.commitVersion(),
      now: this.now,
      evaluate: (input) => this.evaluateSubscription(input),
    });
    this.coordinator = new CommitCoordinator({
      engine: this.engine,
      limits: this.limits,
      reservePublication: (bytes) => this.reactive.publication.reserve(bytes),
      now: this.now,
    });
    const globalControlReserve = Math.min(
      this.limits.maxFrameBytes,
      this.limits.sse.maxBytes - 1,
    );
    this.sseBudget = new OutboundBudget(this.limits.sse.maxBytes, globalControlReserve);
    this.telemetry.recordEvent({
      name: "lifecycle",
      level: "info",
      operation: "lifecycle",
      lifecycleState: "ready",
    });
    this.startSampler();
    this.armScheduler();
  }

  kindOf(address: string): string | null {
    if (address.startsWith("events.")) return "event";
    return this.registry.kindOf(address) ?? null;
  }

  async openSession(context: SessionRuntimeContext): Promise<void> {
    this.assertReady();
    if (context.authEpoch !== 0) throw new DbzzError("validation", "new sessions must start at auth epoch 0");
    if (context.principal.kind === "system") throw new DbzzError("unauthorized", "system identity is local only");
    if (this.sessions.has(context.clientSessionId)) {
      throw new DbzzError("conflict", "client session is already connected", { resource: "connection" });
    }
    if (this.sessions.size >= this.limits.maxConnections) {
      throw new DbzzError("overloaded", "connection capacity is full", {
        retryable: true,
        retryAfterMs: 0,
        resource: "connection",
      });
    }

    let state!: RuntimeSession;
    const subscriber = this.makeSubscriber(() => state, context.authEpoch);
    state = {
      context,
      subscriber,
      subscriptions: new Map(),
      capture: null,
      activeOperations: 0,
    };
    this.sessions.set(context.clientSessionId, state);
    this.telemetry.recordMetric({ name: "runtime.connections", value: this.sessions.size, unit: "gauge" });
  }

  async transitionAuth(transition: RuntimeAuthTransition): Promise<readonly RuntimePublication[]> {
    const state = this.currentSession(transition.from, true);
    return this.runOperation(state, "subscription", undefined, 1, async () => {
      if (
        transition.to.clientSessionId !== transition.from.clientSessionId ||
        transition.to.authEpoch !== transition.from.authEpoch + 1
      ) {
        throw new DbzzError("validation", "authentication transition is not monotonic");
      }
      aborted(transition.to.signal);
      const captured: AuthTransitionCapture = {
        phase: "revoking",
        authEpoch: transition.from.authEpoch,
        frames: [],
        bytes: 0,
      };
      state.capture = captured;
      try {
        const rotation = await this.reactive.rotateAuth(state.subscriber, transition.to.authEpoch);
        if (rotation.deliveryFailures.length > 0) {
          throw new DbzzError("unavailable", "subscription revocation could not be delivered", {
            resource: "subscription",
            cause: rotation.deliveryFailures[0]?.error,
          });
        }
        state.context = transition.to;
        state.subscriber = this.makeSubscriber(() => state, transition.to.authEpoch);
        captured.phase = "reattaching";
        captured.authEpoch = transition.to.authEpoch;
        for (const [id, definition] of [...state.subscriptions].sort(([left], [right]) => left - right)) {
          try {
            await this.attachSubscription(state, id, definition, false);
          } catch (error) {
            state.subscriptions.delete(id);
            this.captureFrame(captured, {
              v: PROTOCOL_VERSION,
              t: "err",
              id,
              outcome: outcomeFromError(transportError(error)),
            });
          }
        }
        return Object.freeze([...captured.frames]);
      } catch (error) {
        // Auth transitions are terminal when their captured protocol cannot be
        // completed. Remove both old and partially reattached ownership now;
        // Session still holds the old epoch and cannot close the new one.
        this.removeSession(state);
        throw error;
      } finally {
        state.capture = null;
      }
    });
  }

  async subscribe(context: SessionRuntimeContext, message: SubscribeMessage): Promise<void> {
    const state = this.currentSession(context);
    await this.runOperation(state, "subscription", message.ref, byteLength(message), async () => {
      const definition: RuntimeSubscription = Object.freeze({
        address: message.ref,
        args: snapshotValue(message.args),
        ...(message.cursor === undefined ? {} : { cursor: Object.freeze({ ...message.cursor }) }),
      });
      await this.attachSubscription(state, message.id, definition, true);
    });
  }

  async unsubscribe(context: SessionRuntimeContext, message: UnsubscribeMessage): Promise<void> {
    const state = this.currentSession(context);
    await this.runOperation(state, "subscription", undefined, byteLength(message), () => {
      this.reactive.unsubscribe(state.subscriber, message.id);
      state.subscriptions.delete(message.id);
    });
  }

  async reset(context: SessionRuntimeContext, message: ResetRequestMessage): Promise<void> {
    const state = this.currentSession(context);
    await this.runOperation(state, "subscription", undefined, byteLength(message), () =>
      this.reactive.reset(state.subscriber, message.id, message.cursor));
  }

  async query(context: SessionRuntimeContext, message: QueryMessage): Promise<unknown> {
    const state = this.currentSession(context);
    return this.runOperation(state, "query", message.ref, byteLength(message), async () => {
      const evaluation = await this.executeQuery(
        message.ref,
        message.args,
        context.principal,
        context.clientSessionId,
        context.signal,
        byteLength(message),
      );
      this.assertFrameFits({
        v: PROTOCOL_VERSION,
        t: "ok",
        id: message.id,
        kind: "query",
        value: evaluation.value,
      } satisfies QueryOkMessage, "query result");
      return evaluation.value;
    });
  }

  async mutation(context: SessionRuntimeContext, message: MutationMessage): Promise<RuntimeMutationResult> {
    const state = this.currentSession(context);
    return this.runOperation(state, "mutation", message.ref, byteLength(message), async () => {
      const fn = this.expect(message.ref, "mutation");
      const requestBytes = byteLength(message);
      let scheduledTouched = false;
      const result = await this.coordinator.execute({
        operation: "mutation",
        fairnessKey: context.clientSessionId,
        requestBytes,
        signal: context.signal,
        idempotency: {
          sessionId: context.clientSessionId,
          requestId: message.mutationRequestId,
          issuedAt: message.issuedAt,
          principalFingerprint: digest(context.principal),
          functionRef: message.ref,
          argsFingerprint: digest(message.args),
        },
        work: (db) => invokeFunction(fn, Object.freeze({ db, auth: context.principal }), message.args),
        publication: (_version, writes) => {
          scheduledTouched = writes.scheduledTouched;
          return this.publicationFor(writes, state.subscriber);
        },
        validate: (value, version, writes) => {
          const obligations = this.reactive.affectedQueryIds(state.subscriber, writes.keys);
          this.assertFrameFits(
            this.mutationFrame(
              message,
              value,
              version,
              this.engine.durability,
              "executed",
              obligations,
            ),
            "mutation result",
          );
        },
      });
      if (scheduledTouched) this.armScheduler();
      return this.finishMutation(state, message, result);
    });
  }

  async closeSession(context: SessionRuntimeContext, _outcome: Outcome): Promise<void> {
    const state = this.sessions.get(context.clientSessionId);
    if (state === undefined) return;
    if (state.context.authEpoch !== context.authEpoch) return;
    this.removeSession(state);
  }

  private removeSession(state: RuntimeSession): void {
    this.reactive.disconnect(state.subscriber);
    state.subscriptions.clear();
    if (this.sessions.get(state.context.clientSessionId) !== state) return;
    this.sessions.delete(state.context.clientSessionId);
    this.telemetry.recordMetric({ name: "runtime.connections", value: this.sessions.size, unit: "gauge" });
  }

  async runProcedure(request: RuntimeProcedureRequest): Promise<unknown> {
    const requestBytes = byteLength({
      v: PROTOCOL_VERSION,
      t: "call",
      id: request.id,
      ref: request.address,
      args: request.args,
    });
    return this.runOperation(null, "procedure", request.address, requestBytes, async () => {
      const fn = this.expect(request.address, "procedure");
      aborted(request.signal);
      const value = await invokeFunction(
        fn,
        this.procedureContext(
          request.principal,
          request.fairnessKey ?? digest(request.principal),
          request.signal,
          requestBytes,
        ),
        request.args,
      );
      aborted(request.signal);
      this.assertFrameFits({
        v: PROTOCOL_VERSION,
        t: "ok",
        id: request.id,
        kind: "procedure",
        value,
      }, "procedure result");
      return value;
    });
  }

  async runSse(request: RuntimeSseRequest): Promise<ReadableStream<Uint8Array>> {
    const requestBytes = byteLength({
      v: PROTOCOL_VERSION,
      t: "call",
      id: request.id,
      ref: request.address,
      args: request.args,
    });
    const release = this.admitOperation(null);
    const startedAt = performance.now();
    const context = telemetryContext(undefined, String(request.id));
    let producer: BoundedSseProducer | null = null;
    let spanRecorded = false;
    const record = (error?: unknown) => {
      if (spanRecorded) return;
      spanRecorded = true;
      this.recordSpan("sse", request.address, requestBytes, startedAt, context, error);
    };
    try {
      const fn = this.expect(request.address, "sse");
      aborted(request.signal);
      producer = new BoundedSseProducer({
        budget: this.sseBudget,
        limits: this.limits,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      this.sseProducers.add(producer);
      const authorized = deferred<void>();
      const stream: StreamWriter = Object.freeze({
        write: (chunk: unknown) => producer!.write(chunk),
        merge: (source: ReadableStream<unknown>) => {
          void producer!.merge(source).catch(() => {});
        },
      });
      const handler = invokeFunction(
        fn,
        Object.freeze({
          ...this.procedureContext(
            request.principal,
            request.fairnessKey ?? digest(request.principal),
            producer.signal,
            requestBytes,
          ),
          stream,
          abortSignal: producer.signal,
        }) as SseCtx,
        request.args,
        { onAuthorized: () => authorized.resolve() },
      );
      const completion = handler.then(
        () => producer!.complete(),
        (error) => {
          producer!.fail(error);
          throw error;
        },
      );
      const lifecycle = completion.then(
        () => record(),
        (error) => {
          record(transportError(error));
          throw error;
        },
      ).finally(() => {
        this.sseProducers.delete(producer!);
        release();
      });
      void lifecycle.catch(() => {});
      await Promise.race([
        authorized.promise,
        handler.then(
          () => undefined,
          (error) => {
            throw error;
          },
        ),
      ]);
      return producer.stream;
    } catch (error) {
      if (producer !== null) {
        this.sseProducers.delete(producer);
        try {
          await producer.stream.cancel(error);
        } catch {
          // No stream escaped this boundary; cancellation is capacity cleanup.
        }
      }
      release();
      const safeError = transportError(error);
      record(safeError);
      throw safeError;
    }
  }

  runScheduled(now = this.readNow()): Promise<number> {
    if (this.scheduledRun !== null) return this.scheduledRun;
    this.assertReady();
    const execution = this.runOperation(null, "scheduled", undefined, 1, async () => {
      let handled = 0;
      while (handled < this.limits.schedulerBatchSize) {
        const candidate = await this.nextScheduledCandidate(now);
        if (candidate === null) break;
        let row: Record<string, unknown> | null = null;
        const result = await this.coordinator.execute({
          operation: "scheduled",
          fairnessKey: "system:scheduler",
          requestBytes: 1,
          work: async (db) => {
            const plan = this.engine.plan(candidate.table);
            const raw = this.engine.writer
              .query(
                `SELECT * FROM ${quoted(candidate.table)} WHERE ${quoted(plan.pk)} = ? AND ${quoted(plan.scheduleAt!)} <= ?`,
              )
              .get(candidate.primaryKey as never, now) as Record<string, unknown> | null;
            if (raw === null) return false;
            row = this.engine.rowFromSql(plan, raw);
            const fn = this.expect(candidate.address, "mutation");
            await invokeFunction(fn, Object.freeze({ db, auth: SYSTEM_PRINCIPAL }), row);
            return true;
          },
          finalize: (writes) => {
            if (row === null) return;
            const plan = this.engine.plan(candidate.table);
            this.engine.writer
              .query(`DELETE FROM ${quoted(candidate.table)} WHERE ${quoted(plan.pk)} = ?`)
              .run(row[plan.pk] as never);
            emitWriteKeys(plan, row, writes.keys);
            writes.scheduledTouched = true;
          },
          publication: (_version, writes) => this.publicationFor(writes),
        });
        if (result.value) handled++;
      }
      return handled;
    });
    let run!: Promise<number>;
    run = execution.then(
      (handled) => {
        if (this.lifecycle === "ready") this.armScheduler();
        return handled;
      },
      (error) => {
        this.retryScheduler(error);
        throw error;
      },
    ).finally(() => {
      if (this.scheduledRun === run) this.scheduledRun = null;
    });
    this.scheduledRun = run;
    return run;
  }

  armScheduler(): void {
    const generation = ++this.schedulerGeneration;
    if (this.schedulerTimer !== null) clearTimeout(this.schedulerTimer);
    this.schedulerTimer = null;
    if (this.lifecycle !== "ready" || this.scheduled.size === 0) return;
    void this.nextScheduledAt().then(
      (at) => {
        if (this.lifecycle !== "ready" || generation !== this.schedulerGeneration || at === null) return;
        const delay = Math.min(Math.max(0, at - this.readNow()), 0x7fff_ffff);
        this.schedulerTimer = setTimeout(() => {
          this.schedulerTimer = null;
          void this.runScheduled().catch(() => {});
        }, delay);
        this.schedulerTimer.unref?.();
      },
      (error) => {
        if (this.lifecycle === "ready" && generation === this.schedulerGeneration) {
          this.retryScheduler(error);
        }
      },
    );
  }

  private retryScheduler(error: unknown): void {
    this.telemetry.recordEvent({
      name: "failure",
      level: "error",
      operation: "scheduled",
      outcome: outcomeFromError(transportError(error)).code,
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
    const generation = ++this.schedulerGeneration;
    if (this.schedulerTimer !== null) clearTimeout(this.schedulerTimer);
    this.schedulerTimer = null;
    if (this.lifecycle !== "ready") return;
    this.schedulerTimer = setTimeout(() => {
      if (this.lifecycle === "ready" && generation === this.schedulerGeneration) this.armScheduler();
    }, SCHEDULER_RETRY_MS);
    this.schedulerTimer.unref?.();
  }

  status(): RuntimeStatus {
    return Object.freeze({
      state: this.lifecycle,
      connections: this.sessions.size,
      activeOperations: this.activeOperations,
      activeSse: this.sseProducers.size,
      scheduledHandlers: this.scheduled.size,
      schedulerArmed: this.schedulerTimer !== null,
      reader: this.reader.snapshot(),
      writer: this.coordinator.snapshot(),
      reactive: this.reactive.snapshot(),
      publication: this.reactive.publication.snapshot(),
      sseBudget: this.sseBudget.snapshot(),
      telemetry: this.telemetry.snapshot(),
      storage: this.engine.status(),
    });
  }

  drain(): Promise<void> {
    if (this.drainPromise !== null) return this.drainPromise;
    if (this.lifecycle === "stopped") return Promise.resolve();
    this.lifecycle = "draining";
    this.schedulerGeneration++;
    if (this.schedulerTimer !== null) clearTimeout(this.schedulerTimer);
    this.schedulerTimer = null;
    this.stopSampler();
    this.telemetry.recordEvent({
      name: "lifecycle",
      level: "info",
      operation: "lifecycle",
      lifecycleState: "draining",
    });
    const draining = new DbzzError("draining", "runtime is draining", { resource: "operation" });
    for (const producer of this.sseProducers) producer.fail(draining);

    this.drainPromise = (async () => {
      await this.waitForActiveOperations();
      this.coordinator.close();
      await this.coordinator.drain();
      await this.reactive.close();
      this.reader.close();
      await this.reader.drain();
      this.lifecycle = "stopped";
      this.telemetry.recordEvent({
        name: "lifecycle",
        level: "info",
        operation: "lifecycle",
        lifecycleState: "stopped",
      });
      if (this.ownsTelemetry) this.telemetry.stop();
      await this.telemetry.flush();
    })();
    return this.drainPromise;
  }

  private expect(address: string, kind: "query" | "mutation" | "procedure" | "sse"): AnyRegistered {
    const fn = this.registry.get(address);
    if (fn === undefined) throw new DbzzError("not_found", `unknown function "${address}"`);
    if (fn.kind !== kind) {
      throw new DbzzError("validation", `"${address}" is a ${fn.kind}, expected a ${kind}`);
    }
    return fn;
  }

  private currentSession(context: SessionRuntimeContext, allowAborted = false): RuntimeSession {
    const state = this.sessions.get(context.clientSessionId);
    if (
      state === undefined ||
      state.context.authEpoch !== context.authEpoch ||
      state.context.principal !== context.principal ||
      state.context.signal !== context.signal
    ) {
      throw new DbzzError("auth_stale", "authentication state changed");
    }
    if (!allowAborted) aborted(context.signal);
    return state;
  }

  private makeSubscriber(state: () => RuntimeSession, authEpoch: number): Subscriber {
    const publish = (message: RuntimePublication): Promise<void> =>
      this.publishSession(state(), authEpoch, message);
    return Object.freeze({
      sendTransition: (id: number, transition: SubscriptionTransition) => publish({
        v: PROTOCOL_VERSION,
        t: "transition",
        id,
        transition,
      } satisfies TransitionMessage),
      sendEvent: (id: number, event: LiveEvent) => publish({
        v: PROTOCOL_VERSION,
        t: "event",
        id,
        event,
      } satisfies EventMessage),
      sendError: (id: number, outcome: Outcome) => publish({
        v: PROTOCOL_VERSION,
        t: "err",
        id,
        outcome,
      } satisfies ErrorMessage),
    });
  }

  private async publishSession(
    state: RuntimeSession,
    sourceAuthEpoch: number,
    message: RuntimePublication,
  ): Promise<void> {
    const capture = state.capture;
    if (capture !== null) {
      if (!this.captureAccepts(capture, sourceAuthEpoch, message)) return;
      const bytes = this.assertFrameFits(message, "subscription frame", "subscription");
      this.captureFrame(capture, message, bytes);
      return;
    }
    if (sourceAuthEpoch !== state.context.authEpoch) return;
    this.assertFrameFits(message, "subscription frame", "subscription");
    if (!await state.context.publish(message)) {
      throw new DbzzError("auth_stale", "authentication state changed");
    }
  }

  private captureAccepts(
    capture: AuthTransitionCapture,
    sourceAuthEpoch: number,
    message: RuntimePublication,
  ): boolean {
    if (sourceAuthEpoch !== capture.authEpoch) return false;
    if (capture.phase === "revoking") {
      return (
        message.t === "transition" &&
        message.transition.kind === "revoked" &&
        message.transition.outcome.code === "auth_stale"
      ) || (message.t === "err" && message.outcome.code === "auth_stale");
    }
    return (
      (message.t === "transition" && message.transition.kind === "reset") ||
      (message.t === "event" && message.event.kind === "reset") ||
      message.t === "err"
    );
  }

  private captureFrame(
    capture: AuthTransitionCapture,
    message: RuntimePublication,
    measuredBytes = this.assertFrameFits(message, "subscription frame", "subscription"),
  ): void {
    const maxItems = Math.min(Number.MAX_SAFE_INTEGER, this.limits.maxSubscriptionsPerConnection * 2);
    const maxBytes = this.limits.webSocket.maxBytesPerConnection - this.limits.maxFrameBytes;
    if (capture.frames.length >= maxItems || measuredBytes > maxBytes - capture.bytes) {
      throw new DbzzError("overloaded", "authentication transition exceeds capture capacity", {
        retryable: true,
        retryAfterMs: 0,
        resource: "subscription",
      });
    }
    capture.frames.push(message);
    capture.bytes += measuredBytes;
  }

  private async attachSubscription(
    state: RuntimeSession,
    id: number,
    definition: RuntimeSubscription,
    remember: boolean,
  ): Promise<void> {
    let remembered = definition;
    if (definition.address.startsWith("events.")) {
      const table = definition.address.slice("events.".length);
      const tableDefinition = this.engine.schema.tables[table];
      if (tableDefinition?.kind !== "event") {
        throw new DbzzError("not_found", `unknown event table "${table}"`);
      }
      const subscription = tableDefinition.eventSubscription!;
      const authorized = await authorizeInvocation(
        subscription,
        { auth: state.context.principal },
        definition.args,
      );
      await this.reactive.subscribeEvent({
        subscriber: state.subscriber,
        id,
        table,
        authEpoch: state.context.authEpoch,
        args: authorized.args,
        matches: subscription.matches as (row: unknown, args: unknown) => boolean,
      });
      remembered = Object.freeze({ ...definition, args: authorized.args });
    } else {
      this.expect(definition.address, "query");
      await this.reactive.subscribeQuery({
        subscriber: state.subscriber,
        id,
        address: definition.address,
        args: definition.args,
        policyScopeFingerprint: digest(state.context.principal),
        context: {
          principal: state.context.principal,
          fairnessKey: state.context.clientSessionId,
        },
        authEpoch: state.context.authEpoch,
        ...(!remember || definition.cursor === undefined ? {} : { cursor: definition.cursor }),
      });
    }
    if (remember) state.subscriptions.set(id, remembered);
  }

  private executeQuery(
    address: string,
    args: unknown,
    principal: Principal,
    fairnessKey: string,
    signal: AbortSignal | undefined,
    requestBytes: number,
  ): Promise<QueryEvaluation> {
    const fn = this.expect(address, "query");
    return this.submitRead(async (connection) => {
      aborted(signal);
      connection.exec("BEGIN DEFERRED");
      try {
        const readSet = new Set<string>();
        const recorder: ReadRecorder = { add: (key) => readSet.add(key) };
        const version = this.engine.commitVersion(connection);
        const db = makeDbReader(this.engine, connection, recorder);
        const value = await invokeFunction(fn, Object.freeze({ db, auth: principal }), args);
        aborted(signal);
        const encoded = encode(value);
        connection.exec("COMMIT");
        return Object.freeze({ value, encoded, readSet, commitVersion: version });
      } catch (error) {
        try {
          connection.exec("ROLLBACK");
        } catch {
          throw new DbzzError("unavailable", "reader snapshot could not be closed", {
            resource: "reader",
            cause: error,
          });
        }
        throw error;
      }
    }, {
      operation: "query",
      bytes: requestBytes,
      fairnessKey,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  private submitRead<T>(
    work: (connection: Database) => T | Promise<T>,
    options: ExecutorTaskOptions,
  ): Promise<T> {
    return this.reader.submit(async () => {
      const connection = this.availableReaders.pop() ?? this.engine.createReader();
      try {
        return await work(connection);
      } finally {
        this.availableReaders.push(connection);
      }
    }, options);
  }

  private evaluateSubscription(input: QueryEvaluationInput<ReactiveContext>): Promise<QueryEvaluation> {
    return this.executeQuery(
      input.address,
      input.args,
      input.context.principal,
      input.context.fairnessKey,
      undefined,
      byteLength(input.args),
    );
  }

  private procedureContext(
    principal: Principal,
    fairnessKey: string,
    signal: AbortSignal | undefined,
    requestBytes: number,
  ): ProcedureCtx {
    return Object.freeze({
      auth: principal,
      tx: async <T>(work: (ctx: TxCtx) => T | Promise<T>): Promise<T> => {
        aborted(signal);
        let scheduledTouched = false;
        const result = await this.coordinator.execute({
          operation: "transaction",
          fairnessKey,
          requestBytes,
          ...(signal === undefined ? {} : { signal }),
          work: (db) => work(Object.freeze({ db, auth: principal })),
          publication: (_version, writes) => {
            scheduledTouched = writes.scheduledTouched;
            return this.publicationFor(writes);
          },
        });
        if (scheduledTouched) this.armScheduler();
        return result.value;
      },
    });
  }

  private publicationFor(writes: WriteCollector, caller?: Subscriber): ReactiveCommit {
    return new ReactiveCommit(
      writes.keys,
      writes.events,
      caller,
    );
  }

  private async finishMutation(
    state: RuntimeSession,
    message: MutationMessage,
    result: CommitResult<unknown, ReactiveCommit>,
  ): Promise<RuntimeMutationResult> {
    let obligations: readonly number[];
    if (result.replay === "replayed") {
      const convergence = await this.reactive.converge(state.subscriber, result.commitVersion);
      obligations = convergence.affectedCallerIds;
      this.assertConvergence(state.subscriber, obligations, convergence.deliveryFailures);
    } else {
      const convergence = result.publication?.result;
      if (convergence === undefined) {
        throw convergenceError("commit publication did not produce convergence state");
      }
      obligations = convergence.affectedCallerIds;
      this.assertConvergence(state.subscriber, obligations, convergence.deliveryFailures);
    }
    const frame = this.mutationFrame(
      message,
      result.value,
      result.commitVersion,
      result.durability,
      result.replay,
      obligations,
    );
    try {
      this.assertFrameFits(frame, "mutation result");
    } catch (error) {
      throw convergenceError(
        `mutation ${message.mutationRequestId} committed but its receipt cannot fit one frame`,
      );
    }
    return Object.freeze({ value: result.value, receipt: frame.receipt });
  }

  private mutationFrame(
    message: MutationMessage,
    value: unknown,
    commitVersion: bigint,
    durability: CommitResult<unknown, ReactiveCommit>["durability"],
    replay: "executed" | "replayed",
    obligations: readonly number[],
  ): MutationOkMessage {
    return {
      v: PROTOCOL_VERSION,
      t: "ok",
      id: message.id,
      kind: "mutation",
      value,
      receipt: {
        mutationRequestId: message.mutationRequestId,
        commitVersion,
        durability,
        replay,
        obligations: Object.freeze([...obligations]),
      },
    };
  }

  private assertConvergence(
    caller: Subscriber,
    obligations: readonly number[],
    failures: readonly { subscriber: Subscriber; subscriptionId: number; error: unknown }[],
  ): void {
    const required = new Set(obligations);
    const failure = failures.find(
      (candidate) => candidate.subscriber === caller && required.has(candidate.subscriptionId),
    );
    if (failure !== undefined) {
      throw new DbzzError("convergence_unavailable", "mutation committed but subscription convergence failed", {
        committed: true,
        cause: failure.error,
      });
    }
  }

  private assertFrameFits(
    frame: unknown,
    label: string,
    resource: "operation" | "subscription" = "operation",
  ): number {
    let bytes: number;
    try {
      bytes = byteLength(frame);
    } catch (error) {
      throw new DbzzError("validation", `${label} is not wire-representable`, { cause: error });
    }
    if (bytes > this.limits.maxFrameBytes) {
      throw new DbzzError("overloaded", `${label} exceeds maxFrameBytes`, { resource });
    }
    return bytes;
  }

  private nextScheduledAt(): Promise<number | null> {
    return this.submitRead((connection) => {
      let earliest: number | null = null;
      for (const table of this.scheduled.keys()) {
        const plan = this.engine.plan(table);
        const row = connection
          .query(`SELECT MIN(${quoted(plan.scheduleAt!)}) AS at FROM ${quoted(table)}`)
          .get() as { at: number | bigint | null };
        if (row.at === null) continue;
        const value = Number(row.at);
        if (earliest === null || value < earliest) earliest = value;
      }
      return earliest;
    }, {
      operation: "scheduled",
      bytes: 1,
      fairnessKey: "system:scheduler",
    });
  }

  private nextScheduledCandidate(now: number): Promise<ScheduledCandidate | null> {
    return this.submitRead((connection) => {
      let candidate: (ScheduledCandidate & { readonly at: number }) | null = null;
      for (const [table, address] of this.scheduled) {
        const plan = this.engine.plan(table);
        const raw = connection
          .query(
            `SELECT ${quoted(plan.pk)} AS primaryKey, ${quoted(plan.scheduleAt!)} AS at FROM ${quoted(table)} WHERE ${quoted(plan.scheduleAt!)} <= ? ORDER BY ${quoted(plan.scheduleAt!)}, ${quoted(plan.pk)} LIMIT 1`,
          )
          .get(now) as { primaryKey: unknown; at: number | bigint } | null;
        if (raw === null) continue;
        const at = Number(raw.at);
        if (candidate === null || at < candidate.at) {
          candidate = { table, address, primaryKey: raw.primaryKey, at };
        }
      }
      return candidate === null
        ? null
        : { table: candidate.table, address: candidate.address, primaryKey: candidate.primaryKey };
    }, {
      operation: "scheduled",
      bytes: 1,
      fairnessKey: "system:scheduler",
    });
  }

  private runOperation<T>(
    session: RuntimeSession | null,
    operation: TelemetryOperation,
    functionName: string | undefined,
    sizeBytes: number,
    work: () => T | Promise<T>,
  ): Promise<T> {
    const release = this.admitOperation(session);
    const startedAt = performance.now();
    const context = telemetryContext(
      session === null ? undefined : digest(session.context.clientSessionId),
    );
    return Promise.resolve()
      .then(work)
      .then(
        (value) => {
          this.recordSpan(operation, functionName, sizeBytes, startedAt, context);
          return value;
        },
        (error) => {
          const safeError = transportError(error);
          this.recordSpan(operation, functionName, sizeBytes, startedAt, context, safeError);
          throw safeError;
        },
      )
      .finally(release);
  }

  private admitOperation(session: RuntimeSession | null): () => void {
    this.assertReady();
    if (this.activeOperations >= this.limits.maxOperations) {
      throw new DbzzError("overloaded", "operation capacity is full", {
        retryable: true,
        retryAfterMs: 0,
        resource: "operation",
      });
    }
    if (session !== null && session.activeOperations >= this.limits.maxOperationsPerConnection) {
      throw new DbzzError("overloaded", "per-connection operation capacity is full", {
        retryable: true,
        retryAfterMs: 0,
        resource: "operation",
      });
    }
    this.activeOperations++;
    if (session !== null) session.activeOperations++;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.activeOperations--;
      if (session !== null) session.activeOperations--;
      if (this.activeOperations === 0) {
        for (const resolve of this.activeWaiters) resolve();
        this.activeWaiters.clear();
      }
    };
  }

  private waitForActiveOperations(): Promise<void> {
    if (this.activeOperations === 0) return Promise.resolve();
    return new Promise((resolve) => this.activeWaiters.add(resolve));
  }

  private assertReady(): void {
    if (this.lifecycle === "ready") return;
    throw new DbzzError("draining", "runtime is not accepting operations", { resource: "operation" });
  }

  private recordSpan(
    operation: TelemetryOperation,
    functionName: string | undefined,
    sizeBytes: number,
    startedAt: number,
    context: TelemetryTraceContext,
    error?: unknown,
  ): void {
    const outcome = error === undefined ? "ok" : outcomeFromError(error).code;
    this.telemetry.recordSpan({
      operation,
      stage: "handler",
      outcome,
      ...(functionName === undefined ? {} : { functionName }),
      context,
      durationMs: Math.max(0, performance.now() - startedAt),
      sizeBytes,
    });
  }

  private startSampler(): void {
    if (!this.telemetry.enabled) return;
    const interval = this.limits.telemetry.sampleIntervalMs;
    this.expectedSampleAt = performance.now() + interval;
    this.sampleTimer = setInterval(() => this.sample(), interval);
    this.sampleTimer.unref?.();
  }

  private stopSampler(): void {
    if (this.sampleTimer === null) return;
    clearInterval(this.sampleTimer);
    this.sampleTimer = null;
  }

  private sample(): void {
    if (this.lifecycle !== "ready") return;
    const now = performance.now();
    const elapsedMs = Math.max(1, now - this.lastCpuAt);
    const cpu = process.cpuUsage(this.lastCpu);
    const cores = (cpu.user + cpu.system) / (elapsedMs * 1_000);
    this.lastCpu = process.cpuUsage();
    this.lastCpuAt = now;
    const eventLoopDrift = Math.max(0, now - this.expectedSampleAt);
    this.expectedSampleAt = now + this.limits.telemetry.sampleIntervalMs;
    const storage = this.engine.status();
    const reactive = this.reactive.snapshot();
    const reader = this.reader.snapshot();
    const writer = this.coordinator.snapshot();
    const metrics: ReadonlyArray<readonly [string, number, "count" | "bytes" | "milliseconds" | "gauge"]> = [
      ["runtime.connections", this.sessions.size, "gauge"],
      ["runtime.operations", this.activeOperations, "gauge"],
      ["runtime.subscriptions", reactive.queryListeners + reactive.eventListeners, "gauge"],
      ["runtime.read_queue_items", reader.queue.queuedItems, "gauge"],
      ["runtime.read_queue_bytes", reader.queue.queuedBytes, "bytes"],
      ["runtime.write_queue_items", writer.queue.queuedItems, "gauge"],
      ["runtime.write_queue_bytes", writer.queue.queuedBytes, "bytes"],
      ["runtime.revalidation_active", reactive.revalidation.active, "gauge"],
      ["runtime.revalidation_queue_items", reactive.revalidation.queue.queuedItems, "gauge"],
      ["runtime.revalidation_queue_bytes", reactive.revalidation.queue.queuedBytes, "bytes"],
      ["runtime.revalidation_queue_age", reactive.revalidation.queue.oldestAgeMs, "milliseconds"],
      ["runtime.database_bytes", storage.databaseBytes, "bytes"],
      ["runtime.wal_bytes", storage.walBytes, "bytes"],
      ["runtime.rss_bytes", process.memoryUsage().rss, "bytes"],
      ["runtime.cpu_cores", cores, "gauge"],
      ["runtime.event_loop_drift", eventLoopDrift, "milliseconds"],
    ];
    for (const [name, value, unit] of metrics) this.telemetry.recordMetric({ name, value, unit });
  }

  private readNow(): number {
    const now = this.now();
    if (!Number.isFinite(now)) throw new RangeError("runtime clock must return finite milliseconds");
    return now;
  }
}
