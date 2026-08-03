import {
  type EventMap,
  type PortableRTCConfiguration,
  type PortableRTCPeerConnection,
  type RegisteredRealtimeContract,
  type RealtimeStreamMap,
} from "@ackerdb/core";
import type { Schema } from "../schema/definition.ts";
import {
  type ArgsInput,
  type Invocable,
  type ProcedureCtx,
} from "../app/functions.ts";
import { compileInvocation } from "../app/invocation.ts";
import {
  isAccessPolicy,
  type AccessPolicy,
  type InvocationContext,
} from "../app/access.ts";
import {
  type Expand,
  type InferShape,
  type InferValidator,
  type InferValidatorInput,
  type ObjectShape,
  type Validator,
} from "../validation/v.ts";
import {
  type AuthorizationError,
  type AuthorizationState,
  type DeclarationInputs as EventInputs,
  type DeclarationOutputs as EventOutputs,
  authorizationResult as realtimeAuthorizationResult,
  validateDeclaration,
  validateEventDeclarations,
  validateArgsShape,
} from "../validation/declarations.ts";
import type { RealtimeMedia } from "./media.ts";

type EmptyRealtimeCapabilities = Readonly<Record<never, never>>;

export type RealtimeRTCConfiguration = PortableRTCConfiguration;
export type RealtimePeerConnection = PortableRTCPeerConnection;

export type RealtimeEventDeclarations = Readonly<
  Record<string, Validator<unknown, string>>
>;

export interface RealtimeStreamDeclaration<
  Metadata extends Validator<unknown, string> = Validator<unknown, string>,
> {
  readonly metadata: Metadata;
  readonly maxBytes?: number;
}

export type RealtimeStreamDeclarations = Readonly<
  Record<string, RealtimeStreamDeclaration>
>;

type StreamInputs<Declarations extends RealtimeStreamDeclarations> = {
  readonly [Name in keyof Declarations]: Expand<
    InferValidatorInput<Declarations[Name]["metadata"]>
  >;
};

type StreamOutputs<Declarations extends RealtimeStreamDeclarations> = {
  readonly [Name in keyof Declarations]: Expand<
    InferValidator<Declarations[Name]["metadata"]>
  >;
};

export interface RealtimeIncomingStream<Metadata> {
  readonly id: string;
  readonly size?: number;
  readonly metadata: Metadata;
  readonly readable: ReadableStream<Uint8Array>;
  readonly abortSignal: AbortSignal;
}

export interface RealtimeOutgoingStream {
  readonly id: string;
  readonly writable: WritableStream<Uint8Array>;
}

export interface RealtimeOpenStreamOptions {
  readonly size?: number;
}

export type RealtimeSend<Events extends EventMap> = <
  Name extends Extract<keyof Events, string>,
>(
  event: Name,
  payload: NoInfer<Events[Name]>,
) => boolean;

export interface RealtimeEventRegistrar<Events extends EventMap> {
  <Name extends Extract<keyof Events, string>>(
    event: Name,
    handler: (payload: Events[Name]) => unknown,
  ): () => void;
}

export interface RealtimeRun {
  /**
   * Runs work originating outside AckerDB's transport callbacks—such as an
   * upstream WebSocket message—inside this realtime session's invocation
   * context, concurrency limit, abort lifecycle, and failure boundary.
   */
  (work: () => unknown): void;
}

export interface RealtimeStreamRegistrar<Streams extends RealtimeStreamMap> {
  <Name extends Extract<keyof Streams, string>>(
    stream: Name,
    handler: (input: RealtimeIncomingStream<Streams[Name]>) => unknown,
  ): void;
}

export interface RealtimeStreamOpener<Streams extends RealtimeStreamMap> {
  <Name extends Extract<keyof Streams, string>>(
    stream: Name,
    metadata: NoInfer<Streams[Name]>,
    options?: RealtimeOpenStreamOptions,
  ): RealtimeOutgoingStream;
}

export type RealtimeAuthorizationCtx<
  S extends Schema,
  Capabilities extends object = EmptyRealtimeCapabilities,
  TransactionCapabilities extends object = EmptyRealtimeCapabilities,
> = ProcedureCtx<S, Capabilities, TransactionCapabilities>;

export type RealtimeCtx<
  S extends Schema,
  State,
  ClientEvents extends EventMap,
  ServerEvents extends EventMap,
  ClientStreams extends RealtimeStreamMap,
  ServerStreams extends RealtimeStreamMap,
  Capabilities extends object = EmptyRealtimeCapabilities,
  TransactionCapabilities extends object = EmptyRealtimeCapabilities,
