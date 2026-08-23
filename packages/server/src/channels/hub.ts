import {
  getRef,
  isApplicationError,
  stableEncode,
  type ApplicationError,
  type ChannelRef,
} from "@ackerdb/core";
import type { Principal } from "../auth/credentials.ts";
import {
  invokeFunction,
  invokeRegisteredHandler,
} from "../app/invocation.ts";
import type {
  OwnedProcedureContext,
  ProcedureCtx,
} from "../app/functions.ts";
import type { Registry } from "../app/registry.ts";
import { deepFreeze } from "../shared/immutable.ts";
import { AckerDBError } from "../shared/errors.ts";
import { positiveSafeInteger } from "../shared/numbers.ts";
import { settleOnAbort } from "../runtime/abort.ts";
import type { Validator } from "../validation/validator.ts";
import {
  channelAuthorizationResult,
  type AnyRegisteredChannel,
  type ChannelDisconnectReason,
} from "./definition.ts";

export interface ChannelSessionAdapter {
  readonly principal: Principal;
  createContext(signal: AbortSignal, requestBytes: number): OwnedProcedureContext;
  send(id: number, event: string, payload: unknown): Promise<boolean>;
}

export interface ChannelJoinInput {
  readonly session: ChannelSessionAdapter;
  readonly id: number;
  readonly address: string;
  readonly args: unknown;
  readonly hasRoom: boolean;
  readonly room?: unknown;
  readonly requestBytes: number;
}

export type ChannelJoinResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: ApplicationError };

export interface ChannelMembershipDescription {
  readonly id: number;
  readonly address: string;
  readonly args: unknown;
  readonly hasRoom: boolean;
  readonly room?: unknown;
}

export interface ChannelHubOptions {
  readonly registry: Registry;
  readonly maxMembers: number;
  readonly maxMembersPerSession: number;
  readonly disconnectTimeoutMs?: number;
  readonly observeDisconnectTimeout?: () => void;
}

interface Member {
  readonly session: ChannelSessionAdapter;
  readonly id: number;
  readonly address: string;
  readonly definition: AnyRegisteredChannel;
  readonly args: unknown;
  readonly room?: unknown;
  readonly hasRoom: boolean;
  readonly audienceKey: string;
  readonly state: unknown;
  readonly controller: AbortController;
  active: boolean;
  tail: Promise<void>;
}

const EMPTY_ROOM = Symbol("ackerdb.channel.noRoom");
const DEFAULT_DISCONNECT_TIMEOUT_MS = 5_000;

type RuntimeChannelCtx = ProcedureCtx & {
  readonly args: unknown;
  readonly state: unknown;
  readonly room?: unknown;
  readonly send: (event: string, payload: unknown) => Promise<boolean>;
  readonly publish: (event: string, payload: unknown) => Promise<number>;
  readonly channels: {
    publish(
      ref: ChannelRef,
      args: unknown,
      event: {
        readonly room?: unknown;
        readonly event: string;
        readonly payload: unknown;
      },
    ): Promise<number>;
  };
};

export class ChannelHub {
  readonly maxMembers: number;
  readonly maxMembersPerSession: number;
  readonly disconnectTimeoutMs: number;

  private readonly registry: Registry;
  private readonly bySession = new Map<ChannelSessionAdapter, Map<number, Member>>();
  private readonly audiences = new Map<string, Set<Member>>();
  private readonly observeDisconnectTimeout?: () => void;
  private members = 0;

  constructor(options: ChannelHubOptions) {
    this.registry = options.registry;
    this.maxMembers = positiveSafeInteger(options.maxMembers, "maxMembers");
    this.maxMembersPerSession = positiveSafeInteger(
      options.maxMembersPerSession,
      "maxMembersPerSession",
    );
    this.disconnectTimeoutMs = positiveSafeInteger(
      options.disconnectTimeoutMs ?? DEFAULT_DISCONNECT_TIMEOUT_MS,
      "disconnectTimeoutMs",
    );
    this.observeDisconnectTimeout = options.observeDisconnectTimeout;
  }

