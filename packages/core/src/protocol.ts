import type { Identity } from "./identity.ts";
import {
  boundedString as string,
  exactFields as exact,
  malformed,
  protocolObject as object,
  ProtocolError,
  type ProtocolObject as ObjectValue,
} from "./protocol-validation.ts";
import {
  Status,
  type ApplicationError,
  type ErrorHttpStatus,
} from "./result.ts";

export { ProtocolError } from "./protocol-validation.ts";

/**
 * The executable client/server envelope contract. Application arguments,
 * results, and event rows remain opaque and keep their inferred TypeScript
 * types; every framework-owned field is validated after wire decode.
 *
 * The version covers the grammar of every framework-owned field, `ref`
 * included. 6 carries two changes from the 0.16 wire: a function address now
 * begins with its API path, so a version-5 `ref` naming one function could name
 * a different one here, and the credential TTL disclosure gained `null` for the
 * identity credentials that do not expire, which a version-5 decoder refuses as
 * malformed. A decoder that refuses the version is what turns skew into one
 * refusal instead of a call that lands somewhere else, or a session that dies
 * on its own welcome frame.
 *
 * **It moves once per released version, not once per wire change.** Its
 * consumers are released builds: packages ship lockstep, so a 0.16 client meets
 * a 0.17 server as one refusal at the handshake, and that is the whole job.
 * Incrementing again for a second change inside one unreleased cycle would
 * publish a number no stable build ever spoke, and leave a released user asking
 * where it went. Prerelease-to-prerelease skew is deliberately not this field's
 * problem — a canary is unstable by definition, and the version could not
 * describe that skew anyway, since most breaking changes between canaries never
 * touch the wire at all.
 */

export const PROTOCOL_VERSION = 6 as const;
export const MAX_PROTOCOL_ID = 0x7fff_ffff;
export const MAX_RETRY_AFTER_MS = 30_000;
export const MAX_CREDENTIAL_BYTES = 16 * 1024;
export const MAX_RECEIPT_OBLIGATIONS = 65_536;

const MAX_SESSION_ID_LENGTH = 128;
const MAX_REFERENCE_LENGTH = 512;
const MAX_CURSOR_PART_LENGTH = 512;
const MAX_SAFE_MESSAGE_LENGTH = 512;
const MAX_SSE_TOKEN_LENGTH = 128;
const MAX_PROVENANCE_PART_LENGTH = MAX_CREDENTIAL_BYTES;
const MAX_IDENTITY = 2n ** 63n - 1n;

export const OUTCOME_CODES = [
  "malformed",
  "validation",
  "unsupported_protocol",
  "unauthenticated",
  "auth_unavailable",
  "auth_stale",
  "unauthorized",
  "not_found",
  "conflict",
  "overloaded",
  "slow_consumer",
  "deadline_exceeded",
  "draining",
  "unavailable",
  "convergence_unavailable",
  "indeterminate",
  "internal",
] as const;

export type OutcomeCode = (typeof OUTCOME_CODES)[number];

export const RESOURCE_CLASSES = [
  "connection",
  "operation",
  "reader",
  "writer",
  "subscription",
  "revalidation",
  "publication",
  "outbound",
  "sse",
  "history",
  "idempotency",
  "telemetry",
] as const;

export type ResourceClass = (typeof RESOURCE_CLASSES)[number];

export const DURABILITY_POLICIES = ["production", "balanced"] as const;
export type DurabilityPolicy = (typeof DURABILITY_POLICIES)[number];

export const PRINCIPAL_KINDS = ["anonymous", "user", "workload", "system"] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

/** Exact external account that produced the currently accepted credential. */
export interface CredentialProvenance {
  readonly issuer: string;
  readonly subject: string;
}

/**
 * Secret-free client view of the accepted principal. System principals are
 * local-only and therefore intentionally absent from this wire contract.
 */
export type AuthenticationDescriptor =
  | { readonly principal: "anonymous" }
  | {
      readonly principal: "user";
      readonly identity: Identity;
      readonly provenance: CredentialProvenance;
      /**
       * Credential TTL disclosure: remaining validity of the accepted
       * credential as a relative duration, or `null` when it does not expire.
       * An identity credential is revoked rather than aged out, so `null` is a
       * real answer and not a missing one — the field stays required so a
       * client can never mistake silence for it.
       */
      readonly credentialTtlMs: number | null;
    }
  | {
      readonly principal: "workload";
      readonly provenance: CredentialProvenance;
      /** As above: a relative duration, or `null` for a credential that does not expire. */
      readonly credentialTtlMs: number | null;
    };

