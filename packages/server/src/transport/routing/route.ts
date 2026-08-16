/**
 * The one HTTP route model. An AckerDB HTTP entry — a webhook, a health probe,
 * a File byte route, an exposed function, the WebSocket door — is the same
 * value: an explicit path and a method-keyed map of handlers. There is no
 * route-kind discriminator, because dispatch never needs one; what differs
 * between a webhook and a health probe is what its handler does, and that is
 * the handler's business.
 *
 * A handler receives a context and the `Request`, and answers a `Response`.
 * The context always carries the route's decoded `params`; an
 * application-owned route's context carries application capabilities on top of
 * them, which is the only axis on which framework and application routes
 * differ. Both are the same generic, specialized.
 *
 * The literal path drives all of it: `/users/:id` types its handlers'
 * `ctx.params.id` as `string`, a static path types no parameters at all, and
 * an illegal path is a compile error before it is a load error.
 */
import type { FileProcedureCapability } from "../../files/api.ts";
import type { FunctionResult, TxCtx } from "../../app/functions.ts";
import type { Schema } from "../../schema/definition.ts";
import {
  HTTP_METHODS,
  isHttpMethod,
  validateRoutePath,
  type HttpMethod,
  type HttpParams,
  type ValidHttpPath,
} from "./path.ts";

/** The `Request` a method-keyed handler receives, with its method narrowed. */
export type HttpRequest<Method extends HttpMethod = HttpMethod> =
  & Request
  & { readonly method: Method };

/** What every route handler is given: the captures its path declared. */
export interface HttpRouteCtx<Path extends string = string> {
  readonly params: HttpParams<Path>;
}

/**
 * The application capabilities a route handler holds beside its params. The
 * auth members are deliberately absent: a raw route resolves no credential, so
 * `Authorization` is an ordinary request header and verification — HMAC,
 * static-token comparison, or nothing — is the handler's own job. `tx` carries
 * application authority on the same trust rationale as other
 * application-owned code at the boundary.
 */
export interface HttpCapabilities<S extends Schema = Schema> {
  readonly timestamp: number;
  /** Fires when the caller disconnects or the Runtime shuts down. */
  readonly abortSignal: AbortSignal;
  /** Immutable File byte I/O for trusted raw HTTP code. */
  readonly files: FileProcedureCapability;
  /** Open a transaction: atomic, consistent, no external calls inside. */
  tx<R>(fn: (tx: TxCtx<S>) => R): Promise<FunctionResult<R>>;
}

/** An application route handler's context: its captures and its capabilities. */
export interface HttpHandlerCtx<Path extends string = string, S extends Schema = Schema>
  extends HttpRouteCtx<Path>, HttpCapabilities<S> {}

/**
 * What a handler may answer. `undefined` exists for one reason: Bun's own
 * contract for an accepted WebSocket upgrade, where the socket has left HTTP
 * and no response is this route's to write. Application handlers never see it
 * — their `Response` result is pinned below.
 */
export type HttpRouteResult = Response | undefined;

/** The canonical handler: one context, the method-narrowed Request, a result. */
export type HttpHandlerOf<Method extends HttpMethod, Ctx, Result extends HttpRouteResult> = (
  ctx: Ctx,
  request: HttpRequest<Method>,
) => Result | Promise<Result>;

/** The application-facing handler, for separately declared route handlers. */
export type HttpHandler<
  Method extends HttpMethod,
  Path extends string,
  S extends Schema = Schema,
> = HttpHandlerOf<Method, HttpHandlerCtx<Path, S>, Response>;

export type HttpHandlerGET<Path extends string, S extends Schema = Schema> =
  HttpHandler<"GET", Path, S>;
export type HttpHandlerHEAD<Path extends string, S extends Schema = Schema> =
  HttpHandler<"HEAD", Path, S>;
export type HttpHandlerPOST<Path extends string, S extends Schema = Schema> =
  HttpHandler<"POST", Path, S>;
export type HttpHandlerPUT<Path extends string, S extends Schema = Schema> =
  HttpHandler<"PUT", Path, S>;
export type HttpHandlerPATCH<Path extends string, S extends Schema = Schema> =
  HttpHandler<"PATCH", Path, S>;
export type HttpHandlerDELETE<Path extends string, S extends Schema = Schema> =
  HttpHandler<"DELETE", Path, S>;
export type HttpHandlerOPTIONS<Path extends string, S extends Schema = Schema> =
  HttpHandler<"OPTIONS", Path, S>;

/** Every method a route answers, each with the handler that answers it. */
export type HttpHandlers<Ctx, Result extends HttpRouteResult> = {
  readonly [Method in HttpMethod]?: HttpHandlerOf<Method, Ctx, Result>;
};

/** One route: the path it owns and the methods it answers there. */
export interface Http<
  Path extends string = string,
  Ctx = HttpHandlerCtx<Path>,
  Result extends HttpRouteResult = Response,
> {
  readonly isAckerDB: true;
  /** Generated client APIs erase this export; it has no callable reference. */
  readonly isAckerDBServerOnly: true;
  readonly kind: "http";
  readonly path: Path;
  readonly handlers: HttpHandlers<Ctx, Result>;
}

/** An application-authored route with its schema erased, as the loader holds it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyHttp = Http<string, HttpHandlerCtx<string, any>, Response>;

/** One of its handlers, as the Runtime invokes it once a method has selected it. */
export type AnyHttpHandler = HttpHandlerOf<
  HttpMethod,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  HttpHandlerCtx<string, any>,
  Response
>;

/**
 * A route as the registry holds and calls it: params alone, because the
 * registry cannot build application capabilities — those exist only inside a
 * Runtime execution frame, which is what an application route's compiled
 * handler enters before calling the author's code.
 */
