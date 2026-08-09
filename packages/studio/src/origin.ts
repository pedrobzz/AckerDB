/**
 * One origin, two owners — and the single rule that decides between them.
 *
 * `acker studio` serves the Studio SPA and proxies the application on one port,
 * so both sides address one flat path namespace. The application names its own
 * HTTP roots: every API path it declares becomes one, and the framework's
 * protocol roots sit beside them. Queries answer GET as well as POST, so a
 * browser navigation to an application or Admin API address is
 * indistinguishable from a navigation to a Studio screen by anything except the
 * path itself — which is why nothing here reads `Accept`.
 *
 * **The SPA owns one prefix and nothing else.** The prefix carries the
 * {@link RESERVED_MARKER}, the character an application may never begin a name
 * with, so no application can claim it by declaring an API path or an MCP path
 * — today, or after any change it makes. Its client-side routes live under the
 * prefix, which is why the shell answers for every unknown path *inside* it.
 *
 * **Everything outside the prefix is the application's, including paths neither
 * side knows.** The two failures are not symmetric. A path the application does
 * not serve comes back as its own visible 404; a Studio screen shadowed by the
 * shell comes back as a plausible page nobody ever notices. Sending the unknown
 * to the application puts the failure where the operator reads it.
 *
 * **The one carve-out is a browser landing on the bare origin.** A `GET` of `/`
 * or of the prefix without its trailing slash redirects into the prefix, so the
 * printed URL's origin opens Studio. It is restricted to navigations because
 * `/` is a legal MCP endpoint path, and MCP speaks `POST` and `OPTIONS`: a
 * redirect that answered every method would be exactly the silent shadow the
 * prefix exists to prevent.
 */
/**
 * The reserved marker, bound to `@ackerdb/core`'s by its type rather than by a
 * value import. Three runtimes read this module — the Bun launcher, the browser
 * bundle, and Node's type-stripping loader when Vite reads its config — so it
 * stays free of runtime imports, while the annotation still fails this build if
 * the framework ever moves the character its whole namespace rule turns on.
 */
const RESERVED_MARKER: typeof import("@ackerdb/core").RESERVED_MARKER = "_";

/**
 * The one path prefix the Studio SPA answers for, trailing slash included. It
 * is the SPA's base URL, its router's basepath, and the launcher's routing
 * rule — spelled once, because a disagreement between the three is a shell that
 * loads without its assets.
 */
export const STUDIO_PATH_PREFIX = `/${RESERVED_MARKER}studio/`;

/** What one request belongs to, and what the launcher owes it. */
export type StudioRoute =
  /** A browser landing on the bare origin; `location` is where Studio lives. */
  | { readonly kind: "redirect"; readonly location: string }
  /** The SPA's: `path` names a bundled file, or nothing, in which case the shell answers. */
  | { readonly kind: "studio"; readonly path: string }
  /** Inside the SPA prefix with a method the SPA has no answer for. */
  | { readonly kind: "refused" }
  /** The application's, whether or not it serves it. */
  | { readonly kind: "application" };

/** The methods the SPA answers: it serves documents and nothing else. */
export const STUDIO_METHODS = "GET, HEAD";

/**
 * The whole Studio-versus-application decision, over the two facts a request
 * carries before its body is read. Pure so that the rule is testable as a
 * table rather than through a live socket.
 */
export function studioRoute(method: string, pathname: string): StudioRoute {
  const navigation = method === "GET" || method === "HEAD";
  if (navigation && (pathname === "/" || pathname === STUDIO_PATH_PREFIX.slice(0, -1))) {
    return { kind: "redirect", location: STUDIO_PATH_PREFIX };
  }
  if (!pathname.startsWith(STUDIO_PATH_PREFIX)) return { kind: "application" };
  if (!navigation) return { kind: "refused" };
  return { kind: "studio", path: pathname.slice(STUDIO_PATH_PREFIX.length) };
}
