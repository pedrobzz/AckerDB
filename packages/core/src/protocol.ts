/**
 * Protocol 2 is the executable client/server envelope contract. Application
 * arguments, results, and event rows remain opaque and keep their inferred
 * TypeScript types; every framework-owned field is validated after wire decode.
 */

export const PROTOCOL_VERSION = 2 as const;
export const MAX_PROTOCOL_ID = 0x7fff_ffff;
export const MAX_RETRY_AFTER_MS = 30_000;
export const MAX_CREDENTIAL_BYTES = 16 * 1024;
export const MAX_RECEIPT_OBLIGATIONS = 65_536;

const MAX_SESSION_ID_LENGTH = 128;
const MAX_REFERENCE_LENGTH = 512;
const MAX_CURSOR_PART_LENGTH = 512;
const MAX_SAFE_MESSAGE_LENGTH = 512;

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

export interface MutationMessage extends Frame<"m"> {
  id: number;
  ref: string;
  args: unknown;
  mutationRequestId: string;
  issuedAt: number;
}

export type PingMessage = Frame<"ping">;

export type ClientMessage =
  | HelloMessage
  | ClientAuthMessage
  | SubscribeMessage
  | UnsubscribeMessage
  | ResetRequestMessage
  | QueryMessage
  | MutationMessage
  | PingMessage;

export interface WelcomeMessage extends Frame<"welcome"> {
  clientSessionId: string;
  authEpoch: number;
  principal: PrincipalKind;
}

export interface AuthenticatedMessage extends Frame<"auth"> {
  attemptId: number;
  authEpoch: number;
  principal: PrincipalKind;
}

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
  | ErrorMessage
  | PongMessage;

/** Versioned HTTP body for procedure and SSE procedure calls. */
export interface CallRequest extends Frame<"call"> {
  id: number;
  ref: string;
  args: unknown;
}

export type CallResponse = ProcedureOkMessage | ErrorMessage;

export class ProtocolError extends Error {
  constructor(
    readonly code: "malformed" | "unsupported_protocol",
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

type ObjectValue = Record<string, unknown>;

const outcomeCodes = new Set<string>(OUTCOME_CODES);
const resourceClasses = new Set<string>(RESOURCE_CLASSES);
const durabilityPolicies = new Set<string>(DURABILITY_POLICIES);
const principalKinds = new Set<string>(PRINCIPAL_KINDS);
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Extract the embedded Unix-millisecond timestamp from a validated UUIDv7. */
export function uuidV7Timestamp(value: string): number {
  if (!uuidV7.test(value)) malformed("mutationRequestId must be UUIDv7");
  return Number.parseInt(value.slice(0, 8) + value.slice(9, 13), 16);
}
const utf8 = new TextEncoder();

function malformed(message: string): never {
  throw new ProtocolError("malformed", message);
}

function object(value: unknown, name: string): ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    malformed(`${name} must be an object`);
  }
  return value as ObjectValue;
}

function exact(value: ObjectValue, required: readonly string[], optional: readonly string[] = []): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) malformed(`missing field ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) malformed(`unknown field ${key}`);
  }
}

function string(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    malformed(`${name} must be a non-empty bounded string`);
  }
  return value;
}

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
      exact(result, ["v", "t", "id", "ref", "args"]);
      protocolId(result.id, "request id");
      string(result.ref, "ref", MAX_REFERENCE_LENGTH);
      payload(result.args, "args");
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
      exact(result, ["v", "t", "clientSessionId", "authEpoch", "principal"]);
      string(result.clientSessionId, "clientSessionId", MAX_SESSION_ID_LENGTH);
      nonNegativeInteger(result.authEpoch, "authEpoch");
      enumValue<PrincipalKind>(result.principal, "principal kind", principalKinds);
      break;
    case "auth":
      exact(result, ["v", "t", "attemptId", "authEpoch", "principal"]);
      protocolId(result.attemptId, "attemptId");
      nonNegativeInteger(result.authEpoch, "authEpoch");
      enumValue<PrincipalKind>(result.principal, "principal kind", principalKinds);
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

export function parseCallRequest(value: unknown): CallRequest {
  const result = frame(value);
  if (result.t !== "call") malformed("HTTP request must be a call frame");
  exact(result, ["v", "t", "id", "ref", "args"]);
  protocolId(result.id, "request id");
  string(result.ref, "ref", MAX_REFERENCE_LENGTH);
  payload(result.args, "args");
  return result as unknown as CallRequest;
}

export function parseCallResponse(value: unknown): CallResponse {
  const result = parseServerMessage(value);
  if (result.t === "err" || (result.t === "ok" && result.kind === "procedure")) return result;
  return malformed("HTTP response must be a procedure result or error");
}
