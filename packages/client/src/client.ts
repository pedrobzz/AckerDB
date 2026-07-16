import {
  MAX_PROTOCOL_ID,
  MAX_RETRY_AFTER_MS,
  PROTOCOL_VERSION,
  ProtocolError,
  WireError,
  decode,
  encode,
  getRef,
  parseCallRequest,
  parseCallResponse,
  parseClientMessage,
  parseCredential,
  parseServerMessage,
  parseSseMessage,
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
  type SseAckRequest,
  type SseChunkMessage,
  type SseDoneMessage,
  type SseErrorMessage,
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
  readonly maxSseAckAgeMs: number;
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

/**
 * Public connection lifecycle. `suspended` and `resuming` are reserved for the
 * native runtime adapter and are never produced by this client today.
 */
export type DbzzConnectionState =
  | { readonly phase: "connecting" }
  | { readonly phase: "ready"; readonly authentication: DbzzAuthentication }
  | { readonly phase: "reconnecting" }
  | { readonly phase: "authentication-blocked"; readonly error: DbzzClientError }
  | { readonly phase: "terminal-error"; readonly error: DbzzClientError }
  | { readonly phase: "closed" }
  | { readonly phase: "suspended" }
  | { readonly phase: "resuming" };

/**
 * Public authentication lifecycle, derived from the same protocol facts as
 * {@link DbzzConnectionState} and published in the same transition turns.
 *
 * - `authenticating`: a credential presentation is in flight — the connect
 *   handshake (`hello`/`welcome`) or an explicit `refreshCredential` attempt.
 *   `credential` is the kind being presented; the server treats an anonymous
 *   presentation on an established session as a sign-out.
 * - `unauthenticated`: the server confirmed an anonymous session principal.
 * - `authenticated`: the server confirmed a verified session principal.
 * - `refresh-required`: the server rejected the credential or an attempt timed
 *   out; the client will not reconnect until `refreshCredential` supplies a
 *   new credential. The same error is the connection state's
 *   `authentication-blocked` error.
 * - `failed`: the client stopped permanently; no credential can recover it.
 * - `closed`: the client was closed.
 */
export type DbzzAuthenticationState =
  | { readonly phase: "authenticating"; readonly credential: Credential["kind"] }
  | { readonly phase: "unauthenticated"; readonly authentication: DbzzAuthentication }
  | { readonly phase: "authenticated"; readonly authentication: DbzzAuthentication }
  | { readonly phase: "refresh-required"; readonly error: DbzzClientError }
  | { readonly phase: "failed"; readonly error: DbzzClientError }
  | { readonly phase: "closed" };

export type DbzzLiveEvent<Row> =
  | { readonly kind: "row"; readonly cursor: LiveEventCursor; readonly row: Row }
  | { readonly kind: "gap"; readonly cursor: LiveEventCursor }
  | { readonly kind: "reset"; readonly cursor: LiveEventCursor };

export interface DbzzCallOptions {
  readonly signal?: AbortSignal;
}

export interface DbzzSubscribeOptions {
  /**
   * Fires when the server authoritatively confirms the already-held value
   * without redelivering it: applied `resume` and `checkpoint` transitions,
   * and deliveries landing exactly on the held cursor. Together with
   * `onUpdate` this makes "the held data is current on this connection"
   * observable, which is what reconnect-aware consumers (the React binding's
   * stale/fresh distinction) need. Value deliveries keep flowing through
   * `onUpdate`; this never carries data.
   */
  readonly onCursorConfirmed?: () => void;
}

export const DBZZ_CLIENT_LIMITS: DbzzClientLimits = Object.freeze({
  maxPendingItems: 4_096,
  maxPendingBytes: 16 * 1024 * 1024,
  maxQueryAgeMs: 30_000,
  maxMutationAgeMs: 24 * 60 * 60 * 1_000,
  maxFrameBytes: 1024 * 1024,
  maxSseBufferBytes: 1024 * 1024,
  maxSseAckAgeMs: 5_000,
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
  readonly onCursorConfirmed?: () => void;
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

interface CancelableResponse {
  cancel(reason?: unknown): Promise<void>;
}

interface SseResponseReader extends CancelableResponse {
  read(): Promise<
    | { readonly done: true; readonly value?: undefined }
    | { readonly done: false; readonly value: Uint8Array }
  >;
  releaseLock(): void;
}

const encoder = new TextEncoder();
const UUID_RANDOM_MASK = (1n << 74n) - 1n;
const SSE_STREAM_HEADER = "x-dbzz-sse-stream";
const SSE_STALL_HEADER = "x-dbzz-sse-max-stall-ms";
const MAX_SSE_TOKEN_LENGTH = 128;
const MAX_SSE_ACK_ATTEMPTS = 8;

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

function cancelWithoutWaiting(target: CancelableResponse, reason?: unknown): void {
  try {
    void Promise.resolve(target.cancel(reason)).catch(() => {});
  } catch {
    // Cleanup cannot inherit control from an external cancellation implementation.
  }
}

function releaseReaderLock(reader: SseResponseReader): void {
  try {
    reader.releaseLock();
  } catch {
    // A pending external read may make immediate lock release impossible.
  }
}

async function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  error: DbzzClientError,
  onLate?: (value: T) => void,
): Promise<T> {
  const discard = (value: T): never => {
    try {
      onLate?.(value);
    } catch {
      // Late external values cannot regain ownership or replace the cancellation outcome.
    }
    throw error;
  };
  const observed = promise.then((value) => (signal.aborted ? discard(value) : value));
  if (signal.aborted) {
    void observed.catch(() => {});
    throw error;
  }
  let rejectInterrupted!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectInterrupted = () => reject(error);
  });
  const onAbort = (): void => rejectInterrupted();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const value = await Promise.race([observed, interrupted]);
    return signal.aborted ? discard(value) : value;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
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

const CONNECTING_STATE: DbzzConnectionState = Object.freeze({ phase: "connecting" });
const RECONNECTING_STATE: DbzzConnectionState = Object.freeze({ phase: "reconnecting" });
const CLOSED_STATE: DbzzConnectionState = Object.freeze({ phase: "closed" });

const AUTHENTICATING_ANONYMOUS: DbzzAuthenticationState = Object.freeze({
  phase: "authenticating",
  credential: "anonymous",
});
const AUTHENTICATING_BEARER: DbzzAuthenticationState = Object.freeze({
  phase: "authenticating",
  credential: "bearer",
});
const CLOSED_AUTHENTICATION_STATE: DbzzAuthenticationState = Object.freeze({ phase: "closed" });

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
  private connectionState: DbzzConnectionState = CONNECTING_STATE;
  private readonly connectionStateListeners = new Set<(state: DbzzConnectionState) => void>();
  private authenticationState: DbzzAuthenticationState;
  private readonly authenticationStateListeners = new Set<(state: DbzzAuthenticationState) => void>();
  private connectRequested = false;
  private everReady = false;
  private blockingError?: DbzzClientError;
  private terminalError?: DbzzClientError;

  constructor(options: DbzzClientOptions) {
    this.httpUrl = options.url.replace(/\/$/, "");
    if (!/^https?:\/\//.test(this.httpUrl)) throw new TypeError("url must use http or https");
    this.wsUrl = `${this.httpUrl.replace(/^http/, "ws")}/ws`;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.random = options.random ?? SYSTEM_RANDOM;
    this.createWebSocket = options.createWebSocket ?? SYSTEM_SOCKET_FACTORY;
    this.fetcher = options.fetch ?? SYSTEM_FETCH;
    this.credential = freezeCredential(options.credential);
    this.authenticationState =
      this.credential.kind === "anonymous" ? AUTHENTICATING_ANONYMOUS : AUTHENTICATING_BEARER;
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

  /** Immutable snapshot; the same object is returned until the next transition. */
  get currentConnectionState(): DbzzConnectionState {
    return this.connectionState;
  }

  /** Notifies on connection-state transitions only; read the snapshot for the current value. */
  subscribeConnectionState(listener: (state: DbzzConnectionState) => void): () => void {
    this.connectionStateListeners.add(listener);
    return () => {
      this.connectionStateListeners.delete(listener);
    };
  }

  /** Immutable snapshot; the same object is returned until the next transition. */
  get currentAuthenticationState(): DbzzAuthenticationState {
    return this.authenticationState;
  }

  /** Notifies on authentication-state transitions only; read the snapshot for the current value. */
  subscribeAuthenticationState(listener: (state: DbzzAuthenticationState) => void): () => void {
    this.authenticationStateListeners.add(listener);
    return () => {
      this.authenticationStateListeners.delete(listener);
    };
  }

  /**
   * Establishes standing connection demand: the client dials now and keeps
   * reconnecting after drops until close(), even with no operations in flight.
   * No-op when closed, failed, blocked, or connected.
   */
  connect(): void {
    this.connectRequested = true;
    this.ensureConnected();
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
    this.blockingError = undefined;
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
      const error = localError("auth_unavailable", "authentication timed out", "connection");
      this.blockingError = error;
      attempt.reject(error);
      this.socket?.close(1008, "authentication timed out");
      this.publishConnectionState();
    }, this.limits.maxQueryAgeMs);
    this.authAttempt = attempt;
    if (this.ready) this.sendAuth(attempt);
    else this.ensureConnected();
    // Published last: a listener may reenter close(), which must find the
    // installed attempt and its expiry timer so it can release them.
    this.publishConnectionState();
    return result;
  }

  subscribe<A, R = unknown>(
    ref: QueryRef<A, R> | string,
    args: A,
    onUpdate: (value: R) => void,
    onError?: (error: DbzzClientError) => void,
    options: DbzzSubscribeOptions = {},
  ): () => void {
    this.assertUsable();
    const id = this.allocateId();
    const address = getRef(ref as FunctionReference | string);
    const frame = this.encodeSubscriptionOrReject(id, address, args);
    const bytes = this.reservePersistent(frame, "subscription");
    const subscription: QuerySubscription = {
      kind: "query",
      id,
      ref: address,
      args,
      onUpdate: onUpdate as (value: unknown) => void,
      onError,
      onCursorConfirmed: options.onCursorConfirmed,
      resetRequested: false,
      frame,
      bytes,
    };
    this.subscriptions.set(id, subscription);
    this.ensureConnected();
    if (this.canSendOperations()) this.sendSubscription(subscription);
    return () => this.removeSubscription(id, true);
  }

  subscribeEvent<A, Row = unknown>(
    ref: EventRef<A, Row> | string,
    args: A,
    onEvent: (event: DbzzLiveEvent<Row>) => void,
    onError?: (error: DbzzClientError) => void,
  ): () => void {
    this.assertUsable();
    const id = this.allocateId();
    const address = getRef(ref as FunctionReference | string);
    const frame = this.encodeSubscriptionOrReject(id, address, args);
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
    if (options.signal?.aborted) {
      throw localError("unavailable", "procedure request was canceled", "operation");
    }
    const id = this.allocateId();
    const body = this.encodeCall(id, getRef(ref as FunctionReference | string), args);
    const release = this.reserveTransient(body, "operation");
    const fetchControl = this.createFetchController(options.signal, this.limits.maxQueryAgeMs);
    try {
      let response: Response;
      try {
        // Response acquisition must settle through the owned controller even
        // when the injected fetch ignores its signal, so abort and close()
        // cannot leave the caller or its transient reservation pending.
        response = await raceWithAbort(
          (async () =>
            this.fetcher(`${this.httpUrl}/api/call`, {
              method: "POST",
              headers: this.httpHeaders(),
              body,
              signal: fetchControl.controller.signal,
            }))(),
          fetchControl.controller.signal,
          localError("indeterminate", "procedure completion is unknown", "operation"),
          (late) => {
            if (late.body) cancelWithoutWaiting(late.body, fetchControl.controller.signal.reason);
          },
        );
      } catch {
        throw localError("indeterminate", "procedure completion is unknown", "operation");
      }
      let text: string;
      try {
        text = await this.readBoundedResponse(
          response,
          this.limits.maxFrameBytes,
          fetchControl.controller.signal,
        );
      } catch (error) {
        if (error instanceof DbzzClientError && error.code !== "unavailable") throw error;
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

  /**
   * Acknowledged SSE stream: `Chunk` is the ref's server-validated yield
   * type. Chunk N's receiver credit is sent when the consumer requests chunk
   * N+1, so iteration pace is the backpressure signal end to end.
   */
  async *sse<A, Chunk = unknown>(
    ref: SseRef<A, Chunk> | string,
    args: A,
    options: DbzzCallOptions = {},
  ): AsyncGenerator<Chunk, void, undefined> {
    this.assertUsable();
    if (options.signal?.aborted) {
      throw localError("unavailable", "SSE request was canceled", "sse");
    }
    const id = this.allocateId();
    const body = this.encodeCall(id, getRef(ref as FunctionReference | string), args);
    const releaseReservation = this.reserveTransient(body, "sse");
    const fetchControl = this.createFetchController(options.signal);
    let responseBody: CancelableResponse | undefined;
    let reader: SseResponseReader | undefined;
    let cleanupStarted = false;
    let cleanupReason: unknown;
    const cancellationError = localError("unavailable", "SSE request was canceled", "sse");
    let interruptWait: (() => void) | undefined;
    const waitForOwnership = async <T>(promise: Promise<T>): Promise<T> => {
      if (cleanupStarted) {
        void promise.catch(() => {});
        throw cancellationError;
      }
      let rejectInterrupted!: () => void;
      const interrupted = new Promise<never>((_resolve, reject) => {
        rejectInterrupted = () => reject(cancellationError);
      });
      interruptWait = rejectInterrupted;
      try {
        const value = await Promise.race([promise, interrupted]);
        if (cleanupStarted) throw cancellationError;
        return value;
      } finally {
        if (interruptWait === rejectInterrupted) interruptWait = undefined;
      }
    };
    const cancelOwnedResponse = (): void => {
      const ownedReader = reader;
      const ownedBody = ownedReader ? undefined : responseBody;
      reader = undefined;
      responseBody = undefined;
      if (ownedReader) {
        cancelWithoutWaiting(ownedReader, cleanupReason);
        releaseReaderLock(ownedReader);
      } else if (ownedBody) {
        cancelWithoutWaiting(ownedBody, cleanupReason);
      }
    };
    const cleanup = (reason?: unknown): void => {
      if (!cleanupStarted) {
        cleanupStarted = true;
        cleanupReason = reason;
        fetchControl.controller.signal.removeEventListener("abort", onAbort);
        this.releaseFetchController(fetchControl);
        releaseReservation();
        cancelOwnedResponse();
      }
    };
    const onAbort = (): void => {
      cleanup(fetchControl.controller.signal.reason);
      interruptWait?.();
    };
    fetchControl.controller.signal.addEventListener("abort", onAbort, { once: true });
    if (fetchControl.controller.signal.aborted) onAbort();
    try {
      if (cleanupStarted) {
        throw localError("unavailable", "SSE request was canceled", "sse");
      }
      let response: Response;
      const pendingResponse = (async () =>
        this.fetcher(`${this.httpUrl}/api/sse`, {
          method: "POST",
          headers: this.httpHeaders(),
          body,
          signal: fetchControl.controller.signal,
        }))().then((candidate) => {
          if (!cleanupStarted) return candidate;
          if (candidate.body) cancelWithoutWaiting(candidate.body, cleanupReason);
          throw cancellationError;
        });
      try {
        response = await waitForOwnership(pendingResponse);
      } catch (error) {
        if (error === cancellationError || cleanupStarted || fetchControl.controller.signal.aborted) {
          throw cancellationError;
        }
        throw localError("indeterminate", "SSE procedure completion is unknown", "sse");
      }
      responseBody = response.body ?? undefined;
      if (cleanupStarted) {
        cancelOwnedResponse();
        throw localError("unavailable", "SSE response was canceled", "sse");
      }
      if (!response.ok) {
        responseBody = undefined;
        const text = await this.readBoundedResponse(
          response,
          this.limits.maxFrameBytes,
          fetchControl.controller.signal,
          "sse",
        );
        let parsed: ServerMessage;
        try {
          parsed = parseServerMessage(decode(text));
        } catch (error) {
          throw this.protocolError(error, "sse");
        }
        if (parsed.t !== "err" || (parsed.id !== null && parsed.id !== id)) {
          throw localError("malformed", "SSE error response does not match its request", "sse");
        }
        throw new DbzzClientError(parsed.outcome);
      }
      if (response.status !== 200) {
        throw localError("malformed", "SSE endpoint returned an unexpected success status", "sse");
      }
      const stream = this.sseStream(response);
      const ackAgeMs = this.sseAckAge(response);
      if (!response.body) throw localError("malformed", "SSE response has no body", "sse");

      const streamReader = response.body.getReader();
      responseBody = undefined;
      reader = streamReader;
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      let buffer = "";
      let pendingBytes = 0;
      let strippedPrefixBytes = 0;
      let scanFrom = 0;
      let decoderAtStart = true;
      const appendDecoded = (text: string): void => {
        if (decoderAtStart && text.length !== 0) {
          decoderAtStart = false;
          if (text.startsWith("\uFEFF")) {
            strippedPrefixBytes = 3;
            text = text.slice(1);
          }
        }
        buffer += text;
      };
      let expectedSequence = 1;
      for (;;) {
        let payload: string | null = null;
        for (;;) {
          const lfBoundary = buffer.indexOf("\n\n", scanFrom);
          const crlfBoundary = buffer.indexOf("\r\n\r\n", scanFrom);
          const useCrlf = crlfBoundary !== -1 && (lfBoundary === -1 || crlfBoundary < lfBoundary);
          const boundary = useCrlf ? crlfBoundary : lfBoundary;
          if (boundary === -1) {
            scanFrom = Math.max(0, buffer.length - 3);
            break;
          }
          const consumedEnd = boundary + (useCrlf ? 4 : 2);
          const block = buffer.slice(0, boundary).replaceAll("\r\n", "\n");
          pendingBytes -=
            encoder.encode(buffer.slice(0, consumedEnd)).byteLength + strippedPrefixBytes;
          strippedPrefixBytes = 0;
          buffer = buffer.slice(consumedEnd);
          scanFrom = 0;
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
          if (eventName !== "message") {
            throw localError("malformed", "unknown SSE event type", "sse");
          }
          payload = data.join("\n");
          break;
        }
        if (payload === null) {
          let part: Awaited<ReturnType<SseResponseReader["read"]>>;
          try {
            part = await waitForOwnership((async () => streamReader.read())());
          } catch (error) {
            if (cleanupStarted || fetchControl.controller.signal.aborted) {
              throw cancellationError;
            }
            throw error;
          }
          if (cleanupStarted || fetchControl.controller.signal.aborted) {
            throw cancellationError;
          }
          if (part.done) {
            try {
              appendDecoded(decoder.decode());
            } catch (error) {
              throw this.protocolError(error, "sse");
            }
            if (buffer.length !== 0) {
              throw localError("malformed", "SSE stream ended mid-event", "sse");
            }
            throw localError("indeterminate", "SSE stream ended before completion", "sse");
          }
          pendingBytes += part.value.byteLength;
          if (pendingBytes > this.limits.maxSseBufferBytes) {
            throw localError("overloaded", "SSE input exceeds the client buffer limit", "sse");
          }
          try {
            appendDecoded(decoder.decode(part.value, { stream: true }));
          } catch (error) {
            throw this.protocolError(error, "sse");
          }
          continue;
        }

        let frame: SseChunkMessage | SseDoneMessage | SseErrorMessage;
        try {
          frame = parseSseMessage(decode(payload));
        } catch (error) {
          throw this.protocolError(error, "sse");
        }
        if (frame.seq !== expectedSequence) {
          throw localError(
            "malformed",
            `SSE sequence ${frame.seq} does not match expected ${expectedSequence}`,
            "sse",
          );
        }
        if (frame.t === "sse_chunk") {
          yield frame.value as Chunk;
          await this.acknowledgeSse(stream, frame, ackAgeMs, fetchControl.controller.signal);
          expectedSequence++;
          continue;
        }
        await this.acknowledgeSse(stream, frame, ackAgeMs, fetchControl.controller.signal);
        if (frame.t === "sse_done") return;
        throw new DbzzClientError(frame.outcome);
      }
    } catch (error) {
      if (error instanceof DbzzClientError) throw error;
      throw localError("indeterminate", "SSE response was interrupted", "sse");
    } finally {
      cleanup();
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
    this.publishConnectionState();
    this.connectionStateListeners.clear();
    this.authenticationStateListeners.clear();
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

  private publishConnectionState(): void {
    // Both snapshots are derived from the same transition before either
    // listener set runs, so no listener can observe them disagreeing.
    const authenticationBefore = this.authenticationState;
    const authenticationAfter = this.deriveAuthenticationState(authenticationBefore);
    this.authenticationState = authenticationAfter;
    const connectionBefore = this.connectionState;
    const connectionAfter = this.deriveConnectionState(connectionBefore);
    this.connectionState = connectionAfter;
    if (authenticationAfter !== authenticationBefore) {
      for (const listener of [...this.authenticationStateListeners]) {
        // A reentrant transition already notified every listener with the
        // newer state; delivering the superseded one would reorder time.
        if (this.authenticationState !== authenticationAfter) return;
        listener(authenticationAfter);
      }
    }
    if (connectionAfter === connectionBefore) return;
    for (const listener of [...this.connectionStateListeners]) {
      // A reentrant transition already notified every listener with the newer
      // state; delivering the superseded one afterwards would reorder time.
      if (this.connectionState !== connectionAfter) return;
      listener(connectionAfter);
    }
  }

  private deriveConnectionState(current: DbzzConnectionState): DbzzConnectionState {
    if (this.closed) return CLOSED_STATE;
    if (this.permanentFailure) {
      return current.phase === "terminal-error" && current.error === this.terminalError
        ? current
        : Object.freeze({ phase: "terminal-error" as const, error: this.terminalError! });
    }
    if (this.authBlocked) {
      return current.phase === "authentication-blocked" && current.error === this.blockingError
        ? current
        : Object.freeze({ phase: "authentication-blocked" as const, error: this.blockingError! });
    }
    if (this.ready) {
      return current.phase === "ready" && current.authentication === this.authentication
        ? current
        : Object.freeze({ phase: "ready" as const, authentication: this.authentication! });
    }
    return this.everReady ? RECONNECTING_STATE : CONNECTING_STATE;
  }

  private deriveAuthenticationState(current: DbzzAuthenticationState): DbzzAuthenticationState {
    if (this.closed) return CLOSED_AUTHENTICATION_STATE;
    if (this.permanentFailure) {
      return current.phase === "failed" && current.error === this.terminalError
        ? current
        : Object.freeze({ phase: "failed" as const, error: this.terminalError! });
    }
    if (this.authBlocked) {
      return current.phase === "refresh-required" && current.error === this.blockingError
        ? current
        : Object.freeze({ phase: "refresh-required" as const, error: this.blockingError! });
    }
    // A pending refresh attempt outranks a live session: the server already
    // retired the previous epoch when the attempt reached it, and this client
    // withholds operations until the presented credential is confirmed.
    const pending = this.authAttempt;
    if (pending !== undefined || !this.ready) {
      return (pending?.credential ?? this.credential).kind === "anonymous"
        ? AUTHENTICATING_ANONYMOUS
        : AUTHENTICATING_BEARER;
    }
    const phase =
      this.authentication!.principal === "anonymous" ? ("unauthenticated" as const) : ("authenticated" as const);
    return current.phase === phase && current.authentication === this.authentication
      ? current
      : Object.freeze({ phase, authentication: this.authentication! });
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
    this.publishConnectionState();
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
        this.everReady = true;
        this.authentication = Object.freeze({ authEpoch: frame.authEpoch, principal: frame.principal });
        if (this.authAttempt) this.sendAuth(this.authAttempt);
        this.flushState();
        this.startConnectionTimers();
        // Published last: a listener may reenter close(), which must find the
        // connection timers already installed so it can release them.
        this.publishConnectionState();
        return;
      case "auth": {
        const attempt = this.authAttempt;
        if (!attempt || attempt.id !== frame.attemptId) return;
        this.authentication = Object.freeze({ authEpoch: frame.authEpoch, principal: frame.principal });
        this.resolveAuth(attempt, this.authentication);
        this.flushState();
        this.publishConnectionState();
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
      // A delivery landing exactly on the held cursor (typically the resume
      // acknowledgment after reconnect) authoritatively confirms the held
      // value — unless the client is still demanding a reset.
      if (!subscription.resetRequested) subscription.onCursorConfirmed?.();
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
        subscription.onCursorConfirmed?.();
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
    this.blockingError = error;
    if (this.authAttempt) {
      this.clock.clearTimeout(this.authAttempt.expiryHandle);
      this.authAttempt.reject(error);
      this.authAttempt = undefined;
    }
    for (const request of [...this.pending.values()]) this.finishRequest(request, undefined, error);
    for (const subscription of this.subscriptions.values()) subscription.onError?.(error);
    this.socket?.close(1008, "authentication failed");
    this.publishConnectionState();
  }

  private failPermanently(error: DbzzClientError): void {
    if (this.permanentFailure || this.closed) return;
    this.permanentFailure = true;
    this.terminalError = error;
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
    this.publishConnectionState();
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
    return (
      this.connectRequested ||
      this.subscriptions.size > 0 ||
      this.pending.size > 0 ||
      this.authAttempt !== undefined
    );
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

  // Subscription arguments are caller-supplied values, so unencodable ones
  // (non-finite numbers, functions, ...) surface as the exact validation
  // rejection rather than a raw wire error.
  private encodeSubscriptionOrReject(id: number, ref: string, args: unknown): string {
    try {
      return this.encodeClient({ v: PROTOCOL_VERSION, t: "sub", id, ref, args });
    } catch (error) {
      if (error instanceof WireError) {
        throw localError("validation", error.message, "subscription");
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

  private protocolError(error: unknown, resource: ResourceClass = "connection"): DbzzClientError {
    return error instanceof ProtocolError
      ? localError(error.code, error.message, resource)
      : localError("malformed", "invalid protocol payload", resource);
  }

  private sseStream(response: Response): string {
    const stream = response.headers.get(SSE_STREAM_HEADER);
    if (
      stream === null ||
      stream.length === 0 ||
      stream.length > MAX_SSE_TOKEN_LENGTH ||
      encoder.encode(stream).byteLength > MAX_SSE_TOKEN_LENGTH ||
      stream.trim() !== stream
    ) {
      throw localError("malformed", `SSE response requires a bounded ${SSE_STREAM_HEADER} header`, "sse");
    }
    return stream;
  }

  private sseAckAge(response: Response): number {
    const header = response.headers.get(SSE_STALL_HEADER);
    if (header === null) {
      throw localError("malformed", `SSE response requires ${SSE_STALL_HEADER}`, "sse");
    }
    if (!/^[1-9]\d{0,15}$/.test(header)) {
      throw localError("malformed", `${SSE_STALL_HEADER} must be positive integer milliseconds`, "sse");
    }
    const value = Number(header);
    if (!Number.isSafeInteger(value)) {
      throw localError("malformed", `${SSE_STALL_HEADER} must be safe integer milliseconds`, "sse");
    }
    return Math.min(value, MAX_RETRY_AFTER_MS, this.limits.maxSseAckAgeMs);
  }

  private async acknowledgeSse(
    stream: string,
    frame: SseChunkMessage | SseDoneMessage | SseErrorMessage,
    maxAgeMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const acknowledgment: SseAckRequest = {
      v: PROTOCOL_VERSION,
      t: "sse_ack",
      stream,
      seq: frame.seq,
      proof: frame.proof,
    };
    const body = encode(acknowledgment);
    this.frameBytes(body, "sse");
    const startedAt = this.now();
    const deadlineAt = Math.min(Number.MAX_SAFE_INTEGER, startedAt + maxAgeMs);
    let attempts = 0;

    for (;;) {
      attempts++;
      let retryAfterMs = 0;
      try {
        const result = await this.withinSseAckDeadline(signal, deadlineAt, async (attemptSignal) => {
          const cancellationError = localError("unavailable", "SSE acknowledgment was canceled", "sse");
          const response = await raceWithAbort(
            (async () =>
              this.fetcher(`${this.httpUrl}/api/sse/ack`, {
                method: "POST",
                headers: { "content-type": "text/plain;charset=UTF-8" },
                body,
                signal: attemptSignal,
              }))(),
            attemptSignal,
            cancellationError,
            (late) => {
              if (late.body) cancelWithoutWaiting(late.body, attemptSignal.reason);
            },
          );
          if (attemptSignal.aborted) {
            if (response.body) cancelWithoutWaiting(response.body, attemptSignal.reason);
            throw cancellationError;
          }
          if (response.status === 204) {
            // Spec fetches model No Content as a null body; Bun's native
            // fetch models it as an empty stream. Both are exact — anything
            // that actually delivers bytes is not.
            const body = response.body;
            if (body === null) return null;
            const reader = body.getReader();
            let empty = false;
            try {
              const part = await raceWithAbort(
                (async () => reader.read())(),
                attemptSignal,
                cancellationError,
              );
              if (!part.done) {
                throw localError("malformed", "SSE acknowledgment 204 response must not have a body", "sse");
              }
              empty = true;
              return null;
            } finally {
              if (!empty) cancelWithoutWaiting(reader, attemptSignal.reason);
              releaseReaderLock(reader);
            }
          }

          const text = await this.readBoundedResponse(
            response,
            this.limits.maxFrameBytes,
            attemptSignal,
            "sse",
          );
          if (attemptSignal.aborted) throw cancellationError;
          let parsed: ServerMessage;
          try {
            parsed = parseServerMessage(decode(text));
          } catch (error) {
            throw this.protocolError(error, "sse");
          }
          if (parsed.t !== "err" || parsed.id !== null) {
            throw localError("malformed", "SSE acknowledgment returned an invalid response", "sse");
          }
          const error = new DbzzClientError(parsed.outcome);
          if ((response.status === 429 || response.status === 503) && error.retryable) {
            return Math.max(error.retryAfterMs ?? 0, this.retryAfter(response));
          }
          throw error;
        });
        if (result === null) return;
        retryAfterMs = result;
      } catch (error) {
        if (error instanceof DbzzClientError) throw error;
        if (signal.aborted) {
          throw localError("unavailable", "SSE acknowledgment was canceled", "sse");
        }
      }

      if (attempts >= MAX_SSE_ACK_ATTEMPTS) {
        throw localError("deadline_exceeded", "SSE acknowledgment retry limit exceeded", "sse");
      }
      const remainingMs = deadlineAt - this.now();
      if (remainingMs <= 0) {
        throw localError("deadline_exceeded", "SSE acknowledgment deadline exceeded", "sse");
      }
      const random = this.random();
      if (!Number.isFinite(random) || random < 0 || random >= 1) {
        throw localError("internal", "client random source is invalid", "sse");
      }
      const jitterCeiling = Math.min(
        this.reconnect.maxDelayMs,
        this.reconnect.baseDelayMs * 2 ** Math.min(attempts - 1, 30),
      );
      const delayMs = Math.max(
        retryAfterMs,
        Math.floor(random * (jitterCeiling + 1)),
      );
      if (delayMs >= remainingMs) {
        throw localError("deadline_exceeded", "SSE acknowledgment cannot retry before its deadline", "sse");
      }
      await this.waitForSseRetry(delayMs, signal);
    }
  }

  private async withinSseAckDeadline<T>(
    signal: AbortSignal,
    deadlineAt: number,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (signal.aborted) throw localError("unavailable", "SSE acknowledgment was canceled", "sse");
    const remainingMs = deadlineAt - this.now();
    if (remainingMs <= 0) {
      throw localError("deadline_exceeded", "SSE acknowledgment deadline exceeded", "sse");
    }
    const controller = new AbortController();
    let timeoutHandle: unknown;
    let rejectInterrupted!: (error: DbzzClientError) => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectInterrupted = reject;
    });
    const onAbort = () => {
      controller.abort(signal.reason);
      rejectInterrupted(localError("unavailable", "SSE acknowledgment was canceled", "sse"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = this.clock.setTimeout(() => {
        const error = localError("deadline_exceeded", "SSE acknowledgment deadline exceeded", "sse");
        reject(error);
        controller.abort(error);
      }, remainingMs);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => work(controller.signal)),
        interrupted,
        timeout,
      ]);
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.clock.clearTimeout(timeoutHandle);
      controller.abort();
    }
  }

  private retryAfter(response: Response): number {
    const header = response.headers.get("retry-after");
    if (header === null) return 0;
    const value = header.trim();
    if (value.length === 0 || value.length > 64) {
      throw localError("malformed", "Retry-After is invalid", "sse");
    }
    let delayMs: number;
    if (/^\d+$/.test(value)) {
      delayMs = Number(value) * 1_000;
    } else {
      const at = Date.parse(value);
      if (!Number.isFinite(at)) throw localError("malformed", "Retry-After is invalid", "sse");
      delayMs = Math.max(0, at - this.now());
    }
    return Math.min(Number.isFinite(delayMs) ? delayMs : MAX_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS);
  }

  private waitForSseRetry(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(localError("unavailable", "SSE acknowledgment was canceled", "sse"));
    if (delayMs === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const handle = this.clock.setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      const onAbort = () => {
        this.clock.clearTimeout(handle);
        reject(localError("unavailable", "SSE acknowledgment was canceled", "sse"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
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

  private async readBoundedResponse(
    response: Response,
    maxBytes: number,
    signal: AbortSignal,
    resource: ResourceClass = "operation",
  ): Promise<string> {
    const cancellationError = localError("unavailable", "response read was canceled", resource);
    if (signal.aborted) {
      if (response.body) cancelWithoutWaiting(response.body, signal.reason);
      throw cancellationError;
    }
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    let complete = false;
    let interruptRead: (() => void) | undefined;
    const onAbort = (): void => interruptRead?.();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      for (;;) {
        let part: Awaited<ReturnType<SseResponseReader["read"]>>;
        let rejectInterrupted!: () => void;
        const interrupted = new Promise<never>((_resolve, reject) => {
          rejectInterrupted = () => reject(cancellationError);
        });
        interruptRead = rejectInterrupted;
        try {
          part = await Promise.race([(async () => reader.read())(), interrupted]);
        } catch (error) {
          if (signal.aborted) throw cancellationError;
          throw error;
        } finally {
          if (interruptRead === rejectInterrupted) interruptRead = undefined;
        }
        if (signal.aborted) throw cancellationError;
        if (part.done) {
          const result = text + decoder.decode();
          complete = true;
          return result;
        }
        bytes += part.value.byteLength;
        if (bytes > maxBytes) {
          throw localError("overloaded", "response exceeds the client frame limit", resource);
        }
        text += decoder.decode(part.value, { stream: true });
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (!complete) {
        cancelWithoutWaiting(reader, signal.reason);
      }
      releaseReaderLock(reader);
    }
  }
}