export interface Outcome {
  code: OutcomeCode;
  retryable: boolean;
  message: string;
  retryAfterMs?: number;
  resource?: ResourceClass;
  /** Present only when convergence failed after a mutation was committed. */
  committed?: true;
}

export type Credential = { kind: "anonymous" } | { kind: "bearer"; token: string };

export interface SubscriptionCursor {
  generation: string;
  commitVersion: bigint;
  authEpoch: number;
  identity: string;
}

export type SubscriptionTransition =
  | {
      kind: "reset";
      from: SubscriptionCursor | null;
      to: SubscriptionCursor;
      value: unknown;
    }
  | {
      kind: "update";
      from: SubscriptionCursor;
      to: SubscriptionCursor;
      value: unknown;
    }
  | {
      kind: "checkpoint";
      from: SubscriptionCursor;
      to: SubscriptionCursor;
    }
  | {
      kind: "resume";
      from: SubscriptionCursor;
      to: SubscriptionCursor;
    }
  | {
      kind: "revoked";
      from: SubscriptionCursor;
      to: SubscriptionCursor;
      outcome: Outcome;
    }
  | {
      kind: "application-error";
      from: SubscriptionCursor | null;
      to: SubscriptionCursor;
      error: ApplicationError;
    };

export interface LiveEventCursor {
  generation: string;
  commitVersion: bigint;
  sequence: bigint;
}

export type LiveEvent =
  | { kind: "row"; cursor: LiveEventCursor; row: unknown }
  | { kind: "gap"; cursor: LiveEventCursor }
  | { kind: "reset"; cursor: LiveEventCursor };

export interface MutationReceipt {
  mutationRequestId: string;
  commitVersion: bigint;
  durability: DurabilityPolicy;
  replay: "executed" | "replayed";
  /** Query subscription IDs that must reach commitVersion before resolution. */
  obligations: readonly number[];
}

interface Frame<T extends string> {
  v: typeof PROTOCOL_VERSION;
  t: T;
}

export interface HelloMessage extends Frame<"hello"> {
  clientSessionId: string;
  credential: Credential;
}

export interface ClientAuthMessage extends Frame<"auth"> {
  attemptId: number;
  credential: Credential;
}

export interface SubscribeMessage extends Frame<"sub"> {
  id: number;
  ref: string;
  args: unknown;
  cursor?: SubscriptionCursor;
}

export interface UnsubscribeMessage extends Frame<"unsub"> {
  id: number;
}

export interface ResetRequestMessage extends Frame<"reset"> {
  id: number;
  cursor: SubscriptionCursor;
}

export interface QueryMessage extends Frame<"q"> {
  id: number;
  ref: string;
  args: unknown;
}

export interface ProcedureMessage extends Frame<"p"> {
  id: number;
  ref: string;
  args: unknown;
}

export interface ProcedureCancelMessage extends Frame<"cancel"> {
  id: number;
}

export interface MutationMessage extends Frame<"m"> {
  id: number;
  ref: string;
  args: unknown;
  mutationRequestId: string;
  issuedAt: number;
}

export interface ChannelJoinMessage extends Frame<"channel_join"> {
  id: number;
  ref: string;
  args: unknown;
  room?: unknown;
}

export interface ChannelLeaveMessage extends Frame<"channel_leave"> {
  id: number;
}

export interface ChannelSendMessage extends Frame<"channel_send"> {
  id: number;
  event: string;
  payload: unknown;
}

export type PingMessage = Frame<"ping">;

export type ClientMessage =
  | HelloMessage
  | ClientAuthMessage
  | SubscribeMessage
  | UnsubscribeMessage
  | ResetRequestMessage
  | QueryMessage
  | ProcedureMessage
  | ProcedureCancelMessage
  | MutationMessage
  | ChannelJoinMessage
  | ChannelLeaveMessage
  | ChannelSendMessage
  | PingMessage;

export type WelcomeMessage = Frame<"welcome"> & AuthenticationDescriptor & {
  clientSessionId: string;
  authEpoch: number;
};

