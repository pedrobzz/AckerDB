import type { Outcome } from "@ackerdb/core";
import { outcomeFromError } from "../../runtime/outcome.ts";
import type { OutboundLane } from "./budget.ts";

export type DeliveryTransport = "websocket" | "sse";
export type DeliveryStage = "encoding" | "queue" | "delivery";
export type DeliverySource = "send" | "write" | "merge" | "terminal";
export type DeliveryOutcome = "ok" | "dropped" | Outcome["code"];

export interface DeliveryObservation {
  readonly transport: DeliveryTransport;
  readonly stage: DeliveryStage;
  readonly lane: OutboundLane;
  readonly source: DeliverySource;
  readonly bytes: number;
  readonly durationMs: number;
  readonly outcome: DeliveryOutcome;
  readonly terminalOutcome?: Outcome["code"];
  /** Records omitted from this bounded observer batch before it was drained. */
  readonly droppedObservations?: number;
}

/** Metadata-only hook. Delivery never awaits it and ignores callback failures. */
export type DeliveryObserver = (observation: DeliveryObservation) => unknown;

/** Package-private terminal ownership released even when diagnostics are dropped. */
export const FINALIZE_DELIVERY_OBSERVER = Symbol("ackerdb.finalizeDeliveryObserver");

/** Captures the observer that owns one frame before any delivery work begins. */
export type DeliveryObserverCapture = (lane: OutboundLane) => DeliveryObserver | undefined;

export interface DeliveryClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DeliveryTiming {
  readonly observer: DeliveryObserver;
  readonly source: DeliverySource;
  readonly bytes: number;
  readonly queueStartedAt: number;
  readonly terminalOutcome?: Outcome["code"];
  deliveryStartedAt?: number;
}

interface PendingDeliveryObservation {
  readonly observer: DeliveryObserver;
  readonly record: DeliveryObservation;
  readonly terminal: boolean;
}

export interface DeliveryInstrumentation {
  readonly captureObserver: DeliveryObserverCapture;
  readonly clock: DeliveryClock;
  readonly transport: DeliveryTransport;
  readonly pending: PendingDeliveryObservation[];
  scheduled: boolean;
  dropped: number;
}

const MAX_PENDING_DELIVERY_OBSERVATIONS = 256;

