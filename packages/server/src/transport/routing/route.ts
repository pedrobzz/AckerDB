import type { FunctionResult, TxCtx } from "../../app/functions.ts";
import type { FileProcedureCapability } from "../../files/api.ts";
import type { Schema } from "../../schema/definition.ts";
import {
  HTTP_METHODS,
  isHttpMethod,
  validateRoutePath,
  type HttpMethod,
  type HttpParams,
  type ValidHttpPath,
} from "./path.ts";

export type HttpRequest<M extends HttpMethod = HttpMethod> = Request & { readonly method: M };
export interface HttpRouteCtx<Path extends string = string> {
  readonly params: HttpParams<Path>;
}
export interface HttpCapabilities<S extends Schema = Schema> {
  readonly timestamp: number;
  readonly abortSignal: AbortSignal;
  readonly files: FileProcedureCapability;
  tx<R>(fn: (tx: TxCtx<S>) => R): Promise<FunctionResult<R>>;
}
export interface HttpHandlerCtx<Path extends string = string, S extends Schema = Schema>
  extends HttpRouteCtx<Path>, HttpCapabilities<S> {}

export type HttpRouteResult = Response | undefined;
export type HttpHandlerOf<M extends HttpMethod, Ctx, Result extends HttpRouteResult> = (
  ctx: Ctx,
  request: HttpRequest<M>,
) => Result | Promise<Result>;
export type HttpHandler<M extends HttpMethod, Path extends string, S extends Schema = Schema> =
  HttpHandlerOf<M, HttpHandlerCtx<Path, S>, Response>;
export type HttpHandlerGET<P extends string, S extends Schema = Schema> = HttpHandler<"GET", P, S>;
export type HttpHandlerHEAD<P extends string, S extends Schema = Schema> = HttpHandler<"HEAD", P, S>;
export type HttpHandlerPOST<P extends string, S extends Schema = Schema> = HttpHandler<"POST", P, S>;
export type HttpHandlerPUT<P extends string, S extends Schema = Schema> = HttpHandler<"PUT", P, S>;
export type HttpHandlerPATCH<P extends string, S extends Schema = Schema> = HttpHandler<"PATCH", P, S>;
export type HttpHandlerDELETE<P extends string, S extends Schema = Schema> = HttpHandler<"DELETE", P, S>;
export type HttpHandlerOPTIONS<P extends string, S extends Schema = Schema> = HttpHandler<"OPTIONS", P, S>;
export type HttpHandlers<Ctx, Result extends HttpRouteResult> = {
  readonly [M in HttpMethod]?: HttpHandlerOf<M, Ctx, Result>;
};

export interface Http<Path extends string = string> {
  readonly isAckerDB: true;
  readonly isAckerDBServerOnly: true;
  readonly kind: "http";
  readonly path: Path;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyHttpHandler = HttpHandlerOf<HttpMethod, HttpHandlerCtx<string, any>, Response>;
export type RunHttpHandler = (
  handler: AnyHttpHandler,
  path: string,
  params: HttpParams,
  request: Request,
) => Promise<Response>;
export type HttpRouteHandler = (
  ctx: HttpRouteCtx,
  request: HttpRequest,
  run: RunHttpHandler,
) => HttpRouteResult | Promise<HttpRouteResult>;
export interface RuntimeHttp<Path extends string = string> extends Http<Path> {
  readonly handlers: Readonly<Partial<Record<HttpMethod, HttpRouteHandler>>>;
}
export type HttpBuilder<S extends Schema> = <const Path extends string>(
  path: Path & ValidHttpPath<Path>,
  handlers: HttpHandlers<HttpHandlerCtx<Path, S>, Response>,
) => Http<Path>;

type Handler = (ctx: HttpRouteCtx, request: HttpRequest) => unknown;

function buildHttp<const Path extends string>(
  path: Path,
  handlers: object,
  adapt: (handler: Handler) => HttpRouteHandler,
): RuntimeHttp<Path> {
  const compiled: Partial<Record<HttpMethod, HttpRouteHandler>> = {};
  for (const [method, value] of Object.entries(handlers)) {
    if (!isHttpMethod(method) || typeof value !== "function") {
      throw new TypeError(`http handlers must use ${HTTP_METHODS.join(", ")} function keys`);
    }
    compiled[method] = adapt(value as Handler);
  }
  if (!Object.keys(compiled).length) throw new TypeError("http requires a handler");
  return Object.freeze({
    isAckerDB: true,
    isAckerDBServerOnly: true,
    kind: "http",
    path: validateRoutePath(path, "http") as Path,
    handlers: Object.freeze(compiled),
  });
}

export function http<const Path extends string>(
  path: Path & ValidHttpPath<Path>,
  handlers: HttpHandlers<HttpHandlerCtx<Path>, Response>,
): Http<Path> {
  return buildHttp(path, handlers, (handler) => (ctx, request, run) =>
    run(handler as AnyHttpHandler, path, ctx.params, request));
}

export function frameworkHttp<const Path extends string>(
  path: Path & ValidHttpPath<Path>,
  handlers: HttpHandlers<HttpRouteCtx<Path>, HttpRouteResult>,
): RuntimeHttp<Path> {
  return buildHttp(path, handlers, (handler) => (ctx, request) =>
    handler(ctx, request) as HttpRouteResult | Promise<HttpRouteResult>);
}

export function isHttpShaped(value: unknown): value is Http {
  return typeof value === "object" && value !== null &&
    (value as Partial<Http>).isAckerDB === true && (value as Partial<Http>).kind === "http";
}

export function validateRegisteredHttp(value: object, where: string): RuntimeHttp {
  if (!isHttpShaped(value) || value.isAckerDBServerOnly !== true ||
    typeof (value as Partial<RuntimeHttp>).handlers !== "object") {
    throw new TypeError(`${where} is not an http route`);
  }
  validateRoutePath(value.path, where);
  return value as RuntimeHttp;
}
