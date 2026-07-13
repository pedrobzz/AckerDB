import {
  MAX_PROTOCOL_ID,
  MAX_RETRY_AFTER_MS,
  PROTOCOL_VERSION,
  ProtocolError,
  decode,
  encode,
  getRef,
  parseCallRequest,
  parseCallResponse,
  parseClientMessage,
  parseCredential,
  parseOutcome,
  parseServerMessage,
  type ClientMessage,
  type Credential,
  type EventRef,
  type FunctionReference,
  type LiveEventCursor,
  type MutationOkMessage,
  type MutationReceipt,
  type MutationRef,
  type Outcome,
  type OutcomeCode,
  type PrincipalKind,
  type ProcedureRef,
  type QueryRef,
  type ResourceClass,
  type ServerMessage,
  type SseRef,
  type SubscriptionCursor,
  type SubscriptionTransition,
} from "@dbzz/core";

export interface DbzzClientLimits {
  readonly maxPendingItems: number;
  readonly maxPendingBytes: number;
  readonly maxQueryAgeMs: number;
  readonly maxMutationAgeMs: number;
  readonly maxFrameBytes: number;
  readonly maxSseBufferBytes: number;
}

export interface DbzzReconnectOptions {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly stableOpenMs: number;
}

export interface DbzzClientClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface DbzzWebSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type DbzzWebSocketFactory = (url: string) => DbzzWebSocket;
export type DbzzFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface DbzzClientOptions {
  /** Server base URL, for example `http://127.0.0.1:3211`. */
  readonly url: string;
  /** Every connection starts with this explicit anonymous or bearer credential. */
  readonly credential: Credential;
  /** Stable for this logical client across every reconnect. Generated once when omitted. */
  readonly clientSessionId?: string;
  readonly limits?: Partial<DbzzClientLimits>;
  readonly reconnect?: Partial<DbzzReconnectOptions>;
  readonly clock?: DbzzClientClock;
  readonly random?: () => number;
  readonly createWebSocket?: DbzzWebSocketFactory;
  readonly fetch?: DbzzFetch;
}

export interface DbzzAuthentication {
  readonly authEpoch: number;
  readonly principal: PrincipalKind;
}

export type DbzzLiveEvent<Row> =
  | { readonly kind: "row"; readonly cursor: LiveEventCursor; readonly row: Row }
  | { readonly kind: "gap"; readonly cursor: LiveEventCursor }
  | { readonly kind: "reset"; readonly cursor: LiveEventCursor };

export interface DbzzCallOptions {
  readonly signal?: AbortSignal;
}

export const DBZZ_CLIENT_LIMITS: DbzzClientLimits = Object.freeze({
  maxPendingItems: 4_096,
  maxPendingBytes: 16 * 1024 * 1024,
  maxQueryAgeMs: 30_000,
  maxMutationAgeMs: 24 * 60 * 60 * 1_000,
  maxFrameBytes: 1024 * 1024,
  maxSseBufferBytes: 1024 * 1024,
});

export const DBZZ_RECONNECT_DEFAULTS: DbzzReconnectOptions = Object.freeze({
  baseDelayMs: 100,
  maxDelayMs: 3_000,
  stableOpenMs: 10_000,
});

export class DbzzClientError extends Error {
  readonly outcome: Readonly<Outcome>;
  readonly code: OutcomeCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly resource?: ResourceClass;
  readonly committed?: true;

  constructor(outcome: Outcome) {
    super(outcome.message);
    this.name = "DbzzClientError";
    this.outcome = Object.freeze({ ...outcome });
    this.code = outcome.code;
    this.retryable = outcome.retryable;
    this.retryAfterMs = outcome.retryAfterMs;
    this.resource = outcome.resource;
    this.committed = outcome.committed;
  }
}

interface QuerySubscription {
  readonly kind: "query";
  readonly id: number;
  readonly ref: string;
  readonly args: unknown;
  readonly onUpdate: (value: unknown) => void;
  readonly onError?: (error: DbzzClientError) => void;
  cursor?: SubscriptionCursor;
  resetRequested: boolean;
  frame: string;
  bytes: number;
  sentConnection?: number;
}

interface EventSubscription {
  readonly kind: "event";
  readonly id: number;
  readonly ref: string;
  readonly onEvent: (event: DbzzLiveEvent<unknown>) => void;
  readonly onError?: (error: DbzzClientError) => void;
  cursor?: LiveEventCursor;
  frame: string;
  bytes: number;
  sentConnection?: number;
}

type Subscription = QuerySubscription | EventSubscription;

interface PendingRequest {
  readonly id: number;
  readonly kind: "query" | "mutation";
  readonly frame: string;
  readonly bytes: number;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: DbzzClientError) => void;
  readonly mutationRequestId?: string;
  expiryHandle?: unknown;
  sentConnection?: number;
  receipt?: MutationReceipt;
  result?: unknown;
  obligations?: Set<number>;
}

interface AuthAttempt {
  readonly id: number;
  readonly credential: Credential;
  readonly resolve: (authentication: DbzzAuthentication) => void;
  readonly reject: (error: DbzzClientError) => void;
  expiryHandle?: unknown;
  sentConnection?: number;
}

interface FetchControl {
  readonly controller: AbortController;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
  readonly timeoutHandle?: unknown;
}

const encoder = new TextEncoder();
const UUID_RANDOM_MASK = (1n << 74n) - 1n;

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function localError(
  code: OutcomeCode,
  message: string,
  resource?: ResourceClass,
  committed?: true,
): DbzzClientError {
  return new DbzzClientError({ code, message, retryable: false, resource, committed });
}

