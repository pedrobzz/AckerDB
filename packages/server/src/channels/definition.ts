import {
  isResult,
  type ApplicationError,
  type AnyChannelRef,
  type ChannelRef,
  type ChannelRoom,
  type ChannelServerEvents,
  type EventMap,
  type RegisteredChannelContract,
  type Result,
} from "@ackerdb/core";
import type { Schema } from "../schema/definition.ts";
import {
  isAccessPolicy,
  validateArgsShape,
  type AccessPolicy,
  type ArgsInput,
  type Invocable,
  type ProcedureCtx,
} from "../app/functions.ts";
import {
  compileInvocation,
  type InvocationContext,
} from "../app/invocation.ts";
import {
  type Expand,
  type InferShape,
  type InferValidator,
  type InferValidatorInput,
  type ObjectShape,
  type Validator,
} from "../validation/v.ts";

export type ChannelEventDeclarations = Readonly<
  Record<string, Validator<unknown, string>>
>;

type EventInputs<Declarations extends ChannelEventDeclarations> = {
  readonly [Name in keyof Declarations]: Expand<
    InferValidatorInput<Declarations[Name]>
  >;
};

type EventOutputs<Declarations extends ChannelEventDeclarations> = {
  readonly [Name in keyof Declarations]: Expand<
    InferValidator<Declarations[Name]>
  >;
};

type RoomInput<Room extends Validator<unknown, string> | undefined> =
  Room extends Validator<unknown, string>
    ? Expand<InferValidatorInput<Room>>
    : never;

type RoomOutput<Room extends Validator<unknown, string> | undefined> =
  Room extends Validator<unknown, string>
    ? Expand<InferValidator<Room>>
    : never;

type AuthorizationState<Value> =
  Awaited<Value> extends Result<infer State, infer _Error>
    ? State
    : Awaited<Value>;

type AuthorizationError<Value> =
  Awaited<Value> extends Result<infer _State, infer Error>
    ? Error
    : never;

type ChannelRoomProperty<Room> = [Room] extends [never]
  ? Readonly<Record<never, never>>
  : { readonly room: Room };

export type ChannelDisconnectReason =
  | "leave"
  | "disconnect"
  | "authentication-change"
  | "server-shutdown";

export type ChannelAuthorizationCtx<
  S extends Schema,
  Room,
> = ProcedureCtx<S> & ChannelRoomProperty<Room>;

export type ChannelSend<Events extends EventMap> = <
  Name extends Extract<keyof Events, string>,
>(
  event: Name,
  payload: NoInfer<Events[Name]>,
) => Promise<boolean>;

export type ChannelPublish<Events extends EventMap> = <
  Name extends Extract<keyof Events, string>,
>(
  event: Name,
  payload: NoInfer<Events[Name]>,
) => Promise<number>;

type TargetRoom<Ref extends AnyChannelRef> = [ChannelRoom<Ref>] extends [never]
  ? Readonly<Record<never, never>>
  : { readonly room: ChannelRoom<Ref> };

export type ChannelTargetEvent<
  Ref extends AnyChannelRef,
  Name extends Extract<keyof ChannelServerEvents<Ref>, string>,
> = TargetRoom<Ref> & {
  readonly event: Name;
  readonly payload: ChannelServerEvents<Ref>[Name];
};

export interface ChannelPublisher {
  publish<
    Ref extends AnyChannelRef,
    Name extends Extract<keyof ChannelServerEvents<Ref>, string>,
  >(
    channel: Ref,
    args: ChannelArgsInput<Ref>,
    event: ChannelTargetEvent<Ref, Name>,
  ): Promise<number>;
}

export type ChannelArgsInput<Ref extends AnyChannelRef> =
  Ref extends ChannelRef<infer Args, unknown, EventMap, EventMap, unknown>
    ? Args
    : never;

export type ChannelCtx<
  S extends Schema,
  Args,
  Room,
  State,
  ServerEvents extends EventMap,
> = ProcedureCtx<S> & ChannelRoomProperty<Room> & {
  readonly args: Args;
  readonly state: State;
  readonly send: ChannelSend<ServerEvents>;
  readonly publish: ChannelPublish<ServerEvents>;
  readonly channels: ChannelPublisher;
};

export type ChannelHandlers<
  S extends Schema,
  Args,
  Room,
  State,
  ClientEvents extends EventMap,
  ServerEvents extends EventMap,
> = {
  readonly [Name in keyof ClientEvents]: (
    ctx: ChannelCtx<S, Args, Room, State, ServerEvents>,
    payload: ClientEvents[Name],
  ) => unknown;
};

