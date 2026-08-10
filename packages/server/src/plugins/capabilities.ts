import type { DbReader, DbWriter } from "../database/query/types.ts";
import type { Schema } from "../schema/definition.ts";
import type { Analytics } from "../signals/analytics.ts";
import type { Logger } from "../signals/logger.ts";
import type { Expand, InferValidator } from "../validation/validator.ts";
import type { InferShape, ObjectShape } from "../validation/composites.ts";
import type {
  AnyPluginOperationSpec,
  PluginContractTree,
  PluginExposedCall,
  PluginOperationKind,
  PluginOperationSpec,
} from "./contract.ts";

export type PluginOperationCall<Spec extends AnyPluginOperationSpec> =
  Spec extends PluginOperationSpec<
    PluginOperationKind,
    any,
    any,
    infer Call
  >
    ? Call
    : never;

export type OperationKinds<Node> = Node extends PluginOperationSpec<infer Kind, any, any, any>
  ? Kind
  : Node extends PluginContractTree
    ? { [Name in keyof Node]: OperationKinds<Node[Name]> }[keyof Node]
    : never;

export type CallableKinds<Caller extends PluginOperationKind> = Caller extends "query"
  ? "query"
  : Caller extends "mutation"
    ? "query" | "mutation"
    : PluginOperationKind;

export type PluginCapabilities<
  Contract extends PluginContractTree,
  Caller extends PluginOperationKind,
> = {
  readonly [Name in keyof Contract as Extract<
    OperationKinds<Contract[Name]>,
    CallableKinds<Caller>
  > extends never
    ? never
    : Name]: Contract[Name] extends AnyPluginOperationSpec
      ? Contract[Name]["kind"] extends CallableKinds<Caller>
        ? PluginOperationCall<Contract[Name]>
        : never
      : Contract[Name] extends PluginContractTree
        ? PluginCapabilities<Contract[Name], Caller>
        : never;
};

export type PluginQueryCapabilities<Contract extends PluginContractTree> =
  PluginCapabilities<Contract, "query">;
export type PluginMutationCapabilities<Contract extends PluginContractTree> =
  PluginCapabilities<Contract, "mutation">;
export type PluginProcedureCapabilities<Contract extends PluginContractTree> =
  PluginCapabilities<Contract, "procedure">;

export type PluginDependencyContracts = Readonly<Record<string, PluginContractTree>>;
export type DependencyCapabilities<
  Dependencies extends PluginDependencyContracts,
  Kind extends PluginOperationKind,
> = {
  readonly [Slot in keyof Dependencies as keyof PluginCapabilities<
    Dependencies[Slot],
    Kind
  > extends never ? never : Slot]: PluginCapabilities<Dependencies[Slot], Kind>;
};

export interface PluginInvocationCtx {
  readonly timestamp: number;
  readonly mount: string;
  readonly log: Logger;
}

export type PluginQueryCtx<
  S extends Schema,
  Dependencies extends PluginDependencyContracts = Readonly<Record<never, never>>,
> = PluginInvocationCtx &
  { readonly db: DbReader<S> } &
  DependencyCapabilities<Dependencies, "query">;

export type PluginMutationCtx<
  S extends Schema,
  Dependencies extends PluginDependencyContracts = Readonly<Record<never, never>>,
> = PluginInvocationCtx &
  { readonly analytics: Analytics; readonly db: DbWriter<S> } &
  DependencyCapabilities<Dependencies, "mutation">;

export type PluginProcedureCtx<
  S extends Schema,
  Dependencies extends PluginDependencyContracts = Readonly<Record<never, never>>,
> = PluginInvocationCtx &
  DependencyCapabilities<Dependencies, "procedure"> & {
    readonly abortSignal: AbortSignal;
    tx<T>(
      work: (ctx: PluginMutationCtx<S, Dependencies>) => T | Promise<T>,
    ): Promise<T>;
  };

export type PluginCtxFor<
  Kind extends PluginOperationKind,
  S extends Schema,
  Dependencies extends PluginDependencyContracts,
> = Kind extends "query"
  ? PluginQueryCtx<S, Dependencies>
  : Kind extends "mutation"
    ? PluginMutationCtx<S, Dependencies>
    : PluginProcedureCtx<S, Dependencies>;

export type PluginHandler<Ctx, Spec extends AnyPluginOperationSpec> =
  Spec extends PluginOperationSpec<PluginOperationKind, infer A, infer Result, any>
    ? (
      ctx: Ctx,
      args: Expand<InferShape<A>>,
    ) => Expand<InferValidator<Result>> | Promise<Expand<InferValidator<Result>>>
    : never;
