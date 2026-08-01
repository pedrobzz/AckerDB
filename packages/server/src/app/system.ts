import type { SystemPrincipal } from "../auth/credentials.ts";
import type { Schema } from "../schema/definition.ts";
import type {
  App,
  AppPluginCapabilities,
  AppSchema,
} from "./definition.ts";
import type {
  FunctionResult,
  MutationCtx,
  ProcedureCtx,
} from "./functions.ts";

const SYSTEM_OPERATION_NAME = /^[A-Za-z][A-Za-z0-9_-]*(?:[.:][A-Za-z][A-Za-z0-9_-]*)*$/;
const UUID_SEGMENT =
  /(?:^|[.:])[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:$|[.:])/i;

/** Keep telemetry names bounded and reject obvious per-call identifier segments. */
export function isSystemOperationName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    SYSTEM_OPERATION_NAME.test(value) &&
    !UUID_SEGMENT.test(value)
  );
}

/** Transaction powers inherited by one trusted in-process system run. */
export type SystemTxCtx<
  S extends Schema = Schema,
  Capabilities extends object = Readonly<Record<never, never>>,
> = Omit<MutationCtx<S, Capabilities>, "auth"> & {
  readonly auth: SystemPrincipal;
};

/** Procedure-like powers owned by trusted in-process application work. */
export type SystemCtx<
  S extends Schema = Schema,
  Capabilities extends object = Readonly<Record<never, never>>,
  TransactionCapabilities extends object = Readonly<Record<never, never>>,
> = Omit<ProcedureCtx<S, Capabilities, TransactionCapabilities>, "auth" | "tx"> & {
  readonly auth: SystemPrincipal;
  tx<R>(
    fn: (tx: SystemTxCtx<S, TransactionCapabilities>) => R,
  ): Promise<FunctionResult<R>>;
};

/** The exact system context derived from one application manifest. */
export type AppSystemCtx<A extends App> = SystemCtx<
  AppSchema<A>,
  AppPluginCapabilities<A, "procedure">,
  AppPluginCapabilities<A, "mutation">
>;

export interface SystemRunOptions {
  readonly signal?: AbortSignal;
}

/** Explicit system authority held by a programmatically started application. */
export interface SystemRunner<Ctx = SystemCtx> {
  run<R>(
    name: string,
    work: (ctx: Ctx) => R | PromiseLike<R>,
    options?: SystemRunOptions,
  ): Promise<Awaited<R>>;
}
