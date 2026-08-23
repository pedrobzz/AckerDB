import { addRoute, createRouter, findRoute, type RouterContext } from "rou3";
import { AckerDBError } from "../../shared/errors.ts";
import { methodNotAllowed, outcomeError } from "../response.ts";
import {
  captureNames,
  matcherPattern,
  routeSignature,
  NO_PARAMS,
  type HttpMethod,
  type HttpParams,
} from "./path.ts";
import type {
  HttpRequest,
  HttpRouteHandler,
  RunHttpHandler,
  Http,
} from "./route.ts";

interface RegisteredHandler {
  readonly call: HttpRouteHandler;
  readonly params: readonly string[];
}

interface RegisteredRoute {
  readonly matcherParams: readonly string[];
  readonly handlers: Partial<Record<HttpMethod, RegisteredHandler>>;
}

function decodedParams(
  raw: Record<string, string> | undefined,
  matcherNames: readonly string[],
  handlerNames: readonly string[],
): HttpParams | null {
  if (raw === undefined) return NO_PARAMS;
  const params = Object.create(null) as Record<string, string>;
  for (const [index, name] of handlerNames.entries()) {
    const value = raw[matcherNames[index] ?? ""];
    if (value === undefined) return null;
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
  private readonly routes = new Map<string, RegisteredRoute>();

  constructor(
    private readonly unmatched: () => Response,
    private readonly run: RunHttpHandler,
  ) {}

  add(route: Http): void {
    const signature = routeSignature(route.path);
    if (this.routes.has(signature)) {
      throw new Error(`HTTP route "${route.path}" is already owned`);
    }
    const registered: RegisteredRoute = {
      matcherParams: captureNames(route.path),
      handlers: {},
    };
    const methods = Object.keys(route.handlers) as HttpMethod[];
    this.routes.set(signature, registered);
    addRoute(this.matcher, "", matcherPattern(route.path), registered);
    const params = captureNames(route.path);
    for (const method of methods) {
      registered.handlers[method] = { call: route.handlers[method]!, params };
    }
  }

  dispatch(pathname: string, request: Request): Response | undefined | Promise<Response | undefined> {
    const matched = findRoute(this.matcher, "", pathname);
    if (matched === undefined) return this.unmatched();
    const handler = matched.data.handlers[request.method as HttpMethod];
    if (handler === undefined) {
      return methodNotAllowed(Object.keys(matched.data.handlers).join(", "));
    }
    const params = decodedParams(matched.params, matched.data.matcherParams, handler.params);
    if (params === null) {
      return outcomeError(new AckerDBError("malformed", "path contains an invalid escape"));
    }
    return handler.call({ params }, request as HttpRequest, this.run);
  }
}
