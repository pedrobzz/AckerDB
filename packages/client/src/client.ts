import {
  MAX_PROTOCOL_ID,
  MAX_RETRY_AFTER_MS,
  ACKERDB_VERSION,
  ProtocolError,
  WireError,
  Err,
  Failure,
  Ok,
  decode,
  encode,
  getRef,
  httpPathForAddress,
  parseClientMessage,
  parseCredential,
  parseOutcome,
  parseClientHandshake,
  parseConnectionError,
  parseServerHandshake,
  parseServerMessage,
  type ClientSessionMessage,
  type ErrorMessage,
  toStandardJson,
  type AuthenticatedMessage,
  type ApplicationError,
  type ApplicationErrorMessage,
  type AnyChannelRef,
  type AuthenticationDescriptor,
  type ChannelArgs,
  type ChannelRoom,
  type ChannelServerEvents,
  type ChannelClientEvents,
  type ChannelError,
  type Credential,
  type EventRef,
  type LiveEventCursor,
  type MutationOkMessage,
  type MutationReceipt,
  type MutationRef,
  type Outcome,
  type OutcomeCode,
  type ProcedureRef,
  type QueryRef,
  type ResourceClass,
  type Result,
  type ServerMessage,
  type SseAckRequest,
  type SseChunkMessage,
  type SseDoneMessage,
  type SseErrorMessage,
  type SseRef,
  type SubscriptionCursor,
  type SubscriptionTransition,
  type WelcomeMessage,
} from "@ackerdb/core";
import {
  ChannelManager,
  type AckerDBChannel,
  type AckerDBChannelOptions,
} from "./channels/channel.ts";
import { retryDelay } from "./connection/retry-policy.ts";
import {
  AckerDBFilesClient,
  type AckerDBFiles,
} from "./files/client.ts";
import { SseEventDecoder } from "./sse/event-decoder.ts";
import { raceWithAbort } from "./abort.ts";
import {
  SubscriptionRetryScheduler,
  createSubscriptionRetryState,
  type SubscriptionRetryState,
} from "./subscriptions/retry.ts";

export interface AckerDBClientLimits {
  readonly maxPendingItems: number;
  readonly maxPendingBytes: number;
  readonly maxQueryAgeMs: number;
  readonly maxMutationAgeMs: number;
  readonly maxFrameBytes: number;
  readonly maxSseBufferBytes: number;
  readonly maxSseAckAgeMs: number;
}

export interface AckerDBReconnectOptions {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly stableOpenMs: number;
  readonly disconnectedGraceMs: number;
}

export interface AckerDBClientClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface AckerDBClientScheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AckerDBWebSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type AckerDBWebSocketFactory = (url: string) => AckerDBWebSocket;
export type AckerDBFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Application-lifecycle notifications, driven by an injected platform
 * observer: the client owns what suspension means, the adapter owns when it
 * happens. `suspend` (the application entered background) retires the
 * physical connection while keeping all logical demand; `resume` (the
 * application returned to active) recovers the constructor-owned connection
 * immediately.
 * Both coalesce duplicates, so the adapter may forward platform events
 * verbatim.
 */
export interface AckerDBLifecyclePort {
  suspend(): void;
  resume(): void;
}

/**
 * Registers a platform lifecycle observer for one client lifetime and returns
 * its deregistration. The client invokes the source once, at the end of
 * construction, and invokes the returned function exactly once, before any
 * other teardown in close() — so the observer exists exactly as long as the
 * client does.
 */
export type AckerDBLifecycleSource = (port: AckerDBLifecyclePort) => () => void;

/**
 * Credential source: the application-owned callback producing the client's
 * current explicit credential on demand — including the explicit anonymous
 * credential for signed-out state. The client owns when to ask: at
 * construction, ahead of disclosed credential expiry, and after a principal
 * rejection.
 */
export type AckerDBCredentialSource = () => Promise<Credential>;

export interface AckerDBClientOptionsBase {
  /** Server base URL, for example `http://127.0.0.1:3211`. */
  readonly url: string;
  /** Stable for this logical client across every reconnect. Generated once when omitted. */
  readonly clientSessionId?: string;
  readonly limits?: Partial<AckerDBClientLimits>;
  readonly reconnect?: Partial<AckerDBReconnectOptions>;
  readonly clock?: AckerDBClientClock;
  readonly random?: () => number;
  readonly createWebSocket?: AckerDBWebSocketFactory;
  readonly fetch?: AckerDBFetch;
  readonly lifecycle?: AckerDBLifecycleSource;
}

/**
 * Exactly one of `credential` or `credentialSource` — enforced at the type
 * level and again at construction. A fixed credential starts every connection
 * as-is; a credential source is pulled for the initial connect, re-pulled
 * ahead of the server-disclosed credential TTL, and re-pulled after a
 * principal rejection with bounded jittered backoff.
 */
export type AckerDBClientOptions =
  | (AckerDBClientOptionsBase & {
      /** Every connection starts with this explicit anonymous or bearer credential. */
      readonly credential: Credential;
      readonly credentialSource?: undefined;
    })
  | (AckerDBClientOptionsBase & {
      readonly credential?: undefined;
      /** The application-owned callback producing the current explicit credential. */
      readonly credentialSource: AckerDBCredentialSource;
    });

/** Server-confirmed, secret-free principal descriptor for one auth epoch. */
export type AckerDBAuthentication = AuthenticationDescriptor & { readonly authEpoch: number };

/**
 * Public connection lifecycle. `suspended` and `resuming` are produced by the
 * injected lifecycle notifications (the native adapter's AppState observer):
 * backgrounding retires the transport and publishes `suspended`; activation
 * publishes `resuming` until the fresh handshake completes.
 */
export type AckerDBConnectionState =
  | { readonly phase: "connecting" }
  | { readonly phase: "ready"; readonly authentication: AckerDBAuthentication }
  | { readonly phase: "reconnecting" }
  | { readonly phase: "authentication-blocked"; readonly error: AckerDBClientError }
  | { readonly phase: "terminal-error"; readonly error: AckerDBClientError }
  | { readonly phase: "closed" }
  | { readonly phase: "suspended" }
  | { readonly phase: "resuming" };

/**
 * Public authentication lifecycle, derived from the same protocol facts as
 * {@link AckerDBConnectionState} and published in the same transition turns.
 *
 * - `authenticating`: a credential presentation is in flight — the connect
 *   handshake (`hello`/`welcome`) or an explicit `refreshCredential` attempt.
 *   `credential` is the kind being presented; the server treats an anonymous
 *   presentation on an established session as a sign-out.
 * - `unauthenticated`: the server confirmed an anonymous session principal.
 * - `authenticated`: the server confirmed a user or workload principal. User
 *   descriptors carry durable Identity separately from exact credential
 *   provenance; workload descriptors carry provenance but no user Identity.
 * - `refresh-required`: the server rejected the credential or an attempt timed
 *   out; the client will not reconnect until `refreshCredential` supplies a
 *   new credential. The same error is the connection state's
 *   `authentication-blocked` error.
 * - `failed`: the client stopped permanently; no credential can recover it.
 * - `closed`: the client was closed.
 */
export type AckerDBAuthenticationState =
  | {
      readonly phase: "authenticating";
      /** `"source"`: a credential-source client that has not yet produced its first credential. */
      readonly credential: Credential["kind"] | "source";
    }
  | {
      readonly phase: "unauthenticated";
      readonly authentication: Extract<AckerDBAuthentication, { principal: "anonymous" }>;
    }
  | {
      readonly phase: "authenticated";
      readonly authentication: Exclude<AckerDBAuthentication, { principal: "anonymous" }>;
    }
  | { readonly phase: "refresh-required"; readonly error: AckerDBClientError }
  | { readonly phase: "failed"; readonly error: AckerDBClientError }
  | { readonly phase: "closed" };

export type AckerDBLiveEvent<Row> =
  | { readonly kind: "row"; readonly cursor: LiveEventCursor; readonly row: Row }
  | { readonly kind: "gap"; readonly cursor: LiveEventCursor }
  | { readonly kind: "reset"; readonly cursor: LiveEventCursor };

export interface AckerDBCallOptions {
  readonly signal?: AbortSignal;
}

export interface AckerDBSubscribeOptions<Error extends ApplicationError = ApplicationError> {
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
  /** Receives an authoritative application Err while keeping the live subscription active. */
  readonly onApplicationError?: (error: Error) => void;
}

export const ACKERDB_CLIENT_LIMITS: AckerDBClientLimits = Object.freeze({
  maxPendingItems: 4_096,
  maxPendingBytes: 16 * 1024 * 1024,
  maxQueryAgeMs: 30_000,
  maxMutationAgeMs: 24 * 60 * 60 * 1_000,
  maxFrameBytes: 1024 * 1024,
  maxSseBufferBytes: 1024 * 1024,
  maxSseAckAgeMs: 5_000,
});

export const ACKERDB_RECONNECT_DEFAULTS: AckerDBReconnectOptions = Object.freeze({
  baseDelayMs: 100,
  maxDelayMs: 3_000,
  stableOpenMs: 10_000,
  disconnectedGraceMs: 5_000,
});

const CLIENT_CLOSE_CODE = Object.freeze({
  retryLater: 4000,
  suspended: 4001,
  protocolFailure: 4002,
  authenticationFailed: 4008,
} as const);

export class AckerDBClientError extends Error {
  readonly kind: "framework" | "unhandled" | "transport";
  readonly outcome: Readonly<Outcome>;
  readonly code: OutcomeCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly resource?: ResourceClass;
  readonly committed?: true;
  /**
   * Present when application-lifecycle suspension settled this non-resumable
   * operation (a procedure, SSE stream, or AI generation): the application
   * entered background, so the client aborted the in-flight transport work —
   * or refused to start new work — and produced this outcome. Consumers that
   * separate deliberate lifecycle cancellation from failure (the AI SDK
   * transport classifies these as aborts, not errors) key on it. The code
   * stays an ordinary base category: `unavailable` when the work provably
   * never ran, `indeterminate` when completion is unknown.
   */
  readonly interruption?: "suspension";