  get size(): number {
    return this.members;
  }

  descriptions(session: ChannelSessionAdapter): readonly ChannelMembershipDescription[] {
    return Object.freeze(
      [...(this.bySession.get(session)?.values() ?? [])]
        .sort((left, right) => left.id - right.id)
        .map((member) =>
          Object.freeze({
            id: member.id,
            address: member.address,
            args: member.args,
            hasRoom: member.hasRoom,
            ...(member.hasRoom ? { room: member.room } : {}),
          })
        ),
    );
  }

  async join(input: ChannelJoinInput): Promise<ChannelJoinResult> {
    const definition = this.registry.getChannel(input.address);
    if (definition === undefined) {
      throw new AckerDBError("not_found", `unknown channel "${input.address}"`);
    }
    const mine = this.bySession.get(input.session);
    if (mine?.has(input.id)) {
      throw new AckerDBError("conflict", "channel ID is already active");
    }
    if ((mine?.size ?? 0) >= this.maxMembersPerSession) {
      throw new AckerDBError("overloaded", "connection channel capacity is full", {
        retryable: true,
        retryAfterMs: 0,
        resource: "subscription",
      });
    }
    if (this.members >= this.maxMembers) {
      throw new AckerDBError("overloaded", "channel capacity is full", {
        retryable: true,
        retryAfterMs: 0,
        resource: "subscription",
      });
    }

    const room = this.validateRoom(definition, input.hasRoom, input.room);
    const controller = new AbortController();
    const owned = input.session.createContext(controller.signal, input.requestBytes);
    let args: unknown;
    let authorization: ReturnType<typeof channelAuthorizationResult>;
    try {
      const authorizationContext = this.authorizationContext(
        owned.value,
        definition,
        room,
      );
      const result = await invokeFunction(
        definition,
        authorizationContext as never,
        input.args,
        {
          onAuthorized: (_ctx, authorizedArgs) => {
            args = authorizedArgs;
          },
        },
      );
      authorization = channelAuthorizationResult(result);
    } finally {
      owned.release();
    }
    if (!authorization.ok) {
      if (!isApplicationError(authorization.error)) {
        throw new AckerDBError(
          "internal",
          "channel authorization returned an invalid application error",
        );
      }
      return Object.freeze({ ok: false, error: authorization.error });
    }

    const audienceKey = this.key(input.address, args, input.hasRoom ? room : EMPTY_ROOM);
    const member: Member = {
      session: input.session,
      id: input.id,
      address: input.address,
      definition,
      args: deepFreeze(args),
      hasRoom: input.hasRoom,
      ...(input.hasRoom ? { room } : {}),
      audienceKey,
      state: authorization.state,
      controller,
      active: true,
      tail: Promise.resolve(),
    };
    this.add(member);
    try {
      if (definition.onConnect !== undefined) {
        await this.invoke(member, input.requestBytes, (ctx) => definition.onConnect!(ctx as never));
      }
      return Object.freeze({ ok: true });
    } catch (error) {
      await this.remove(member, "disconnect", input.requestBytes, false);
      throw error;
    }
  }

  handle(
    session: ChannelSessionAdapter,
    id: number,
    event: string,
    payload: unknown,
    requestBytes: number,
  ): Promise<void> {
    const member = this.bySession.get(session)?.get(id);
    if (member === undefined || !member.active) {
      throw new AckerDBError("not_found", "channel membership is not active");
    }
    const declaration = member.definition.clientEvents[event];
    const handler = member.definition.on[event];
    if (declaration === undefined || handler === undefined) {
      throw new AckerDBError("validation", `unknown client channel event "${event}"`);
    }
    const validated = deepFreeze(declaration.parse(payload, `event.${event}`));
    return this.enqueue(member, () =>
      this.invoke(member, requestBytes, (ctx) => handler(ctx as never, validated))
    );
  }

