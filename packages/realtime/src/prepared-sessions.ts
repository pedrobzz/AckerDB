import TTLCache from "@isaacs/ttlcache";
import {
  decode,
  type PortableRTCConfiguration,
} from "@ackerdb/core";
import {
  AckerDBError,
  type AnyRegisteredRealtime,
} from "@ackerdb/server";
import type { RealtimeServerSessionAdapter } from "@ackerdb/server/realtime-host";

const utf8 = new TextEncoder();
// The wire bytes are exact; this charges the fixed JS ownership retained for
// each ticket (entry, Map/TTL nodes, adapter and abort/release closures).
const PREPARED_ENTRY_OVERHEAD_BYTES = 1024;

interface PreparedEntry {
  readonly ticket: string;
  readonly owner: string;
  readonly definition: AnyRegisteredRealtime;
  readonly adapter: RealtimeServerSessionAdapter;
  /** Canonical AckerDB wire payload; never retain authorization values as objects. */
  readonly payload: string;
  readonly recovery: boolean;
  readonly signal: AbortSignal;
  readonly release: () => void;
  readonly removeSignalListener: () => void;
  readonly bytes: number;
}

export interface PreparedSessionInput {
  readonly ticket: string;
  readonly owner: string;
  readonly definition: AnyRegisteredRealtime;
  readonly adapter: RealtimeServerSessionAdapter;
  readonly payload: string;
  readonly recovery: boolean;
  readonly signal: AbortSignal;
  /** Releases both the session reservation and retained authentication lease. */
  readonly release: () => void;
}

export interface ConsumedPreparedSession {
  readonly definition: AnyRegisteredRealtime;
  readonly adapter: RealtimeServerSessionAdapter;
  readonly args: unknown;
  readonly state: unknown;
  readonly configuration: PortableRTCConfiguration;
  readonly recovery: boolean;
  readonly signal: AbortSignal;
  /** Transfers the reservation and authentication lease to the generation. */
  readonly release: () => void;
}

export interface PreparedSessionsOptions {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly ttlMs: number;
}

function notFound(): AckerDBError {
  return new AckerDBError("not_found", "realtime preparation does not exist");
}

function overloaded(): AckerDBError {
  return new AckerDBError(
    "overloaded",
    "realtime prepared session capacity is full",
    { resource: "connection", retryable: true, retryAfterMs: 0 },
  );
}

function wireFailure(cause: unknown): AckerDBError {
  return new AckerDBError(
    "internal",
    "realtime prepared session payload is invalid",
    { cause },
  );
}

function once(release: () => void): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

function payload(value: string): {
  readonly args: unknown;
  readonly state: unknown;
  readonly configuration: PortableRTCConfiguration;
} {
  try {
    const decoded = decode(value);
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      Array.isArray(decoded)
    ) {
      throw new TypeError("prepared payload must be an object");
    }
    const record = decoded as Record<string, unknown>;
    if (
      typeof record.address !== "string" ||
      !("args" in record) ||
      !("principal" in record) ||
      typeof record.configuration !== "object" ||
      record.configuration === null ||
      Array.isArray(record.configuration)
    ) {
      throw new TypeError("prepared payload has an invalid shape");
    }
    return Object.freeze({
      args: record.args,
      state: record.state,
      configuration: record.configuration as PortableRTCConfiguration,
    });
  } catch (cause) {
    throw wireFailure(cause);
  }
}

/**
 * Owns prepared-ticket lifetime. The map is authoritative for ownership and
 * accounting; ttlcache only wakes expiry and mirrors the already-admitted
 * entry limit.
 */
export class PreparedSessions {
  private readonly entries = new Map<string, PreparedEntry>();
  private readonly cache: TTLCache<string, PreparedEntry>;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private retainedBytes = 0;