> = ProcedureCtx<S, Capabilities, TransactionCapabilities> & {
  readonly state: State;
  readonly peerConnection: RealtimePeerConnection;
  /**
   * Creates a session-owned auxiliary peer, for example a connection to an
   * upstream realtime provider. It closes automatically with this session.
   */
  readonly createPeerConnection: (
    configuration?: RealtimeRTCConfiguration,
  ) => RealtimePeerConnection;
  readonly run: RealtimeRun;
  /** Lazy raw-media access. No frame decoding happens until a stream is made. */
  readonly media: RealtimeMedia;
  readonly on: RealtimeEventRegistrar<ClientEvents>;
  readonly send: RealtimeSend<ServerEvents>;
  readonly onStream: RealtimeStreamRegistrar<ClientStreams>;
  readonly openStream: RealtimeStreamOpener<ServerStreams>;
};

interface RealtimeDefinitionBase<
  A extends ObjectShape,
  ClientEventDeclarations extends RealtimeEventDeclarations,
  ServerEventDeclarations extends RealtimeEventDeclarations,
  ClientStreamDeclarations extends RealtimeStreamDeclarations,
  ServerStreamDeclarations extends RealtimeStreamDeclarations,
  S extends Schema,
  Capabilities extends object = EmptyRealtimeCapabilities,
  TransactionCapabilities extends object = EmptyRealtimeCapabilities,
> {
  readonly args: A;
  readonly clientEvents: ClientEventDeclarations;
  readonly serverEvents: ServerEventDeclarations;
  readonly clientStreams?: ClientStreamDeclarations;
  readonly serverStreams?: ServerStreamDeclarations;
  readonly access: AccessPolicy<
    RealtimeAuthorizationCtx<S, Capabilities, TransactionCapabilities>,
    Expand<InferShape<A>>
  >;
}

export interface RealtimeDefinition<
  A extends ObjectShape,
  ClientEventDeclarations extends RealtimeEventDeclarations,
  ServerEventDeclarations extends RealtimeEventDeclarations,
  ClientStreamDeclarations extends RealtimeStreamDeclarations,
  ServerStreamDeclarations extends RealtimeStreamDeclarations,
  AuthorizationReturn,
  HandlerReturn,
  S extends Schema,
  Capabilities extends object = EmptyRealtimeCapabilities,
  TransactionCapabilities extends object = EmptyRealtimeCapabilities,
> extends RealtimeDefinitionBase<
  A,
  ClientEventDeclarations,
  ServerEventDeclarations,
  ClientStreamDeclarations,
  ServerStreamDeclarations,
  S,
  Capabilities,
  TransactionCapabilities
> {
  readonly authorize?: (
    ctx: RealtimeAuthorizationCtx<S, Capabilities, TransactionCapabilities>,
    args: Expand<InferShape<A>>,
  ) => AuthorizationReturn;
  readonly handler: (
    ctx: RealtimeCtx<
      S,
      NoInfer<AuthorizationState<AuthorizationReturn>>,
      EventOutputs<ClientEventDeclarations>,
      EventInputs<ServerEventDeclarations>,
      StreamOutputs<ClientStreamDeclarations>,
      StreamInputs<ServerStreamDeclarations>,
      Capabilities,
      TransactionCapabilities
    >,
    args: Expand<InferShape<A>>,
  ) => HandlerReturn;
}

export interface RegisteredRealtime<
  A extends ObjectShape = ObjectShape,
  ClientEventDeclarations extends RealtimeEventDeclarations = RealtimeEventDeclarations,
  ServerEventDeclarations extends RealtimeEventDeclarations = RealtimeEventDeclarations,
  ClientStreamDeclarations extends RealtimeStreamDeclarations = RealtimeStreamDeclarations,
  ServerStreamDeclarations extends RealtimeStreamDeclarations = RealtimeStreamDeclarations,
  AuthorizationReturn = unknown,
  HandlerReturn = unknown,
  S extends Schema = Schema,
  Capabilities extends object = EmptyRealtimeCapabilities,
  TransactionCapabilities extends object = EmptyRealtimeCapabilities,
> extends
  RegisteredRealtimeContract<
    ArgsInput<A>,
    EventInputs<ClientEventDeclarations>,
    EventOutputs<ServerEventDeclarations>,
    StreamInputs<ClientStreamDeclarations>,
    StreamOutputs<ServerStreamDeclarations>,
    AuthorizationError<AuthorizationReturn>
  >,
  Invocable<
    "realtime",
    A,
    RealtimeCtx<
      S,
      AuthorizationState<AuthorizationReturn>,
      EventOutputs<ClientEventDeclarations>,
      EventInputs<ServerEventDeclarations>,
      StreamOutputs<ClientStreamDeclarations>,
      StreamInputs<ServerStreamDeclarations>,
      Capabilities,
      TransactionCapabilities
    >,
    HandlerReturn
  > {
  readonly clientEvents: ClientEventDeclarations;
  readonly serverEvents: ServerEventDeclarations;
  readonly clientStreams: ClientStreamDeclarations;
  readonly serverStreams: ServerStreamDeclarations;
  readonly authorize?: (
    ctx: RealtimeAuthorizationCtx<S, Capabilities, TransactionCapabilities>,
    args: Expand<InferShape<A>>,
  ) => AuthorizationReturn;
}

