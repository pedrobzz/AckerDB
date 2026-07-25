/** Named HTTP error statuses accepted by {@link Err}. */
export const Status = Object.freeze({
  /** 400 Bad Request — the request is invalid for this operation. */
  BadRequest: 400,
  /** 401 Unauthorized — authentication is required or invalid. */
  Unauthorized: 401,
  /** 402 Payment Required — payment or additional payment action is required. */
  PaymentRequired: 402,
  /** 403 Forbidden — the caller is authenticated but not allowed. */
  Forbidden: 403,
  /** 404 Not Found — the requested resource does not exist. */
  NotFound: 404,
  /** 405 Method Not Allowed — the operation does not support this method. */
  MethodNotAllowed: 405,
  /** 406 Not Acceptable — no acceptable response representation is available. */
  NotAcceptable: 406,
  /** 407 Proxy Authentication Required — the proxy requires authentication. */
  ProxyAuthenticationRequired: 407,
  /** 408 Request Timeout — the request was not completed in time. */
  RequestTimeout: 408,
  /** 409 Conflict — the request conflicts with current state. */
  Conflict: 409,
  /** 410 Gone — the resource is intentionally no longer available. */
  Gone: 410,
  /** 411 Length Required — the request requires a content length. */
  LengthRequired: 411,
  /** 412 Precondition Failed — a request precondition was false. */
  PreconditionFailed: 412,
  /** 413 Content Too Large — the request body exceeds the accepted size. */
  ContentTooLarge: 413,
  /** 414 URI Too Long — the request target exceeds the accepted size. */
  UriTooLong: 414,
  /** 415 Unsupported Media Type — the request representation is unsupported. */
  UnsupportedMediaType: 415,
  /** 416 Range Not Satisfiable — the requested range cannot be served. */
  RangeNotSatisfiable: 416,
  /** 417 Expectation Failed — the request expectation cannot be met. */
  ExpectationFailed: 417,
  /** 418 I'm a Teapot — the server refuses to brew coffee in a teapot. */
  ImATeapot: 418,
  /** 421 Misdirected Request — the target server cannot produce this response. */
  MisdirectedRequest: 421,
  /** 422 Unprocessable Content — the content is valid but cannot be processed. */
  UnprocessableContent: 422,
  /** 423 Locked — the target resource is locked. */
  Locked: 423,
  /** 424 Failed Dependency — a required dependent operation failed. */
  FailedDependency: 424,
  /** 425 Too Early — replaying the request could be unsafe. */
  TooEarly: 425,
  /** 426 Upgrade Required — the client must switch protocols. */
  UpgradeRequired: 426,
  /** 428 Precondition Required — the request must be conditional. */
  PreconditionRequired: 428,
  /** 429 Too Many Requests — the caller exceeded a rate limit. */
  TooManyRequests: 429,
  /** 431 Request Header Fields Too Large — request headers exceed the accepted size. */
  RequestHeaderFieldsTooLarge: 431,
  /** 451 Unavailable For Legal Reasons — access is denied for legal reasons. */
  UnavailableForLegalReasons: 451,
  /** 500 Internal Server Error — the operation failed unexpectedly. */
  InternalServerError: 500,
  /** 501 Not Implemented — the operation is not supported. */
  NotImplemented: 501,
  /** 502 Bad Gateway — an upstream service returned an invalid response. */
  BadGateway: 502,
  /** 503 Service Unavailable — the service cannot currently complete the operation. */
  ServiceUnavailable: 503,
  /** 504 Gateway Timeout — an upstream service did not respond in time. */
  GatewayTimeout: 504,
  /** 505 HTTP Version Not Supported — the requested HTTP version is unsupported. */
  HttpVersionNotSupported: 505,
  /** 506 Variant Also Negotiates — response negotiation is misconfigured. */
  VariantAlsoNegotiates: 506,
  /** 507 Insufficient Storage — the server cannot store the required representation. */
  InsufficientStorage: 507,
  /** 508 Loop Detected — the server detected an infinite processing loop. */
  LoopDetected: 508,
  /** 510 Not Extended — additional request extensions are required. */
  NotExtended: 510,
  /** 511 Network Authentication Required — network access requires authentication. */
  NetworkAuthenticationRequired: 511,
} as const);

export type ErrorHttpStatus = (typeof Status)[keyof typeof Status];

export type ApplicationError<
  Code extends string = string,
  Body = unknown,
  HttpStatus extends ErrorHttpStatus = ErrorHttpStatus,
> = Readonly<{
  kind: "application";
  code: Code;
  body: Body;
  status: HttpStatus;
}>;