export type AuthenticatedMessage = Frame<"auth"> & AuthenticationDescriptor & {
  attemptId: number;
  authEpoch: number;
};

export interface TransitionMessage extends Frame<"transition"> {
  id: number;
  transition: SubscriptionTransition;
}

export interface EventMessage extends Frame<"event"> {
  id: number;
  event: LiveEvent;
}

export interface QueryOkMessage extends Frame<"ok"> {
  id: number;
  kind: "query";
  value: unknown;
}

export interface ProcedureOkMessage extends Frame<"ok"> {
  id: number;
  kind: "procedure";
  value: unknown;
}

export interface MutationOkMessage extends Frame<"ok"> {
  id: number;
  kind: "mutation";
  value: unknown;
  receipt: MutationReceipt;
}

export interface ApplicationErrorMessage extends Frame<"app_err"> {
  id: number;
  kind: "query" | "mutation" | "procedure";
  error: ApplicationError;
  /** Present only for idempotent mutations. */
  receipt?: MutationReceipt;
}

export interface ChannelReadyMessage extends Frame<"channel_ready"> {
  id: number;
  authEpoch: number;
}

export interface ChannelEventMessage extends Frame<"channel_event"> {
  id: number;
  event: string;
  payload: unknown;
}

export interface ChannelRejectedMessage extends Frame<"channel_rejected"> {
  id: number;
  authEpoch: number;
  error: ApplicationError;
}

export interface ErrorMessage extends Frame<"err"> {
  /** Null identifies a connection-level failure rather than one operation. */
  id: number | null;
  outcome: Outcome;
}

export type PongMessage = Frame<"pong">;

export type ServerMessage =
  | WelcomeMessage
  | AuthenticatedMessage
  | TransitionMessage
  | EventMessage
  | QueryOkMessage
  | ProcedureOkMessage
  | MutationOkMessage
  | ApplicationErrorMessage
  | ChannelReadyMessage
  | ChannelEventMessage
  | ChannelRejectedMessage
  | ErrorMessage
  | PongMessage;

interface SseFrame<T extends string> extends Frame<T> {
  seq: number;
  proof: string;
}

export interface SseChunkMessage extends SseFrame<"sse_chunk"> {
  value: unknown;
}

export type SseDoneMessage = SseFrame<"sse_done">;

export interface SseErrorMessage extends SseFrame<"sse_error"> {
  outcome: Outcome;
}

export type SseMessage = SseChunkMessage | SseDoneMessage | SseErrorMessage;

export interface SseAckRequest extends SseFrame<"sse_ack"> {
  stream: string;
}

const outcomeCodes = new Set<string>(OUTCOME_CODES);
const resourceClasses = new Set<string>(RESOURCE_CLASSES);
const durabilityPolicies = new Set<string>(DURABILITY_POLICIES);
const errorHttpStatuses = new Set<number>(Object.values(Status));
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Extract the embedded Unix-millisecond timestamp from a validated UUIDv7. */
export function uuidV7Timestamp(value: string): number {
  if (!uuidV7.test(value)) malformed("mutationRequestId must be UUIDv7");
  return Number.parseInt(value.slice(0, 8) + value.slice(9, 13), 16);
}
const utf8 = new TextEncoder();

function payload(value: unknown, name: string): unknown {
  if (value === undefined) malformed(`${name} must be wire-representable`);
  return value;
}

function protocolId(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_PROTOCOL_ID) {
    malformed(`${name} must be an integer from 1 through ${MAX_PROTOCOL_ID}`);
  }
  return value as number;
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    malformed(`${name} must be a positive safe integer`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    malformed(`${name} must be a non-negative safe integer`);
  }
  return value as number;
}

function nonNegativeBigint(value: unknown, name: string): bigint {
  if (typeof value !== "bigint" || value < 0n) malformed(`${name} must be a non-negative bigint`);
  return value;
}

function enumValue<T extends string>(value: unknown, name: string, values: Set<string>): T {
  if (typeof value !== "string" || !values.has(value)) malformed(`unknown ${name}`);
  return value as T;
}

function frame(value: unknown): ObjectValue {
  const result = object(value, "frame");
  if (!Object.hasOwn(result, "v")) malformed("missing field v");
  if (result.v !== PROTOCOL_VERSION) {
    if (Number.isInteger(result.v)) {
      throw new ProtocolError("unsupported_protocol", "unsupported protocol version");
    }
    malformed("v must be an integer protocol version");
  }
  if (typeof result.t !== "string") malformed("t must be a frame type");
  return result;
}

