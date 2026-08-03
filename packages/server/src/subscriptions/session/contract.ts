import type {
  ApplicationErrorMessage,
  AuthenticatedMessage,
  ChannelEventMessage,
  ChannelJoinMessage,
  ChannelLeaveMessage,
  ChannelReadyMessage,
  ChannelRejectedMessage,
  ChannelSendMessage,
  ErrorMessage,
  EventMessage,
  MutationMessage,
  MutationOkMessage,
  MutationReceipt,
  Outcome,
  PongMessage,
  ProcedureMessage,
  ProcedureOkMessage,
  QueryMessage,
  QueryOkMessage,
  ResetRequestMessage,
  SubscribeMessage,
  TransitionMessage,
  UnsubscribeMessage,
  WelcomeMessage,
  Identity,
} from "@ackerdb/core";
import { encode } from "@ackerdb/core";
import type {
  CredentialVerifier,
  ExternalAccount,
  Principal,
} from "../../auth/credentials.ts";
import type { AuthInvalidationScope } from "../../auth/invalidation.ts";
import type { TransportSource } from "../../runtime/caller.ts";
import type { ServiceLimits } from "../../runtime/limits.ts";

export type SubscriptionServerMessage = TransitionMessage | EventMessage;
export type SessionApplicationMessage =
  | SubscriptionServerMessage
  | ChannelReadyMessage
  | ChannelEventMessage
  | ChannelRejectedMessage
  | QueryOkMessage
  | ProcedureOkMessage
  | MutationOkMessage
  | ApplicationErrorMessage
  | ErrorMessage;
const RUNTIME_PUBLICATION_BRAND: unique symbol = Symbol("ackerdb.runtimePublication");
const runtimePublications = new WeakSet<object>();

export interface RuntimePublication {
  readonly message: SessionApplicationMessage;
  readonly text: string;
  readonly bytes: number;
  readonly [RUNTIME_PUBLICATION_BRAND]: true;
}

export function prepareRuntimePublication(message: SessionApplicationMessage): RuntimePublication {
  Object.freeze(message);
  const text = encode(message);
  const publication = Object.freeze({
    message,
    text,
    bytes: Buffer.byteLength(text),
    [RUNTIME_PUBLICATION_BRAND]: true as const,
  });
  runtimePublications.add(publication);
  return publication;
}

export function assertRuntimePublication(publication: RuntimePublication): void {
  if (!runtimePublications.has(publication)) {
    throw new TypeError("application publication was not prepared by ackerdb");
  }
}
/**
 * Exact-byte ownership for publications captured during an auth transition.
 * Frames are valid only until `release()`; release is idempotent and empties
 * the batch so terminal Session cleanup cannot retain obsolete publications.
 */
export interface RuntimePublicationBatch {
  readonly frames: readonly RuntimePublication[];
  readonly bytes: number;
  release(): void;
}
export type SessionControlMessage = WelcomeMessage | AuthenticatedMessage | PongMessage | ErrorMessage;

/**
 * A bounded transport queue. Control writes use reserved capacity, while
 * application writes are epoch-tagged and remain removable until accepted in
 * order. A resolved write must not be overtaken by a later write.
 */
export interface SessionSink {
  sendControl(message: SessionControlMessage): Promise<void>;
  sendApplication(authEpoch: number, publication: RuntimePublication): Promise<void>;
  dropApplicationFramesBefore(authEpoch: number): Promise<void>;
  close(outcome: Outcome): Promise<void>;
}

export interface SessionClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SessionRuntimeContext {
  readonly clientSessionId: string;
  readonly principal: Principal;
  /** Fixed-width caller ownership shared with HTTP and immutable for this auth epoch. */
  readonly fairnessKey: string;
  readonly authEpoch: number;
  /** Aborted as soon as an auth refresh, expiry, invalidation, or close starts. */
  readonly signal: AbortSignal;
  /** Package-owned verifier subscription identity for delayed self-invalidation. */
  readonly invalidationScope?: AuthInvalidationScope;
  /** Publishes an application frame only while this exact epoch is current. */
  publish(message: RuntimePublication): Promise<boolean>;
}

