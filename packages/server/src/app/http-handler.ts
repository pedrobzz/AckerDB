/**
 * The raw HTTP handler kind: the deliberate contract-less boundary of the
 * HTTP surface. A handler receives the untouched `Request` — raw body bytes,
 * every header including `Authorization` — and returns a `Response` the
 * listener sends byte-for-byte. No `v` validation, no auth resolution, no
 * OpenAPI operation: an `httpHandler` is served raw; a function with
 * `http: true` is served through its contract.
 */
import type { Schema } from "../schema/definition.ts";
import {
  apiPath,
  refuseUnknownFields,
  type FunctionResult,
  type TxCtx,
} from "./functions.ts";
import type { FileProcedureCapability } from "../files/api.ts";

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

/**
 * A strict subset of the procedure context. The auth members are deliberately
 * absent: raw routes resolve no credential, so `Authorization` is an ordinary
 * request header and verification — HMAC, static-token comparison, or nothing
 * — is the handler's own job. `tx` carries application authority on the same
 * trust rationale as other application-owned code at the boundary.
 */
export type HttpHandlerCtx<S extends Schema = Schema> = {
  readonly timestamp: number;
  /** Fires when the caller disconnects or the Runtime shuts down. */
  readonly abortSignal: AbortSignal;
  /** Immutable File byte I/O for trusted raw HTTP code. */
  readonly files: FileProcedureCapability;
  /** Open a transaction: atomic, consistent, no external calls inside. */
  tx<R>(
    fn: (tx: TxCtx<S>) => R,
  ): Promise<FunctionResult<R>>;
};

export interface RegisteredHttpHandler<S extends Schema = Schema> {
  readonly isAckerDB: true;
  /** Generated client APIs erase this export; it has no callable reference. */
  readonly isAckerDBServerOnly: true;
  readonly kind: "http";
  /** The group whose HTTP root this route hangs under; `"api"` when unnamed. */
  readonly apiPath: string;
  readonly methods: readonly HttpHandlerMethod[];
  readonly handler: (
    ctx: HttpHandlerCtx<S>,
    request: Request,
  ) => Response | Promise<Response>;
}

// Registries deliberately erase the handler's concrete context.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRegisteredHttpHandler = RegisteredHttpHandler<any>;

/**
 * A raw handler's declaration, stated once. Every signature below and the
 * field-refusal list are derived from it, so the shape cannot drift between
 * what the builder accepts and what registration allows.
 */
export interface HttpHandlerDef<S extends Schema = Schema> {
  /**
   * The group this route is published in; `"api"` by default. Unlike the four
   * function kinds it need not be a string literal: a raw handler appears in
   * no generated tree, so its group moves only its route and there is no
   * binding for a widened `string` to fail to select. An undeclared group is
   * still a startup refusal, as it is everywhere else.
   */
  readonly apiPath?: string;
  readonly methods: readonly HttpHandlerMethod[];
  readonly handler: (
    ctx: HttpHandlerCtx<S>,
    request: Request,
  ) => Response | Promise<Response>;
}

export type HttpHandlerBuilder<S extends Schema> = (
  def: HttpHandlerDef<S>,
) => RegisteredHttpHandler<S>;

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

/** The declaration's own fields; `satisfies` keeps the list and the type equal. */
const DEFINITION_FIELDS = {
  apiPath: true,
  methods: true,
  handler: true,
} satisfies Record<keyof HttpHandlerDef, true>;

const DEFINITION_KEYS = Object.freeze(Object.keys(DEFINITION_FIELDS));
const REGISTERED_KEYS = Object.freeze(
  [...DEFINITION_KEYS, "isAckerDB", "isAckerDBServerOnly", "kind"],
);

/** A raw handler's surface, read once from the declaration it was written on. */
interface HttpHandlerSurface {
  readonly apiPath: string;
  readonly methods: readonly HttpHandlerMethod[];
  readonly handler: AnyRegisteredHttpHandler["handler"];
}

/**
 * The one interpreter of a raw handler's definition. Exactly `apiPath`,
 * `methods`, and `handler`: nothing else exists to consume — no validators, no
 * OpenAPI operation, no policy — so any other field is a registration error,
 * never a silently ignored expectation.
 */
export function validateHttpHandlerShape(
  value: {
    readonly apiPath?: unknown;
    readonly methods?: unknown;
    readonly handler?: unknown;
  },
  where = "httpHandler",
  allowed: readonly string[] = DEFINITION_KEYS,
): HttpHandlerSurface {
  refuseUnknownFields(value, allowed, where);
  const apiPathValue = apiPath(value.apiPath, `${where} apiPath`);
  const methods = validateMethods(value.methods, where);
  // Read once, here, and returned: an accessor that answered a function to
  // this check and something else at dispatch would put a non-function into a
  // live route, which is the divergence the snapshot exists to close.
  const handler = value.handler;
  if (typeof handler !== "function") {
    throw new TypeError(`${where} handler must be a function`);
  }
  return {
    apiPath: apiPathValue,
    methods,
    handler: handler as AnyRegisteredHttpHandler["handler"],
  };
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
  const snapshot = value as {
    isAckerDBServerOnly?: unknown;
    apiPath?: unknown;
    methods?: unknown;
    handler?: unknown;
  };
  // The same interpreter, widened to the markers the builder stamps: one
  // owner for every field, so the registered form cannot read a field
  // differently from the declaration it came from.
  const surface = validateHttpHandlerShape(snapshot, where, REGISTERED_KEYS);
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
  });
}

export function httpHandler<S extends Schema>(
  def: HttpHandlerDef<S>,
): RegisteredHttpHandler<S> {
  return Object.freeze({
    isAckerDB: true as const,
    isAckerDBServerOnly: true as const,
    kind: "http" as const,
    ...validateHttpHandlerShape(def),
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