export function parseCredential(value: unknown): Credential {
  const result = object(value, "credential");
  if (result.kind === "anonymous") {
    exact(result, ["kind"]);
    return result as unknown as Credential;
  }
  if (result.kind === "bearer") {
    exact(result, ["kind", "token"]);
    const token = string(result.token, "credential token", MAX_CREDENTIAL_BYTES);
    if (utf8.encode(token).byteLength > MAX_CREDENTIAL_BYTES) {
      malformed("credential token exceeds the byte limit");
    }
    return result as unknown as Credential;
  }
  return malformed("unknown credential kind");
}

function parseCredentialProvenance(value: unknown): CredentialProvenance {
  const result = object(value, "credential provenance");
  exact(result, ["issuer", "subject"]);
  string(result.issuer, "credential provenance issuer", MAX_PROVENANCE_PART_LENGTH);
  string(result.subject, "credential provenance subject", MAX_PROVENANCE_PART_LENGTH);
  return result as unknown as CredentialProvenance;
}

// Every accepted bearer presentation discloses its TTL; omission is malformed.
// `null` is the disclosure for a credential that does not expire, which is what
// an identity credential is: it ends by revocation, never by the clock.
function parseCredentialTtl(result: ObjectValue): void {
  if (result.credentialTtlMs === null) return;
  nonNegativeInteger(result.credentialTtlMs, "credentialTtlMs");
}

function parseAuthenticationDescriptor(
  result: ObjectValue,
  frameFields: readonly string[],
): void {
  switch (result.principal) {
    case "anonymous":
      exact(result, [...frameFields, "principal"]);
      return;
    case "user":
      exact(result, [...frameFields, "principal", "identity", "provenance", "credentialTtlMs"]);
      if (
        typeof result.identity !== "bigint" ||
        result.identity <= 0n ||
        result.identity > MAX_IDENTITY
      ) {
        malformed("identity must be a positive signed 64-bit bigint");
      }
      parseCredentialProvenance(result.provenance);
      parseCredentialTtl(result);
      return;
    case "workload":
      exact(result, [...frameFields, "principal", "provenance", "credentialTtlMs"]);
      parseCredentialProvenance(result.provenance);
      parseCredentialTtl(result);
      return;
    default:
      malformed("unknown client principal kind");
  }
}

export function parseOutcome(value: unknown): Outcome {
  const result = object(value, "outcome");
  exact(result, ["code", "retryable", "message"], ["retryAfterMs", "resource", "committed"]);
  const code = enumValue<OutcomeCode>(result.code, "outcome code", outcomeCodes);
  if (typeof result.retryable !== "boolean") malformed("retryable must be a boolean");
  string(result.message, "outcome message", MAX_SAFE_MESSAGE_LENGTH);
  if (Object.hasOwn(result, "retryAfterMs")) {
    const retryAfterMs = nonNegativeInteger(result.retryAfterMs, "retryAfterMs");
    if (retryAfterMs > MAX_RETRY_AFTER_MS) malformed(`retryAfterMs exceeds ${MAX_RETRY_AFTER_MS}`);
    if (!result.retryable) malformed("retryAfterMs requires a retryable outcome");
  }
  if (Object.hasOwn(result, "resource")) {
    enumValue<ResourceClass>(result.resource, "resource class", resourceClasses);
  }
  if (Object.hasOwn(result, "committed")) {
    if (result.committed !== true || code !== "convergence_unavailable") {
      malformed("committed is valid only for convergence_unavailable");
    }
  }
  if (code === "convergence_unavailable" && (result.committed !== true || result.retryable)) {
    malformed("convergence_unavailable must be committed and non-retryable");
  }
  return result as unknown as Outcome;
}

export function parseApplicationError(value: unknown): ApplicationError {
  const result = object(value, "application error");
  exact(result, ["kind", "code", "body", "status"]);
  if (result.kind !== "application") malformed("application error kind must be application");
  string(result.code, "application error code", MAX_REFERENCE_LENGTH);
  payload(result.body, "application error body");
  if (
    !Number.isInteger(result.status) ||
    !errorHttpStatuses.has(result.status as number)
  ) {
    malformed("application error status must be a supported named error status");
  }
  return result as unknown as ApplicationError<string, unknown, ErrorHttpStatus>;
}