interface ChannelDefinitionBase<
  A extends ObjectShape,
  Room extends Validator<unknown, string> | undefined,
  ClientDeclarations extends ChannelEventDeclarations,
  ServerDeclarations extends ChannelEventDeclarations,
  S extends Schema,
> {
  readonly args: A;
  readonly room?: Room;
  readonly clientEvents: ClientDeclarations;
  readonly serverEvents: ServerDeclarations;
  readonly access: AccessPolicy<
    ChannelAuthorizationCtx<S, RoomOutput<Room>>,
    Expand<InferShape<A>>
  >;
}

export interface ChannelDefinition<
  A extends ObjectShape,
  Room extends Validator<unknown, string> | undefined,
  ClientDeclarations extends ChannelEventDeclarations,
  ServerDeclarations extends ChannelEventDeclarations,
  AuthorizationReturn,
  S extends Schema,
> extends ChannelDefinitionBase<A, Room, ClientDeclarations, ServerDeclarations, S> {
  readonly authorize?: (
    ctx: ChannelAuthorizationCtx<S, RoomOutput<Room>>,
    args: Expand<InferShape<A>>,
  ) => AuthorizationReturn;
  readonly on: ChannelHandlers<
    S,
    Expand<InferShape<A>>,
    RoomOutput<Room>,
    NoInfer<AuthorizationState<AuthorizationReturn>>,
    EventOutputs<ClientDeclarations>,
    EventInputs<ServerDeclarations>
  >;
  readonly onConnect?: (
    ctx: ChannelCtx<
      S,
      Expand<InferShape<A>>,
      RoomOutput<Room>,
      NoInfer<AuthorizationState<AuthorizationReturn>>,
      EventInputs<ServerDeclarations>
    >,
  ) => unknown;
  readonly onDisconnect?: (
    ctx: ChannelCtx<
      S,
      Expand<InferShape<A>>,
      RoomOutput<Room>,
      NoInfer<AuthorizationState<AuthorizationReturn>>,
      EventInputs<ServerDeclarations>
    >,
    reason: ChannelDisconnectReason,
  ) => unknown;
}

export interface RegisteredChannel<
  A extends ObjectShape = ObjectShape,
  Room extends Validator<unknown, string> | undefined = Validator<unknown, string> | undefined,
  ClientDeclarations extends ChannelEventDeclarations = ChannelEventDeclarations,
  ServerDeclarations extends ChannelEventDeclarations = ChannelEventDeclarations,
  AuthorizationReturn = unknown,
  S extends Schema = Schema,
> extends
  RegisteredChannelContract<
    ArgsInput<A>,
    RoomInput<Room>,
    EventInputs<ClientDeclarations>,
    EventOutputs<ServerDeclarations>,
    AuthorizationError<AuthorizationReturn>
  >,
  Invocable<
    "channel",
    A,
    ChannelAuthorizationCtx<S, RoomOutput<Room>>,
    AuthorizationReturn
  > {
  readonly args: A;
  readonly room?: Room;
  readonly clientEvents: ClientDeclarations;
  readonly serverEvents: ServerDeclarations;
  readonly access: AccessPolicy<
    ChannelAuthorizationCtx<S, RoomOutput<Room>>,
    Expand<InferShape<A>>
  >;
  readonly authorize?: (
    ctx: ChannelAuthorizationCtx<S, RoomOutput<Room>>,
    args: Expand<InferShape<A>>,
  ) => AuthorizationReturn;
  readonly handler: (
    ctx: ChannelAuthorizationCtx<S, RoomOutput<Room>>,
    args: Expand<InferShape<A>>,
  ) => AuthorizationReturn | Promise<AuthorizationReturn>;
  readonly on: ChannelHandlers<
    S,
    Expand<InferShape<A>>,
    RoomOutput<Room>,
    AuthorizationState<AuthorizationReturn>,
    EventOutputs<ClientDeclarations>,
    EventInputs<ServerDeclarations>
  >;
  readonly onConnect?: ChannelDefinition<
    A,
    Room,
    ClientDeclarations,
    ServerDeclarations,
    AuthorizationReturn,
    S
  >["onConnect"];
  readonly onDisconnect?: ChannelDefinition<
    A,
    Room,
    ClientDeclarations,
    ServerDeclarations,
    AuthorizationReturn,
    S
  >["onDisconnect"];
}

function validator(value: unknown, path: string): asserts value is Validator<unknown, string> {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as Validator).kind !== "string" ||
    typeof (value as Validator).check !== "function"
  ) {
    throw new TypeError(`${path} must be a v validator`);
  }
}

