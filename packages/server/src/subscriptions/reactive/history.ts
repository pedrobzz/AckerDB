import type { ApplicationError } from "@ackerdb/core";
import type { ServiceLimits } from "../../runtime/limits.ts";
import type { QueryEntry } from "./entry.ts";

export interface HistoryRecord<C> {
  readonly entry: QueryEntry<C>;
  readonly fromVersion: bigint;
  readonly toVersion: bigint;
  readonly kind: "update" | "checkpoint";
  readonly value?: unknown;
  readonly applicationError?: ApplicationError;
  readonly bytes: number;
  readonly createdAtMs: number;
  previousGlobal?: HistoryRecord<C>;
  nextGlobal?: HistoryRecord<C>;
  active: boolean;
}

/**
 * The resume window: one age-ordered global ring of retained transitions plus
 * the per-entry slice each subscription resumes through. Owns both the global
 * and per-stream byte/transition budgets, so a retained record can never
 * outlive `resume.maxAgeMs` or push the ring past `resume.maxBytes`.
 */
export class TransitionHistory<C> {
  private head?: HistoryRecord<C>;
  private tail?: HistoryRecord<C>;
  private retainedBytes = 0;
  private retainedTransitions = 0;

  constructor(private readonly limits: ServiceLimits["resume"]) {}

  get bytes(): number {
    return this.retainedBytes;
  }

  get transitions(): number {
    return this.retainedTransitions;
  }

  /** Retains one transition, evicting to fit. False means the resume window broke. */
  retain(entry: QueryEntry<C>, record: HistoryRecord<C>): boolean {
    const now = record.createdAtMs;
    this.prune(now);
    if (record.bytes > this.limits.maxBytesPerStream || record.bytes > this.limits.maxBytes) {
      this.clear(entry);
      return false;
    }
    while (
      entry.history.length >= this.limits.maxTransitionsPerStream ||
      record.bytes > this.limits.maxBytesPerStream - entry.historyBytes
    ) {
      this.remove(entry.history[0]!);
    }
    while (record.bytes > this.limits.maxBytes - this.retainedBytes && this.head) {
      this.remove(this.head);
    }
    if (record.bytes > this.limits.maxBytes - this.retainedBytes) {
      this.clear(entry);
      return false;
    }
    entry.history.push(record);
    entry.historyBytes += record.bytes;
    this.retainedBytes += record.bytes;
    this.retainedTransitions++;
    if (this.tail) {
      this.tail.nextGlobal = record;
      record.previousGlobal = this.tail;
    } else {
      this.head = record;
    }
    this.tail = record;
    return true;
  }

  prune(now: number): void {
    while (this.head && now - this.head.createdAtMs >= this.limits.maxAgeMs) {
      this.remove(this.head);
    }
  }

  clear(entry: QueryEntry<C>): void {
    for (const record of [...entry.history]) this.remove(record);
  }

  /** The contiguous retained run from `fromVersion` to `toVersion`, or undefined. */
  chain(
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

  private remove(record: HistoryRecord<C>): void {
    if (!record.active) return;
    record.active = false;
    const index = record.entry.history.indexOf(record);
    if (index >= 0) record.entry.history.splice(index, 1);
    record.entry.historyBytes -= record.bytes;
    this.retainedBytes -= record.bytes;
    this.retainedTransitions--;
    if (record.previousGlobal) record.previousGlobal.nextGlobal = record.nextGlobal;
    else this.head = record.nextGlobal;
    if (record.nextGlobal) record.nextGlobal.previousGlobal = record.previousGlobal;
    else this.tail = record.previousGlobal;
    record.previousGlobal = undefined;
    record.nextGlobal = undefined;
  }
}
