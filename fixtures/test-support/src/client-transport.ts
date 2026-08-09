import {
  ACKERDB_VERSION,
  decode,
  encode,
  parseClientMessage,
  type AuthenticationDescriptor,
  type ClientMessage,
  type ServerMessage,
} from "@ackerdb/core";
import type { AckerDBClientClock, AckerDBWebSocket } from "@ackerdb/client";

/**
 * The two doubles `AckerDBClient` accepts through its config — `clock` and the
 * socket returned by `createWebSocket` — are the whole injected environment a
 * client test runs on. Both live here because every suite that drives a client
 * without a real server needs the same pair, and a per-suite copy of either one
 * silently drifts from the protocol the client actually speaks.
 */

interface ClockTask {
  at: number;
  callback: () => void;
  intervalMs?: number;
}

/**
 * Drives every client timer from the test instead of the event loop, so a
 * reconnect backoff, heartbeat, or lease renewal is observed at an exact point
 * rather than slept toward. Time only moves in `advance`.
 */
export class ManualClock implements AckerDBClientClock {
  private readonly tasks = new Map<number, ClockTask>();
  private nextId = 0;

  constructor(private time = 0) {}

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.nextId;
    this.tasks.set(id, { at: this.time + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  setInterval(callback: () => void, delayMs: number): number {
    const id = ++this.nextId;
    this.tasks.set(id, { at: this.time + delayMs, callback, intervalMs: delayMs });
    return id;
  }

  clearInterval(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  /**
   * Moves wall time forward while every timer stays asleep: the frozen-tab
   * and suspended-host case, where a scheduled callback simply does not run
   * for however long the environment was stopped. Anything that came due
   * during the freeze becomes due at the wake instant, so the next `advance`
   * fires it there — a woken browser runs overdue callbacks now, never at
   * the moment they were originally scheduled for.
   */
  freeze(ms: number): void {
    this.time += ms;
    // Everything that came due while the environment was stopped is now
    // simply overdue: a woken browser runs those callbacks at the current
    // instant, never at the moment they were originally scheduled for.
    for (const task of this.tasks.values()) {
      if (task.at < this.time) task.at = this.time;
    }
  }

  /**
   * Runs every task due within `ms`, each at its own scheduled instant, so a
   * callback that reads `now()` or schedules more work sees the time it would
   * have seen in real execution. Intervals keep their slot rather than being
   * re-queued, which keeps repeat ordering stable against same-instant peers.
   */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let next: [number, ClockTask] | undefined;
      for (const entry of this.tasks) {
        if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
      }
      if (!next) break;
      const [id, task] = next;
      this.time = task.at;
      if (task.intervalMs === undefined) this.tasks.delete(id);
      else task.at += task.intervalMs;
      task.callback();
    }
    this.time = target;
  }

  /** Delay until the earliest pending task, or `undefined` when none is armed. */
  nextDueIn(): number | undefined {
    let due: number | undefined;
    for (const task of this.tasks.values()) {
      const delay = task.at - this.time;
      if (due === undefined || delay < due) due = delay;
    }
    return due;
  }

  /** Pending timers, so a test can prove the client armed or released them. */
  get taskCount(): number {
    return this.tasks.size;
  }
}

/**
 * A socket the test writes both sides of. Everything the client sends is parsed
 * with the real protocol parser before it is recorded, so a suite asserting on
 * frames can never pass on a frame the wire would have rejected.
 */
export class FakeSocket implements AckerDBWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  /** Raw wire text of everything the client sent, in order. */
  readonly sent: string[] = [];
  /** Close codes and reasons the client asked for, in order. */
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  /**
   * A real socket reports its close asynchronously. Set this to hold the close
   * event back, so a test can observe what the client does in the window where
   * it has asked to close but has not been told the socket is gone.
   */
  deferClose = false;
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  send(data: string): void {
    if (this.#closed) throw new Error("socket is closed");
    parseClientMessage(decode(data));
    this.sent.push(data);
  }

  /**
   * Rejects codes a browser would reject, so a client that closes with an
   * unusable code fails here instead of only in a real deployment.
   */
  close(code?: number, reason?: string): void {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException("Invalid WebSocket close code", "InvalidAccessError");
    }
    if (this.#closed) return;
    this.#closed = true;
    this.closes.push({ code, reason });
    if (!this.deferClose) this.onclose?.();
  }

  /** Completes the transport handshake without granting a session. */
  open(): void {
    this.onopen?.();
  }

  /**
   * Opens and admits the session, the ordinary start of a connected test.
   * `authEpoch` is explicit because a reconnect that lands on a later epoch is
   * a different admission than a fresh one, and suites assert on that.
   */
  welcome(
    clientSessionId: string,
    descriptor: AuthenticationDescriptor = { principal: "anonymous" },
    authEpoch = 0,
  ): void {
    this.open();
    this.receive({
      v: ACKERDB_VERSION,
      t: "welcome",
      clientSessionId,
      authEpoch,
      ...descriptor,
    });
  }

  receive(frame: ServerMessage): void {
    this.receiveRaw(encode(frame));
  }

  /** Delivers bytes the encoder would not produce, for malformed-input tests. */
  receiveRaw(data: string): void {
    this.onmessage?.({ data });
  }

  frames(): ClientMessage[] {
    return this.sent.map((text) => parseClientMessage(decode(text)));
  }

  framesOf<T extends ClientMessage["t"]>(type: T): Extract<ClientMessage, { t: T }>[] {
    return this.frames().filter((frame) => frame.t === type) as Extract<
      ClientMessage,
      { t: T }
    >[];
  }

  /** The most recent frame of one type; throws when the client sent none. */
  lastFrame<T extends ClientMessage["t"]>(type: T): Extract<ClientMessage, { t: T }> {
    const frame = this.framesOf(type).at(-1);
    if (!frame) throw new Error(`No ${type} frame`);
    return frame;
  }
}
