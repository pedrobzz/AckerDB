export const HTTP_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

const methods = new Set<string>(HTTP_METHODS);

export function isHttpMethod(value: unknown): value is HttpMethod {
  return typeof value === "string" && methods.has(value);
}

export const NO_PARAMS: HttpParams = Object.freeze(Object.create(null));

type SegmentParam<Segment extends string> = Segment extends `:${infer Name}` ? Name
  : Segment extends "*" ? "*"
  : never;

type ParamNames<Path extends string> = Path extends `${infer Head}/${infer Tail}`
  ? SegmentParam<Head> | ParamNames<Tail>
  : SegmentParam<Path>;

export type HttpParams<Path extends string = string> = string extends Path
  ? Readonly<Record<string, string>>
  : Readonly<Record<ParamNames<Path>, string>>;

/** Literal paths must be absolute; the runtime owns the complete grammar. */
export type ValidHttpPath<Path extends string> = string extends Path ? unknown
  : Path extends `/${string}` ? unknown
  : "AckerDB route paths start with /";

const PARAMETER = /^[A-Za-z0-9_-]+$/;
const MATCHER_SYNTAX = /[:*(){}\\?#]/;

export function validateRoutePath(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new TypeError(`${where} path must be an absolute string`);
  }
  if (value === "/") return value;
  const segments = value.slice(1).split("/");
  const names = new Set<string>();
  for (const [index, segment] of segments.entries()) {
    if (segment === "") throw new TypeError(`${where} path "${value}" has an empty segment`);
    if (segment === "*") {
      if (index !== segments.length - 1) {
        throw new TypeError(`${where} path "${value}" has a non-terminal wildcard`);
      }
    } else if (segment.startsWith(":")) {
      const name = segment.slice(1);
      if (!PARAMETER.test(name) || names.has(name)) {
        throw new TypeError(`${where} path "${value}" has an invalid parameter "${name}"`);
      }
      names.add(name);
    } else if (MATCHER_SYNTAX.test(segment)) {
      throw new TypeError(`${where} path "${value}" contains matcher syntax`);
    }
  }
  return value;
}

export function routeSignature(path: string): string {
  return path.replace(/:[^/]+/g, ":");
}

export function captureNames(path: string): readonly string[] {
  return path.split("/").flatMap((segment) =>
    segment.startsWith(":") ? [segment.slice(1)] : segment === "*" ? [segment] : []
  );
}

export function matcherPattern(path: string): string {
  return path.endsWith("/*") ? `${path.slice(0, -1)}**:*` : path;
}