export function parseSubscriptionCursor(value: unknown): SubscriptionCursor {
  const result = object(value, "subscription cursor");
  exact(result, ["generation", "commitVersion", "authEpoch", "identity"]);
  string(result.generation, "cursor generation", MAX_CURSOR_PART_LENGTH);
  nonNegativeBigint(result.commitVersion, "cursor commitVersion");
  nonNegativeInteger(result.authEpoch, "cursor authEpoch");
  string(result.identity, "cursor identity", MAX_CURSOR_PART_LENGTH);
  return result as unknown as SubscriptionCursor;
}

function sameStream(from: SubscriptionCursor, to: SubscriptionCursor): void {
  if (
    from.generation !== to.generation ||
    from.authEpoch !== to.authEpoch ||
    from.identity !== to.identity ||
    to.commitVersion <= from.commitVersion
  ) {
    malformed("update/checkpoint cursors must advance one stream");
  }
}

function sameCursor(from: SubscriptionCursor, to: SubscriptionCursor): void {
  if (
    from.generation !== to.generation ||
    from.commitVersion !== to.commitVersion ||
    from.authEpoch !== to.authEpoch ||
    from.identity !== to.identity
  ) {
    malformed("resume cursors must be identical");
  }
}

export function parseSubscriptionTransition(value: unknown): SubscriptionTransition {
  const result = object(value, "subscription transition");
  switch (result.kind) {
    case "reset": {
      exact(result, ["kind", "from", "to", "value"]);
      if (result.from !== null) parseSubscriptionCursor(result.from);
      parseSubscriptionCursor(result.to);
      payload(result.value, "transition value");
      return result as unknown as SubscriptionTransition;
    }
    case "update": {
      exact(result, ["kind", "from", "to", "value"]);
      const from = parseSubscriptionCursor(result.from);
      const to = parseSubscriptionCursor(result.to);
      sameStream(from, to);
      payload(result.value, "transition value");
      return result as unknown as SubscriptionTransition;
    }
    case "checkpoint": {
      exact(result, ["kind", "from", "to"]);
      const from = parseSubscriptionCursor(result.from);
      const to = parseSubscriptionCursor(result.to);
      sameStream(from, to);
      return result as unknown as SubscriptionTransition;
    }
    case "resume": {
      exact(result, ["kind", "from", "to"]);
      const from = parseSubscriptionCursor(result.from);
      const to = parseSubscriptionCursor(result.to);
      sameCursor(from, to);
      return result as unknown as SubscriptionTransition;
    }
    case "revoked": {
      exact(result, ["kind", "from", "to", "outcome"]);
      parseSubscriptionCursor(result.from);
      parseSubscriptionCursor(result.to);
      const outcome = parseOutcome(result.outcome);
      if (![
        "unauthenticated",
        "auth_unavailable",
        "auth_stale",
        "unauthorized",
      ].includes(outcome.code)) {
        malformed("revoked requires an authentication or authorization outcome");
      }
      return result as unknown as SubscriptionTransition;
    }
    case "application-error": {
      exact(result, ["kind", "from", "to", "error"]);
      if (result.from !== null) {
        const from = parseSubscriptionCursor(result.from);
        const to = parseSubscriptionCursor(result.to);
        sameStream(from, to);
      } else {
        parseSubscriptionCursor(result.to);
      }
      parseApplicationError(result.error);
      return result as unknown as SubscriptionTransition;
    }
    default:
      return malformed("unknown subscription transition kind");
  }
}

function parseLiveEventCursor(value: unknown): LiveEventCursor {
  const result = object(value, "live event cursor");
  exact(result, ["generation", "commitVersion", "sequence"]);
  string(result.generation, "event generation", MAX_CURSOR_PART_LENGTH);
  nonNegativeBigint(result.commitVersion, "event commitVersion");
  nonNegativeBigint(result.sequence, "event sequence");
  return result as unknown as LiveEventCursor;
}

