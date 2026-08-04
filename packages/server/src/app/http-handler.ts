/**
 * The raw HTTP handler kind: the deliberate contract-less boundary of the
 * HTTP surface. A handler receives the untouched `Request` — raw body bytes,
 * every header including `Authorization` — and returns a `Response` the
 * listener sends byte-for-byte. No `v` validation, no auth resolution, no
 * OpenAPI operation: an `httpHandler` is served raw; a function with
 * `http: true` is served through its contract.
 */
import type { Schema } from "../schema/definition.ts";
import type { FunctionResult, TxCtx } from "./functions.ts";
import type { ApplicationLogger } from "../telemetry/application-signals/types.ts";

export const HTTP_HANDLER_METHODS = Object.freeze([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const);

export type HttpHandlerMethod = (typeof HTTP_HANDLER_METHODS)[number];

type EmptyContextCapabilities = Readonly<Record<never, never>>;

/**
 * A strict subset of the procedure context. The auth members are deliberately
 * absent: raw routes resolve no credential, so `Authorization` is an ordinary
 * request header and verification — HMAC, static-token comparison, or nothing
 * — is the handler's own job. `tx` carries application authority on the same
 * trust rationale as a Service: application-owned code at the boundary.
 */
export type HttpHandlerCtx<
  S extends Schema = Schema,
  Capabilities extends object = EmptyContextCapabilities,
  TransactionCapabilities extends object = EmptyContextCapabilities,
> = Capabilities & {
  readonly log: ApplicationLogger;
  readonly timestamp: number;
  /** Fires when the caller disconnects or the Runtime shuts down. */
  readonly abortSignal: AbortSignal;
  /** Open a transaction: atomic, consistent, no external calls inside. */
  tx<R>(
    fn: (tx: TxCtx<S, TransactionCapabilities>) => R,
  ): Promise<FunctionResult<R>>;
};

export interface OwnedHttpHandlerContext {
  readonly value: HttpHandlerCtx;
  release(): void;
}

export interface RegisteredHttpHandler<S extends Schema = Schema> {
  readonly isAckerDB: true;
  /** Generated client APIs erase this export; it has no callable reference. */
  readonly isAckerDBServerOnly: true;
  readonly kind: "http";
  readonly methods: readonly HttpHandlerMethod[];
  readonly handler: (
    ctx: HttpHandlerCtx<S>,
    request: Request,
  ) => Response | Promise<Response>;
}

// Registries deliberately erase the handler's concrete context.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRegisteredHttpHandler = RegisteredHttpHandler<any>;

export type HttpHandlerBuilder<
  S extends Schema,
  Capabilities extends object = EmptyContextCapabilities,
  TransactionCapabilities extends object = EmptyContextCapabilities,
> = (def: {
  readonly methods: readonly HttpHandlerMethod[];
  readonly handler: (
    ctx: HttpHandlerCtx<S, Capabilities, TransactionCapabilities>,
    request: Request,
  ) => Response | Promise<Response>;
}) => RegisteredHttpHandler<S>;

function validateMethods(value: unknown, where: string): readonly HttpHandlerMethod[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${where} methods must be a non-empty array of HTTP methods`);
  }
  const seen = new Set<HttpHandlerMethod>();
  for (const [index, method] of value.entries()) {
    if (!HTTP_HANDLER_METHODS.includes(method)) {
      throw new TypeError(
        `${where} methods[${index}] must be one of ${HTTP_HANDLER_METHODS.join(", ")}`,
      );
    }
    if (seen.has(method)) {
      throw new TypeError(`${where} methods must not repeat "${method}"`);
    }
    seen.add(method);
  }
  return Object.freeze([...value]) as readonly HttpHandlerMethod[];
}

/**
 * The one interpreter of a raw handler's shape. The builder runs it at
 * definition; the registry runs it again for untyped exports, so a malformed
 * shape is always a registration error naming the export, never a route that
 * silently fails to serve.
 */
export function validateHttpHandlerShape(
  value: { readonly methods?: unknown; readonly handler?: unknown },
  where = "httpHandler",
): readonly HttpHandlerMethod[] {
  const methods = validateMethods(value.methods, where);
  if (typeof value.handler !== "function") {
    throw new TypeError(`${where} handler must be a function`);
  }
  return methods;
}

export function httpHandler<S extends Schema>(def: {
  readonly methods: readonly HttpHandlerMethod[];
  readonly handler: (
    ctx: HttpHandlerCtx<S>,
    request: Request,
  ) => Response | Promise<Response>;
}): RegisteredHttpHandler<S> {
  return Object.freeze({
    isAckerDB: true as const,
    isAckerDBServerOnly: true as const,
    kind: "http" as const,
    methods: validateHttpHandlerShape(def),
    handler: def.handler,
  });
}

/** Detects intent only; the registry validates the full shape afterward. */
export function isHttpHandlerShaped(value: unknown): value is AnyRegisteredHttpHandler {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { isAckerDB?: unknown }).isAckerDB === true &&
    (value as { kind?: unknown }).kind === "http"
  );
}
