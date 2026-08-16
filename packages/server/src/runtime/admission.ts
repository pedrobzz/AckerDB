import { validateQueueLimits, type QueueLimits } from "./limits.ts";
import { AckerDBError, DRAIN_RETRY_AFTER_MS } from "../shared/errors.ts";
import { finiteClock, finiteMillis } from "../shared/clock.ts";

export type AdmissionResource =
  | "reader"
  | "writer"
  | "subscription"
  | "revalidation"
  | "publication";

export type AdmissionDiscipline = "fifo" | "round-robin";
export type AdmissionRejectionReason =
  | "items"
  | "bytes"
  | "age"
  | "deadline"
  | "canceled"
  | "closed";

export interface AdmissionQueueOptions {
  readonly discipline: AdmissionDiscipline;
  readonly limits: QueueLimits;
  readonly resource: AdmissionResource;
  readonly retryAfterMs?: number;
  readonly now?: () => number;
}

export interface AdmissionRequestOptions {
  readonly bytes: number;
  readonly fairnessKey?: string;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
}

export interface AdmissionLease<T> {
  readonly value: T;
  readonly fairnessKey?: string;
  readonly bytes: number;
  readonly enqueuedAtMs: number;
  readonly admittedAtMs: number;
  readonly queueAgeMs: number;
  readonly turn: number;
}

export interface AdmissionRejectionTotals {
  readonly items: number;
  readonly bytes: number;
  readonly age: number;
  readonly deadline: number;
  readonly canceled: number;
  readonly closed: number;
}

export interface AdmissionQueueSnapshot {
  readonly discipline: AdmissionDiscipline;
  readonly resource: AdmissionResource;
  readonly queuedItems: number;
  readonly queuedBytes: number;
  readonly oldestAgeMs: number;
  readonly nextExpiryAtMs?: number;
  readonly activeFairnessKeys: number;
  readonly turns: number;
  readonly admitted: number;
  readonly rejected: AdmissionRejectionTotals;
  readonly closed: boolean;
}

type AdmissionOutcomeCode = "overloaded" | "deadline_exceeded" | "draining" | "unavailable";

export class AdmissionRejected extends AckerDBError {
  declare readonly code: AdmissionOutcomeCode;
  declare readonly resource: AdmissionResource;

  constructor(
    readonly reason: AdmissionRejectionReason,
    resource: AdmissionResource,
    retryAfterMs: number,
  ) {
    const capacity = reason === "items" || reason === "bytes";
    const draining = reason === "closed";
    const code: AdmissionOutcomeCode = capacity
      ? "overloaded"
      : reason === "age" || reason === "deadline"
        ? "deadline_exceeded"
        : draining
          ? "draining"
          : "unavailable";
    // A drain-time refusal is always retryable and always bounded: the caller
    // is told when this process expects to be back.
    super(code, `Admission rejected: ${reason}`, {
      retryable: capacity || draining,
      resource,
      ...(capacity ? { retryAfterMs } : {}),
      ...(draining ? { retryAfterMs: DRAIN_RETRY_AFTER_MS } : {}),
    });
    this.name = "AdmissionRejected";
  }
}

interface FairnessGroup<T> {
  head?: PendingAdmission<T>;
  tail?: PendingAdmission<T>;
}

interface PendingAdmission<T> {
  readonly sequence: number;
  readonly value: T;
  readonly fairnessKey?: string;
  readonly bytes: number;
  readonly enqueuedAtMs: number;
  readonly expiresAtMs: number;
  readonly expiresBy: "age" | "deadline";
  readonly resolve: (lease: AdmissionLease<T>) => void;
  readonly reject: (error: AdmissionRejected) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  active: boolean;
  previous?: PendingAdmission<T>;
  next?: PendingAdmission<T>;
  group?: FairnessGroup<T>;
  previousInGroup?: PendingAdmission<T>;
  nextInGroup?: PendingAdmission<T>;
}

function earlier<T>(left: PendingAdmission<T>, right: PendingAdmission<T>): boolean {
  return left.expiresAtMs < right.expiresAtMs ||
    (left.expiresAtMs === right.expiresAtMs && left.sequence < right.sequence);
}

export class AdmissionQueue<T> {
  readonly discipline: AdmissionDiscipline;
  readonly limits: QueueLimits;
  readonly resource: AdmissionResource;

