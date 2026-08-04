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

const DEFINITION_KEYS = Object.freeze(["methods", "handler"] as const);
const REGISTERED_KEYS = Object.freeze(
  [...DEFINITION_KEYS, "isAckerDB", "isAckerDBServerOnly", "kind"] as const,
);

/**
 * Every own key, enumerable or not, string or symbol: a field hidden behind
 * `enumerable: false` is still a field the author expected something to
 * consume, and nothing here consumes any of them.
 */
function refuseUnknownKeys(
  value: object,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol" || !allowed.includes(key)) {
      throw new TypeError(
        `${where} must not declare "${String(key)}" — an httpHandler carries exactly methods and handler`,
      );
    }
  }
}

/**
 * The one interpreter of a raw handler's definition. Exactly `methods` and
 * `handler`: nothing else exists to consume — no validators, no OpenAPI
 * operation, no policy — so any other field is a registration error, never a
 * silently ignored expectation.
 */
export function validateHttpHandlerShape(
  value: { readonly methods?: unknown; readonly handler?: unknown },
  where = "httpHandler",
): readonly HttpHandlerMethod[] {
  refuseUnknownKeys(value, DEFINITION_KEYS, where);
  const methods = validateMethods(value.methods, where);
  if (typeof value.handler !== "function") {
    throw new TypeError(`${where} handler must be a function`);
  }
  return methods;
}

/**
 * The registered form, for untyped exports: the definition fields plus every
 * marker the builder stamps. `isAckerDBServerOnly` is the marker generated
 * client APIs erase the export by, so a value missing it would register a
 * live route while leaking a client reference — refused here instead.
 *
 * Returns the frozen snapshot the registry stores. Validating the caller's
 * object and then serving from it would let an accessor answer one way here
 * and another way at dispatch; every field the surface reads is read exactly
 * once, here, and copied.
 */
export function validateRegisteredHttpHandler(
  value: object,
  where: string,
): AnyRegisteredHttpHandler {
  refuseUnknownKeys(value, REGISTERED_KEYS, where);
  const snapshot = value as {
    isAckerDBServerOnly?: unknown;
    methods?: unknown;
    handler?: unknown;
  };
  if (snapshot.isAckerDBServerOnly !== true) {
    throw new TypeError(
      `${where} must carry isAckerDBServerOnly: true — generated client APIs erase the export by that marker`,
    );
  }
  const methods = validateMethods(snapshot.methods, where);
  const handler = snapshot.handler;
  if (typeof handler !== "function") {
    throw new TypeError(`${where} handler must be a function`);
  }
  return Object.freeze({
    isAckerDB: true as const,
    isAckerDBServerOnly: true as const,
    kind: "http" as const,
    methods,
    handler: handler as AnyRegisteredHttpHandler["handler"],
  });
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
