/**
 * DbzzClient: the Node/Bun client. Subscriptions, one-shot queries and
 * mutations ride one WebSocket; procedures use HTTP; SSE procedures stream
 * over fetch. No Bun-specific APIs — plain WebSocket/fetch globals.
 *
 * Reliability model:
 * - The socket connects lazily and reconnects with backoff, forever, until
 *   `close()`.
 * - `onopen` is the *single* sender of subscription and pending frames: a
 *   frame sent on a live socket is sent once; anything unanswered when the
 *   socket drops is re-sent by the next `onopen`. Mutations carry a
 *   client-generated idempotency key, so a retry after a lost response
 *   replays the recorded result instead of re-executing (exactly-once
 *   effect); queries are pure and procedures never ride the socket.
 * - Re-subscribing after reconnect makes the server push the current value,
 *   so subscribers converge without any client-side diffing.
 */
import { decode, encode, getRef, type EventRef, type FunctionReference, type MutationRef, type ProcedureRef, type QueryRef, type ServerMessage, type SseRef } from "@dbzz/core";

export interface DbzzClientOptions {
  /** Server base URL, e.g. "http://127.0.0.1:3211". */
  url: string;
}

interface Subscription {
  ref: string;
  args: unknown;
  onUpdate: (value: never) => void;
  onError?: (message: string) => void;
}

interface PendingRequest {
  frame: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const unref = (timer: unknown): void => {
  (timer as { unref?: () => void }).unref?.();
};

export class DbzzClient {
  private readonly httpUrl: string;
  private readonly wsUrl: string;
  private ws: WebSocket | null = null;
  private open = false;
  private closedByUser = false;
  private nextId = 1;
  private readonly subs = new Map<number, Subscription>();
  private readonly pending = new Map<number, PendingRequest>();
  private backoff = 100;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: DbzzClientOptions) {
    this.httpUrl = opts.url.replace(/\/$/, "");
    this.wsUrl = `${this.httpUrl.replace(/^http/, "ws")}/ws`;
  }

  // -- connection -------------------------------------------------------------

  private ensureConnected(): void {
    if (this.closedByUser) throw new Error("client is closed");
    if (this.ws !== null) return;
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.open = true;
      this.backoff = 100;
      // the single sender: everything alive gets (re)sent here or on a live socket
      for (const [id, sub] of this.subs) {
        ws.send(encode({ t: "sub", id, ref: sub.ref, args: sub.args }));
      }
      for (const request of this.pending.values()) {
        ws.send(request.frame);
      }
    };
    ws.onmessage = (event) => this.dispatch(decode(String(event.data)) as ServerMessage);
    ws.onclose = () => {
      this.open = false;
      this.ws = null;
      if (this.closedByUser) return;
      if (this.subs.size === 0 && this.pending.size === 0) return; // reconnect on demand
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.closedByUser) this.ensureConnected();
      }, this.backoff + Math.random() * this.backoff);
      unref(this.reconnectTimer);
      this.backoff = Math.min(this.backoff * 2, 3000);
    };
    ws.onerror = () => {
      /* onclose follows and handles it */
    };
    if (this.pingTimer === null) {
      this.pingTimer = setInterval(() => {
        if (this.open) this.ws?.send(`{"t":"ping"}`);
      }, 30_000);
      unref(this.pingTimer);
    }
  }

  private dispatch(frame: ServerMessage): void {
    switch (frame.t) {
      case "update": {
        (this.subs.get(frame.id)?.onUpdate as ((v: unknown) => void) | undefined)?.(frame.value);
        return;
      }
      case "event": {
        (this.subs.get(frame.id)?.onUpdate as ((v: unknown) => void) | undefined)?.(frame.row);
        return;
      }
      case "ok": {
        const request = this.pending.get(frame.id);
        if (request !== undefined) {
          this.pending.delete(frame.id);
          request.resolve(frame.value);
        }
        return;
      }
      case "err": {
        const request = this.pending.get(frame.id);
        if (request !== undefined) {
          this.pending.delete(frame.id);
          request.reject(new Error(frame.message));
          return;
        }
        const sub = this.subs.get(frame.id);
        sub?.onError?.(frame.message);
        return;
      }
      case "pong":
        return;
    }
  }

  /** Send a request frame; it is re-sent on reconnect until answered. */
  private request(frame: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const text = encode({ ...frame, id });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { frame: text, resolve, reject });
      this.ensureConnected();
      if (this.open) this.ws!.send(text);
    });
  }

  // -- public API ---------------------------------------------------------------

  /** Subscribe to a reactive query (or an event table ref). Returns unsubscribe. */
  subscribe<A, R = unknown>(
    ref: QueryRef<A, R> | EventRef<R> | string,
    args: A,
    onUpdate: (value: R) => void,
    onError?: (message: string) => void,
  ): () => void {
    const id = this.nextId++;
    this.subs.set(id, { ref: getRef(ref as FunctionReference | string), args, onUpdate: onUpdate as (value: never) => void, onError });
    this.ensureConnected();
    if (this.open) {
      this.ws!.send(encode({ t: "sub", id, ref: getRef(ref as FunctionReference | string), args }));
    }
    return () => {
      if (!this.subs.delete(id)) return;
      if (this.open) this.ws!.send(encode({ t: "unsub", id }));
    };
  }

  /** Await a query once — no standing subscription. */
  query<A, R = unknown>(ref: QueryRef<A, R> | string, args: A): Promise<R> {
    return this.request({ t: "q", ref: getRef(ref as FunctionReference | string), args }) as Promise<R>;
  }

  /** Run a mutation. Exactly-once: retries after reconnect replay the result. */
  mutation<A, R = unknown>(ref: MutationRef<A, R> | string, args: A): Promise<R> {
    return this.request({
      t: "m",
      ref: getRef(ref as FunctionReference | string),
      args,
      mid: crypto.randomUUID(),
    }) as Promise<R>;
  }

  /** Call a procedure over HTTP. Failures surface to you; no auto-retry. */
  async procedure<A, R = unknown>(ref: ProcedureRef<A, R> | string, args: A): Promise<R> {
    const response = await fetch(`${this.httpUrl}/api/call`, {
      method: "POST",
      body: encode({ ref: getRef(ref as FunctionReference | string), args }),
    });
    const body = decode(await response.text()) as { value?: R; error?: string };
    if (!response.ok || body.error !== undefined) {
      throw new Error(body.error ?? `procedure failed with status ${response.status}`);
    }
    return body.value as R;
  }

  /** Call an SSE procedure; yields decoded chunks until the stream ends. */
  async *sse<A>(
    ref: SseRef<A, unknown> | string,
    args: A,
    opts: { signal?: AbortSignal } = {},
  ): AsyncGenerator<unknown, void, undefined> {
    const response = await fetch(`${this.httpUrl}/api/sse`, {
      method: "POST",
      body: encode({ ref: getRef(ref as FunctionReference | string), args }),
      signal: opts.signal,
    });
    if (!response.ok || response.body === null) {
      let detail = "";
      try {
        detail = String((decode(await response.text()) as { error?: string }).error ?? "");
      } catch {
        /* not json */
      }
      throw new Error(detail === "" ? `sse failed with status ${response.status}` : detail);
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += value;
        for (;;) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary === -1) break;
          const message = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const line of message.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice("data: ".length);
            if (payload === "[DONE]") return;
            yield decode(payload);
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  /** Drop the connection and reject anything in flight. */
  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
    this.open = false;
    for (const request of this.pending.values()) {
      request.reject(new Error("client closed"));
    }
    this.pending.clear();
    this.subs.clear();
  }
}