const RESULT = Symbol("@dbzz/core/Result");

type ErrorCode<E> = E extends { readonly code: infer Code extends string } ? Code : never;
type ErrorMapper<E> = {
  readonly [Code in ErrorCode<E>]?: (
    error: Extract<E, { readonly code: Code }>,
  ) => ErrResult<ApplicationError>;
};
type MappedCodes<Mapping> = Extract<keyof Mapping, string>;
type ResidualError<E, Mapping> = E extends { readonly code: infer Code extends string }
  ? Code extends MappedCodes<Mapping>
    ? never
    : E
  : E;
type MappedError<Mapping> = ReturnType<
  Extract<
    Mapping[keyof Mapping],
    (...args: never[]) => ErrResult<ApplicationError>
  >
> extends ErrResult<infer E>
  ? E
  : never;

interface ResultMethods<T, E> {
  mapErr<const Mapping extends ErrorMapper<E>>(
    mapping: Mapping & Record<Exclude<keyof Mapping, ErrorCode<E>>, never>,
  ): Result<T, ResidualError<E, Mapping> | MappedError<Mapping>>;
}

export type OkResult<T, E = never> = Readonly<{
  ok: true;
  data: T;
  error?: never;
}> & ResultMethods<T, E>;

export type ErrResult<E, T = never> = Readonly<{
  ok: false;
  data?: never;
  error: E;
}> & ResultMethods<T, E>;

export type Result<T, E> = [E] extends [never]
  ? OkResult<T>
  : OkResult<T, E> | ErrResult<E, T>;

type BrandedResult = Result<unknown, unknown> & { readonly [RESULT]: true };

function result<T, E>(
  value: { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: E },
): Result<T, E> {
  const branded = value as typeof value & {
    [RESULT]?: true;
    mapErr?: (mapping: Readonly<Record<string, (error: E) => ErrResult<unknown>>>) => Result<T, E>;
  };
  Object.defineProperty(branded, RESULT, { value: true });
  Object.defineProperty(branded, "mapErr", {
    value(mapping: Readonly<Record<string, (error: E) => ErrResult<unknown>>>): Result<T, E> {
      if (value.ok) return branded as unknown as Result<T, E>;
      const code = (value.error as { readonly code?: string }).code ?? "";
      if (!Object.hasOwn(mapping, code)) {
        return branded as unknown as Result<T, E>;
      }
      const mapper = mapping[code];
      if (mapper === undefined) return branded as unknown as Result<T, E>;
      const mapped = mapper(value.error);
      if (
        !isResult(mapped) ||
        mapped.ok ||
        !isApplicationError(mapped.error)
      ) {
        throw new TypeError("Result.mapErr callbacks must return Err(...)");
      }
      return mapped as Result<T, E>;
    },
  });
  return Object.freeze(branded) as Result<T, E>;
}

export function Ok<T, E = never>(data: T): OkResult<T, E> {
  return result<T, E>({ ok: true, data }) as OkResult<T, E>;
}

export function Err<
  const Code extends string,
  Body,
  const HttpStatus extends ErrorHttpStatus,
  T = never,
>(
  code: Code,
  body: Body,
  status: HttpStatus,
): ErrResult<ApplicationError<Code, Body, HttpStatus>, T> {
  return result<T, ApplicationError<Code, Body, HttpStatus>>({
    ok: false,
    error: Object.freeze({ kind: "application" as const, code, body, status }),
  }) as ErrResult<ApplicationError<Code, Body, HttpStatus>, T>;
}

/**
 * Construct a non-application failure Result at a transport adapter boundary.
 * Application functions should use {@link Err}; this primitive exists so
 * DBzz clients can preserve framework, unhandled, and transport failures in
 * the same exhaustive Result shape.
 */
export function Failure<E, T = never>(error: E): ErrResult<E, T> {
  return result<T, E>({ ok: false, error }) as ErrResult<E, T>;
}

export function isResult(value: unknown): value is Result<unknown, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<BrandedResult>)[RESULT] === true
  );
}

export function isApplicationError(value: unknown): value is ApplicationError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<ApplicationError>).kind === "application" &&
    typeof (value as Partial<ApplicationError>).code === "string" &&
    Object.values(Status).includes(
      (value as Partial<ApplicationError>).status as ErrorHttpStatus,
    ) &&
    Object.hasOwn(value, "body")
  );
}

export function isErr<E>(
  value: OkResult<unknown, E> | ErrResult<E, unknown>,
): value is ErrResult<E, unknown> {
  return !value.ok;
}