  leave(
    session: ChannelSessionAdapter,
    id: number,
    reason: ChannelDisconnectReason,
    requestBytes: number,
  ): Promise<void> {
    const member = this.bySession.get(session)?.get(id);
    return member === undefined
      ? Promise.resolve()
      : this.remove(member, reason, requestBytes, true);
  }

  async disconnect(
    session: ChannelSessionAdapter,
    reason: ChannelDisconnectReason,
    requestBytes = 1,
  ): Promise<void> {
    const members = [...(this.bySession.get(session)?.values() ?? [])];
    await Promise.all(
      members.map((member) => this.remove(member, reason, requestBytes, true)),
    );
  }

  private add(member: Member): void {
    let mine = this.bySession.get(member.session);
    if (mine === undefined) this.bySession.set(member.session, (mine = new Map()));
    mine.set(member.id, member);
    let audience = this.audiences.get(member.audienceKey);
    if (audience === undefined) this.audiences.set(member.audienceKey, (audience = new Set()));
    audience.add(member);
    this.members++;
  }

  private async remove(
    member: Member,
    reason: ChannelDisconnectReason,
    requestBytes: number,
    callDisconnect: boolean,
  ): Promise<void> {
    if (!member.active) return;
    member.active = false;
    member.controller.abort(
      new AckerDBError("unavailable", `channel membership ended: ${reason}`),
    );
    const mine = this.bySession.get(member.session);
    mine?.delete(member.id);
    if (mine?.size === 0) this.bySession.delete(member.session);
    const audience = this.audiences.get(member.audienceKey);
    audience?.delete(member);
    if (audience?.size === 0) this.audiences.delete(member.audienceKey);
    this.members--;
    if (callDisconnect && member.definition.onDisconnect !== undefined) {
      await this.enqueue(member, () =>
        this.invokeDisconnect(member, requestBytes, (ctx) =>
          member.definition.onDisconnect!(ctx as never, reason)
        )
      );
    }
  }

  private enqueue(member: Member, work: () => Promise<void>): Promise<void> {
    const current = member.tail.then(work, work);
    member.tail = current.catch(() => {});
    return current;
  }

  private async invoke(
    member: Member,
    requestBytes: number,
    work: (ctx: RuntimeChannelCtx) => unknown,
  ): Promise<void> {
    await this.invokeWithSignal(
      member,
      member.controller.signal,
      requestBytes,
      work,
    );
  }

