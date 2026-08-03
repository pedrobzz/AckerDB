import {
  type AnyChannelRef,
  type ChannelRef,
  type ChannelRoom,
  type ChannelServerEvents,
  type EventMap,
  type RegisteredChannelContract,
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
  authorizationResult as channelAuthorizationResult,
  validateDeclaration,
  validateEventDeclarations,
  validateArgsShape,
} from "../validation/declarations.ts";

export type ChannelEventDeclarations = Readonly<
  Record<string, Validator<unknown, string>>
>;

type RoomInput<Room extends Validator<unknown, string> | undefined> =
  Room extends Validator<unknown, string>
    ? Expand<InferValidatorInput<Room>>
    : never;

type RoomOutput<Room extends Validator<unknown, string> | undefined> =
  Room extends Validator<unknown, string>
    ? Expand<InferValidator<Room>>
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
  validateEventDeclarations(definition.clientEvents, "clientEvents");
  validateEventDeclarations(definition.serverEvents, "serverEvents");
  if (definition.room !== undefined) {
    validateDeclaration(definition.room, "room");
  }
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

export { channelAuthorizationResult };
