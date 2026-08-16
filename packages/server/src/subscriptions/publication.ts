import { AckerDBError } from "../shared/errors.ts";
import { validateCapacityLimits, type CapacityLimits } from "../runtime/limits.ts";

export interface Publication<T> {
  readonly version: bigint;
  readonly value: T;
  readonly reservedBytes: number;
  readonly reservedAtMs: number;
}

export interface PublicationReservation<T> {
  /** The version the transaction must persist before COMMIT. */
  readonly version: bigint;
  readonly reservedBytes: number;
  readonly completion: Promise<void>;
  /** Replaces the provisional byte reservation while the slot is still open. */
  resize(reservedBytes: number): void;
  /** Called synchronously after a successful COMMIT. Cannot reject for capacity. */
  commit(value: T): void;
  /** Releases a reservation when its transaction rolls back or never begins. */
  cancel(): void;
}

export interface PublicationSnapshot {
  readonly items: number;
  readonly bytes: number;
  readonly oldestAgeMs: number;
  readonly highWater: bigint;
  readonly processedHighWater: bigint;
  readonly processed: number;
  readonly failures: number;
  readonly lastFailureVersion?: bigint;
  readonly closed: boolean;
}

export interface OrderedPublicationOptions<T> {
  readonly limits: CapacityLimits;
  readonly process: (publication: Publication<T>) => void | Promise<void> | PublicationHandoff;
  readonly initialVersion?: bigint;
  readonly now?: () => number;
}

/** Ordered scheduling is complete; this promise owns only that slot's convergence. */
export class PublicationHandoff {
  constructor(readonly completion: Promise<void>) {}
}

type SlotState = "reserved" | "committed" | "processing" | "settled" | "canceled";
const commitSlot = Symbol("commitPublicationSlot");
const cancelSlot = Symbol("cancelPublicationSlot");
const resizeSlot = Symbol("resizePublicationSlot");

interface MutablePublication<T> {
  readonly version: bigint;
  value?: T;
  reservedBytes: number;
  readonly reservedAtMs: number;
}

class Slot<T> implements PublicationReservation<T> {
  readonly publication: MutablePublication<T>;
  private readonly settlement = Promise.withResolvers<void>();
  readonly completion = this.settlement.promise;
  readonly resolve = this.settlement.resolve;
  readonly reject = this.settlement.reject;
  state: SlotState = "reserved";
  previous?: Slot<T>;
  next?: Slot<T>;

  constructor(
    readonly owner: OrderedPublication<T>,
    readonly version: bigint,
    public reservedBytes: number,
    reservedAtMs: number,
  ) {
    this.publication = { version, reservedBytes, reservedAtMs };
  }

  commit(value: T): void {
    this.owner[commitSlot](this, value);
  }

  resize(reservedBytes: number): void {
    this.owner[resizeSlot](this, reservedBytes);
  }

  cancel(): void {
    this.owner[cancelSlot](this);
  }
}

/**
 * Owns the only fallible capacity boundary between a writer transaction and
 * ordered post-commit work. One writer reservation may be open at a time;
 * committed slots may backlog up to the configured item/byte limits.
 */
export class OrderedPublication<T> {
  readonly limits: CapacityLimits;

  private readonly processPublication: OrderedPublicationOptions<T>["process"];
  private readonly now: () => number;
  private head?: Slot<T>;
  private tail?: Slot<T>;
  private openReservation?: Slot<T>;
  private items = 0;
  private bytes = 0;
  private committedHighWater: bigint;
  private settledHighWater: bigint;
  private processed = 0;
  private failures = 0;
  private lastFailureVersion?: bigint;
  private starting = false;
  private startedHighWater: bigint;
  private readonly unsettledVersions = new Set<bigint>();
  private closed = false;
  private closing?: PromiseWithResolvers<void>;

  constructor(options: OrderedPublicationOptions<T>) {
    this.limits = validateCapacityLimits(options.limits, "publication");
    const initialVersion = options.initialVersion ?? 0n;
    if (typeof initialVersion !== "bigint" || initialVersion < 0n) {
      throw new RangeError("initialVersion must be a non-negative bigint");
    }
    this.committedHighWater = initialVersion;
    this.settledHighWater = initialVersion;
    this.startedHighWater = initialVersion;
    this.processPublication = options.process;
    this.now = options.now ?? Date.now;
  }

  reserve(reservedBytes: number): PublicationReservation<T> {
    if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 0) {
      throw new RangeError("reservedBytes must be a non-negative safe integer");
    }
    if (this.closed) throw unavailable("draining", "Publication coordinator is closed");
    if (this.items >= this.limits.maxItems || reservedBytes > this.limits.maxBytes - this.bytes) {
      throw unavailable("overloaded", "Publication capacity is full", true);
    }
    if (this.openReservation) {
      throw unavailable("unavailable", "A writer publication reservation is already open");
    }