  private async invokeDisconnect(
    member: Member,
    requestBytes: number,
    work: (ctx: RuntimeChannelCtx) => unknown,
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = new AckerDBError(
      "unavailable",
      "channel disconnect handler timed out",
      { resource: "operation" },
    );
    const timer = setTimeout(
      () => controller.abort(timeout),
      this.disconnectTimeoutMs,
    );
    timer.unref?.();
    try {
      await this.invokeWithSignal(
        member,
        controller.signal,
        requestBytes,
        work,
      );
    } catch (error) {
      if (error !== timeout) throw error;
      try {
        this.observeDisconnectTimeout?.();
      } catch {
        // Operational observation is fail-open.
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async invokeWithSignal(
    member: Member,
    signal: AbortSignal,
    requestBytes: number,
    work: (ctx: RuntimeChannelCtx) => unknown,
  ): Promise<void> {
    if (signal.aborted) throw signal.reason;
    const owned = member.session.createContext(signal, requestBytes);
    try {
      const context = this.memberContext(member, owned.value);
      await settleOnAbort(
        invokeRegisteredHandler(
          member.definition,
          context as never,
          () => work(context),
        ),
        signal,
      );
    } finally {
      owned.release();
    }
  }

  private memberContext(
    member: Member,
    procedure: ProcedureCtx,
  ): RuntimeChannelCtx {
    return Object.freeze({
      ...procedure,
      args: member.args,
      state: member.state,
      ...(member.hasRoom ? { room: member.room } : {}),
      send: (event: string, payload: unknown) =>
        member.active
          ? this.sendMember(member, event, payload)
          : Promise.resolve(false),
      publish: (event: string, payload: unknown) =>
        this.publishDefinition(member.definition, member.audienceKey, event, payload),
      channels: Object.freeze({
        publish: (
          ref: ChannelRef,
          args: unknown,
          event: { readonly room?: unknown; readonly event: string; readonly payload: unknown },
        ) => this.publishTarget(ref, args, event),
      }),
    }) as RuntimeChannelCtx;
  }

  private authorizationContext(
    procedure: ProcedureCtx,
    definition: AnyRegisteredChannel,
    room: unknown,
  ): ProcedureCtx {
    return definition.room === undefined
      ? procedure
      : Object.freeze({ ...procedure, room });
  }

  private validateRoom(
    definition: AnyRegisteredChannel,
    hasRoom: boolean,
    rawRoom: unknown,
  ): unknown {
    if (definition.room === undefined) {
      if (hasRoom) {
        throw new AckerDBError("validation", "roomless channel does not accept a room");
      }
      return undefined;
    }
    if (!hasRoom) {
      throw new AckerDBError("validation", "roomed channel requires a room");
    }
    return deepFreeze(definition.room.parse(rawRoom, "room"));
  }

  private sendMember(
    member: Member,
    event: string,
    payload: unknown,
  ): Promise<boolean> {
    const validated = this.validateServerEvent(member.definition, event, payload);
    return member.session.send(member.id, event, validated);
  }

  private async publishDefinition(
    definition: AnyRegisteredChannel,
    audienceKey: string,
    event: string,
    payload: unknown,
  ): Promise<number> {
    const validated = this.validateServerEvent(definition, event, payload);
    return this.publishAudience(audienceKey, event, validated);
  }

  private publishTarget(
    ref: ChannelRef,
    rawArgs: unknown,
    event: { readonly room?: unknown; readonly event: string; readonly payload: unknown },
  ): Promise<number> {
    const address = getRef(ref);
    const definition = this.registry.getChannel(address);
    if (definition === undefined) {
      throw new AckerDBError("not_found", `unknown channel "${address}"`);
    }
    const args = this.validateTargetArgs(definition, rawArgs);
    const hasRoom = Object.hasOwn(event, "room");
    const room = this.validateRoom(definition, hasRoom, event.room);
    const key = this.key(address, args, hasRoom ? room : EMPTY_ROOM);
    return this.publishDefinition(definition, key, event.event, event.payload);
  }

  private validateTargetArgs(
    definition: AnyRegisteredChannel,
    rawArgs: unknown,
  ): unknown {
    return deepFreeze(definition.args.parse(rawArgs === undefined ? {} : rawArgs, "args"));
  }

  private validateServerEvent(
    definition: AnyRegisteredChannel,
    event: string,
    payload: unknown,
  ): unknown {
    const declaration = definition.serverEvents[event] as
      | Validator<unknown, string>
      | undefined;
    if (declaration === undefined) {
      throw new AckerDBError("validation", `unknown server channel event "${event}"`);
    }
    return deepFreeze(declaration.parse(payload, `event.${event}`));
  }

  private async publishAudience(
    key: string,
    event: string,
    payload: unknown,
  ): Promise<number> {
    const audience = this.audiences.get(key);
    if (audience === undefined) return 0;
    const delivered = await Promise.all(
      [...audience].map((member) =>
        member.active
          ? member.session.send(member.id, event, payload)
          : Promise.resolve(false)
      ),
    );
    let accepted = 0;
    for (const value of delivered) if (value) accepted++;
    return accepted;
  }

  private key(address: string, args: unknown, room: unknown): string {
    return stableEncode([
      address,
      args,
      room === EMPTY_ROOM
        ? { hasRoom: false }
        : { hasRoom: true, value: room },
    ]);
  }
}