  constructor(options: PreparedSessionsOptions) {
    this.maxEntries = options.maxEntries;
    this.maxBytes = options.maxBytes;
    this.cache = new TTLCache({
      // This is a safety mirror. add() admits explicitly before set(), so
      // TTLCache capacity eviction is never part of the ownership contract.
      max: options.maxEntries,
      ttl: options.ttlMs,
      updateAgeOnGet: false,
      checkAgeOnGet: true,
      dispose: (entry, ticket) => this.expire(ticket, entry),
    });
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.retainedBytes;
  }

  add(input: PreparedSessionInput): void {
    const bytes =
      utf8.encode(input.payload).byteLength +
      utf8.encode(input.ticket).byteLength +
      utf8.encode(input.owner).byteLength +
      PREPARED_ENTRY_OVERHEAD_BYTES;
    if (
      this.entries.size >= this.maxEntries ||
      bytes > this.maxBytes - this.retainedBytes
    ) {
      throw overloaded();
    }
    if (input.signal.aborted) {
      input.release();
      throw input.signal.reason;
    }

    let entry!: PreparedEntry;
    const released = once(input.release);
    const abort = () => this.discardEntry(entry);
    entry = Object.freeze({
      ticket: input.ticket,
      owner: input.owner,
      definition: input.definition,
      adapter: input.adapter,
      payload: input.payload,
      recovery: input.recovery,
      signal: input.signal,
      release: released,
      removeSignalListener: () => input.signal.removeEventListener("abort", abort),
      bytes,
    });
    this.entries.set(input.ticket, entry);
    this.retainedBytes += bytes;
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) {
      this.discardEntry(entry);
      throw input.signal.reason;
    }
    try {
      this.cache.set(input.ticket, entry);
      if (this.entries.get(input.ticket) !== entry) {
        throw new AckerDBError(
          "internal",
          "realtime prepared session was evicted during admission",
        );
      }
    } catch (error) {
      this.discardEntry(entry);
      throw error;
    }
  }

  consume(ticket: string, owner: string): ConsumedPreparedSession {
    // ttlcache's timer is only a scheduler. checkAgeOnGet makes a late caller
    // remove a stale ticket synchronously without renewing its age.
    const scheduled = this.cache.get(ticket, {
      checkAgeOnGet: true,
      updateAgeOnGet: false,
    });
    const entry = this.entries.get(ticket);
    if (scheduled === undefined || entry === undefined || scheduled !== entry) {
      if (entry !== undefined && scheduled !== entry) this.discardEntry(entry);
      throw notFound();
    }
    if (entry.owner !== owner) throw notFound();
    if (entry.signal.aborted) {
      this.discardEntry(entry);
      throw entry.signal.reason;
    }

    this.detach(entry);
    try {
      const decoded = payload(entry.payload);
      return Object.freeze({
        definition: entry.definition,
        adapter: entry.adapter,
        args: decoded.args,
        state: decoded.state,
        configuration: decoded.configuration,
        recovery: entry.recovery,
        signal: entry.signal,
        release: entry.release,
      });
    } catch (error) {
      entry.release();
      throw error;
    }
  }

  cancel(ticket: string, owner: string): void {
    const entry = this.entries.get(ticket);
    if (entry !== undefined && entry.owner === owner) this.discardEntry(entry);
  }

  drain(): void {
    for (const entry of [...this.entries.values()]) this.discardEntry(entry);
    this.cache.clear();
  }

  private expire(ticket: string, entry: PreparedEntry): void {
    if (entry.ticket !== ticket) return;
    this.discardEntry(entry);
  }

  private detach(entry: PreparedEntry): void {
    if (this.entries.get(entry.ticket) !== entry) return;
    this.entries.delete(entry.ticket);
    this.retainedBytes -= entry.bytes;
    entry.removeSignalListener();
    this.cache.delete(entry.ticket);
  }

  private discardEntry(entry: PreparedEntry): void {
    if (this.entries.get(entry.ticket) !== entry) return;
    this.detach(entry);
    entry.release();
  }
}