function freezeCredential(credential: Credential): Credential {
  const parsed = parseCredential(credential);
  return parsed.kind === "anonymous"
    ? Object.freeze({ kind: "anonymous" })
    : Object.freeze({ kind: "bearer", token: parsed.token });
}

function sameCursor(left: SubscriptionCursor | undefined, right: SubscriptionCursor | null): boolean {
  return (
    left !== undefined &&
    right !== null &&
    left.generation === right.generation &&
    left.commitVersion === right.commitVersion &&
    left.authEpoch === right.authEpoch &&
    left.identity === right.identity
  );
}

function sameEventCursor(left: LiveEventCursor | undefined, right: LiveEventCursor): boolean {
  return (
    left !== undefined &&
    left.generation === right.generation &&
    left.commitVersion === right.commitVersion &&
    left.sequence === right.sequence
  );
}

class UuidV7Factory {
  private lastTimestamp = -1;
  private randomBits = 0n;

  constructor(private readonly random: () => number) {}

  create(nowMs: number): string {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs >= 2 ** 48) {
      throw new RangeError("clock must return a UUIDv7-compatible timestamp");
    }
    let timestamp = Math.max(nowMs, this.lastTimestamp);
    if (timestamp > this.lastTimestamp) {
      this.randomBits = this.readRandomBits();
    } else if (this.randomBits < UUID_RANDOM_MASK) {
      this.randomBits++;
    } else {
      timestamp++;
      if (timestamp >= 2 ** 48) throw new RangeError("UUIDv7 timestamp exhausted");
      this.randomBits = this.readRandomBits();
    }
    this.lastTimestamp = timestamp;

    const timestampHex = timestamp.toString(16).padStart(12, "0");
    const randomA = (this.randomBits >> 62n).toString(16).padStart(3, "0");
    const randomB = ((2n << 62n) | (this.randomBits & ((1n << 62n) - 1n)))
      .toString(16)
      .padStart(16, "0");
    return `${timestampHex.slice(0, 8)}-${timestampHex.slice(8)}-7${randomA}-${randomB.slice(0, 4)}-${randomB.slice(4)}`;
  }

  private readRandomBits(): bigint {
    let bits = 0n;
    for (let index = 0; index < 10; index++) {
      const value = this.random();
      if (!Number.isFinite(value) || value < 0 || value >= 1) {
        throw new RangeError("random must return a number from 0 up to but excluding 1");
      }
      bits = (bits << 8n) | BigInt(Math.floor(value * 256));
    }
    return bits & UUID_RANDOM_MASK;
  }
}