interface RealtimeAuthorizationInvocation<
  A extends ObjectShape,
  AuthorizationReturn,
  S extends Schema,
  Capabilities extends object = EmptyRealtimeCapabilities,
  TransactionCapabilities extends object = EmptyRealtimeCapabilities,
> extends Invocable<
  "realtime-authorization",
  A,
  RealtimeAuthorizationCtx<S, Capabilities, TransactionCapabilities>,
  AuthorizationReturn
> {}

const authorizationInvocations = new WeakMap<
  AnyRegisteredRealtime,
  RealtimeAuthorizationInvocation<ObjectShape, unknown, Schema, any, any>
>();

function streamDeclarations(value: unknown, path: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be a stream declaration map`);
  }
  for (const [name, declaration] of Object.entries(value)) {
    if (name.length === 0) throw new TypeError(`${path} stream names must be non-empty`);
    if (typeof declaration !== "object" || declaration === null) {
      throw new TypeError(`${path}.${name} must be a stream declaration`);
    }
    validateDeclaration(
      (declaration as RealtimeStreamDeclaration).metadata,
      `${path}.${name}.metadata`,
    );
    const maxBytes = (declaration as RealtimeStreamDeclaration).maxBytes;
    if (
      maxBytes !== undefined &&
      (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    ) {
      throw new TypeError(`${path}.${name}.maxBytes must be a positive safe integer`);
    }
  }
}

const EMPTY_STREAMS = Object.freeze({}) as RealtimeStreamDeclarations;

export type RealtimeBuilder<
  S extends Schema,
  Capabilities extends object = EmptyRealtimeCapabilities,
  TransactionCapabilities extends object = EmptyRealtimeCapabilities,
> = <
  A extends ObjectShape,
  ClientEventDeclarations extends RealtimeEventDeclarations,
  ServerEventDeclarations extends RealtimeEventDeclarations,
  ClientStreamDeclarations extends RealtimeStreamDeclarations = Record<never, never>,
  ServerStreamDeclarations extends RealtimeStreamDeclarations = Record<never, never>,
  AuthorizationReturn = undefined,
  HandlerReturn = unknown,
>(
  definition: RealtimeDefinition<
    A,
    ClientEventDeclarations,
    ServerEventDeclarations,
    ClientStreamDeclarations,
    ServerStreamDeclarations,
    AuthorizationReturn,
    HandlerReturn,
    S,
    Capabilities,
    TransactionCapabilities
  >,
) => RegisteredRealtime<
  A,
  ClientEventDeclarations,
  ServerEventDeclarations,
  ClientStreamDeclarations,
  ServerStreamDeclarations,
  AuthorizationReturn,
  HandlerReturn,
  S,
  Capabilities,
  TransactionCapabilities
>;

export const realtime: RealtimeBuilder<Schema> = (definition) => {
  if (!isAccessPolicy(definition.access)) {
    throw new TypeError(
      "realtime access must be public, authenticated, system, or a policy callback",
    );
  }
  validateArgsShape(definition.args);
  validateEventDeclarations(definition.clientEvents, "clientEvents");
  validateEventDeclarations(definition.serverEvents, "serverEvents");
  streamDeclarations(definition.clientStreams ?? EMPTY_STREAMS, "clientStreams");
  streamDeclarations(definition.serverStreams ?? EMPTY_STREAMS, "serverStreams");
  if (definition.authorize !== undefined && typeof definition.authorize !== "function") {
    throw new TypeError("authorize must be a function");
  }
  if (typeof definition.handler !== "function") {
    throw new TypeError("handler must be a function");
  }

  const registered = Object.freeze({
    isAckerDBRealtime: true as const,
    kind: "realtime" as const,
    ...definition,
    clientStreams: definition.clientStreams ?? EMPTY_STREAMS,
    serverStreams: definition.serverStreams ?? EMPTY_STREAMS,
  }) as unknown as AnyRegisteredRealtime;
  const authorization = Object.freeze({
    kind: "realtime-authorization" as const,
    args: registered.args,
    access: registered.access,
    handler: registered.authorize ?? (() => undefined),
  }) as RealtimeAuthorizationInvocation<ObjectShape, unknown, Schema, any, any>;
  compileInvocation(registered);
  compileInvocation(authorization);
  authorizationInvocations.set(registered, authorization);
  return registered as never;
};

export type AnyRegisteredRealtime = RegisteredRealtime<
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  Schema,
  any,
  any
>;

export function isRegisteredRealtime(value: unknown): value is AnyRegisteredRealtime {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly isAckerDBRealtime?: unknown }).isAckerDBRealtime === true &&
    (value as { readonly kind?: unknown }).kind === "realtime"
  );
}

export function realtimeAuthorization(
  definition: AnyRegisteredRealtime,
): RealtimeAuthorizationInvocation<ObjectShape, unknown, Schema, any, any> {
  const invocation = authorizationInvocations.get(definition);
  if (invocation === undefined) {
    throw new Error("realtime authorization invocation was not compiled");
  }
  return invocation;
}

export { realtimeAuthorizationResult };