  constructor(outcome: Outcome, interruption?: "suspension") {
    super(outcome.message);
    this.name = "AckerDBClientError";
    this.kind = outcome.code === "internal"
      ? "unhandled"
      : outcome.code === "malformed" ||
          outcome.code === "validation" ||
          outcome.code === "version_mismatch" ||
          outcome.code === "unauthenticated" ||
          outcome.code === "auth_unavailable" ||
          outcome.code === "auth_stale" ||
          outcome.code === "unauthorized" ||
          outcome.code === "not_found" ||
          outcome.code === "conflict"
        ? "framework"
        : "transport";
    this.outcome = Object.freeze({ ...outcome });
    this.code = outcome.code;
    this.retryable = outcome.retryable;
    this.retryAfterMs = outcome.retryAfterMs;
    this.resource = outcome.resource;
    this.committed = outcome.committed;
    if (interruption !== undefined) this.interruption = interruption;
  }
}

export type ClientResult<Data, Error extends ApplicationError = never> = Result<
  Data,
  Error | AckerDBClientError
>;

interface QuerySubscription {
  readonly kind: "query";
  readonly id: number;
  readonly ref: string;
  readonly args: unknown;
  readonly onUpdate: (value: unknown) => void;
  readonly onApplicationError?: (error: ApplicationError) => void;
  readonly onError?: (error: AckerDBClientError) => void;
  readonly onCursorConfirmed?: () => void;
  cursor?: SubscriptionCursor;
  resetRequested: boolean;
  frame: string;
  bytes: number;
  sentGeneration?: number;
  retry: SubscriptionRetryState;
}

interface EventSubscription {
  readonly kind: "event";
  readonly id: number;
  readonly ref: string;
  readonly onEvent: (event: AckerDBLiveEvent<unknown>) => void;
  readonly onError?: (error: AckerDBClientError) => void;
  cursor?: LiveEventCursor;
  frame: string;
  bytes: number;
  sentGeneration?: number;
  retry: SubscriptionRetryState;
}

type Subscription = QuerySubscription | EventSubscription;

interface PendingRequest {
  readonly id: number;
  readonly kind: "query" | "mutation" | "procedure";
  readonly frame: string;
  readonly bytes: number;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: AckerDBClientError) => void;
  readonly mutationRequestId?: string;
  expiryHandle?: unknown;
  sentGeneration?: number;
  receipt?: MutationReceipt;
  result?: unknown;
  obligations?: Set<number>;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
}

interface AuthAttempt {
  readonly id: number;
  readonly credential: Credential;
  readonly result: Promise<AckerDBAuthentication>;
  readonly resolve: (authentication: AckerDBAuthentication) => void;
  readonly reject: (error: AckerDBClientError) => void;
  /** Absolute deadline: the timer pauses across suspension, this does not. */
  readonly expiresAtMs: number;
  expiryHandle?: unknown;
  sentGeneration?: number;
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
  // The done branch admits `value?: Uint8Array` (never read here) because
  // that is the WHATWG `ReadableStreamReadDoneResult` shape: consumers
  // typechecking this source against the DOM lib must be able to assign
  // `response.body.getReader()` directly. Bun's stricter reader type remains
  // assignable to the wider target.
  read(): Promise<
    | { readonly done: true; readonly value?: Uint8Array }
    | { readonly done: false; readonly value: Uint8Array }
  >;
  releaseLock(): void;
}

const encoder = new TextEncoder();
const UUID_RANDOM_MASK = (1n << 74n) - 1n;
const SSE_STREAM_HEADER = "x-ackerdb-sse-stream";
const SSE_STALL_HEADER = "x-ackerdb-sse-max-stall-ms";
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
): AckerDBClientError {
  return new AckerDBClientError({ code, message, retryable: false, resource, committed });
}

/**
 * A typed outcome produced by lifecycle suspension settling — or refusing to
 * start — non-resumable work. The code is an ordinary base-client category;
 * the `interruption` marker is what tells consumers the application lifecycle
 * (not a failure and not their own abort) owned the settlement.
 */
function suspensionError(
  code: OutcomeCode,
  message: string,
  resource?: ResourceClass,
): AckerDBClientError {
  return new AckerDBClientError({ code, message, retryable: false, resource }, "suspension");
}

/**
 * The reason suspendTransport gives every in-flight fetch controller.
 * Settlement paths compare the signal's reason against this exact value, so
 * suspension-caused outcomes carry their {@link AckerDBClientError.interruption}
 * marker while caller aborts and close() keep their plain outcomes.
 */
const SUSPENSION_INTERRUPTION = suspensionError(
  "unavailable",
  "client suspended while the request was in flight",
  "connection",
);

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

function freezeCredential(credential: Credential): Credential {
  const parsed = parseCredential(credential);
  return parsed.kind === "anonymous"
    ? Object.freeze({ kind: "anonymous" })
    : Object.freeze({ kind: "bearer", token: parsed.token });
}