function parseLiveEvent(value: unknown): LiveEvent {
  const result = object(value, "live event");
  if (result.kind === "row") {
    exact(result, ["kind", "cursor", "row"]);
    parseLiveEventCursor(result.cursor);
    payload(result.row, "event row");
    return result as unknown as LiveEvent;
  }
  if (result.kind === "gap" || result.kind === "reset") {
    exact(result, ["kind", "cursor"]);
    parseLiveEventCursor(result.cursor);
    return result as unknown as LiveEvent;
  }
  return malformed("unknown live event kind");
}

export function parseMutationReceipt(value: unknown): MutationReceipt {
  const result = object(value, "mutation receipt");
  exact(result, ["mutationRequestId", "commitVersion", "durability", "replay", "obligations"]);
  const mutationRequestId = string(result.mutationRequestId, "mutationRequestId", 36);
  if (!uuidV7.test(mutationRequestId)) malformed("mutationRequestId must be UUIDv7");
  nonNegativeBigint(result.commitVersion, "receipt commitVersion");
  enumValue<DurabilityPolicy>(result.durability, "durability policy", durabilityPolicies);
  if (result.replay !== "executed" && result.replay !== "replayed") malformed("unknown replay status");
  if (!Array.isArray(result.obligations) || result.obligations.length > MAX_RECEIPT_OBLIGATIONS) {
    malformed("obligations must be a bounded array");
  }
  const unique = new Set<number>();
  for (const obligation of result.obligations) {
    const id = protocolId(obligation, "obligation");
    if (unique.has(id)) malformed("obligations must be unique");
    unique.add(id);
  }
  return result as unknown as MutationReceipt;
}

export function parseClientMessage(value: unknown): ClientMessage {
  const result = frame(value);
  switch (result.t) {
    case "hello":
      exact(result, ["v", "t", "clientSessionId", "credential"]);
      string(result.clientSessionId, "clientSessionId", MAX_SESSION_ID_LENGTH);
      parseCredential(result.credential);
      break;
    case "auth":
      exact(result, ["v", "t", "attemptId", "credential"]);
      protocolId(result.attemptId, "attemptId");
      parseCredential(result.credential);
      break;
    case "sub":
      exact(result, ["v", "t", "id", "ref", "args"], ["cursor"]);
      protocolId(result.id, "subscription id");
      string(result.ref, "ref", MAX_REFERENCE_LENGTH);
      payload(result.args, "args");
      if (Object.hasOwn(result, "cursor")) parseSubscriptionCursor(result.cursor);
      break;
    case "unsub":
      exact(result, ["v", "t", "id"]);
      protocolId(result.id, "subscription id");
      break;
    case "reset":
      exact(result, ["v", "t", "id", "cursor"]);
      protocolId(result.id, "subscription id");
      parseSubscriptionCursor(result.cursor);
      break;
    case "q":
    case "p":
      exact(result, ["v", "t", "id", "ref", "args"]);
      protocolId(result.id, "request id");
      string(result.ref, "ref", MAX_REFERENCE_LENGTH);
      payload(result.args, "args");
      break;
    case "cancel":
      exact(result, ["v", "t", "id"]);
      protocolId(result.id, "request id");
      break;
    case "m": {
      exact(result, ["v", "t", "id", "ref", "args", "mutationRequestId", "issuedAt"]);
      protocolId(result.id, "request id");
      string(result.ref, "ref", MAX_REFERENCE_LENGTH);
      payload(result.args, "args");
      const mutationRequestId = string(result.mutationRequestId, "mutationRequestId", 36);
      if (!uuidV7.test(mutationRequestId)) malformed("mutationRequestId must be UUIDv7");
      nonNegativeInteger(result.issuedAt, "issuedAt");
      break;
    }
    case "channel_join":
      exact(result, ["v", "t", "id", "ref", "args"], ["room"]);
      protocolId(result.id, "channel id");
      string(result.ref, "ref", MAX_REFERENCE_LENGTH);
      payload(result.args, "args");
      if (Object.hasOwn(result, "room")) payload(result.room, "room");
      break;
    case "channel_leave":
      exact(result, ["v", "t", "id"]);
      protocolId(result.id, "channel id");
      break;
    case "channel_send":
      exact(result, ["v", "t", "id", "event", "payload"]);
      protocolId(result.id, "channel id");
      string(result.event, "channel event", MAX_REFERENCE_LENGTH);
      payload(result.payload, "channel payload");
      break;
    case "ping":
      exact(result, ["v", "t"]);
      break;
    default:
      return malformed("unknown client frame type");
  }
  return result as unknown as ClientMessage;
}