  private readonly now: () => number;
  private readonly retryAfterMs: number;
  private readonly groups = new Map<string, FairnessGroup<T>>();
  private readonly expiryHeap: PendingAdmission<T>[] = [];
  private readonly rejectionTotals: Record<AdmissionRejectionReason, number> = {
    items: 0,
    bytes: 0,
    age: 0,
    deadline: 0,
    canceled: 0,
    closed: 0,
  };
  private head?: PendingAdmission<T>;
  private tail?: PendingAdmission<T>;
  private queuedItems = 0;
  private queuedBytes = 0;
  private sequence = 0;
  private turns = 0;
  private admitted = 0;
  private isClosed = false;

  constructor(options: AdmissionQueueOptions) {
    if (options.discipline !== "fifo" && options.discipline !== "round-robin") {
      throw new TypeError("discipline must be fifo or round-robin");
    }
    const retryAfterMs = options.retryAfterMs ?? 0;
    if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0 || retryAfterMs > 30_000) {
      throw new RangeError("retryAfterMs must be an integer from 0 through 30000");
    }
    this.discipline = options.discipline;
    this.limits = validateQueueLimits(options.limits);
    this.resource = options.resource;
    this.retryAfterMs = retryAfterMs;
    this.now = finiteClock(options.now ?? Date.now, "admission clock");
  }

  enqueue(value: T, options: AdmissionRequestOptions): Promise<AdmissionLease<T>> {
    if (!Number.isSafeInteger(options.bytes) || options.bytes < 0) {
      throw new RangeError("bytes must be a non-negative safe integer");
    }
    if (
      this.discipline === "round-robin" &&
      (typeof options.fairnessKey !== "string" || options.fairnessKey.length === 0)
    ) {
      throw new TypeError("round-robin admission requires a non-empty fairnessKey");
    }
    if (options.deadlineMs !== undefined) finiteMillis(options.deadlineMs, "deadlineMs");

    const now = this.now();
    if (this.isClosed) return this.rejectImmediately("closed");
    if (options.signal?.aborted) return this.rejectImmediately("canceled");
    if (options.deadlineMs !== undefined && options.deadlineMs <= now) {
      return this.rejectImmediately("deadline");
    }
    if (this.queuedItems >= this.limits.maxItems) return this.rejectImmediately("items");
    if (options.bytes > this.limits.maxBytes - this.queuedBytes) {
      return this.rejectImmediately("bytes");
    }

    const ageExpiry = now + this.limits.maxAgeMs;
    const expiresBy = options.deadlineMs !== undefined && options.deadlineMs <= ageExpiry
      ? "deadline"
      : "age";
    const expiresAtMs = expiresBy === "deadline" ? options.deadlineMs! : ageExpiry;
    const { promise: ticket, resolve, reject } = Promise.withResolvers<AdmissionLease<T>>();
    const entry: PendingAdmission<T> = {
      sequence: ++this.sequence,
      value,
      fairnessKey: options.fairnessKey,
      bytes: options.bytes,
      enqueuedAtMs: now,
      expiresAtMs,
      expiresBy,
      resolve,
      reject,
      active: true,
    };

    this.append(entry);
    this.pushExpiry(entry);
    if (options.signal) {
      entry.signal = options.signal;
      entry.onAbort = () => this.rejectEntry(entry, "canceled");
      options.signal.addEventListener("abort", entry.onAbort, { once: true });
      if (options.signal.aborted) this.rejectEntry(entry, "canceled");
    }
    return ticket;
  }

  take(): AdmissionLease<T> | undefined {
    const now = this.now();
    this.expire(now);
    let entry: PendingAdmission<T> | undefined;
    let servedGroup: FairnessGroup<T> | undefined;

    if (this.discipline === "fifo") {
      entry = this.head;
    } else {
      const first = this.groups.entries().next().value as
        | [string, FairnessGroup<T>]
        | undefined;
      if (first) {
        servedGroup = first[1];
        entry = servedGroup.head;
      }
    }
    if (!entry) return undefined;

    const fairnessKey = entry.fairnessKey;
    this.detach(entry);
    if (servedGroup?.head && fairnessKey !== undefined) {
      this.groups.delete(fairnessKey);
      this.groups.set(fairnessKey, servedGroup);
    }

    const lease = Object.freeze({
      value: entry.value,
      fairnessKey,
      bytes: entry.bytes,
      enqueuedAtMs: entry.enqueuedAtMs,
      admittedAtMs: now,
      queueAgeMs: Math.max(0, now - entry.enqueuedAtMs),
      turn: ++this.turns,
    });
    this.admitted++;
    entry.resolve(lease);
    return lease;
  }

  expire(now = this.now()): number {
    finiteMillis(now, "expiry time");
    let expired = 0;
    this.discardInactiveExpiryHeads();
    while (this.expiryHeap[0] && this.expiryHeap[0].expiresAtMs <= now) {
      const entry = this.popExpiry()!;
      if (entry.active) {
        this.rejectEntry(entry, entry.expiresBy);
        expired++;
      }
      this.discardInactiveExpiryHeads();
    }
    return expired;
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    while (this.head) this.rejectEntry(this.head, "closed");
  }

  snapshot(): AdmissionQueueSnapshot {
    const now = this.now();
    this.expire(now);
    this.discardInactiveExpiryHeads();
    return Object.freeze({
      discipline: this.discipline,
      resource: this.resource,
      queuedItems: this.queuedItems,
      queuedBytes: this.queuedBytes,
      oldestAgeMs: this.head ? Math.max(0, now - this.head.enqueuedAtMs) : 0,
      nextExpiryAtMs: this.expiryHeap[0]?.expiresAtMs,
      activeFairnessKeys: this.discipline === "round-robin" ? this.groups.size : 0,
      turns: this.turns,
      admitted: this.admitted,
      rejected: Object.freeze({ ...this.rejectionTotals }),
      closed: this.isClosed,
    });
  }


  private rejectImmediately(reason: AdmissionRejectionReason): Promise<never> {
    this.rejectionTotals[reason]++;
    return Promise.reject(new AdmissionRejected(reason, this.resource, this.retryAfterMs));
  }

  private append(entry: PendingAdmission<T>): void {
    entry.previous = this.tail;
    if (this.tail) this.tail.next = entry;
    else this.head = entry;
    this.tail = entry;

    if (this.discipline === "round-robin") {
      const key = entry.fairnessKey!;
      let group = this.groups.get(key);
      if (!group) {
        group = {};
        this.groups.set(key, group);
      }
      entry.group = group;
      entry.previousInGroup = group.tail;
      if (group.tail) group.tail.nextInGroup = entry;
      else group.head = entry;
      group.tail = entry;
    }

    this.queuedItems++;
    this.queuedBytes += entry.bytes;
  }

  private detach(entry: PendingAdmission<T>): void {
    if (!entry.active) return;
    entry.active = false;
    if (entry.previous) entry.previous.next = entry.next;
    else this.head = entry.next;
    if (entry.next) entry.next.previous = entry.previous;
    else this.tail = entry.previous;

    const group = entry.group;
    if (group) {
      if (entry.previousInGroup) entry.previousInGroup.nextInGroup = entry.nextInGroup;
      else group.head = entry.nextInGroup;
      if (entry.nextInGroup) entry.nextInGroup.previousInGroup = entry.previousInGroup;
      else group.tail = entry.previousInGroup;
      if (!group.head) this.groups.delete(entry.fairnessKey!);
    }

    if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
    this.queuedItems--;
    this.queuedBytes -= entry.bytes;
  }

  private rejectEntry(entry: PendingAdmission<T>, reason: AdmissionRejectionReason): void {
    if (!entry.active) return;
    this.detach(entry);
    this.rejectionTotals[reason]++;
    entry.reject(new AdmissionRejected(reason, this.resource, this.retryAfterMs));
  }

  private pushExpiry(entry: PendingAdmission<T>): void {
    const heap = this.expiryHeap;
    let index = heap.length;
    heap.push(entry);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!earlier(heap[index]!, heap[parent]!)) break;
      [heap[index], heap[parent]] = [heap[parent]!, heap[index]!];
      index = parent;
    }
  }

  private popExpiry(): PendingAdmission<T> | undefined {
    const heap = this.expiryHeap;
    const first = heap[0];
    const last = heap.pop();
    if (!first || first === last) return first;
    heap[0] = last!;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let earliest = index;
      if (heap[left] && earlier(heap[left], heap[earliest]!)) earliest = left;
      if (heap[right] && earlier(heap[right], heap[earliest]!)) earliest = right;
      if (earliest === index) break;
      [heap[index], heap[earliest]] = [heap[earliest]!, heap[index]!];
      index = earliest;
    }
    return first;
  }

  private discardInactiveExpiryHeads(): void {
    while (this.expiryHeap[0] && !this.expiryHeap[0].active) this.popExpiry();
  }
}