function sameCredential(left: Credential, right: Credential): boolean {
  return left.kind === "anonymous"
    ? right.kind === "anonymous"
    : right.kind === "bearer" && left.token === right.token;
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

const SYSTEM_CLOCK: AckerDBClientClock = {
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

const CONNECTING_STATE: AckerDBConnectionState = Object.freeze({ phase: "connecting" });
const RECONNECTING_STATE: AckerDBConnectionState = Object.freeze({ phase: "reconnecting" });
const CLOSED_STATE: AckerDBConnectionState = Object.freeze({ phase: "closed" });
const SUSPENDED_STATE: AckerDBConnectionState = Object.freeze({ phase: "suspended" });
const RESUMING_STATE: AckerDBConnectionState = Object.freeze({ phase: "resuming" });

const AUTHENTICATING_ANONYMOUS: AckerDBAuthenticationState = Object.freeze({
  phase: "authenticating",
  credential: "anonymous",
});
const AUTHENTICATING_BEARER: AckerDBAuthenticationState = Object.freeze({
  phase: "authenticating",
  credential: "bearer",
});
const AUTHENTICATING_SOURCE: AckerDBAuthenticationState = Object.freeze({
  phase: "authenticating",
  credential: "source",
});
/** Proactive source re-pull lands this far before disclosed expiry when 80% of the TTL cannot. */
const SOURCE_REFRESH_MARGIN_MS = 5_000;
/**
 * Floor for the proactive re-pull delay so tiny TTLs cannot hot-loop the
 * source. A credential whose lifetime is shorter than this cycle degrades to
 * the reactive refresh path by design.
 */
const MIN_SOURCE_REFRESH_DELAY_MS = 1_000;
/** Platform timer ceiling; longer delays would wrap to ~1 ms and hot-loop the source. */
const MAX_SOURCE_REFRESH_DELAY_MS = 0x7fff_ffff;
const CLOSED_AUTHENTICATION_STATE: AckerDBAuthenticationState = Object.freeze({ phase: "closed" });

function authenticationFromFrame(
  frame: WelcomeMessage | AuthenticatedMessage,
): AckerDBAuthentication {
  if (frame.principal === "anonymous") {
    return Object.freeze({ authEpoch: frame.authEpoch, principal: "anonymous" });
  }
  const provenance = Object.freeze({ ...frame.provenance });
  return frame.principal === "user"
    ? Object.freeze({
        authEpoch: frame.authEpoch,
        principal: "user",
        identity: frame.identity,
        provenance,
        credentialTtlMs: frame.credentialTtlMs,
      })
    : Object.freeze({
        authEpoch: frame.authEpoch,
        principal: "workload",
        provenance,
        credentialTtlMs: frame.credentialTtlMs,
      });
}

const SYSTEM_SOCKET_FACTORY: AckerDBWebSocketFactory = (url) =>
  new WebSocket(url) as unknown as AckerDBWebSocket;
const SYSTEM_FETCH: AckerDBFetch = (url, init) => fetch(url, init);
const SYSTEM_RANDOM = (): number => {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0]! / 0x1_0000_0000;
};

export class AckerDBClient {
  readonly clientSessionId: string;
  readonly scheduler: AckerDBClientScheduler;
  readonly files: AckerDBFiles;

  private readonly httpUrl: string;
  private readonly wsUrl: string;
  private readonly limits: AckerDBClientLimits;
  private readonly reconnect: AckerDBReconnectOptions;
  private readonly clock: AckerDBClientClock;
  private readonly random: () => number;
  private readonly createWebSocket: AckerDBWebSocketFactory;
  private readonly fetcher: AckerDBFetch;
  private readonly uuid: UuidV7Factory;
  private readonly subscriptions = new Map<number, Subscription>();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly activeFetches = new Set<AbortController>();
  private readonly channels: ChannelManager;
  private readonly subscriptionRetries: SubscriptionRetryScheduler;

  /** Undefined only on a credential-source client before its first successful pull. */
  private credential?: Credential;
  private readonly credentialSource?: AckerDBCredentialSource;
  /** Single-flight: concurrent pull triggers coalesce onto this promise. */
  private sourcePull: Promise<AckerDBAuthentication> | null = null;
  /** One queued fresh pull for explicit refreshes that arrive mid-flight. */
  private sourceFollowUp: Promise<AckerDBAuthentication> | null = null;
  /** The next credential-source retry's backoff step; 1 is the first retry. */
  private sourceBackoffStep = 1;
  private sourceRetryHandle?: unknown;
  private sourceRefreshHandle?: unknown;
  /** When the accepted credential dies, in clock time; undefined while anonymous. */
  private credentialExpiresAtMs?: number;
  /** The credential the current connection's hello presented. */
  private helloCredential?: Credential;
  private socket: AckerDBWebSocket | null = null;
  private socketOpen = false;
  private ready = false;
  private closed = false;
  private permanentFailure = false;
  private authBlocked = false;
  /** The application is backgrounded: no transport exists and none is dialed. */
  private suspended = false;
  /** A foreground recovery attempt is in flight, from resume until its first outcome. */
  private resuming = false;
  private stopLifecycle?: () => void;
  /**
   * Monotonically increasing generation of the physical connection: each dial
   * in ensureConnected() takes the next value. Work that can outlive a
   * connection proves it still owns the active generation before mutating
   * state — socket callbacks by socket identity (each generation owns a
   * distinct socket object), connection timers by capturing the generation,
   * sent-work stamps by comparing it. Suspension retires the current
   * generation by detaching its socket; the resume dial takes a fresh one.
   */
  private connectionGeneration = 0;
  private nextId = 1;
  /** The next reconnect's backoff step; 1 is the first retry after a live connection. */
  private reconnectBackoffStep = 1;
  /**
   * Absolute clock time before which the server asked this client not to
   * reconnect (a retryable session error's Retry-After hint). An admission
   * deadline, not client backoff: it expires by clock, never by lifecycle —
   * suspension retains it and activation honors any remainder.
   */
  private serverRetryNotBeforeMs = 0;
  private pendingItems = 0;
  private pendingBytes = 0;
  private authAttempt?: AuthAttempt;
  private reconnectHandle?: unknown;
  private stableHandle?: unknown;
  private pingHandle?: unknown;
  private authentication?: AckerDBAuthentication;
  private connectionState: AckerDBConnectionState = CONNECTING_STATE;
  private readonly connectionStateListeners = new Set<(state: AckerDBConnectionState) => void>();
  private authenticationState: AckerDBAuthenticationState;
  private readonly authenticationStateListeners = new Set<(state: AckerDBAuthenticationState) => void>();
  private everReady = false;
  private blockingError?: AckerDBClientError;
  private terminalError?: AckerDBClientError;

  constructor(options: AckerDBClientOptions) {
    this.httpUrl = options.url.replace(/\/$/, "");
    if (!/^https?:\/\//.test(this.httpUrl)) throw new TypeError("url must use http or https");
    this.wsUrl = `${this.httpUrl.replace(/^http/, "ws")}/_ws`;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.scheduler = Object.freeze({
      now: () => this.clock.now(),
      setTimeout: (callback: () => void, delayMs: number) =>
        this.clock.setTimeout(callback, delayMs),
      clearTimeout: (handle: unknown) => this.clock.clearTimeout(handle),
    });
    this.random = options.random ?? SYSTEM_RANDOM;
    this.createWebSocket = options.createWebSocket ?? SYSTEM_SOCKET_FACTORY;
    this.fetcher = options.fetch ?? SYSTEM_FETCH;
    if ((options.credential === undefined) === (options.credentialSource === undefined)) {
      throw new TypeError("exactly one of credential or credentialSource is required");
    }
    this.credentialSource = options.credentialSource;
    if (options.credential !== undefined) this.credential = freezeCredential(options.credential);
    this.authenticationState =
      this.credential === undefined
        ? AUTHENTICATING_SOURCE
        : this.credential.kind === "anonymous"
          ? AUTHENTICATING_ANONYMOUS
          : AUTHENTICATING_BEARER;
    this.limits = Object.freeze({ ...ACKERDB_CLIENT_LIMITS, ...options.limits });
    this.reconnect = Object.freeze({ ...ACKERDB_RECONNECT_DEFAULTS, ...options.reconnect });
    for (const [name, value] of Object.entries(this.limits)) positiveInteger(value, name);
    for (const [name, value] of Object.entries(this.reconnect)) positiveInteger(value, name);
    if (this.reconnect.baseDelayMs > this.reconnect.maxDelayMs) {
      throw new RangeError("baseDelayMs cannot exceed maxDelayMs");
    }
    this.subscriptionRetries = new SubscriptionRetryScheduler(
      this.clock,
      this.reconnect,
      this.random,
      MAX_RETRY_AFTER_MS,
    );
    this.uuid = new UuidV7Factory(this.random);
    this.clientSessionId = options.clientSessionId ?? this.uuid.create(this.now());
    this.channels = new ChannelManager({
      allocateId: () => this.allocateId(),
      encode: (frame) => this.encodeChannelOrReject(frame),
      retain: (frame) => this.reservePersistent(frame, "subscription"),
      release: (bytes) => this.releasePersistent(bytes),
      ensureConnected: () => this.ensureConnected(),
      canSend: () => this.canSendOperations(),
      send: (frame) => {
        this.frameBytes(frame, "subscription");
        return this.sendText(frame);
      },
      generation: () => this.connectionGeneration,
      authEpoch: () => this.authentication?.authEpoch,
    });
    this.files = new AckerDBFilesClient({
      mutation: (ref, args) => this.mutation(ref, args),
      fetch: (url, init) => this.fetcher(url, init),
      createFetchControl: (signal) => {
        const control = this.createFetchController(signal);
        return {
          signal: control.controller.signal,
          release: () => this.releaseFetchController(control),
        };
      },
      authorizationHeaders: () => {
        this.assertUsable();
        const headers = new Headers();
        // A credential-source client has no credential until its first pull.
        if (this.credential?.kind === "bearer") {
          headers.set("authorization", `Bearer ${this.credential.token}`);
        }
        return headers;
      },
      httpOrigin: new URL(this.httpUrl).origin,
      scheduler: this.scheduler,
      random: this.random,
      readResponse: (response, signal) =>
        this.readBoundedResponse(response, this.limits.maxFrameBytes, signal, "idempotency"),
      clientError: (outcome, interruption) => new AckerDBClientError(outcome, interruption),
    });
    // A credential-source client validates each pulled credential when it is
    // presented; a fixed credential is validated here, before any dial.
    if (this.credential !== undefined) {
      parseClientHandshake({
        v: ACKERDB_VERSION,
        t: "hello",
        clientSessionId: this.clientSessionId,
        credential: this.credential,
      });
    }
    // Registered last: a lifecycle source that notifies synchronously (a
    // platform that is already backgrounded) must observe a fully constructed
    // client, and a constructor failure must not leave an observer behind.
    this.stopLifecycle = options.lifecycle?.({
      suspend: () => this.suspendTransport(),
      resume: () => this.resumeTransport(),
    });
    // Construction is the one public startup operation. A synchronously
    // notifying lifecycle source may have suspended the fully initialized
    // client above; ensureConnected() observes that state and will defer the
    // physical dial until resume without losing standing demand.
    this.ensureConnected();
  }

  get currentAuthentication(): AckerDBAuthentication | undefined {
    return this.authentication === undefined ? undefined : Object.freeze({ ...this.authentication });
  }

  /** Immutable snapshot; the same object is returned until the next transition. */
  get currentConnectionState(): AckerDBConnectionState {
    return this.connectionState;
  }

  /** Notifies on connection-state transitions only; read the snapshot for the current value. */
  subscribeConnectionState(listener: (state: AckerDBConnectionState) => void): () => void {
    this.connectionStateListeners.add(listener);
    return () => {
      this.connectionStateListeners.delete(listener);
    };
  }

  /** Immutable snapshot; the same object is returned until the next transition. */
  get currentAuthenticationState(): AckerDBAuthenticationState {
    return this.authenticationState;
  }

  /** Notifies on authentication-state transitions only; read the snapshot for the current value. */
  subscribeAuthenticationState(listener: (state: AckerDBAuthenticationState) => void): () => void {
    this.authenticationStateListeners.add(listener);
    return () => {
      this.authenticationStateListeners.delete(listener);
    };
  }

  /**
   * Presents a credential for this session: the server verifies it, retires
   * the current auth epoch, and confirms the new principal. Presenting the
   * anonymous credential is the protocol's sign-out. Single-flight: a call
   * with the credential already in flight joins that attempt; a different
   * credential supersedes it with an `auth_stale` rejection.
   *
   * A credential-source client owns its credential: `refreshCredential()`
   * takes no argument there and re-invokes the source immediately — the
   * "sign-in just happened" path.
   */
  refreshCredential(credential?: Credential): Promise<AckerDBAuthentication> {
    if (this.closed) throw localError("unavailable", "client is closed", "connection");
    if (this.permanentFailure) {
      throw localError("unavailable", "client stopped after a protocol failure", "connection");
    }
    if (this.credentialSource !== undefined) {
      if (credential !== undefined) {
        throw new TypeError(
          "a credential-source client owns its credential; refreshCredential() re-invokes the source",
        );
      }
      this.sourceBackoffStep = 1;
      this.clearSourceRetryTimer();
      return this.demandFreshPull();
    }
    if (credential === undefined) {
      throw new TypeError("refreshCredential requires a credential unless a credentialSource is configured");
    }
    return this.presentCredential(credential);
  }

  private presentCredential(credential: Credential): Promise<AckerDBAuthentication> {
    // Re-checked here: a source pull resolves asynchronously and may land on a
    // client that closed or failed while the source was working.
    if (this.closed) throw localError("unavailable", "client is closed", "connection");
    if (this.permanentFailure) {
      throw localError("unavailable", "client stopped after a protocol failure", "connection");
    }
    const nextCredential = freezeCredential(credential);
    if (this.authAttempt && sameCredential(this.authAttempt.credential, nextCredential)) {
      return this.authAttempt.result;
    }
    const id = this.allocateId();
    // The auth frame is validated against the wire and frame limits before
    // any state changes, so an unencodable credential rejects here instead of
    // installing an attempt whose frame can never be sent.
    this.frameBytes(
      this.encodeClient({ t: "auth", attemptId: id, credential: nextCredential }),
      "connection",
    );
    if (this.authAttempt) {
      this.clock.clearTimeout(this.authAttempt.expiryHandle);
      this.authAttempt.reject(localError("auth_stale", "authentication attempt was superseded", "connection"));
    }
    this.credential = nextCredential;
    // The deadline describes the accepted credential; this one is not
    // accepted until the server confirms it.
    this.credentialExpiresAtMs = undefined;
    this.authBlocked = false;
    this.blockingError = undefined;
    const { promise: result, resolve, reject } = Promise.withResolvers<AckerDBAuthentication>();
    const attempt: AuthAttempt = {
      id,
      credential: nextCredential,
      result,
      resolve,
      reject,
      expiresAtMs: this.now() + this.limits.maxQueryAgeMs,
    };
    // While suspended no timer is armed — background timers cannot be trusted
    // to fire — but the absolute deadline stands: resume re-evaluates it.
    if (!this.suspended) {
      attempt.expiryHandle = this.clock.setTimeout(
        () => this.expireAuthAttempt(attempt),
        this.limits.maxQueryAgeMs,
      );
    }
    this.authAttempt = attempt;
    if (this.ready) this.sendAuth(attempt);
    else this.ensureConnected();
    // Published last: a listener may reenter close(), which must find the
    // installed attempt and its expiry timer so it can release them.
    this.publishConnectionState();
    return result;
  }

  /**
   * An explicit refresh is new demand, not a joinable trigger: a pull already
   * in flight may have produced the pre-sign-in credential, so joining it
   * would silently discard the sign-in. One follow-up pull is queued behind
   * the flight; concurrent explicit refreshes share it.
   */
  private demandFreshPull(): Promise<AckerDBAuthentication> {
    if (this.sourcePull === null) return this.pullCredentialSource();
    if (this.sourceFollowUp === null) {
      const follow = this.sourcePull.then(
        () => {
          if (this.sourceFollowUp === follow) this.sourceFollowUp = null;
          return this.pullCredentialSource();
        },
        () => {
          if (this.sourceFollowUp === follow) this.sourceFollowUp = null;
          return this.pullCredentialSource();
        },
      );
      this.sourceFollowUp = follow;
      void follow.catch(() => {});
    }
    return this.sourceFollowUp;
  }

  /** Single-flight: concurrent triggers — initial, scheduled, rejected, manual — coalesce. */
  private pullCredentialSource(): Promise<AckerDBAuthentication> {
    const existing = this.sourcePull;
    if (existing !== null) return existing;
    this.clearSourceRetryTimer();
    // The single-flight slot is released before the retry is scheduled, so a
    // firing retry always starts a fresh pull instead of joining a dead one.
    const tracked: Promise<AckerDBAuthentication> = this.runSourcePull().then(
      (authentication) => {
        if (this.sourcePull === tracked) this.sourcePull = null;
        this.sourceBackoffStep = 1;
        return authentication;
      },
      (error: unknown) => {
        if (this.sourcePull === tracked) this.sourcePull = null;
        // The source failed, or the server rejected what it produced: bounded
        // jittered backoff prevents a tight client-to-provider loop around a
        // persistently bad credential.
        if (!this.closed && !this.permanentFailure) this.scheduleSourceRetry();
        throw error;
      },
    );
    this.sourcePull = tracked;
    // Internal triggers do not await the pull; their rejection is already
    // handled by the scheduled retry, so it must not surface as unhandled.
    void tracked.catch(() => {});
    return tracked;
  }

  private async runSourcePull(): Promise<AckerDBAuthentication> {
    let credential: Credential;
    try {
      credential = await this.boundedSourceInvocation();
    } catch {
      throw localError("auth_unavailable", "credential source failed", "connection");
    }
    return this.presentCredential(credential);
  }

  /**
   * The source is external code; without a deadline a hung invocation would
   * occupy the single-flight slot forever and wedge every future refresh.
   */
  private boundedSourceInvocation(): Promise<Credential> {
    return new Promise<Credential>((resolve, reject) => {
      let settled = false;
      const handle = this.clock.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("credential source timed out"));
      }, this.limits.maxQueryAgeMs);
      Promise.resolve()
        .then(() => this.credentialSource!())
        .then(
          (credential) => {
            if (settled) return;
            settled = true;
            this.clock.clearTimeout(handle);
            resolve(credential);
          },
          (cause: unknown) => {
            if (settled) return;
            settled = true;
            this.clock.clearTimeout(handle);
            reject(cause instanceof Error ? cause : new Error(String(cause)));
          },
        );
    });
  }

  private scheduleSourceRetry(): void {
    if (
      this.credentialSource === undefined ||
      this.sourceRetryHandle !== undefined ||
      this.closed ||
      this.permanentFailure ||
      this.suspended
    ) {
      return;
    }
    let delay: number;
    try {
      delay = retryDelay(this.reconnect, this.sourceBackoffStep, 0, this.random, MAX_RETRY_AFTER_MS);
    } catch {
      this.failPermanently(localError("internal", "client random source is invalid", "connection"));
      return;
    }
    this.sourceBackoffStep++;
    this.sourceRetryHandle = this.clock.setTimeout(() => {
      this.sourceRetryHandle = undefined;
      void this.pullCredentialSource().catch(() => {});
    }, delay);
  }

  private clearSourceRetryTimer(): void {
    if (this.sourceRetryHandle === undefined) return;
    this.clock.clearTimeout(this.sourceRetryHandle);
    this.sourceRetryHandle = undefined;
  }

  /**
   * Records when the accepted credential dies and arms the proactive re-pull.
   * The absolute deadline outlives the timer deliberately: an environment
   * that stops running timers (a frozen browser tab, a suspended host) can
   * skip past the scheduled re-pull entirely, and the dial boundary consults
   * the deadline instead of trusting that the timer ever fired.
   */
  private acceptedCredential(): void {
    const authentication = this.authentication;
    // A `null` disclosure is a credential that does not expire, so it has no
    // deadline to record — the same absence anonymous has, reached honestly.
    this.credentialExpiresAtMs =
      authentication === undefined ||
      authentication.principal === "anonymous" ||
      authentication.credentialTtlMs === null
        ? undefined
        : this.now() + authentication.credentialTtlMs;
    this.scheduleSourceRefresh();
  }

  /**
   * Arms the proactive re-pull from the server's credential TTL disclosure:
   * ~80% of the TTL, clamped to land at least the margin before expiry and
   * floored so tiny TTLs cannot hot-loop the source. Anonymous principals
   * disclose no TTL and arm nothing — the next sign-in arrives by
   * `refreshCredential()`. A credential that does not expire arms nothing for
   * the same reason: there is no expiry to get ahead of, and re-pulling a
   * non-expiring secret on a timer would be work with no outcome.
   */
  private scheduleSourceRefresh(): void {
    this.clearSourceRefreshTimer();
    if (this.credentialSource === undefined || this.suspended) return;
    const authentication = this.authentication;
    if (authentication === undefined || authentication.principal === "anonymous") return;
    const ttl = authentication.credentialTtlMs;
    if (ttl === null) return;
    const delay = Math.min(
      MAX_SOURCE_REFRESH_DELAY_MS,
      Math.max(MIN_SOURCE_REFRESH_DELAY_MS, Math.min(ttl * 0.8, ttl - SOURCE_REFRESH_MARGIN_MS)),
    );
    this.sourceRefreshHandle = this.clock.setTimeout(() => {
      this.sourceRefreshHandle = undefined;
      void this.pullCredentialSource().catch(() => {});
    }, delay);
  }

  private clearSourceRefreshTimer(): void {
    if (this.sourceRefreshHandle === undefined) return;
    this.clock.clearTimeout(this.sourceRefreshHandle);
    this.sourceRefreshHandle = undefined;
  }

  subscribe<A, Data = unknown, Error extends ApplicationError = never>(
    ref: QueryRef<A, Data, Error> | string,
    args: A,
    onUpdate: (value: Data) => void,
    onError?: (error: AckerDBClientError) => void,
    options: AckerDBSubscribeOptions<Error> = {},
  ): () => void {
    this.assertUsable();
    const id = this.allocateId();
    const address = getRef(ref);
    const frame = this.encodeSubscriptionOrReject(id, address, args);
    const bytes = this.reservePersistent(frame, "subscription");
    const subscription: QuerySubscription = {
      kind: "query",
      id,
      ref: address,
      args,
      onUpdate: onUpdate as (value: unknown) => void,
      onApplicationError: options.onApplicationError as
        | ((error: ApplicationError) => void)
        | undefined,
      onError,
      onCursorConfirmed: options.onCursorConfirmed,
      resetRequested: false,
      frame,
      bytes,
      retry: createSubscriptionRetryState(),
    };
    this.subscriptions.set(id, subscription);
    this.ensureConnected();
    if (this.canSendOperations()) this.sendSubscription(subscription);
    return () => this.removeSubscription(id, true);
  }

  subscribeEvent<A, Row = unknown>(
    ref: EventRef<A, Row> | string,
    args: A,
    onEvent: (event: AckerDBLiveEvent<Row>) => void,
    onError?: (error: AckerDBClientError) => void,
  ): () => void {
    this.assertUsable();
    const id = this.allocateId();
    const address = getRef(ref);
    const frame = this.encodeSubscriptionOrReject(id, address, args);
    const bytes = this.reservePersistent(frame, "subscription");
    const subscription: EventSubscription = {
      kind: "event",
      id,
      ref: address,
      onEvent: onEvent as (event: AckerDBLiveEvent<unknown>) => void,
      onError,
      frame,
      bytes,
      retry: createSubscriptionRetryState(),
    };
    this.subscriptions.set(id, subscription);
    this.ensureConnected();
    if (this.canSendOperations()) this.sendSubscription(subscription);
    return () => this.removeSubscription(id, true);
  }

  channel<Ref extends AnyChannelRef>(
    ref: Ref,
    args: NoInfer<ChannelArgs<Ref>>,
    ...options: [ChannelRoom<Ref>] extends [never]
      ? [
          options?: AckerDBChannelOptions<
            ChannelRoom<Ref>,
            ChannelServerEvents<Ref>
          >,
        ]
      : [
          options: AckerDBChannelOptions<
            ChannelRoom<Ref>,
            ChannelServerEvents<Ref>
          >,
        ]
  ): AckerDBChannel<ChannelClientEvents<Ref>, ChannelError<Ref>> {
    this.assertUsable();
    return this.channels.observe(
      ref,
      args,
      (options[0] ?? {}) as AckerDBChannelOptions<
        ChannelRoom<Ref>,
        ChannelServerEvents<Ref>
      >,
    );
  }

  query<A, Data = unknown, Error extends ApplicationError = never>(
    ref: QueryRef<A, Data, Error> | string,
    args: A,
  ): Promise<ClientResult<Data, Error>> {
    return this.request("query", getRef(ref), args).catch(
      (error) => Failure(this.asClientError(error)),
    ) as Promise<ClientResult<Data, Error>>;
  }

  mutation<A, Data = unknown, Error extends ApplicationError = never>(
    ref: MutationRef<A, Data, Error> | string,
    args: A,
  ): Promise<ClientResult<Data, Error>> {
    return this.request("mutation", getRef(ref), args).catch(
      (error) => Failure(this.asClientError(error)),
    ) as Promise<ClientResult<Data, Error>>;
  }

  procedure<A, Data = unknown, Error extends ApplicationError = never>(
    ref: ProcedureRef<A, Data, Error> | string,
    args: A,
    options: AckerDBCallOptions = {},
  ): Promise<ClientResult<Data, Error>> {
    try {
      this.assertUsable();
      if (options.signal?.aborted) {
        throw localError("unavailable", "procedure request was canceled", "operation");
      }
      if (this.suspended) {
        throw suspensionError("unavailable", "client is suspended", "operation");
      }
      return this.request("procedure", getRef(ref), args, options.signal).catch(
        (error) => Failure(this.asClientError(error)),
      ) as Promise<ClientResult<Data, Error>>;
    } catch (error) {
      return Promise.resolve(Failure(this.asClientError(error)) as ClientResult<Data, Error>);
    }
  }

  /**
   * Acknowledged SSE stream: `Chunk` is the ref's server-validated yield
   * type. Chunk N's receiver credit is sent when the consumer requests chunk
   * N+1, so iteration pace is the backpressure signal end to end.
   *
   * The stream is lazy: calling this creates a description of work, and the
   * work itself — reservation, fetch, everything — starts at the first pull.
   * Suspension ownership keys on that same moment, mirroring procedure()'s
   * call-time check: a first pull while suspended settles with the marked
   * suspension refusal, while a stream whose first pull happens while active
   * is fresh demand-driven foreground work regardless of when the generator
   * object was created — a never-pulled stream holds no state, hangs no one,
   * and has nothing for activation to restart.
   */
  async *sse<A, Chunk = unknown>(
    ref: SseRef<A, Chunk> | string,
    args: A,
    options: AckerDBCallOptions = {},
  ): AsyncGenerator<Chunk, void, undefined> {
    this.assertUsable();
    if (options.signal?.aborted) {
      throw localError("unavailable", "SSE request was canceled", "sse");
    }
    // The same non-resumable contract as procedure(): a stream first pulled
    // while the application is backgrounded settles now with the typed
    // suspension outcome instead of dispatching transport work — or queueing
    // a hidden start — that activation must never silently perform.
    if (this.suspended) {
      throw suspensionError("unavailable", "client is suspended", "sse");
    }
    // The URL is the address, segment for segment — the group is already its
    // first segment. The response is the correlation, so the request carries
    // the args object alone — no envelope, no client id.
    const url = `${this.httpUrl}${httpPathForAddress(getRef(ref))}`;
    let body: string;
    try {
      // The exposed surface speaks the plain JSON its OpenAPI document
      // publishes — decimal strings for bigints, base64 for bytes — not the
      // escape form the WebSocket session carries. Absent args are that
      // surface's empty args object.
      body = JSON.stringify(toStandardJson(args)) ?? "{}";
    } catch (error) {
      if (!(error instanceof WireError)) throw error;
      throw localError("validation", "SSE arguments cannot be encoded", "sse");
    }
    const releaseReservation = this.reserveTransient(body, "sse");
    const fetchControl = this.createFetchController(options.signal);
    let responseBody: CancelableResponse | undefined;
    let reader: SseResponseReader | undefined;
    let cleanupStarted = false;
    let cleanupReason: unknown;
    // The stream's one cancellation outcome. Reassigned (before any throw can
    // observe it — onAbort runs first) when suspension owns the abort, so the
    // terminal error names the lifecycle interruption exactly.
    let cancellationError = localError("unavailable", "SSE request was canceled", "sse");
    let interruptWait: (() => void) | undefined;
    const waitForOwnership = async <T>(promise: Promise<T>): Promise<T> => {
      if (cleanupStarted) {
        void promise.catch(() => {});
        throw cancellationError;
      }
      const interrupted = Promise.withResolvers<never>();
      const rejectInterrupted = (): void => interrupted.reject(cancellationError);
      interruptWait = rejectInterrupted;
      try {
        const value = await Promise.race([promise, interrupted.promise]);
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
      if (fetchControl.controller.signal.reason === SUSPENSION_INTERRUPTION) {
        cancellationError = suspensionError(
          "unavailable",
          "SSE stream was interrupted by suspension",
          "sse",
        );
      }
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
        this.fetcher(url, {
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
        throw cancellationError;
      }
      if (!response.ok) {
        responseBody = undefined;
        let text: string;
        try {
          text = await this.readBoundedResponse(
            response,
            this.limits.maxFrameBytes,
            fetchControl.controller.signal,
            "sse",
          );
        } catch (error) {
          // A failure that follows the request's abort settles with the
          // stream's one cancellation outcome (suspension-marked when the
          // lifecycle owned the abort), like every other post-abort path.
          if (cleanupStarted || fetchControl.controller.signal.aborted) throw cancellationError;
          throw error;
        }
        // The exposed surface answers the bare outcome; the response itself is
        // the correlation, so there is no frame and nothing to match against.
        let outcome: Outcome;
        try {
          outcome = parseOutcome(JSON.parse(text));
        } catch (error) {
          throw this.protocolError(error, "sse");
        }
        throw new AckerDBClientError(outcome);
      }
      if (response.status !== 200) {
        throw localError("malformed", "SSE endpoint returned an unexpected success status", "sse");
      }
      const stream = this.sseStream(response);
      const ackAgeMs = this.sseAckAge(response);
      // An acknowledgement failure that follows the request's abort settles
      // with the stream's one cancellation outcome (suspension-marked when
      // the lifecycle owned the abort) — the same post-abort rule the read
      // path applies. Genuine acknowledgement failures pass through exactly.
      const acknowledge = async (
        frame: SseChunkMessage | SseDoneMessage | SseErrorMessage,
      ): Promise<void> => {
        try {
          await this.acknowledgeSse(stream, frame, ackAgeMs, fetchControl.controller.signal);
        } catch (error) {
          if (cleanupStarted || fetchControl.controller.signal.aborted) throw cancellationError;
          throw error;
        }
      };
      if (!response.body) throw localError("malformed", "SSE response has no body", "sse");

      const streamReader = response.body.getReader();
      responseBody = undefined;
      reader = streamReader;
      const events = new SseEventDecoder(this.limits.maxSseBufferBytes);
      const frames: (SseChunkMessage | SseDoneMessage | SseErrorMessage)[] = [];
      let expectedSequence = 1;
      for (;;) {
        if (frames.length === 0) {
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
              frames.push(...events.finish());
            } catch (error) {
              throw this.protocolError(error, "sse");
            }
            if (events.hasPendingEvent) {
              throw localError("malformed", "SSE stream ended mid-event", "sse");
            }
            if (frames.length !== 0) continue;
            throw localError("indeterminate", "SSE stream ended before completion", "sse");
          }
          try {
            frames.push(...events.push(part.value));
          } catch (error) {
            if (error instanceof RangeError) {
              throw localError("overloaded", error.message, "sse");
            }
            throw this.protocolError(error, "sse");
          }
          continue;
        }

        const frame = frames.shift()!;
        if (frame.seq !== expectedSequence) {
          throw localError(
            "malformed",
            `SSE sequence ${frame.seq} does not match expected ${expectedSequence}`,
            "sse",
          );
        }
        if (frame.t === "sse_chunk") {
          yield frame.value as Chunk;
          await acknowledge(frame);
          expectedSequence++;
          continue;
        }
        await acknowledge(frame);
        if (frame.t === "sse_done") return;
        throw new AckerDBClientError(frame.outcome);
      }
    } catch (error) {
      if (error instanceof AckerDBClientError) throw error;
      throw localError("indeterminate", "SSE response was interrupted", "sse");
    } finally {
      cleanup();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // The platform lifecycle observer is removed before any other teardown,
    // so no suspend/resume notification can race the close sequence.
    const stopLifecycle = this.stopLifecycle;
    this.stopLifecycle = undefined;
    try {
      stopLifecycle?.();
    } catch {
      // The observer is external code; its removal failing cannot block the
      // client's own teardown.
    }
    this.clearReconnectTimer();
    this.clearConnectionTimers();
    this.clearSourceRetryTimer();
    this.clearSourceRefreshTimer();
    if (this.authAttempt) {
      this.clock.clearTimeout(this.authAttempt.expiryHandle);
      this.authAttempt.reject(localError("unavailable", "client closed", "connection"));
      this.authAttempt = undefined;
    }
    for (const request of [...this.pending.values()]) {
      const indeterminate =
        (request.kind === "mutation" || request.kind === "procedure") &&
        request.sentGeneration !== undefined;
      const message = request.kind === "mutation"
        ? "mutation completion is unknown"
        : request.kind === "procedure"
          ? "procedure completion is unknown"
          : "client closed";
      this.finishRequest(
        request,
        undefined,
        localError(
          indeterminate ? "indeterminate" : "unavailable",
          indeterminate ? message : "client closed",
          request.kind === "mutation" && indeterminate ? "idempotency" : "operation",
        ),
      );
    }
    for (const subscription of this.subscriptions.values()) {
      this.subscriptionRetries.clear(subscription.retry);
      this.releasePersistent(subscription.bytes);
    }
    this.subscriptions.clear();
    this.channels.close();
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

  /**
   * The application entered background. The physical connection is retired —
   * its generation ends when its socket is detached, making every late
   * callback it owns provably stale — and every connection-owned timer
   * (reconnect, stable-open, heartbeat, the credential-presentation deadline)
   * is stopped because none can be trusted to fire while the platform has the
   * process suspended. Logical demand survives untouched: subscriptions and
   * their cursors, pending requests and their mutation identities, the
   * in-flight credential presentation, the current credential, and standing
   * connection demand. Pending-request expiry timers stay armed — their
   * absolute deadlines remain correct however late the platform fires them.
   * Non-resumable transports (procedures, SSE) are aborted so their callers
   * settle promptly with suspension-marked typed outcomes instead of hanging
   * across the gap; nothing restarts them on resume, and new procedure/SSE
   * work started while suspended is refused with the same marked contract
   * rather than queued. Duplicate notifications coalesce.
   */
  private suspendTransport(): void {
    if (this.closed || this.suspended) return;
    for (const request of this.pending.values()) {
      if (request.kind === "procedure" && request.sentGeneration !== undefined) {
        this.sendProcedureCancel(request);
      }
    }
    this.suspended = true;
    this.resuming = false;
    this.clearReconnectTimer();
    // Background timers cannot be trusted to fire; resume pulls the source
    // fresh instead of re-arming these.
    this.clearSourceRetryTimer();
    this.clearSourceRefreshTimer();
    for (const subscription of this.subscriptions.values()) {
      this.subscriptionRetries.pause(subscription.retry);
    }
    if (this.authAttempt !== undefined) {
      this.clock.clearTimeout(this.authAttempt.expiryHandle);
      this.authAttempt.expiryHandle = undefined;
    }
    for (const request of [...this.pending.values()]) {
      if (request.kind !== "procedure") continue;
      this.finishRequest(
        request,
        undefined,
        request.sentGeneration === undefined
          ? suspensionError("unavailable", "client is suspended", "operation")
          : suspensionError("indeterminate", "procedure completion is unknown", "operation"),
      );
    }
    this.retireConnection(CLIENT_CLOSE_CODE.suspended, "client suspended");
    // The abort reason marks these settlements as lifecycle interruptions:
    // each in-flight procedure and SSE stream produces its exact typed
    // suspension outcome (never a caller-abort or failure outcome).
    for (const controller of this.activeFetches) controller.abort(SUSPENSION_INTERRUPTION);
    this.activeFetches.clear();
    this.publishConnectionState();
  }

  /**
   * Synchronously ends the current physical connection's generation. The
   * socket is detached before close() is issued because socket close is
   * asynchronous on real transports: every late callback the retired socket
   * still owns must already fail the identity proof, or a delayed welcome or
   * auth frame could mutate the state the caller is about to publish.
   * Connection-owned timers stop with their generation and live-event
   * cursors reset to their next boundary, exactly as an observed close would
   * have done. Callers own the resulting flags and their state publication.
   * Every path that blocks authentication retires the connection through
   * here, so `authBlocked` implies no socket exists — which is why sends
   * need no separate blocked check.
   */
  private retireConnection(code: number, reason: string): void {
    this.clearConnectionTimers();
    const socket = this.socket;
    this.socket = null;
    this.socketOpen = false;
    this.ready = false;
    this.authentication = undefined;
    // Live events are never replayed: the next connection starts them at a
    // fresh reset boundary, exactly like an ordinary reconnect.
    for (const subscription of this.subscriptions.values()) {
      if (subscription.kind === "event") subscription.cursor = undefined;
    }
    this.channels.connectionLost();
    socket?.close(code, reason);
  }

  /**
   * The application returned to active. Paused deadlines are re-evaluated
   * against the current clock — an absolute deadline that elapsed while
   * suspended expires now, never by waiting for a stale pre-suspension timer.
   * The fresh authenticated connection begins in this same event turn: the
   * reconnect timer was cleared at suspension, so
   * no stale client backoff can delay the first attempt. The one thing that
   * can is a server-directed Retry-After deadline that has not elapsed —
   * admission control that a lifecycle transition must not bypass; the
   * ordinary bounded reconnect policy holds the remainder. Constructor-owned
   * standing demand survives suspension, so activation always restores the
   * connection. If the immediate attempt fails, the ordinary reconnect policy
   * takes over — there is no special retry behavior. Duplicate notifications
   * coalesce.
   */
  private resumeTransport(): void {
    if (this.closed || !this.suspended) return;
    this.suspended = false;
    for (const subscription of this.subscriptions.values()) {
      this.armSubscriptionRetry(subscription);
    }
    const attempt = this.authAttempt;
    if (attempt !== undefined) {
      const remainingMs = attempt.expiresAtMs - this.now();
      if (remainingMs <= 0) this.expireAuthAttempt(attempt);
      else {
        attempt.expiryHandle = this.clock.setTimeout(
          () => this.expireAuthAttempt(attempt),
          remainingMs,
        );
      }
    }
    if (!this.permanentFailure && !this.authBlocked) {
      // ensureConnected is the single enforcement point for the server's
      // Retry-After deadline: an unelapsed one defers this dial to the
      // ordinary reconnect policy (which clears `resuming` again), everything
      // else dials inside this event turn.
      this.resuming = true;
      if (this.credentialSource !== undefined && this.credential !== undefined) {
        // The resume dial is gated on a fresh pull: dialing with the retained
        // credential could welcome a stale principal — expired, signed out,
        // or a switched account — and flush demand under it before the fresh
        // credential arrives. Presentation dials on success; the settlement
        // hook re-ensures connectivity for the paths where it did not — a
        // failed pull (fall back to the retained credential so an unreachable
        // identity provider cannot black out public demand; the bounded retry
        // keeps pulling regardless) and a joined pull that had already
        // settled without dialing. ensureConnected is a no-op on a live dial.
        const ensure = (): void => {
          if (!this.closed && !this.suspended) this.ensureConnected();
        };
        void this.pullCredentialSource().then(ensure, ensure);
      } else {
        this.ensureConnected();
      }
    }
    this.publishConnectionState();
  }

  /**
   * A credential presentation reached its absolute deadline: reject it, block
   * until a new credential is supplied, and retire any socket. Shared by the
   * live expiry timer and resume's re-evaluation of a paused deadline.
   */
  private expireAuthAttempt(attempt: AuthAttempt): void {
    if (this.authAttempt !== attempt) return;
    this.authAttempt = undefined;
    this.authBlocked = true;
    this.ready = false;
    this.resuming = false;
    const error = localError("auth_unavailable", "authentication timed out", "connection");
    this.blockingError = error;
    attempt.reject(error);
    this.retireConnection(
      CLIENT_CLOSE_CODE.authenticationFailed,
      "authentication timed out",
    );
    this.clearSourceRefreshTimer();
    this.scheduleSourceRetry();
    this.publishConnectionState();
  }

  private request(
    kind: "query" | "mutation" | "procedure",
    ref: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let unownedReservation = 0;
    try {
      this.assertUsable();
      const id = this.allocateId();
      const createdAtMs = this.now();
      const mutationRequestId = kind === "mutation" ? this.uuid.create(createdAtMs) : undefined;
      const frame = this.encodeClient(
        kind === "query"
          ? { t: "q", id, ref, args }
          : kind === "procedure"
            ? { t: "p", id, ref, args }
          : {
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
      const maxAge = kind === "mutation" ? this.limits.maxMutationAgeMs : this.limits.maxQueryAgeMs;
      const { promise: result, resolve, reject } = Promise.withResolvers<unknown>();
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
      if (signal !== undefined) {
        pending.abortSignal = signal;
        pending.abortListener = () => this.cancelProcedure(pending);
        signal.addEventListener("abort", pending.abortListener, { once: true });
      }
      this.pending.set(id, pending);
      unownedReservation = 0;
      if (signal?.aborted) {
        this.cancelProcedure(pending);
        return result;
      }
      this.ensureConnected();
      if (this.canSendOperations()) this.sendRequest(pending);
      return result;
    } catch (error) {
      if (unownedReservation) this.releasePersistent(unownedReservation);
      return Promise.reject(
        error instanceof AckerDBClientError
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

  private deriveConnectionState(current: AckerDBConnectionState): AckerDBConnectionState {
    if (this.closed) return CLOSED_STATE;
    if (this.permanentFailure) {
      return current.phase === "terminal-error" && current.error === this.terminalError
        ? current
        : Object.freeze({ phase: "terminal-error" as const, error: this.terminalError! });
    }
    if (this.authBlocked) {
      // Authentication-blocked outranks suspended: both mean "no transport,
      // no dialing", but blocked is the actionable fact — a credential is
      // required, and backgrounding cannot repair that. Consumers key on it
      // (subscription demand survives while blocked), so it stays
      // visible across suspension.
      return current.phase === "authentication-blocked" && current.error === this.blockingError
        ? current
        : Object.freeze({ phase: "authentication-blocked" as const, error: this.blockingError! });
    }
    if (this.suspended) return SUSPENDED_STATE;
    if (this.ready) {
      return current.phase === "ready" && current.authentication === this.authentication
        ? current
        : Object.freeze({ phase: "ready" as const, authentication: this.authentication! });
    }
    if (this.resuming) return RESUMING_STATE;
    return this.everReady ? RECONNECTING_STATE : CONNECTING_STATE;
  }

  private deriveAuthenticationState(current: AckerDBAuthenticationState): AckerDBAuthenticationState {
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
      const presenting = pending?.credential ?? this.credential;
      if (presenting === undefined) return AUTHENTICATING_SOURCE;
      return presenting.kind === "anonymous" ? AUTHENTICATING_ANONYMOUS : AUTHENTICATING_BEARER;
    }
    const authentication = this.authentication!;
    if (authentication.principal === "anonymous") {
      return current.phase === "unauthenticated" && current.authentication === authentication
        ? current
        : Object.freeze({ phase: "unauthenticated" as const, authentication });
    }
    return current.phase === "authenticated" && current.authentication === authentication
      ? current
      : Object.freeze({ phase: "authenticated" as const, authentication });
  }

  private ensureConnected(): void {
    if (this.closed || this.permanentFailure || this.authBlocked || this.suspended || this.socket) {
      return;
    }
    // A credential-source client cannot dial before its first pull produced
    // the hello credential; the pull's presentation re-enters here.
    if (this.credential === undefined) {
      void this.pullCredentialSource().catch(() => {});
      return;
    }
    // Nor may it present a credential the server already told us is dead.
    // Timers are not a durable schedule — a frozen tab or a suspended host
    // can skip the proactive re-pull entirely — so the recorded deadline,
    // not the timer, decides whether this credential is still presentable.
    // Pulling here keeps the wake path free of a doomed handshake and the
    // `refresh-required` blip it would publish.
    if (
      this.credentialSource !== undefined &&
      this.credentialExpiresAtMs !== undefined &&
      this.now() >= this.credentialExpiresAtMs
    ) {
      void this.pullCredentialSource().catch(() => {});
      return;
    }
    // Server admission control is enforced at the one physical dial boundary:
    // no demand path — new work, a credential refresh, or a
    // lifecycle activation — may open a socket before the server's
    // Retry-After deadline. The bounded reconnect policy holds the remainder
    // (an already-scheduled timer is preserved; scheduling clears `resuming`).
    if (this.serverRetryNotBeforeMs > this.now()) {
      this.scheduleReconnect();
      return;
    }
    this.clearReconnectTimer();
    let socket: AckerDBWebSocket;
    try {
      socket = this.createWebSocket(this.wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.connectionGeneration++;
    socket.onopen = () => this.handleOpen(socket);
    socket.onmessage = (event) => this.handleIncoming(socket, event.data);
    socket.onerror = () => socket.close();
    socket.onclose = () => this.handleClose(socket);
  }

  private handleOpen(socket: AckerDBWebSocket): void {
    if (this.socket !== socket || this.closed) return;
    // ensureConnected never dials without a credential; a socket cannot open
    // ahead of the first source pull.
    const credential = this.credential!;
    this.socketOpen = true;
    this.helloCredential = credential;
    try {
      // The one frame this client sends before it has a session, so it is
      // validated against the handshake surface rather than the session one —
      // the same split the receive side reads by.
      const text = encode(parseClientHandshake({
        v: ACKERDB_VERSION,
        t: "hello",
        clientSessionId: this.clientSessionId,
        credential,
      }));
      this.frameBytes(text, "connection");
      this.sendText(text);
    } catch (error) {
      this.failPermanently(error instanceof AckerDBClientError ? error : this.protocolError(error));
    }
  }

  private handleClose(socket: AckerDBWebSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.socketOpen = false;
    this.ready = false;
    // A foreground recovery attempt whose socket died is over: what follows
    // is the ordinary reconnect policy and its ordinary phases.
    this.resuming = false;
    this.authentication = undefined;
    this.clearConnectionTimers();
    for (const subscription of this.subscriptions.values()) {
      if (subscription.kind === "event") subscription.cursor = undefined;
    }
    this.channels.connectionLost();
    for (const request of [...this.pending.values()]) {
      if (
        request.kind === "procedure" &&
        request.sentGeneration === this.connectionGeneration
      ) {
        this.finishRequest(
          request,
          undefined,
          localError("indeterminate", "procedure completion is unknown", "operation"),
        );
      }
    }
    if (!this.closed && !this.permanentFailure && !this.authBlocked) {
      this.scheduleReconnect();
    }
    this.publishConnectionState();
  }

  private handleIncoming(socket: AckerDBWebSocket, data: unknown): void {
    if (this.socket !== socket || this.closed) return;
    if (typeof data !== "string" || encoder.encode(data).byteLength > this.limits.maxFrameBytes) {
      this.failPermanently(localError("malformed", "server frame exceeds the client limit", "connection"));
      return;
    }
    // Which parser runs is the whole of "nothing before the welcome": until
    // this connection has one, the only frames that decode at all are the
    // versioned handshake pair — a welcome, or the connection-level refusal
    // that explains why there will not be one. The guard that used to restate
    // that after parsing is gone with it.
    let frame: ServerMessage;
    try {
      frame = this.ready
        ? parseServerMessage(decode(data))
        : parseServerHandshake(decode(data));
    } catch (error) {
      this.failPermanently(this.protocolError(error));
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
        // The fresh handshake completed: a foreground recovery attempt ends
        // in ready exactly like any other successful connection.
        this.resuming = false;
        this.authentication = authenticationFromFrame(frame);
        if (this.authAttempt) {
          // A hello that presented this attempt's credential value was just
          // verified by this welcome; a second auth round-trip would re-verify
          // the same token and retire the epoch it created. Only a credential
          // that changed after the hello still needs its own transition.
          if (
            this.helloCredential !== undefined &&
            sameCredential(this.authAttempt.credential, this.helloCredential)
          ) {
            this.resolveAuth(this.authAttempt, this.authentication);
          } else {
            this.sendAuth(this.authAttempt);
          }
        }
        this.flushState();
        this.startConnectionTimers();
        this.acceptedCredential();
        // Published last: a listener may reenter close(), which must find the
        // connection timers already installed so it can release them.
        this.publishConnectionState();
        return;
      case "auth": {
        const attempt = this.authAttempt;
        if (!attempt || attempt.id !== frame.attemptId) return;
        this.authentication = authenticationFromFrame(frame);
        this.resolveAuth(attempt, this.authentication);
        this.flushState();
        this.acceptedCredential();
        this.publishConnectionState();
        return;
      }
      case "transition":
        this.applyTransition(frame.id, frame.transition);
        return;
      case "event":
        this.applyLiveEvent(frame.id, frame.event);
        return;
      case "channel_ready":
        this.channels.ready(frame.id, frame.authEpoch);
        return;
      case "channel_event":
        if (!this.channels.event(frame.id, frame.event, frame.payload)) {
          this.failPermanently(
            localError(
              "malformed",
              "server event names no active channel",
              "subscription",
            ),
          );
        }
        return;
      case "channel_rejected":
        this.channels.rejected(frame.id, frame.authEpoch, frame.error);
        return;
      case "ok":
        this.applyResult(frame);
        return;
      case "app_err":
        this.applyApplicationError(frame);
        return;
      case "err":
        this.applyError(frame.id, new AckerDBClientError(frame.outcome));
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
    this.subscriptionRetries.settle(subscription.retry);
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
      case "application-error":
        subscription.onApplicationError?.(transition.error);
        break;
      case "revoked":
        subscription.onError?.(new AckerDBClientError(transition.outcome));
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
    this.subscriptionRetries.settle(subscription.retry);
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
    if (frame.kind === "query" || frame.kind === "procedure") {
      this.finishRequest(request, Ok(frame.value));
      return;
    }
    this.applyMutationReceipt(request, frame, Ok(frame.value));
  }

  private applyApplicationError(frame: ApplicationErrorMessage): void {
    const request = this.pending.get(frame.id);
    if (!request) return;
    if (frame.kind !== request.kind) {
      this.failPermanently(localError("malformed", "error kind does not match its request", "operation"));
      return;
    }
    const result = Err(frame.error.code, frame.error.body, frame.error.status);
    if (frame.kind === "query" || frame.kind === "procedure") {
      this.finishRequest(request, result);
      return;
    }
    this.applyMutationReceipt(request, frame, result);
  }

  private applyMutationReceipt(
    request: PendingRequest,
    frame: MutationOkMessage | ApplicationErrorMessage,
    result: Result<unknown, unknown>,
  ): void {
    if (frame.receipt === undefined) {
      this.failPermanently(localError("malformed", "mutation result has no receipt", "idempotency"));
      return;
    }
    if (frame.receipt.mutationRequestId !== request.mutationRequestId) {
      this.failPermanently(localError("malformed", "mutation receipt changed its request identity", "idempotency"));
      return;
    }
    request.receipt = frame.receipt;
    request.result = result;
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
    if (obligations.size === 0) this.finishRequest(request, result);
  }

  private applyError(id: number | null, error: AckerDBClientError): void {
    if (id === null) {
      if (error.retryable) {
        this.serverRetryNotBeforeMs = Math.max(
          this.serverRetryNotBeforeMs,
          this.now() + Math.min(error.retryAfterMs ?? 0, MAX_RETRY_AFTER_MS),
        );
        this.socket?.close(CLIENT_CLOSE_CODE.retryLater, "retry later");
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
      if (this.subscriptions.get(id) !== subscription) return;
      if (error.retryable) this.scheduleSubscriptionRetry(subscription, error);
      else this.removeSubscription(id, false);
      return;
    }
    this.channels.failed(id, error);
  }

  private requestReset(subscription: QuerySubscription): void {
    if (subscription.resetRequested) return;
    subscription.resetRequested = true;
    if (!this.canSendOperations()) return;
    if (subscription.cursor) {
      this.sendFrame({
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
        error instanceof AckerDBClientError
          ? error
          : localError("overloaded", "subscription cursor exceeds the client state limit", "subscription"),
      );
      this.removeSubscription(subscription.id, true);
      return false;
    }
    const nextTotal = this.pendingBytes - subscription.bytes + bytes;
    if (nextTotal > this.limits.maxPendingBytes) {
      subscription.onError?.(
        new AckerDBClientError({
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
    this.subscriptionRetries.clear(subscription.retry);
    this.subscriptions.delete(id);
    this.releasePersistent(subscription.bytes);
    if (sendUnsubscribe && this.canSendOperations()) {
      this.sendFrame({ t: "unsub", id });
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
    error?: AckerDBClientError,
  ): void {
    if (!this.pending.delete(request.id)) return;
    this.clock.clearTimeout(request.expiryHandle);
    if (request.abortSignal !== undefined && request.abortListener !== undefined) {
      request.abortSignal.removeEventListener("abort", request.abortListener);
    }
    this.releasePersistent(request.bytes);
    if (error) request.reject(error);
    else request.resolve(value);
  }

  private expireRequest(request: PendingRequest): void {
    if (this.pending.get(request.id) !== request) return;
    const committed = request.receipt !== undefined;
    const mutationMayHaveCommitted = request.kind === "mutation" && request.sentGeneration !== undefined;
    const procedureMayHaveCompleted = request.kind === "procedure" && request.sentGeneration !== undefined;
    if (procedureMayHaveCompleted) this.sendProcedureCancel(request);
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
          : procedureMayHaveCompleted
            ? localError("indeterminate", "procedure completion is unknown", "operation")
            : localError("deadline_exceeded", "client request deadline exceeded", "operation"),
    );
  }

  private cancelProcedure(request: PendingRequest): void {
    if (request.kind !== "procedure" || this.pending.get(request.id) !== request) return;
    this.sendProcedureCancel(request);
    this.finishRequest(
      request,
      undefined,
      request.sentGeneration === undefined
        ? localError("unavailable", "procedure request was canceled", "operation")
        : localError("indeterminate", "procedure completion is unknown", "operation"),
    );
  }

  private sendProcedureCancel(request: PendingRequest): void {
    if (
      request.kind !== "procedure" ||
      request.sentGeneration !== this.connectionGeneration ||
      !this.canSendOperations()
    ) return;
    try {
      this.sendFrame({ t: "cancel", id: request.id });
    } catch {
      // Cancellation is best effort; the local outcome remains indeterminate.
    }
  }

  private flushState(): void {
    if (!this.canSendOperations()) return;
    this.channels.flush();
    const now = this.now();
    for (const subscription of this.subscriptions.values()) {
      if (
        !this.subscriptionRetries.waiting(subscription.retry) &&
        subscription.sentGeneration !== this.connectionGeneration
      ) {
        this.sendSubscription(subscription);
      }
    }
    for (const request of [...this.pending.values()]) {
      if (request.expiresAtMs <= now) this.expireRequest(request);
      else if (
        this.pending.get(request.id) === request &&
        request.sentGeneration !== this.connectionGeneration
      ) {
        this.sendRequest(request);
      }
    }
  }

  private sendRequest(request: PendingRequest): void {
    this.sendText(request.frame);
    request.sentGeneration = this.connectionGeneration;
  }

  private sendSubscription(subscription: Subscription): void {
    this.sendText(subscription.frame);
    subscription.sentGeneration = this.connectionGeneration;
  }

  private scheduleSubscriptionRetry(
    subscription: Subscription,
    error: AckerDBClientError,
  ): void {
    if (this.subscriptionRetries.waiting(subscription.retry)) return;
    subscription.sentGeneration = undefined;
    try {
      this.subscriptionRetries.schedule(
        subscription.retry,
        error.retryAfterMs ?? 0,
      );
    } catch {
      this.failPermanently(localError("internal", "client random source is invalid", "connection"));
      return;
    }
    this.armSubscriptionRetry(subscription);
  }

  private armSubscriptionRetry(subscription: Subscription): void {
    if (this.suspended) return;
    this.subscriptionRetries.arm(subscription.retry, () => {
      if (this.subscriptions.get(subscription.id) !== subscription) return;
      if (this.canSendOperations()) this.sendSubscription(subscription);
      else this.ensureConnected();
    });
  }

  private sendAuth(attempt: AuthAttempt): void {
    this.sendFrame({
      t: "auth",
      attemptId: attempt.id,
      credential: attempt.credential,
    });
    attempt.sentGeneration = this.connectionGeneration;
  }

  private resolveAuth(attempt: AuthAttempt, authentication: AckerDBAuthentication): void {
    if (this.authAttempt !== attempt) return;
    this.clock.clearTimeout(attempt.expiryHandle);
    this.authAttempt = undefined;
    attempt.resolve(Object.freeze({ ...authentication }));
  }

  private blockAuthentication(error: AckerDBClientError): void {
    this.authBlocked = true;
    this.ready = false;
    this.resuming = false;
    this.blockingError = error;
    if (this.authAttempt) {
      this.clock.clearTimeout(this.authAttempt.expiryHandle);
      this.authAttempt.reject(error);
      this.authAttempt = undefined;
    }
    // Retired before any externally owned callback runs: an onError handler
    // may reenter refreshCredential in the same turn, and its recovery dial
    // must find the rejected socket already detached or it would never dial.
    this.retireConnection(
      CLIENT_CLOSE_CODE.authenticationFailed,
      "authentication failed",
    );
    for (const request of [...this.pending.values()]) this.finishRequest(request, undefined, error);
    for (const subscription of this.subscriptions.values()) subscription.onError?.(error);
    this.channels.failAll(error);
    // Awaiting a new credential is the source's job when one is configured:
    // the bounded backoff pulls it instead of waiting for application code.
    this.clearSourceRefreshTimer();
    this.scheduleSourceRetry();
    this.publishConnectionState();
  }

  private failPermanently(error: AckerDBClientError): void {
    if (this.permanentFailure || this.closed) return;
    this.permanentFailure = true;
    this.resuming = false;
    this.terminalError = error;
    this.clearReconnectTimer();
    if (this.authAttempt) {
      this.clock.clearTimeout(this.authAttempt.expiryHandle);
      this.authAttempt.reject(error);
      this.authAttempt = undefined;
    }
    for (const request of [...this.pending.values()]) this.finishRequest(request, undefined, error);
    for (const subscription of this.subscriptions.values()) subscription.onError?.(error);
    this.channels.failAll(error);
    for (const subscription of this.subscriptions.values()) {
      this.subscriptionRetries.clear(subscription.retry);
      this.releasePersistent(subscription.bytes);
    }
    this.subscriptions.clear();
    this.retireConnection(CLIENT_CLOSE_CODE.protocolFailure, "protocol failure");
    this.publishConnectionState();
  }

  private scheduleReconnect(): void {
    if (this.reconnectHandle !== undefined || this.socket || this.suspended) {
      return;
    }
    // Scheduling is the entry to the ordinary reconnect policy: a foreground
    // recovery attempt that reaches it (its dial failed outright) publishes
    // ordinary reconnect phases from here on.
    this.resuming = false;
    // The server's admission deadline floors the delay by whatever of it
    // remains; once elapsed it is naturally inert, so it is never cleared.
    const floor = Math.min(
      Math.max(0, this.serverRetryNotBeforeMs - this.now()),
      MAX_RETRY_AFTER_MS,
    );
    let delay: number;
    try {
      delay = retryDelay(
        this.reconnect,
        this.reconnectBackoffStep,
        floor,
        this.random,
        MAX_RETRY_AFTER_MS,
      );
    } catch {
      this.failPermanently(localError("internal", "client random source is invalid", "connection"));
      return;
    }
    this.reconnectBackoffStep++;
    this.reconnectHandle = this.clock.setTimeout(() => {
      this.reconnectHandle = undefined;
      this.ensureConnected();
    }, delay);
  }

  private startConnectionTimers(): void {
    this.clearConnectionTimers();
    const generation = this.connectionGeneration;
    this.stableHandle = this.clock.setTimeout(() => {
      if (this.ready && this.connectionGeneration === generation) this.reconnectBackoffStep = 1;
    }, this.reconnect.stableOpenMs);
    this.pingHandle = this.clock.setInterval(() => {
      if (this.ready && this.connectionGeneration === generation) {
        this.sendFrame({ t: "ping" });
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

  private canSendOperations(): boolean {
    return this.socketOpen && this.ready && !this.authAttempt && this.socket !== null;
  }

  private sendFrame(frame: ClientSessionMessage): void {
    const text = this.encodeClient(frame);
    this.frameBytes(text, "connection");
    this.sendText(text);
  }

  private sendText(text: string): boolean {
    const socket = this.socket;
    if (!socket || !this.socketOpen) return false;
    try {
      socket.send(text);
      return true;
    } catch {
      socket.close();
      this.handleClose(socket);
      return false;
    }
  }

  private encodeClient(frame: ClientSessionMessage): string {
    try {
      return encode(parseClientMessage(frame));
    } catch (error) {
      if (error instanceof ProtocolError) {
        throw localError(error.code, error.message, "operation");
      }
      throw error;
    }
  }

  private encodeChannelOrReject(frame: ClientSessionMessage): string {
    try {
      return this.encodeClient(frame);
    } catch (error) {
      if (error instanceof WireError) {
        throw localError("validation", error.message, "subscription");
      }
      throw error;
    }
  }


  // Subscription arguments are caller-supplied values, so unencodable ones
  // (non-finite numbers, functions, ...) surface as the exact validation
  // rejection rather than a raw wire error.
  private encodeSubscriptionOrReject(id: number, ref: string, args: unknown): string {
    try {
      return this.encodeClient({ t: "sub", id, ref, args });
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
      throw new AckerDBClientError({
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
      throw new AckerDBClientError({
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

  private protocolError(error: unknown, resource: ResourceClass = "connection"): AckerDBClientError {
    return error instanceof ProtocolError
      ? localError(error.code, error.message, resource)
      : localError("malformed", "invalid protocol payload", resource);
  }

  private asClientError(error: unknown): AckerDBClientError {
    return error instanceof AckerDBClientError
      ? error
      : localError("internal", "client operation failed unexpectedly", "operation");
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
      v: ACKERDB_VERSION,
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
    let backoffStep = 0;

    for (;;) {
      attempts++;
      let retryAfterMs = 0;
      try {
        const result = await this.withinSseAckDeadline(signal, deadlineAt, async (attemptSignal) => {
          const cancellationError = localError("unavailable", "SSE acknowledgment was canceled", "sse");
          const response = await raceWithAbort(
            (async () =>
              this.fetcher(`${this.httpUrl}/_sse/ack`, {
                method: "POST",
                headers: { "content-type": "text/plain;charset=UTF-8" },
                body,
                signal: attemptSignal,
              }))(),
            attemptSignal,
            () => cancellationError,
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
                () => cancellationError,
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
          // An acknowledgment travels on its own request, so its failure
          // answers on a connection with no handshake behind it: the parser
          // that owns that surface both checks the version and refuses
          // anything that is not a connection-level refusal.
          let parsed: ErrorMessage;
          try {
            parsed = parseConnectionError(decode(text));
          } catch (error) {
            throw this.protocolError(error, "sse");
          }
          const error = new AckerDBClientError(parsed.outcome);
          if ((response.status === 429 || response.status === 503) && error.retryable) {
            return Math.max(error.retryAfterMs ?? 0, this.retryAfter(response));
          }
          throw error;
        });
        if (result === null) return;
        retryAfterMs = result;
      } catch (error) {
        if (error instanceof AckerDBClientError) throw error;
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
      // The same jittered exponential schedule reconnect uses, so a thousand
      // clients failing together do not acknowledge in the same millisecond.
      let delayMs: number;
      try {
        delayMs = retryDelay(
          this.reconnect,
          backoffStep,
          retryAfterMs,
          this.random,
          MAX_RETRY_AFTER_MS,
        );
      } catch {
        throw localError("internal", "client random source is invalid", "sse");
      }
      backoffStep++;
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
    const { promise: interrupted, reject: rejectInterrupted } = Promise.withResolvers<never>();
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
    return this.credential?.kind === "bearer"
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
        const interrupted = Promise.withResolvers<never>();
        const rejectInterrupted = (): void => interrupted.reject(cancellationError);
        interruptRead = rejectInterrupted;
        try {
          part = await Promise.race([(async () => reader.read())(), interrupted.promise]);
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