export interface RuntimeAuthTransition {
  readonly attemptId: number;
  readonly reason: "refresh" | "sign-out";
  readonly from: SessionRuntimeContext;
  readonly to: SessionRuntimeContext;
}

export interface RuntimeMutationResult {
  readonly value: unknown;
  readonly receipt: MutationReceipt;
}

/** One validated operation paired with the byte count owned by its transport. */
export interface RuntimeRequest<Message> {
  readonly message: Message;
  readonly bytes: number;
  readonly signal?: AbortSignal;
}

const runtimeRequestBytes = new WeakMap<object, number>();

export function prepareRuntimeRequest<Message>(
  message: Message,
  bytes: number,
  signal?: AbortSignal,
): RuntimeRequest<Message> {
  const request = Object.freeze({
    message,
    bytes,
    ...(signal === undefined ? {} : { signal }),
  });
  runtimeRequestBytes.set(request, bytes);
  return request;
}

/** Claims exact Session-owned transport bytes once; intentionally absent from the public index. */
export function claimRuntimeRequestBytes(request: RuntimeRequest<unknown>): number | undefined {
  const bytes = runtimeRequestBytes.get(request);
  if (bytes !== undefined) runtimeRequestBytes.delete(request);
  return bytes;
}

/** Transport-independent adapter implemented by the database runtime. */
export interface RuntimePort {
  readonly credentialVerifier: CredentialVerifier | undefined;
  resolveIdentity(account: ExternalAccount, signal?: AbortSignal): Promise<Identity>;
  openSession(context: SessionRuntimeContext): Promise<void>;
  transitionAuth(transition: RuntimeAuthTransition): Promise<RuntimePublicationBatch>;
  subscribe(context: SessionRuntimeContext, request: RuntimeRequest<SubscribeMessage>): Promise<void>;
  unsubscribe(context: SessionRuntimeContext, request: RuntimeRequest<UnsubscribeMessage>): Promise<void>;
  reset(context: SessionRuntimeContext, request: RuntimeRequest<ResetRequestMessage>): Promise<void>;
  joinChannel(context: SessionRuntimeContext, request: RuntimeRequest<ChannelJoinMessage>): Promise<void>;
  leaveChannel(context: SessionRuntimeContext, request: RuntimeRequest<ChannelLeaveMessage>): Promise<void>;
  sendChannel(context: SessionRuntimeContext, request: RuntimeRequest<ChannelSendMessage>): Promise<void>;
  /** Publishes the success or error frame before settling. */
  query(context: SessionRuntimeContext, request: RuntimeRequest<QueryMessage>): Promise<unknown>;
  /** Publishes the success or error frame before settling. */
  procedure(context: SessionRuntimeContext, request: RuntimeRequest<ProcedureMessage>): Promise<unknown>;
  /** Publishes the success or error frame before settling. */
  mutation(context: SessionRuntimeContext, request: RuntimeRequest<MutationMessage>): Promise<RuntimeMutationResult>;
  closeSession(context: SessionRuntimeContext, outcome: Outcome): Promise<void>;
}

export type SessionPhase = "awaiting_hello" | "opening" | "active" | "refreshing" | "closed";

export interface SessionSnapshot {
  readonly phase: SessionPhase;
  readonly clientSessionId: string | null;
  readonly principal: Principal | null;
  readonly authEpoch: number;
  readonly latestAttemptId: number;
}

export type SessionLimits = Pick<
  ServiceLimits,
  "maxRequestBytes" | "maxFrameBytes"
>;

export interface SessionOptions {
  readonly runtime: RuntimePort;
  readonly sink: SessionSink;
  /** Actual peer address captured by the transport; forwarded headers are not trusted. */
  readonly source: TransportSource;
  readonly clock?: SessionClock;
  readonly revocationDeadlineMs?: number;
  /** Per-session request and transport-frame limits. */
  readonly limits?: SessionLimits;
}