const SYSTEM_CLOCK: DbzzClientClock = {
  now: Date.now,
  setTimeout(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval(callback, delayMs) {
    const handle = setInterval(callback, delayMs);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

const SYSTEM_SOCKET_FACTORY: DbzzWebSocketFactory = (url) =>
  new WebSocket(url) as unknown as DbzzWebSocket;
const SYSTEM_FETCH: DbzzFetch = (url, init) => fetch(url, init);
const SYSTEM_RANDOM = (): number => {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0]! / 0x1_0000_0000;
};

export class DbzzClient {
  readonly clientSessionId: string;

  private readonly httpUrl: string;
  private readonly wsUrl: string;
  private readonly limits: DbzzClientLimits;
  private readonly reconnect: DbzzReconnectOptions;
  private readonly clock: DbzzClientClock;
  private readonly random: () => number;
  private readonly createWebSocket: DbzzWebSocketFactory;
  private readonly fetcher: DbzzFetch;
  private readonly uuid: UuidV7Factory;
  private readonly subscriptions = new Map<number, Subscription>();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly activeFetches = new Set<AbortController>();

  private credential: Credential;
  private socket: DbzzWebSocket | null = null;
  private socketOpen = false;
  private ready = false;
  private closed = false;
  private permanentFailure = false;
  private authBlocked = false;
  private connectionSerial = 0;
  private nextId = 1;
  private reconnectAttempt = 0;
  private serverRetryFloorMs = 0;
  private pendingItems = 0;
  private pendingBytes = 0;
  private authAttempt?: AuthAttempt;
  private reconnectHandle?: unknown;
  private stableHandle?: unknown;
  private pingHandle?: unknown;
  private authentication?: DbzzAuthentication;

  constructor(options: DbzzClientOptions) {
    this.httpUrl = options.url.replace(/\/$/, "");
    if (!/^https?:\/\//.test(this.httpUrl)) throw new TypeError("url must use http or https");
    this.wsUrl = `${this.httpUrl.replace(/^http/, "ws")}/ws`;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.random = options.random ?? SYSTEM_RANDOM;
    this.createWebSocket = options.createWebSocket ?? SYSTEM_SOCKET_FACTORY;
    this.fetcher = options.fetch ?? SYSTEM_FETCH;
    this.credential = freezeCredential(options.credential);
    this.limits = Object.freeze({ ...DBZZ_CLIENT_LIMITS, ...options.limits });
    this.reconnect = Object.freeze({ ...DBZZ_RECONNECT_DEFAULTS, ...options.reconnect });
    for (const [name, value] of Object.entries(this.limits)) positiveInteger(value, name);
    for (const [name, value] of Object.entries(this.reconnect)) positiveInteger(value, name);
    if (this.reconnect.baseDelayMs > this.reconnect.maxDelayMs) {
      throw new RangeError("baseDelayMs cannot exceed maxDelayMs");
    }
    this.uuid = new UuidV7Factory(this.random);
    this.clientSessionId = options.clientSessionId ?? this.uuid.create(this.now());
    parseClientMessage({
      v: PROTOCOL_VERSION,
      t: "hello",
      clientSessionId: this.clientSessionId,
      credential: this.credential,
    });
  }

  get currentAuthentication(): DbzzAuthentication | undefined {
    return this.authentication === undefined ? undefined : Object.freeze({ ...this.authentication });
  }

  refreshCredential(credential: Credential): Promise<DbzzAuthentication> {
    if (this.closed) throw localError("unavailable", "client is closed", "connection");
    if (this.permanentFailure) {
      throw localError("unavailable", "client stopped after a protocol failure", "connection");
    }
    const nextCredential = freezeCredential(credential);
    if (this.authAttempt) {
      this.clock.clearTimeout(this.authAttempt.expiryHandle);
      this.authAttempt.reject(localError("auth_stale", "authentication attempt was superseded", "connection"));
    }
    this.credential = nextCredential;
    this.authBlocked = false;
    const id = this.allocateId();
    let resolve!: (authentication: DbzzAuthentication) => void;
    let reject!: (error: DbzzClientError) => void;
    const result = new Promise<DbzzAuthentication>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    const attempt: AuthAttempt = { id, credential: nextCredential, resolve, reject };
    attempt.expiryHandle = this.clock.setTimeout(() => {
      if (this.authAttempt !== attempt) return;
      this.authAttempt = undefined;
      this.authBlocked = true;
      this.ready = false;
      attempt.reject(localError("auth_unavailable", "authentication timed out", "connection"));
      this.socket?.close(1008, "authentication timed out");
    }, this.limits.maxQueryAgeMs);
    this.authAttempt = attempt;
    if (this.ready) this.sendAuth(attempt);
    else this.ensureConnected();
    return result;
  }

  subscribe<A, R = unknown>(
    ref: QueryRef<A, R> | string,
    args: A,
    onUpdate: (value: R) => void,
    onError?: (error: DbzzClientError) => void,
  ): () => void {
    this.assertUsable();
    const id = this.allocateId();
    const address = getRef(ref as FunctionReference | string);
    const frame = this.encodeClient({ v: PROTOCOL_VERSION, t: "sub", id, ref: address, args });
    const bytes = this.reservePersistent(frame, "subscription");
    const subscription: QuerySubscription = {
      kind: "query",
      id,
      ref: address,
      args,
      onUpdate: onUpdate as (value: unknown) => void,
      onError,
      resetRequested: false,
      frame,
      bytes,
    };
    this.subscriptions.set(id, subscription);
    this.ensureConnected();
    if (this.canSendOperations()) this.sendSubscription(subscription);
    return () => this.removeSubscription(id, true);
  }

  subscribeEvent<Row = unknown>(
    ref: EventRef<Row> | string,
    onEvent: (event: DbzzLiveEvent<Row>) => void,
    onError?: (error: DbzzClientError) => void,
  ): () => void {
    this.assertUsable();
    const id = this.allocateId();
    const address = getRef(ref as FunctionReference | string);
    const frame = this.encodeClient({ v: PROTOCOL_VERSION, t: "sub", id, ref: address, args: {} });
    const bytes = this.reservePersistent(frame, "subscription");
    const subscription: EventSubscription = {
      kind: "event",
      id,
      ref: address,
      onEvent: onEvent as (event: DbzzLiveEvent<unknown>) => void,
      onError,
      frame,
      bytes,
    };
    this.subscriptions.set(id, subscription);
    this.ensureConnected();
    if (this.canSendOperations()) this.sendSubscription(subscription);
    return () => this.removeSubscription(id, true);
  }

  query<A, R = unknown>(ref: QueryRef<A, R> | string, args: A): Promise<R> {
    return this.request("query", getRef(ref as FunctionReference | string), args) as Promise<R>;
  }

  mutation<A, R = unknown>(ref: MutationRef<A, R> | string, args: A): Promise<R> {
    return this.request("mutation", getRef(ref as FunctionReference | string), args) as Promise<R>;
  }

  async procedure<A, R = unknown>(
    ref: ProcedureRef<A, R> | string,
    args: A,
    options: DbzzCallOptions = {},
  ): Promise<R> {
    this.assertUsable();
    const id = this.allocateId();
    const body = this.encodeCall(id, getRef(ref as FunctionReference | string), args);
    const release = this.reserveTransient(body, "operation");
    const fetchControl = this.createFetchController(options.signal, this.limits.maxQueryAgeMs);
    try {
      let response: Response;
      try {
        response = await this.fetcher(`${this.httpUrl}/api/call`, {
          method: "POST",
          headers: this.httpHeaders(),
          body,
          signal: fetchControl.controller.signal,
        });
      } catch {
        throw localError("indeterminate", "procedure completion is unknown", "operation");
      }
      let text: string;
      try {
        text = await this.readBoundedResponse(response, this.limits.maxFrameBytes);
      } catch (error) {
        if (error instanceof DbzzClientError) throw error;
        throw localError("indeterminate", "procedure response was interrupted", "operation");
      }
      let parsed;
      try {
        parsed = parseCallResponse(decode(text));
      } catch (error) {
        throw this.protocolError(error);
      }
      if (parsed.t === "err") {
        if (parsed.id !== null && parsed.id !== id) {
          throw localError("malformed", "procedure error does not match its request", "operation");
        }
        throw new DbzzClientError(parsed.outcome);
      }
      if (!response.ok || parsed.id !== id) {
        throw localError("malformed", "procedure response does not match its request", "operation");
      }
      return parsed.value as R;
    } finally {
      this.releaseFetchController(fetchControl);
      release();
    }
  }

  async *sse<A, Chunk = unknown>(
    ref: SseRef<A, Chunk> | string,
    args: A,
    options: DbzzCallOptions = {},
  ): AsyncGenerator<Chunk, void, undefined> {
    this.assertUsable();
    const id = this.allocateId();
    const body = this.encodeCall(id, getRef(ref as FunctionReference | string), args);
    const release = this.reserveTransient(body, "sse");
    const fetchControl = this.createFetchController(options.signal);
    let reader: { releaseLock(): void } | undefined;
    try {
      let response: Response;
      try {
        response = await this.fetcher(`${this.httpUrl}/api/sse`, {
          method: "POST",
          headers: this.httpHeaders(),
          body,
          signal: fetchControl.controller.signal,
        });
      } catch {
        throw localError("indeterminate", "SSE procedure completion is unknown", "sse");
      }
      if (!response.ok) {
        const text = await this.readBoundedResponse(response, this.limits.maxFrameBytes);
        let parsed: ServerMessage;
        try {
          parsed = parseServerMessage(decode(text));
        } catch (error) {
          throw this.protocolError(error);
        }
        if (parsed.t !== "err" || (parsed.id !== null && parsed.id !== id)) {
          throw localError("malformed", "SSE error response does not match its request", "sse");
        }
        throw new DbzzClientError(parsed.outcome);
      }
      if (!response.body) throw localError("malformed", "SSE response has no body", "sse");

      const streamReader = response.body.getReader();
      reader = streamReader;
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const part = await streamReader.read();
        if (part.done) {
          buffer += decoder.decode();
          if (buffer.length !== 0) throw localError("malformed", "SSE stream ended mid-event", "sse");
          return;
        }
        if (part.value.byteLength > this.limits.maxSseBufferBytes) {
          throw localError("overloaded", "SSE input exceeds the client buffer limit", "sse");
        }
        buffer += decoder.decode(part.value, { stream: true });
        if (encoder.encode(buffer).byteLength > this.limits.maxSseBufferBytes) {
          throw localError("overloaded", "SSE input exceeds the client buffer limit", "sse");
        }

        for (;;) {
          const lfBoundary = buffer.indexOf("\n\n");
          const crlfBoundary = buffer.indexOf("\r\n\r\n");
          const useCrlf = crlfBoundary !== -1 && (lfBoundary === -1 || crlfBoundary < lfBoundary);
          const boundary = useCrlf ? crlfBoundary : lfBoundary;
          if (boundary === -1) break;
          const block = buffer.slice(0, boundary).replaceAll("\r\n", "\n");
          buffer = buffer.slice(boundary + (useCrlf ? 4 : 2));
          let eventName = "message";
          const data: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) continue;
            const separator = line.indexOf(":");
            const field = separator === -1 ? line : line.slice(0, separator);
            const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
            if (field === "event") eventName = value;
            else if (field === "data") data.push(value);
          }
          if (data.length === 0) continue;
          const payload = data.join("\n");
          if (eventName === "dbzz-error") {
            try {
              throw new DbzzClientError(parseOutcome(decode(payload)));
            } catch (error) {
              if (error instanceof DbzzClientError) throw error;
              throw this.protocolError(error);
            }
          }
          if (eventName !== "message") {
            throw localError("malformed", "unknown SSE event type", "sse");
          }
          if (payload === "[DONE]") return;
          try {
            yield decode(payload) as Chunk;
          } catch {
            throw localError("malformed", "invalid SSE data payload", "sse");
          }
        }
      }
    } catch (error) {
      if (error instanceof DbzzClientError) throw error;
      throw localError("indeterminate", "SSE response was interrupted", "sse");
    } finally {
      reader?.releaseLock();
      this.releaseFetchController(fetchControl);
      release();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearReconnectTimer();
    this.clearConnectionTimers();
    if (this.authAttempt) {
      this.clock.clearTimeout(this.authAttempt.expiryHandle);
      this.authAttempt.reject(localError("unavailable", "client closed", "connection"));
      this.authAttempt = undefined;
    }
    for (const request of [...this.pending.values()]) {
      const indeterminate = request.kind === "mutation" && request.sentConnection !== undefined;
      this.finishRequest(
        request,
        undefined,
        localError(
          indeterminate ? "indeterminate" : "unavailable",
          indeterminate ? "mutation completion is unknown" : "client closed",
          indeterminate ? "idempotency" : "operation",
        ),
      );
    }
    for (const subscription of this.subscriptions.values()) {
      this.releasePersistent(subscription.bytes);
    }
    this.subscriptions.clear();
    for (const controller of this.activeFetches) controller.abort();
    this.activeFetches.clear();
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    this.socketOpen = false;
    socket?.close(1000, "client closed");
  }

  private request(kind: "query" | "mutation", ref: string, args: unknown): Promise<unknown> {
    let unownedReservation = 0;
    try {
      this.assertUsable();
      const id = this.allocateId();
      const createdAtMs = this.now();
      const mutationRequestId = kind === "mutation" ? this.uuid.create(createdAtMs) : undefined;
      const frame = this.encodeClient(
        kind === "query"
          ? { v: PROTOCOL_VERSION, t: "q", id, ref, args }
          : {
              v: PROTOCOL_VERSION,
              t: "m",
              id,
              ref,
              args,
              mutationRequestId: mutationRequestId!,
              issuedAt: createdAtMs,
            },
      );
      const bytes = this.reservePersistent(frame, "operation");
      unownedReservation = bytes;
      const maxAge = kind === "query" ? this.limits.maxQueryAgeMs : this.limits.maxMutationAgeMs;
      let resolve!: (value: unknown) => void;
      let reject!: (error: DbzzClientError) => void;
      const result = new Promise<unknown>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
      });
      const pending: PendingRequest = {
        id,
        kind,
        frame,
        bytes,
        createdAtMs,
        expiresAtMs: createdAtMs + maxAge,
        resolve,
        reject,
        mutationRequestId,
      };
      pending.expiryHandle = this.clock.setTimeout(() => this.expireRequest(pending), maxAge);
      this.pending.set(id, pending);
      unownedReservation = 0;
      this.ensureConnected();
      if (this.canSendOperations()) this.sendRequest(pending);
      return result;
    } catch (error) {
      if (unownedReservation) this.releasePersistent(unownedReservation);
      return Promise.reject(
        error instanceof DbzzClientError
          ? error
          : localError("validation", "request cannot be encoded", "operation"),
      );
    }
  }

  private ensureConnected(): void {
    if (this.closed || this.permanentFailure || this.authBlocked || this.socket) return;
    this.clearReconnectTimer();
    let socket: DbzzWebSocket;
    try {
      socket = this.createWebSocket(this.wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.connectionSerial++;
    socket.onopen = () => this.handleOpen(socket);
    socket.onmessage = (event) => this.handleIncoming(socket, event.data);
    socket.onerror = () => socket.close();
    socket.onclose = () => this.handleClose(socket);
  }

  private handleOpen(socket: DbzzWebSocket): void {
    if (this.socket !== socket || this.closed) return;
    this.socketOpen = true;
    try {
      this.sendFrame({
        v: PROTOCOL_VERSION,
        t: "hello",
        clientSessionId: this.clientSessionId,
        credential: this.credential,
      });
    } catch (error) {
      this.failPermanently(error instanceof DbzzClientError ? error : this.protocolError(error));
    }
  }

  private handleClose(socket: DbzzWebSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.socketOpen = false;
    this.ready = false;
    this.authentication = undefined;
    this.clearConnectionTimers();
    for (const subscription of this.subscriptions.values()) {
      if (subscription.kind === "event") subscription.cursor = undefined;
    }
    if (!this.closed && !this.permanentFailure && !this.authBlocked && this.hasReconnectWork()) {
      this.scheduleReconnect();
    }
  }

  private handleIncoming(socket: DbzzWebSocket, data: unknown): void {
    if (this.socket !== socket || this.closed) return;
    if (typeof data !== "string" || encoder.encode(data).byteLength > this.limits.maxFrameBytes) {
      this.failPermanently(localError("malformed", "server frame exceeds the client limit", "connection"));
      return;
    }
    let frame: ServerMessage;
    try {
      frame = parseServerMessage(decode(data));
    } catch (error) {
      this.failPermanently(this.protocolError(error));
      return;
    }
    if (!this.ready && frame.t !== "welcome" && !(frame.t === "err" && frame.id === null)) {
      this.failPermanently(localError("malformed", "server sent data before welcome", "connection"));
      return;
    }
    this.dispatch(frame);
  }

  private dispatch(frame: ServerMessage): void {
    switch (frame.t) {
      case "welcome":
        if (frame.clientSessionId !== this.clientSessionId) {
          this.failPermanently(localError("malformed", "welcome changed the client session", "connection"));
          return;
        }
        if (this.ready) return;
        this.ready = true;
        this.authentication = Object.freeze({ authEpoch: frame.authEpoch, principal: frame.principal });
        if (this.authAttempt) this.sendAuth(this.authAttempt);
        this.flushState();
        this.startConnectionTimers();
        return;
      case "auth": {
        const attempt = this.authAttempt;
        if (!attempt || attempt.id !== frame.attemptId) return;
        this.authentication = Object.freeze({ authEpoch: frame.authEpoch, principal: frame.principal });
        this.resolveAuth(attempt, this.authentication);
        this.flushState();
        return;
      }
      case "transition":
        this.applyTransition(frame.id, frame.transition);
        return;
      case "event":
        this.applyLiveEvent(frame.id, frame.event);
        return;
      case "ok":
        this.applyResult(frame);
        return;
      case "err":
        this.applyError(frame.id, new DbzzClientError(frame.outcome));
        return;
      case "pong":
        return;
    }
  }

  private applyTransition(id: number, transition: SubscriptionTransition): void {
    const subscription = this.subscriptions.get(id);
    if (!subscription) return;
    if (subscription.kind !== "query") {
      this.failPermanently(localError("malformed", "event subscription received a query transition", "subscription"));
      return;
    }
    if (sameCursor(subscription.cursor, transition.to)) {
      if (transition.kind === "reset") subscription.resetRequested = false;
      this.advanceConvergence(id, transition.to.commitVersion);
      return;
    }
    if (subscription.resetRequested && transition.kind !== "reset") return;

    const predecessorMatches =
      transition.kind === "reset"
        ? transition.from === null || sameCursor(subscription.cursor, transition.from)
        : sameCursor(subscription.cursor, transition.from);
    if (!predecessorMatches) {
      this.requestReset(subscription);
      return;
    }
    if (!this.retainCursor(subscription, transition.to)) return;
    subscription.resetRequested = false;
    this.advanceConvergence(id, transition.to.commitVersion);

    switch (transition.kind) {
      case "reset":
      case "update":
        subscription.onUpdate(transition.value);
        break;
      case "revoked":
        subscription.onError?.(new DbzzClientError(transition.outcome));
        break;
      case "checkpoint":
      case "resume":
        break;
    }
  }

  private applyLiveEvent(
    id: number,
    event: Extract<ServerMessage, { t: "event" }>["event"],
  ): void {
    const subscription = this.subscriptions.get(id);
    if (!subscription) return;
    if (subscription.kind !== "event") {
      this.failPermanently(localError("malformed", "query subscription received a live event", "subscription"));
      return;
    }
    if (sameEventCursor(subscription.cursor, event.cursor)) return;
    if (
      event.kind === "row" &&
      subscription.cursor &&
      (subscription.cursor.generation !== event.cursor.generation ||
        event.cursor.sequence !== subscription.cursor.sequence + 1n)
    ) {
      subscription.cursor = event.cursor;
      subscription.onEvent(Object.freeze({ kind: "gap", cursor: event.cursor }));
      return;
    }
    subscription.cursor = event.cursor;
    subscription.onEvent(
      event.kind === "row"
        ? Object.freeze({ kind: "row", cursor: event.cursor, row: event.row })
        : Object.freeze({ kind: event.kind, cursor: event.cursor }),
    );
  }

  private applyResult(frame: Extract<ServerMessage, { t: "ok" }>): void {
    const request = this.pending.get(frame.id);
    if (!request) return;
    if (frame.kind !== request.kind) {
      this.failPermanently(localError("malformed", "result kind does not match its request", "operation"));
      return;
    }
    if (frame.kind === "query") {
      this.finishRequest(request, frame.value);
      return;
    }
    this.applyMutationReceipt(request, frame);
  }

  private applyMutationReceipt(request: PendingRequest, frame: MutationOkMessage): void {
    if (frame.receipt.mutationRequestId !== request.mutationRequestId) {
      this.failPermanently(localError("malformed", "mutation receipt changed its request identity", "idempotency"));
      return;
    }
    request.receipt = frame.receipt;
    request.result = frame.value;
    const obligations = new Set<number>();
    for (const id of frame.receipt.obligations) {
      const subscription = this.subscriptions.get(id);
      if (!subscription) continue;
      if (subscription.kind !== "query") {
        this.failPermanently(localError("malformed", "mutation receipt named a live event", "idempotency"));
        return;
      }
      if (!subscription.cursor || subscription.cursor.commitVersion < frame.receipt.commitVersion) {
        obligations.add(id);
      }
    }
    request.obligations = obligations;
    if (obligations.size === 0) this.finishRequest(request, frame.value);
  }

  private applyError(id: number | null, error: DbzzClientError): void {
    if (id === null) {
      if (error.retryable) {
        this.serverRetryFloorMs = Math.max(
          this.serverRetryFloorMs,
          Math.min(error.retryAfterMs ?? 0, MAX_RETRY_AFTER_MS),
        );
        this.socket?.close(1013, "retry later");
      } else if (
        error.code === "unauthenticated" ||
        error.code === "auth_unavailable" ||
        error.code === "auth_stale" ||
        error.code === "unauthorized"
      ) {
        this.blockAuthentication(error);
      } else {
        this.failPermanently(error);
      }
      return;
    }
    if (this.authAttempt?.id === id) {
      this.blockAuthentication(error);
      return;
    }
    const request = this.pending.get(id);
    if (request) {
      this.finishRequest(request, undefined, error);
      return;
    }
    const subscription = this.subscriptions.get(id);
    if (subscription) {
      subscription.onError?.(error);
      this.removeSubscription(id, false);
    }
  }

  private requestReset(subscription: QuerySubscription): void {
    if (subscription.resetRequested) return;
    subscription.resetRequested = true;
    if (!this.canSendOperations()) return;
    if (subscription.cursor) {
      this.sendFrame({
        v: PROTOCOL_VERSION,
        t: "reset",
        id: subscription.id,
        cursor: subscription.cursor,
      });
    } else {
      this.sendText(this.encodeSubscription(subscription, undefined));
    }
  }

  private retainCursor(subscription: QuerySubscription, cursor: SubscriptionCursor): boolean {
    let frame: string;
    let bytes: number;
    try {
      frame = this.encodeSubscription(subscription, cursor);
      bytes = this.frameBytes(frame, "subscription");
    } catch (error) {
      subscription.onError?.(
        error instanceof DbzzClientError
          ? error
          : localError("overloaded", "subscription cursor exceeds the client state limit", "subscription"),
      );
      this.removeSubscription(subscription.id, true);
      return false;
    }
    const nextTotal = this.pendingBytes - subscription.bytes + bytes;
    if (nextTotal > this.limits.maxPendingBytes) {
      subscription.onError?.(
        new DbzzClientError({
          code: "overloaded",
          retryable: true,
          retryAfterMs: this.reconnect.baseDelayMs,
          message: "subscription cursor exceeds the client state limit",
          resource: "subscription",
        }),
      );
      this.removeSubscription(subscription.id, true);
      return false;
    }
    this.pendingBytes = nextTotal;
    subscription.frame = frame;
    subscription.bytes = bytes;
    subscription.cursor = Object.freeze({ ...cursor });
    return true;
  }

  private advanceConvergence(subscriptionId: number, commitVersion: bigint): void {
    for (const request of [...this.pending.values()]) {
      if (
        request.kind === "mutation" &&
        request.receipt &&
        request.obligations?.has(subscriptionId) &&
        commitVersion >= request.receipt.commitVersion
      ) {
        request.obligations.delete(subscriptionId);
        if (request.obligations.size === 0) this.finishRequest(request, request.result);
      }
    }
  }

  private removeSubscription(id: number, sendUnsubscribe: boolean): void {
    const subscription = this.subscriptions.get(id);
    if (!subscription) return;
    this.subscriptions.delete(id);
    this.releasePersistent(subscription.bytes);
    if (sendUnsubscribe && this.canSendOperations()) {
      this.sendFrame({ v: PROTOCOL_VERSION, t: "unsub", id });
    }
    for (const request of [...this.pending.values()]) {
      if (request.kind === "mutation" && request.receipt && request.obligations?.delete(id)) {
        if (request.obligations.size === 0) this.finishRequest(request, request.result);
      }
    }
  }

  private finishRequest(
    request: PendingRequest,
    value?: unknown,
    error?: DbzzClientError,
  ): void {
    if (!this.pending.delete(request.id)) return;
    this.clock.clearTimeout(request.expiryHandle);
    this.releasePersistent(request.bytes);
    if (error) request.reject(error);
    else request.resolve(value);
  }

  private expireRequest(request: PendingRequest): void {
    if (this.pending.get(request.id) !== request) return;
    const committed = request.receipt !== undefined;
    const mutationMayHaveCommitted = request.kind === "mutation" && request.sentConnection !== undefined;
    this.finishRequest(
      request,
      undefined,
      committed
        ? localError(
            "convergence_unavailable",
            "committed mutation did not converge before its client retention deadline",
            "idempotency",
            true,
          )
        : mutationMayHaveCommitted
          ? localError("indeterminate", "mutation completion is unknown", "idempotency")
          : localError("deadline_exceeded", "client request deadline exceeded", "operation"),
    );
  }

  private flushState(): void {
    if (!this.canSendOperations()) return;
    const now = this.now();
    for (const subscription of this.subscriptions.values()) {
      if (subscription.sentConnection !== this.connectionSerial) this.sendSubscription(subscription);
    }
    for (const request of [...this.pending.values()]) {
      if (request.expiresAtMs <= now) this.expireRequest(request);
      else if (request.sentConnection !== this.connectionSerial) this.sendRequest(request);
    }
  }

  private sendRequest(request: PendingRequest): void {
    this.sendText(request.frame);
    request.sentConnection = this.connectionSerial;
  }

  private sendSubscription(subscription: Subscription): void {
    this.sendText(subscription.frame);
    subscription.sentConnection = this.connectionSerial;
  }

  private sendAuth(attempt: AuthAttempt): void {
    this.sendFrame({
      v: PROTOCOL_VERSION,
      t: "auth",
      attemptId: attempt.id,
      credential: attempt.credential,
    });
    attempt.sentConnection = this.connectionSerial;
  }

  private resolveAuth(attempt: AuthAttempt, authentication: DbzzAuthentication): void {
    if (this.authAttempt !== attempt) return;
    this.clock.clearTimeout(attempt.expiryHandle);
    this.authAttempt = undefined;
    attempt.resolve(Object.freeze({ ...authentication }));
  }

  private blockAuthentication(error: DbzzClientError): void {
    this.authBlocked = true;
    this.ready = false;
    if (this.authAttempt) {
      this.clock.clearTimeout(this.authAttempt.expiryHandle);
      this.authAttempt.reject(error);
      this.authAttempt = undefined;
    }
    for (const request of [...this.pending.values()]) this.finishRequest(request, undefined, error);
    for (const subscription of this.subscriptions.values()) subscription.onError?.(error);
    this.socket?.close(1008, "authentication failed");
  }

  private failPermanently(error: DbzzClientError): void {
    if (this.permanentFailure || this.closed) return;
    this.permanentFailure = true;
    this.clearReconnectTimer();
    if (this.authAttempt) {
      this.clock.clearTimeout(this.authAttempt.expiryHandle);
      this.authAttempt.reject(error);
      this.authAttempt = undefined;
    }
    for (const request of [...this.pending.values()]) this.finishRequest(request, undefined, error);
    for (const subscription of this.subscriptions.values()) subscription.onError?.(error);
    for (const subscription of this.subscriptions.values()) {
      this.releasePersistent(subscription.bytes);
    }
    this.subscriptions.clear();
    this.socket?.close(1002, "protocol failure");
  }

  private scheduleReconnect(): void {
    if (this.reconnectHandle !== undefined || this.socket || !this.hasReconnectWork()) return;
    const windowMs = Math.min(
      this.reconnect.maxDelayMs,
      this.reconnect.baseDelayMs * 2 ** Math.min(this.reconnectAttempt + 1, 30),
    );
    const random = this.random();
    if (!Number.isFinite(random) || random < 0 || random >= 1) {
      this.failPermanently(localError("internal", "client random source is invalid", "connection"));
      return;
    }
    const floor = Math.min(this.serverRetryFloorMs, MAX_RETRY_AFTER_MS);
    const minimum = Math.max(this.reconnect.baseDelayMs, floor);
    const ceiling = Math.max(minimum, windowMs);
    const delay = Math.min(
      MAX_RETRY_AFTER_MS,
      minimum + Math.floor(random * (ceiling - minimum + 1)),
    );
    this.serverRetryFloorMs = 0;
    this.reconnectAttempt++;
    this.reconnectHandle = this.clock.setTimeout(() => {
      this.reconnectHandle = undefined;
      this.ensureConnected();
    }, delay);
  }

  private startConnectionTimers(): void {
    this.clearConnectionTimers();
    const serial = this.connectionSerial;
    this.stableHandle = this.clock.setTimeout(() => {
      if (this.ready && this.connectionSerial === serial) this.reconnectAttempt = 0;
    }, this.reconnect.stableOpenMs);
    this.pingHandle = this.clock.setInterval(() => {
      if (this.ready && this.connectionSerial === serial) {
        this.sendFrame({ v: PROTOCOL_VERSION, t: "ping" });
      }
    }, 30_000);
  }

  private clearConnectionTimers(): void {
    if (this.stableHandle !== undefined) this.clock.clearTimeout(this.stableHandle);
    if (this.pingHandle !== undefined) this.clock.clearInterval(this.pingHandle);
    this.stableHandle = undefined;
    this.pingHandle = undefined;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectHandle !== undefined) this.clock.clearTimeout(this.reconnectHandle);
    this.reconnectHandle = undefined;
  }

  private hasReconnectWork(): boolean {
    return this.subscriptions.size > 0 || this.pending.size > 0 || this.authAttempt !== undefined;
  }

  private canSendOperations(): boolean {
    return this.socketOpen && this.ready && !this.authAttempt && this.socket !== null;
  }

  private sendFrame(frame: ClientMessage): void {
    const text = this.encodeClient(frame);
    this.frameBytes(text, "connection");
    this.sendText(text);
  }

  private sendText(text: string): void {
    const socket = this.socket;
    if (!socket || !this.socketOpen) return;
    try {
      socket.send(text);
    } catch {
      socket.close();
      this.handleClose(socket);
    }
  }

  private encodeClient(frame: ClientMessage): string {
    try {
      return encode(parseClientMessage(frame));
    } catch (error) {
      if (error instanceof ProtocolError) {
        throw localError(error.code, error.message, "operation");
      }
      throw error;
    }
  }

  private encodeCall(id: number, ref: string, args: unknown): string {
    try {
      return encode(parseCallRequest({ v: PROTOCOL_VERSION, t: "call", id, ref, args }));
    } catch (error) {
      if (error instanceof ProtocolError) {
        throw localError("validation", "procedure request cannot be encoded", "operation");
      }
      throw error;
    }
  }

  private encodeSubscription(
    subscription: QuerySubscription,
    cursor: SubscriptionCursor | undefined,
  ): string {
    return this.encodeClient({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: subscription.id,
      ref: subscription.ref,
      args: subscription.args,
      ...(cursor ? { cursor } : {}),
    });
  }

  private reservePersistent(frame: string, resource: ResourceClass): number {
    const bytes = this.frameBytes(frame, resource);
    if (
      this.pendingItems >= this.limits.maxPendingItems ||
      bytes > this.limits.maxPendingBytes - this.pendingBytes
    ) {
      throw new DbzzClientError({
        code: "overloaded",
        retryable: true,
        retryAfterMs: this.reconnect.baseDelayMs,
        message: "client pending state is full",
        resource,
      });
    }
    this.pendingItems++;
    this.pendingBytes += bytes;
    return bytes;
  }

  private reserveTransient(frame: string, resource: ResourceClass): () => void {
    const bytes = this.reservePersistent(frame, resource);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.releasePersistent(bytes);
    };
  }

  private releasePersistent(bytes: number): void {
    this.pendingItems--;
    this.pendingBytes -= bytes;
  }

  private frameBytes(frame: string, resource: ResourceClass): number {
    const bytes = encoder.encode(frame).byteLength;
    if (bytes > this.limits.maxFrameBytes) {
      throw new DbzzClientError({
        code: "overloaded",
        retryable: false,
        message: "client frame exceeds the configured limit",
        resource,
      });
    }
    return bytes;
  }

  private allocateId(): number {
    if (this.nextId > MAX_PROTOCOL_ID) {
      throw localError("unavailable", "client protocol ID space is exhausted", "operation");
    }
    return this.nextId++;
  }

  private assertUsable(): void {
    if (this.closed) throw localError("unavailable", "client is closed", "connection");
    if (this.permanentFailure) throw localError("unavailable", "client stopped after a protocol failure", "connection");
    if (this.authBlocked) throw localError("unauthenticated", "client requires a new credential", "connection");
  }

  private now(): number {
    const now = this.clock.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("clock must return non-negative integer milliseconds");
    return now;
  }

  private protocolError(error: unknown): DbzzClientError {
    return error instanceof ProtocolError
      ? localError(error.code, error.message, "connection")
      : localError("malformed", "invalid protocol payload", "connection");
  }

  private httpHeaders(): Record<string, string> {
    return this.credential.kind === "bearer"
      ? { "content-type": "application/json", authorization: `Bearer ${this.credential.token}` }
      : { "content-type": "application/json" };
  }

  private createFetchController(signal: AbortSignal | undefined, timeoutMs?: number): FetchControl {
    const controller = new AbortController();
    if (signal?.aborted) controller.abort(signal.reason);
    const source = signal;
    const onAbort = source && !source.aborted ? () => controller.abort(source.reason) : undefined;
    if (onAbort) source!.addEventListener("abort", onAbort, { once: true });
    const timeoutHandle = timeoutMs === undefined
      ? undefined
      : this.clock.setTimeout(() => controller.abort(), timeoutMs);
    this.activeFetches.add(controller);
    return { controller, signal, onAbort, timeoutHandle };
  }

  private releaseFetchController(control: FetchControl): void {
    if (control.onAbort) control.signal!.removeEventListener("abort", control.onAbort);
    if (control.timeoutHandle !== undefined) this.clock.clearTimeout(control.timeoutHandle);
    this.activeFetches.delete(control.controller);
    control.controller.abort();
  }

  private async readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) return text + decoder.decode();
        bytes += part.value.byteLength;
        if (bytes > maxBytes) {
          throw localError("overloaded", "response exceeds the client frame limit", "operation");
        }
        text += decoder.decode(part.value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
  }
}