function eventDeclarations(value: unknown, path: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an event validator map`);
  }
  for (const [name, declaration] of Object.entries(value)) {
    if (name.length === 0) throw new TypeError(`${path} event names must be non-empty`);
    validator(declaration, `${path}.${name}`);
  }
}

export type ChannelBuilder<S extends Schema> = <
  A extends ObjectShape,
  Room extends Validator<unknown, string> | undefined = undefined,
  ClientDeclarations extends ChannelEventDeclarations = ChannelEventDeclarations,
  ServerDeclarations extends ChannelEventDeclarations = ChannelEventDeclarations,
  AuthorizationReturn = undefined,
>(
  definition: ChannelDefinition<
    A,
    Room,
    ClientDeclarations,
    ServerDeclarations,
    AuthorizationReturn,
    S
  >,
) => RegisteredChannel<
  A,
  Room,
  ClientDeclarations,
  ServerDeclarations,
  AuthorizationReturn,
  S
>;

export const channel: ChannelBuilder<Schema> = <
  A extends ObjectShape,
  Room extends Validator<unknown, string> | undefined = undefined,
  ClientDeclarations extends ChannelEventDeclarations = ChannelEventDeclarations,
  ServerDeclarations extends ChannelEventDeclarations = ChannelEventDeclarations,
  AuthorizationReturn = undefined,
>(
  definition: ChannelDefinition<
    A,
    Room,
    ClientDeclarations,
    ServerDeclarations,
    AuthorizationReturn,
    Schema
  >,
): RegisteredChannel<
  A,
  Room,
  ClientDeclarations,
  ServerDeclarations,
  AuthorizationReturn,
  Schema
> => {
  if (!isAccessPolicy(definition.access)) {
    throw new TypeError(
      "channel access must be public, authenticated, system, or a policy callback",
    );
  }
  validateArgsShape(definition.args);
  eventDeclarations(definition.clientEvents, "clientEvents");
  eventDeclarations(definition.serverEvents, "serverEvents");
  if (definition.room !== undefined) validator(definition.room, "room");
  if (typeof definition.on !== "object" || definition.on === null) {
    throw new TypeError("on must be a channel event handler map");
  }
  for (const name of Object.keys(definition.clientEvents)) {
    if (typeof definition.on[name] !== "function") {
      throw new TypeError(`on.${name} must be a channel event handler`);
    }
  }
  for (const name of Object.keys(definition.on)) {
    if (!Object.hasOwn(definition.clientEvents, name)) {
      throw new TypeError(`on.${name} has no matching client event declaration`);
    }
  }
  if (definition.authorize !== undefined && typeof definition.authorize !== "function") {
    throw new TypeError("authorize must be a function");
  }
  if (definition.onConnect !== undefined && typeof definition.onConnect !== "function") {
    throw new TypeError("onConnect must be a function");
  }
  if (definition.onDisconnect !== undefined && typeof definition.onDisconnect !== "function") {
    throw new TypeError("onDisconnect must be a function");
  }

  const registered = Object.freeze({
    isAckerDBChannel: true as const,
    kind: "channel" as const,
    ...definition,
    handler: definition.authorize ?? (() => undefined),
  }) as unknown as RegisteredChannel<
    A,
    Room,
    ClientDeclarations,
    ServerDeclarations,
    AuthorizationReturn,
    Schema
  >;
  compileInvocation(registered as unknown as {
    readonly args: ObjectShape;
    readonly access: AccessPolicy<InvocationContext, unknown>;
  });
  return registered;
};

export type AnyRegisteredChannel = RegisteredChannel<
  ObjectShape,
  Validator<unknown, string> | undefined,
  ChannelEventDeclarations,
  ChannelEventDeclarations,
  unknown,
  Schema
>;

export function isRegisteredChannel(value: unknown): value is AnyRegisteredChannel {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly isAckerDBChannel?: unknown }).isAckerDBChannel === true &&
    (value as { readonly kind?: unknown }).kind === "channel"
  );
}

/** Runtime helper: an authorization callback may return raw state or Result. */
export function channelAuthorizationResult(
  value: unknown,
): { readonly ok: true; readonly state: unknown } | {
  readonly ok: false;
  readonly error: ApplicationError;
} {
  if (!isResult(value)) return Object.freeze({ ok: true, state: value });
  return value.ok
    ? Object.freeze({ ok: true, state: value.data })
    : Object.freeze({ ok: false, error: value.error as ApplicationError });
}