export const SYSTEM_CLOCK: DeliveryClock = Object.freeze({
  now: Date.now,
  setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

export function safeDeliveryOutcome(error: unknown): Outcome["code"] {
  try {
    return outcomeFromError(error).code;
  } catch {
    return "internal";
  }
}

function promiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function terminalObservation(
  observation: Pick<DeliveryObservation, "stage" | "source" | "outcome">,
): boolean {
  return observation.stage === "delivery" ||
    (observation.stage === "queue" && observation.outcome !== "ok") ||
    (observation.stage === "encoding" &&
      observation.source === "send" &&
      observation.outcome !== "ok");
}

function finalizeDeliveryObserver(observer: DeliveryObserver): void {
  try {
    (observer as DeliveryObserver & {
      readonly [FINALIZE_DELIVERY_OBSERVER]?: () => void;
    })[FINALIZE_DELIVERY_OBSERVER]?.();
  } catch {
    // Instrumentation ownership is fail-open.
  }
}

function observeDelivery(
  instrumentation: DeliveryInstrumentation | undefined,
  observer: DeliveryObserver | undefined,
  observation: Omit<DeliveryObservation, "durationMs"> & {
    readonly startedAt: number;
    readonly endedAt?: number;
  },
): void {
  if (instrumentation === undefined || observer === undefined) return;
  const terminal = terminalObservation(observation);
  if (instrumentation.pending.length >= MAX_PENDING_DELIVERY_OBSERVATIONS) {
    instrumentation.dropped = Math.min(Number.MAX_SAFE_INTEGER, instrumentation.dropped + 1);
    if (terminal) finalizeDeliveryObserver(observer);
    return;
  }
  let record: DeliveryObservation;
  try {
    const { startedAt, endedAt, ...fields } = observation;
    const elapsed = (endedAt ?? instrumentation.clock.now()) - startedAt;
    if (!Number.isFinite(elapsed)) {
      if (terminal) finalizeDeliveryObserver(observer);
      return;
    }
    record = Object.freeze({
      ...fields,
      durationMs: Math.max(0, elapsed),
    });
  } catch {
    if (terminal) finalizeDeliveryObserver(observer);
    return;
  }
  instrumentation.pending.push({ observer, record, terminal });
  scheduleDeliveryObservations(instrumentation);
}

function scheduleDeliveryObservations(instrumentation: DeliveryInstrumentation): void {
  if (instrumentation.scheduled) return;
  instrumentation.scheduled = true;
  try {
    queueMicrotask(() => drainDeliveryObservations(instrumentation));
  } catch {
    instrumentation.scheduled = false;
    for (const pending of instrumentation.pending.splice(0)) {
      if (pending.terminal) finalizeDeliveryObserver(pending.observer);
    }
    instrumentation.dropped = 0;
  }
}

function drainDeliveryObservations(instrumentation: DeliveryInstrumentation): void {
  instrumentation.scheduled = false;
  const batch = instrumentation.pending.splice(0);
  const dropped = instrumentation.dropped;
  instrumentation.dropped = 0;
  for (let index = 0; index < batch.length; index++) {
    const pending = batch[index]!;
    const record = index === 0 && dropped > 0
      ? Object.freeze({ ...pending.record, droppedObservations: dropped })
      : pending.record;
    try {
      const result = pending.observer(record);
      if (promiseLike(result)) void Promise.resolve(result).catch(() => {});
    } catch {
      // Delivery instrumentation is diagnostic and always fail-open.
    } finally {
      if (pending.terminal) finalizeDeliveryObserver(pending.observer);
    }
  }
  if (instrumentation.pending.length > 0) {
    scheduleDeliveryObservations(instrumentation);
  }
}

export function captureDeliveryObserver(
  instrumentation: DeliveryInstrumentation | undefined,
  lane: OutboundLane,
): DeliveryObserver | undefined {
  if (instrumentation === undefined) return undefined;
  try {
    return instrumentation.captureObserver(lane);
  } catch {
    return undefined;
  }
}

export function observationNow(
  instrumentation: DeliveryInstrumentation | undefined,
): number | undefined {
  if (instrumentation === undefined) return undefined;
  try {
    const now = instrumentation.clock.now();
    return Number.isFinite(now) ? now : undefined;
  } catch {
    return undefined;
  }
}

export function deliveryTiming(
  instrumentation: DeliveryInstrumentation | undefined,
  observer: DeliveryObserver | undefined,
  source: DeliverySource,
  bytes: number,
  terminalOutcome?: Outcome["code"],
): DeliveryTiming | undefined {
  if (observer === undefined) return undefined;
  const queueStartedAt = observationNow(instrumentation);
  if (queueStartedAt === undefined) {
    finalizeDeliveryObserver(observer);
    return undefined;
  }
  return {
    observer,
    source,
    bytes,
    queueStartedAt,
    ...(terminalOutcome === undefined ? {} : { terminalOutcome }),
  };
}

export function observeTiming(
  instrumentation: DeliveryInstrumentation | undefined,
  lane: OutboundLane,
  timing: DeliveryTiming | undefined,
  stage: "queue" | "delivery",
  outcome: DeliveryOutcome,
): void {
  if (instrumentation === undefined || timing === undefined) return;
  const startedAt = stage === "queue" ? timing.queueStartedAt : timing.deliveryStartedAt;
  if (startedAt === undefined) {
    if (stage === "delivery" || outcome !== "ok") finalizeDeliveryObserver(timing.observer);
    return;
  }
  observeDelivery(instrumentation, timing.observer, {
    transport: instrumentation.transport,
    stage,
    lane,
    source: timing.source,
    bytes: timing.bytes,
    outcome,
    ...(timing.terminalOutcome === undefined ? {} : { terminalOutcome: timing.terminalOutcome }),
    startedAt,
  });
}

export function observeEncoding(
  instrumentation: DeliveryInstrumentation | undefined,
  observer: DeliveryObserver | undefined,
  lane: OutboundLane,
  source: DeliverySource,
  startedAt: number | undefined,
  bytes: number,
  outcome: DeliveryOutcome,
  terminalOutcome?: Outcome["code"],
  endedAt?: number,
): void {
  if (instrumentation === undefined || startedAt === undefined) {
    if (source === "send" && outcome !== "ok" && observer !== undefined) {
      finalizeDeliveryObserver(observer);
    }
    return;
  }
  observeDelivery(instrumentation, observer, {
    transport: instrumentation.transport,
    stage: "encoding",
    lane,
    source,
    bytes,
    outcome,
    ...(terminalOutcome === undefined ? {} : { terminalOutcome }),
    startedAt,
    ...(endedAt === undefined ? {} : { endedAt }),
  });
}

export function deliveryInstrumentation(
  observer: DeliveryObserver | undefined,
  clock: DeliveryClock,
  transport: DeliveryTransport,
  captureObserver?: DeliveryObserverCapture,
): DeliveryInstrumentation | undefined {
  const capture = captureObserver ?? (observer === undefined ? undefined : () => observer);
  return capture === undefined
    ? undefined
    : { captureObserver: capture, clock, transport, pending: [], scheduled: false, dropped: 0 };
}