export function parseServerMessage(value: unknown): ServerMessage {
  const result = frame(value);
  switch (result.t) {
    case "welcome":
      parseAuthenticationDescriptor(result, ["v", "t", "clientSessionId", "authEpoch"]);
      string(result.clientSessionId, "clientSessionId", MAX_SESSION_ID_LENGTH);
      nonNegativeInteger(result.authEpoch, "authEpoch");
      break;
    case "auth":
      parseAuthenticationDescriptor(result, ["v", "t", "attemptId", "authEpoch"]);
      protocolId(result.attemptId, "attemptId");
      nonNegativeInteger(result.authEpoch, "authEpoch");
      break;
    case "transition":
      exact(result, ["v", "t", "id", "transition"]);
      protocolId(result.id, "subscription id");
      parseSubscriptionTransition(result.transition);
      break;
    case "event":
      exact(result, ["v", "t", "id", "event"]);
      protocolId(result.id, "subscription id");
      parseLiveEvent(result.event);
      break;
    case "ok":
      if (result.kind === "mutation") {
        exact(result, ["v", "t", "id", "kind", "value", "receipt"]);
        parseMutationReceipt(result.receipt);
      } else if (result.kind === "query" || result.kind === "procedure") {
        exact(result, ["v", "t", "id", "kind", "value"]);
      } else {
        return malformed("unknown ok frame kind");
      }
      protocolId(result.id, "request id");
      payload(result.value, "result value");
      break;
    case "app_err":
      if (result.kind === "mutation") {
        exact(result, ["v", "t", "id", "kind", "error", "receipt"]);
        parseMutationReceipt(result.receipt);
      } else if (result.kind === "query" || result.kind === "procedure") {
        exact(result, ["v", "t", "id", "kind", "error"]);
      } else {
        return malformed("unknown application-error frame kind");
      }
      protocolId(result.id, "request id");
      parseApplicationError(result.error);
      break;
    case "channel_ready":
      exact(result, ["v", "t", "id", "authEpoch"]);
      protocolId(result.id, "channel id");
      nonNegativeInteger(result.authEpoch, "authEpoch");
      break;
    case "channel_event":
      exact(result, ["v", "t", "id", "event", "payload"]);
      protocolId(result.id, "channel id");
      string(result.event, "channel event", MAX_REFERENCE_LENGTH);
      payload(result.payload, "channel payload");
      break;
    case "channel_rejected":
      exact(result, ["v", "t", "id", "authEpoch", "error"]);
      protocolId(result.id, "channel id");
      nonNegativeInteger(result.authEpoch, "authEpoch");
      parseApplicationError(result.error);
      break;
    case "err":
      exact(result, ["v", "t", "id", "outcome"]);
      if (result.id !== null) protocolId(result.id, "request id");
      parseOutcome(result.outcome);
      break;
    case "pong":
      exact(result, ["v", "t"]);
      break;
    default:
      return malformed("unknown server frame type");
  }
  return result as unknown as ServerMessage;
}

export function parseSseMessage(value: unknown): SseMessage {
  const result = frame(value);
  switch (result.t) {
    case "sse_chunk":
      exact(result, ["v", "t", "seq", "proof", "value"]);
      payload(result.value, "SSE chunk value");
      break;
    case "sse_done":
      exact(result, ["v", "t", "seq", "proof"]);
      break;
    case "sse_error":
      exact(result, ["v", "t", "seq", "proof", "outcome"]);
      parseOutcome(result.outcome);
      break;
    default:
      return malformed("unknown SSE frame type");
  }
  positiveSafeInteger(result.seq, "SSE sequence");
  string(result.proof, "SSE proof", MAX_SSE_TOKEN_LENGTH);
  return result as unknown as SseMessage;
}

export function parseSseAckRequest(value: unknown): SseAckRequest {
  const result = frame(value);
  if (result.t !== "sse_ack") malformed("SSE acknowledgment must be an sse_ack frame");
  exact(result, ["v", "t", "stream", "seq", "proof"]);
  string(result.stream, "SSE stream", MAX_SSE_TOKEN_LENGTH);
  positiveSafeInteger(result.seq, "SSE sequence");
  string(result.proof, "SSE proof", MAX_SSE_TOKEN_LENGTH);
  return result as unknown as SseAckRequest;
}