    const slot = new Slot(this, this.committedHighWater + 1n, reservedBytes, this.readNow());
    this.openReservation = slot;
    this.items++;
    this.bytes += reservedBytes;
    if (this.tail) {
      this.tail.next = slot;
      slot.previous = this.tail;
    } else {
      this.head = slot;
    }
    this.tail = slot;
    return slot;
  }

  /**
   * Runs install in the same JavaScript turn only when evaluationVersion is
   * still the committed high-water. Async query evaluation stays outside.
   */
  compareAndInstall(evaluationVersion: bigint, install: () => unknown): boolean {
    if (typeof evaluationVersion !== "bigint" || evaluationVersion < 0n) {
      throw new RangeError("evaluationVersion must be a non-negative bigint");
    }
    if (this.closed) throw unavailable("draining", "Publication coordinator is closed");
    if (evaluationVersion !== this.committedHighWater) return false;
    const installed = install();
    if (
      installed !== null &&
      (typeof installed === "object" || typeof installed === "function") &&
      typeof (installed as PromiseLike<unknown>).then === "function"
    ) {
      throw new TypeError("compareAndInstall callback must be synchronous");
    }
    return true;
  }

  snapshot(): PublicationSnapshot {
    const now = this.readNow();
    return Object.freeze({
      items: this.items,
      bytes: this.bytes,
      oldestAgeMs: this.head ? Math.max(0, now - this.head.publication.reservedAtMs) : 0,
      highWater: this.committedHighWater,
      processedHighWater: this.settledHighWater,
      processed: this.processed,
      failures: this.failures,
      ...(this.lastFailureVersion === undefined ? {} : { lastFailureVersion: this.lastFailureVersion }),
      closed: this.closed,
    });
  }

  /** Rejects future reservations and resolves after every existing slot settles. */
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.closing = Promise.withResolvers<void>();
      this.resolveCloseIfDrained();
    }
    return this.closing.promise;
  }

  [commitSlot](slot: Slot<T>, value: T): void {
    this.assertOpenSlot(slot);
    slot.publication.value = value;
    slot.state = "committed";
    this.openReservation = undefined;
    this.committedHighWater = slot.version;
    this.pump();
  }

  [resizeSlot](slot: Slot<T>, reservedBytes: number): void {
    this.assertOpenSlot(slot);
    if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 0) {
      throw new RangeError("reservedBytes must be a non-negative safe integer");
    }
    const available = this.limits.maxBytes - this.bytes + slot.reservedBytes;
    if (reservedBytes > available) {
      throw unavailable("overloaded", "Publication capacity is full", true);
    }
    this.bytes += reservedBytes - slot.reservedBytes;
    slot.reservedBytes = reservedBytes;
    slot.publication.reservedBytes = reservedBytes;
  }

  [cancelSlot](slot: Slot<T>): void {
    this.assertOpenSlot(slot);
    slot.state = "canceled";
    this.openReservation = undefined;
    this.detach(slot);
    slot.resolve();
    this.resolveCloseIfDrained();
  }

  private assertOpenSlot(slot: Slot<T>): void {
    if (slot.owner !== this || slot !== this.openReservation || slot.state !== "reserved") {
      throw new Error("Publication reservation is no longer open");
    }
  }

  private pump(): void {
    if (this.starting) return;
    let slot = this.head;
    while (slot && slot.state !== "committed") slot = slot.next;
    if (!slot) return;
    slot.state = "processing";
    this.starting = true;
    queueMicrotask(() => {
      this.startedHighWater = slot.version;
      this.unsettledVersions.add(slot.version);
      let processing: void | Promise<void> | PublicationHandoff;
      try {
        processing = this.processPublication(slot.publication as Publication<T>);
      } catch (error) {
        this.starting = false;
        this.settle(slot, error);
        return;
      }
      if (processing instanceof PublicationHandoff) {
        this.starting = false;
        processing.completion.then(
          () => this.settle(slot),
          (error) => this.settle(slot, error),
        );
        this.pump();
        return;
      }
      Promise.resolve(processing).then(
        () => {
          this.starting = false;
          this.settle(slot);
        },
        (error) => {
          this.starting = false;
          this.settle(slot, error);
        },
      );
    });
  }

  private settle(slot: Slot<T>, error?: unknown): void {
    slot.state = "settled";
    this.processed++;
    this.unsettledVersions.delete(slot.version);
    while (
      this.settledHighWater < this.startedHighWater &&
      !this.unsettledVersions.has(this.settledHighWater + 1n)
    ) {
      this.settledHighWater++;
    }
    this.detach(slot);
    if (error === undefined) {
      slot.resolve();
    } else {
      this.failures++;
      if (this.lastFailureVersion === undefined || slot.version > this.lastFailureVersion) {
        this.lastFailureVersion = slot.version;
      }
      slot.reject(error);
    }
    this.pump();
    this.resolveCloseIfDrained();
  }

  private detach(slot: Slot<T>): void {
    if (slot.previous) slot.previous.next = slot.next;
    else this.head = slot.next;
    if (slot.next) slot.next.previous = slot.previous;
    else this.tail = slot.previous;
    slot.previous = undefined;
    slot.next = undefined;
    this.items--;
    this.bytes -= slot.reservedBytes;
  }

  private resolveCloseIfDrained(): void {
    if (!this.closed || this.items !== 0) return;
    this.closing?.resolve();
  }

  private readNow(): number {
    const now = this.now();
    if (!Number.isFinite(now)) throw new RangeError("now must return a finite number");
    return now;
  }
}

function unavailable(
  code: "overloaded" | "draining" | "unavailable",
  message: string,
  retryable = false,
): AckerDBError {
  return new AckerDBError(code, message, {
    retryable,
    ...(retryable ? { retryAfterMs: 0 } : {}),
    resource: "publication",
  });
}
