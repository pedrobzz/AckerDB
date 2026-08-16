/**
 * The one HTTP route path grammar, written twice in one file — once for the
 * compiler and once for the matcher — so a pattern the types accept is exactly
 * a pattern the router matches, and the parameter names one extracts are the
 * names the other captures.
 *
 * The language is deliberately the subset AckerDB can type completely:
 *
 * - static segments (`/live`, `/api/hooks/stripe`);
 * - a named single-segment parameter introduced by a colon (`/users/:id`);
 * - at most one catch-all `*`, and only as the last segment (`/assets/*`).
 *
 * There is no optional parameter, no regular-expression parameter, no
 * host constraint, and no second parameter inside one segment. An underlying
 * matcher supporting more is not a reason to publish more: every published
 * form has to be inferable from the literal path, and these are.
 */

export const HTTP_METHODS = Object.freeze([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const);

export type HttpMethod = (typeof HTTP_METHODS)[number];

const HTTP_METHOD_SET = new Set<string>(HTTP_METHODS);

export function isHttpMethod(value: unknown): value is HttpMethod {
  return typeof value === "string" && HTTP_METHOD_SET.has(value);
}

/**
 * The catch-all segment. It is also the key its capture answers to, so
 * `ctx.params["*"]` reads the same character the path was written with.
 */
export const WILDCARD = "*";

/** What a static route's handler is given: no captures, and no way to add one. */
export const NO_PARAMS: HttpParams = Object.freeze({});

/* ---------------------------------------------------------------- types -- */

/**
 * The characters the matcher reads as syntax. Static text containing one would
 * silently become a pattern of the matcher's own language rather than the
 * literal segment it looks like, so a segment carrying any of them is refused.
 * `?` and `#` are here because a pathname cannot contain them at all.
 */
type SyntaxChar = ":" | "*" | "(" | ")" | "{" | "}" | "\\" | "?" | "#";
const SYNTAX_CHARS = /[:*(){}\\?#]/;

/**
 * What a parameter name may be made of. This is exactly the set the matcher
 * treats as a plain named parameter; a name outside it becomes a
 * pattern-constrained parameter there, which is not a language AckerDB
 * publishes and which would match nothing.
 */
type NameChar =
  | "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j" | "k" | "l" | "m"
  | "n" | "o" | "p" | "q" | "r" | "s" | "t" | "u" | "v" | "w" | "x" | "y" | "z"
  | "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J" | "K" | "L" | "M"
  | "N" | "O" | "P" | "Q" | "R" | "S" | "T" | "U" | "V" | "W" | "X" | "Y" | "Z"
  | "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"
  | "_" | "-";
const NAME_CHARS = /^[A-Za-z0-9_-]+$/;

/** `"/a/b/c"` without its leading slash becomes `["a", "b", "c"]`. */
type SegmentsOf<Rest extends string> = Rest extends `${infer Head}/${infer Tail}`
  ? [Head, ...SegmentsOf<Tail>]
  : [Rest];

/** The name a segment contributes to `ctx.params`, or nothing. */
type NameOf<Segment extends string> = Segment extends `:${infer Name}` ? Name
  : Segment extends typeof WILDCARD ? typeof WILDCARD
  : never;

type IsName<Name extends string> = Name extends `${infer Head}${infer Rest}`
  ? Head extends NameChar ? IsName<Rest> : false
  : true;

/** Why one segment is not a legal pattern segment; `never` when it is. */
type SegmentIssue<
  Segment extends string,
  Seen extends string,
  Terminal extends boolean,
> = Segment extends "" ? "a path may not contain an empty segment"
  : Segment extends typeof WILDCARD
    ? Terminal extends true ? never : 'a "*" may only be the last segment'
  : Segment extends `:${infer Name}`
    ? Name extends "" ? 'a ":" must name a parameter'
    : IsName<Name> extends false
      ? 'a parameter name is letters, digits, "_", and "-"'
    : Name extends Seen ? `a path may not name ":${Name}" twice`
    : never
  : Segment extends `${string}${SyntaxChar}${string}`
    ? 'a segment is static text, ":name", or the terminal "*"'
  : never;

type WalkSegments<
  Segments extends readonly string[],
  Seen extends string,
> = Segments extends readonly [infer Head extends string, ...infer Tail extends readonly string[]]
  ? Tail extends readonly [] ? SegmentIssue<Head, Seen, true>
  : SegmentIssue<Head, Seen, false> | WalkSegments<Tail, Seen | NameOf<Head>>
  : never;

type PathIssues<Path extends string> = Path extends "/" ? never
  : Path extends `/${infer Rest}` ? WalkSegments<SegmentsOf<Rest>, never>
  : 'a path must start with "/"';

/**
 * `unknown` for a legal path, a branded message for an illegal one. Used as
 * `path: Path & ValidHttpPath<Path>`, so `Path` still infers from the literal
 * while an illegal literal has nothing to be assignable to.
 */
export type ValidHttpPath<Path extends string> = string extends Path ? unknown
  : [PathIssues<Path>] extends [never] ? unknown
  : `AckerDB route path error: ${PathIssues<Path>}`;

type NamesOf<Segments extends readonly string[]> = Segments extends
  readonly [infer Head extends string, ...infer Tail extends readonly string[]]
  ? NameOf<Head> | NamesOf<Tail>
  : never;

type ParamNames<Path extends string> = Path extends `/${infer Rest}`
  ? NamesOf<SegmentsOf<Rest>>
  : never;

/**
 * What one route's captures are: every `:name` as a readonly string property,
 * a terminal `*` as `params["*"]`, and nothing at all for a static path — so
 * a misspelled parameter is a compile error rather than `undefined`. A path
 * that is not a literal keeps the open record, because nothing narrows it.
 */
export type HttpParams<Path extends string = string> = string extends Path
  ? Readonly<Record<string, string>>
  : Readonly<Record<ParamNames<Path>, string>>;

/* -------------------------------------------------------------- runtime -- */

/**
 * The same grammar the types above enforce, for the values that reach the
 * loader without a compiler in front of them. Returns the path so callers
 * read the checked value rather than the one they passed.
 */
export function validateRoutePath(value: unknown, where: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${where} path must be a string`);
  }
  if (!value.startsWith("/")) {
    throw new TypeError(`${where} path "${value}" must start with "/"`);
  }
  if (value === "/") return value;
  const segments = value.slice(1).split("/");
  const named = new Set<string>();
  const at = `${where} path "${value}"`;
  for (const [index, segment] of segments.entries()) {
    if (segment === "") {
      throw new TypeError(`${at} may not contain an empty segment`);
    }
    if (segment === WILDCARD) {
      if (index !== segments.length - 1) {
        throw new TypeError(`${at} may only use "*" as the last segment`);
      }
      continue;
    }
    if (segment.startsWith(":")) {
      const name = segment.slice(1);
      if (name === "") throw new TypeError(`${at} has a ":" that names no parameter`);
      if (!NAME_CHARS.test(name)) {
        throw new TypeError(
          `${at} parameter name "${name}" must be letters, digits, "_", and "-"`,
        );
      }
      if (named.has(name)) throw new TypeError(`${at} names ":${name}" twice`);
      named.add(name);
      continue;
    }
    if (SYNTAX_CHARS.test(segment)) {
      throw new TypeError(
        `${at} segment "${segment}" is neither static text, ":name", nor the terminal "*"`,
      );
    }
  }
  return value;
}

/**
 * What two patterns must differ in to be two routes. Parameter names are the
 * caller's vocabulary, not the URL's: `/u/:id` and `/u/:slug` claim the same
 * URLs, so ownership is keyed by this rather than by the written path — the
 * matcher would otherwise accept both and serve only one.
 */
export function routeSignature(path: string): string {
  return path
    .split("/")
    .map((segment) => (segment.startsWith(":") ? ":" : segment))
    .join("/");
}

/**
 * AckerDB's pattern in the matcher's own language. The terminal `*` becomes
 * rou3's named catch-all under the very name AckerDB publishes, so the
 * captured key is `"*"` with nothing to rename, and the catch-all requires at
 * least one segment — `/assets/*` serves everything below `/assets`, and
 * `/assets` itself is a different route to claim.
 */
export function matcherPattern(path: string): string {
  return path.endsWith(`/${WILDCARD}`) ? `${path.slice(0, -1)}**:${WILDCARD}` : path;
}
