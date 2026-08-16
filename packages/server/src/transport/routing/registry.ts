/**
 * The listener's one route table. Every HTTP entry AckerDB serves — health
 * probes, status, the OpenAPI document, File bytes, the WebSocket door, the
 * SSE receiver credit, exposed functions, application-owned raw routes — is a
 * route in here, and the permanent `fetch` does nothing but ask this for one.
 *
 * The registry owns the generic half of HTTP: matching a path, choosing the
 * more specific of two patterns, extracting and decoding captures, selecting a
 * method, and answering `405` with a complete `Allow` or handing an unmatched
 * request to its owner's fallback. It owns none of the other half: whether a
 * route is reachable yet, who may call it, what it costs, and what it answers
 * are the handler's business. It never learns that a route is a webhook, a
 * probe, or a File.
 *
 * Matching itself is commodity, and this does not reimplement it: `rou3` is a
 * radix-tree router with dynamic insertion, named parameters, a terminal
 * catch-all, and the static-before-parameter-before-wildcard precedence Bun
 * and every mature router share. AckerDB owns the published grammar
 * ({@link ../routing/path.ts}) and translates it once at insertion, so nothing
 * rou3 additionally supports becomes an AckerDB route language.
 */
import { addRoute, createRouter, findRoute, type RouterContext } from "rou3";
import { AckerDBError } from "../../shared/errors.ts";
import { methodNotAllowed, outcomeError } from "../response.ts";
import {
  matcherPattern,
  routeSignature,
  HTTP_METHODS,
  NO_PARAMS,
  type HttpParams,
} from "./path.ts";
import { handlerFor, type HttpRequest, type HttpRoute } from "./route.ts";

/** One route and the export that answers for it if its claim is refused. */
export interface ClaimedRoute {
  readonly route: HttpRoute;
  readonly owner: string;
}

interface RegisteredRoute {
  readonly route: HttpRoute;
  /** Built once at insertion; a wrong method never assembles a header. */
  readonly allow: string;
}

/**
 * A capture is the decoded segment, so a handler's runtime value matches the
 * `string` its path declared. An undecodable escape is the caller's malformed
 * request, not the route's absence.
 */
function decodedParams(raw: Record<string, string> | undefined): HttpParams | null {
  if (raw === undefined) return NO_PARAMS;
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    try {
      params[name] = decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return Object.freeze(params);
}

export class HttpRegistry {
  private readonly matcher: RouterContext<RegisteredRoute> = createRouter<RegisteredRoute>();
  /** Path ownership, so two routes can never disagree about who serves one. */
  private readonly owners = new Map<string, string>();

  /**
   * `unmatched` is the owner's policy for a request no route claims — the
   * lifecycle answer before readiness and while draining, the not-found answer
   * after. Keeping it here rather than in `fetch` is what stops "no route" from
   * becoming another dispatch branch.
   */
  constructor(private readonly unmatched: () => Response) {}

  /**
   * The sole registration operation, and a whole batch at a time: every claim
   * in the batch is checked before the matcher is touched at all, so a refused
   * route leaves the live table exactly as it was rather than half-installed.
   * Ownership is by pattern, not by written path — two routes whose parameters
   * differ only in name claim the same URLs.
   */
  add(routes: readonly ClaimedRoute[]): void {
    const claimed = new Map<string, string>();
    for (const { route, owner } of routes) {
      const signature = routeSignature(route.path);
      const existing = this.owners.get(signature) ?? claimed.get(signature);
      if (existing !== undefined) {
        throw new Error(`${owner} and ${existing} both claim the HTTP route "${route.path}"`);
      }
      claimed.set(signature, owner);
    }
    for (const [signature, owner] of claimed) this.owners.set(signature, owner);
    for (const { route } of routes) {
      addRoute(this.matcher, "", matcherPattern(route.path), {
        route,
        allow: HTTP_METHODS.filter((method) => route.handlers[method] !== undefined).join(", "),
      });
    }
  }

  dispatch(pathname: string, request: Request): Response | undefined | Promise<Response | undefined> {
    const matched = findRoute(this.matcher, "", pathname);
    if (matched === undefined) return this.unmatched();
    const { route, allow } = matched.data;
    const handler = handlerFor(route, request.method);
    if (handler === undefined) return methodNotAllowed(allow);
    const params = decodedParams(matched.params);
    if (params === null) {
      return outcomeError(new AckerDBError("malformed", "path contains an invalid escape"));
    }
    return handler({ params }, request as HttpRequest);
  }
}
