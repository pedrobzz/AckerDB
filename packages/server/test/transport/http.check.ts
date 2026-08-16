/**
 * Compile-time assertions for the HTTP route surface: the path grammar the
 * factory admits, the captures a literal path gives its handlers, and the
 * method-specific handler aliases. Never executed — `bun run typecheck`
 * failing is the test.
 *
 * Every positive case here has a matching wire proof in `http-routes.test.ts`:
 * the compiler and the matcher implement one grammar, so a pattern that types
 * must also route.
 */
import {
  http,
  defineSchema,
  defineTable,
  v,
  type HttpBuilder,
  type HttpHandlerCtx,
  type HttpHandler,
  type HttpHandlerDELETE,
  type HttpHandlerGET,
  type HttpHandlerHEAD,
  type HttpHandlerOPTIONS,
  type HttpHandlerPATCH,
  type HttpHandlerPOST,
  type HttpHandlerPUT,
  type HttpParams,
  type ValidHttpPath,
} from "@ackerdb/server";

const schema = defineSchema({
  deliveries: defineTable({ id: v.primaryKey(), type: v.string() }),
});
type S = typeof schema;

/** What generated code produces: the factory with this application bound in. */
const typedHttp = http as HttpBuilder<S>;

type Expect<T extends true> = T;
type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true
  : false;

/* ------------------------------------------- the path grammar, positively -- */

type _static = Expect<Eq<ValidHttpPath<"/live">, unknown>>;
type _root = Expect<Eq<ValidHttpPath<"/">, unknown>>;
type _oneParam = Expect<Eq<ValidHttpPath<"/users/:id">, unknown>>;
type _manyParams = Expect<Eq<ValidHttpPath<"/o/:org/r/:repo">, unknown>>;
type _wildcard = Expect<Eq<ValidHttpPath<"/users/:id/assets/*">, unknown>>;
/** Nothing narrows a non-literal path, so nothing may refuse one either. */
type _erased = Expect<Eq<ValidHttpPath<string>, unknown>>;

/* --------------------------------------------- the captures a path declares -- */

type _noParams = Expect<Eq<HttpParams<"/live">, Readonly<Record<never, string>>>>;
type _idParam = Expect<Eq<HttpParams<"/users/:id">, { readonly id: string }>>;
type _bothParams = Expect<
  Eq<HttpParams<"/o/:org/r/:repo">, { readonly org: string; readonly repo: string }>
>;
type _wildcardParam = Expect<
  Eq<HttpParams<"/assets/*">, { readonly "*": string }>
>;
type _openParams = Expect<Eq<HttpParams<string>, Readonly<Record<string, string>>>>;

export type PathChecks = [
  _static,
  _root,
  _oneParam,
  _manyParams,
  _wildcard,
  _erased,
  _noParams,
  _idParam,
  _bothParams,
  _wildcardParam,
  _openParams,
];

/* --------------------------------------------------------- inline handlers -- */

// An inline handler is contextually typed from the literal path: no helper
// type, no annotation, and the capture is a `string`.
typedHttp("/users/:id", {
  GET: (ctx, request) => {
    const id: string = ctx.params.id;
    const method: "GET" = request.method;
    return new Response(`${id} ${method}`);
  },
});

typedHttp("/o/:org/r/:repo", {
  GET: (ctx) => Response.json({ org: ctx.params.org, repo: ctx.params.repo }),
});

typedHttp("/assets/*", {
  GET: (ctx) => new Response(ctx.params["*"]),
});

// Several methods, one path, one Http value — and the same handler value may
// answer more than one of them.
const answer = (): Response => new Response(null);
typedHttp("/api/hooks/both", { GET: answer, POST: answer, OPTIONS: answer });

// The bound factory carries the application's Schema into `tx`.
typedHttp("/api/hooks/stripe", {
  POST: async (ctx) => {
    await ctx.tx((tx) => tx.db.deliveries.insert({ type: "ping" }));
    return new Response(null);
  },
});

/* ------------------------------------------- separately declared handlers -- */

const get: HttpHandlerGET<"/users/:id", S> = (ctx, request) =>
  new Response(`${ctx.params.id} ${request.method}`);
const head: HttpHandlerHEAD<"/users/:id", S> = (_ctx, request) =>
  new Response(null, { headers: { "x-method": request.method } });
const post: HttpHandlerPOST<"/users/:id", S> = () => new Response(null);
const put: HttpHandlerPUT<"/users/:id", S> = () => new Response(null);
const patch: HttpHandlerPATCH<"/users/:id", S> = () => new Response(null);
const remove: HttpHandlerDELETE<"/users/:id", S> = () => new Response(null);
const options: HttpHandlerOPTIONS<"/users/:id", S> = () => new Response(null);
/** The canonical generic every alias is written in terms of. */
const canonical: HttpHandler<"POST", "/users/:id", S> = post;

typedHttp("/users/:id", {
  GET: get,
  HEAD: head,
  POST: canonical,
  PUT: put,
  PATCH: patch,
  DELETE: remove,
  OPTIONS: options,
});

/** The context type is the same one, addressable on its own. */
const ctxIsBound: HttpHandlerCtx<"/users/:id", S>["params"] = { id: "7" };
void ctxIsBound;

/* --------------------------------------------------------------- negatives -- */

typedHttp("/live", {
  // @ts-expect-error a static path invents no parameter keys
  GET: (ctx) => new Response(ctx.params.id),
});

typedHttp("/users/:id", {
  // @ts-expect-error the path declares `id`, not `userId`
  GET: (ctx) => new Response(ctx.params.userId),
});

// @ts-expect-error a path must start with "/"
typedHttp("users/:id", { GET: answer });

// @ts-expect-error a path may not contain an empty segment
typedHttp("/a//b", { GET: answer });

// @ts-expect-error a wildcard is terminal
typedHttp("/a/*/b", { GET: answer });

// @ts-expect-error a wildcard appears at most once
typedHttp("/a/*/*", { GET: answer });

// @ts-expect-error a parameter name may not repeat
typedHttp("/:id/x/:id", { GET: answer });

// @ts-expect-error a segment is static text, ":name", or the terminal "*"
typedHttp("/a/**", { GET: answer });

// @ts-expect-error the matcher reads "(" as syntax, so static text may not carry it
typedHttp("/v(1)/x", { GET: answer });

// @ts-expect-error the matcher reads "{" as syntax
typedHttp("/a{b,c}", { GET: answer });

// @ts-expect-error a parameter name is letters, digits, "_", and "-"
typedHttp("/x/:a.b", { GET: answer });

// @ts-expect-error TRACE is not a supported method
typedHttp("/a", { TRACE: answer });

// @ts-expect-error a handler answers a Response, never a value
typedHttp("/a", { GET: () => ({ ok: true }) });

// @ts-expect-error a handler never answers undefined
typedHttp("/a", { GET: () => undefined });

typedHttp("/users/:id", {
  GET: (_ctx, request): Response => {
    // @ts-expect-error a GET handler's request method is narrowed to GET
    const method: "POST" = request.method;
    return new Response(method);
  },
});

typedHttp("/api/hooks/stripe", {
  POST: async (ctx) => {
    // @ts-expect-error the bound Schema has no `orders` table
    await ctx.tx((tx) => tx.db.orders.insert({}));
    return new Response(null);
  },
});

// @ts-expect-error a POST handler does not satisfy the GET alias
const wrongMethod: HttpHandlerGET<"/a", S> = post;
void wrongMethod;