export type HttpRoute = Http<string, HttpRouteCtx, HttpRouteResult>;

export type HttpRouteHandler<Method extends HttpMethod = HttpMethod> =
  HttpHandlerOf<Method, HttpRouteCtx, HttpRouteResult>;

/** The route factory, bound to one application's Schema by generated code. */
export type HttpBuilder<S extends Schema> = <const Path extends string>(
  path: Path & ValidHttpPath<Path>,
  handlers: HttpHandlers<HttpHandlerCtx<Path, S>, Response>,
) => Http<Path, HttpHandlerCtx<Path, S>, Response>;

/**
 * The same factory as the framework holds it: the route context alone, and the
 * upgrade result. It narrows capabilities rather than introducing a second
 * model — one function, one validator, one value shape, one `add`.
 */
export type FrameworkHttpBuilder = <const Path extends string>(
  path: Path & ValidHttpPath<Path>,
  handlers: HttpHandlers<HttpRouteCtx<Path>, HttpRouteResult>,
) => Http<Path, HttpRouteCtx<Path>, HttpRouteResult>;

/** The declaration's own fields; `satisfies` keeps the list and the type equal. */
const DEFINITION_FIELDS = {
  path: true,
  handlers: true,
} satisfies Record<keyof Pick<Http, "path" | "handlers">, true>;

const DEFINITION_KEYS = Object.freeze(Object.keys(DEFINITION_FIELDS));
const REGISTERED_KEYS = Object.freeze(
  [...DEFINITION_KEYS, "isAckerDB", "isAckerDBServerOnly", "kind"],
);

/**
 * Untyped module exports reach this interpreter without a compiler in front of
 * them, so every own key — enumerable or not, string or symbol — is checked
 * against the fields the surface consumes; anything else is a registration
 * error, never a silently ignored expectation.
 */
function refuseUnknownFields(value: object, allowed: readonly string[], where: string): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol" || !allowed.includes(key)) {
      throw new TypeError(
        `${where} must not declare "${String(key)}" — it carries exactly ${allowed.join(", ")}`,
      );
    }
  }
}

/**
 * The one interpreter of a route's definition. Every field the surface reads
 * is read exactly once, here, and copied into a frozen snapshot: an accessor
 * that answered one way at registration and another at dispatch would put a
 * different route on the wire than the one that was validated.
 */
function validateHttpShape(
  value: { readonly path?: unknown; readonly handlers?: unknown },
  where: string,
  allowed: readonly string[],
): Pick<HttpRoute, "path" | "handlers"> {
  refuseUnknownFields(value, allowed, where);
  const path = validateRoutePath(value.path, where);
  const declared = value.handlers;
  if (typeof declared !== "object" || declared === null) {
    throw new TypeError(`${where} handlers must be an object keyed by HTTP method`);
  }
  const handlers: Record<string, HttpRouteHandler> = {};
  for (const key of Reflect.ownKeys(declared)) {
    if (typeof key === "symbol" || !isHttpMethod(key)) {
      throw new TypeError(
        `${where} handlers key "${String(key)}" must be one of ${HTTP_METHODS.join(", ")}`,
      );
    }
    const handler = (declared as Record<string, unknown>)[key];
    if (typeof handler !== "function") {
      throw new TypeError(`${where} handler for "${key}" must be a function`);
    }
    handlers[key] = handler as HttpRouteHandler;
  }
  if (Object.keys(handlers).length === 0) {
    throw new TypeError(`${where} handlers must name at least one HTTP method`);
  }
  return { path, handlers: Object.freeze(handlers) };
}

/**
 * Declare one route. The path is explicit and literal: it types the handlers
 * it is given, and a path the grammar does not admit fails to compile before
 * it fails to load. The context and the result are fixed here to what an
 * application may hold and answer; the framework's own binding below is the
 * only thing that narrows the first or widens the second.
 */
export function http<const Path extends string>(
  path: Path & ValidHttpPath<Path>,
  handlers: HttpHandlers<HttpHandlerCtx<Path>, Response>,
): Http<Path, HttpHandlerCtx<Path>, Response> {
  return Object.freeze({
    isAckerDB: true as const,
    isAckerDBServerOnly: true as const,
    kind: "http" as const,
    ...validateHttpShape({ path, handlers }, "http", DEFINITION_KEYS),
  }) as unknown as Http<Path, HttpHandlerCtx<Path>, Response>;
}


/**
 * The registered form, for untyped exports: the definition fields plus every
 * marker the factory stamps. `isAckerDBServerOnly` is the marker generated
 * client APIs erase the export by, so a value missing it would register a live
 * route while leaking a client reference — refused here instead.
 */
export function validateRegisteredHttp(value: object, where: string): AnyHttp {
  const snapshot = value as { isAckerDBServerOnly?: unknown; path?: unknown; handlers?: unknown };
  const surface = validateHttpShape(snapshot, where, REGISTERED_KEYS);
  if (snapshot.isAckerDBServerOnly !== true) {
    throw new TypeError(
      `${where} must carry isAckerDBServerOnly: true — generated client APIs erase the export by that marker`,
    );
  }
  return Object.freeze({
    isAckerDB: true as const,
    isAckerDBServerOnly: true as const,
    kind: "http" as const,
    ...surface,
  }) as AnyHttp;
}

export const frameworkHttp = http as unknown as FrameworkHttpBuilder;

/** Detects intent only; the loader validates the full shape afterward. */
export function isHttpShaped(value: unknown): value is AnyHttp {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { isAckerDB?: unknown }).isAckerDB === true &&
    (value as { kind?: unknown }).kind === "http"
  );
}
