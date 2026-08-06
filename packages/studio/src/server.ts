/**
 * The Studio launcher: one origin that serves the prebuilt SPA bundle and
 * same-origin-proxies everything else — HTTP, WebSocket, SSE — to the app
 * server. `acker studio` resolves this module from the app's node_modules and
 * calls {@link startStudio}; installing @ackerdb/studio is the opt-in.
 *
 * Routing, in order:
 *   1. WebSocket upgrades are bridged to the target.
 *   2. A GET/HEAD whose path is a file in `dist/` serves that file.
 *   3. A GET/HEAD navigation (Accept: text/html) serves `index.html` — the
 *      SPA owns its client-side routes.
 *   4. Everything else is proxied to the target.
 */
import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  proxyHttp,
  proxyWebSocket,
  proxyWebSocketHandlers,
  type ProxiedSocketData,
} from "./proxy.ts";

export const STUDIO_DEFAULT_PORT = 4680;

export interface StudioServerOptions {
  /** The app server origin to proxy to, e.g. `http://127.0.0.1:3211`. */
  readonly target: string;
  /** The Studio port. Default {@link STUDIO_DEFAULT_PORT}; 0 picks a free one. */
  readonly port?: number;
  /** Bind interface. Default 127.0.0.1 — exposing Studio is the user's call. */
  readonly hostname?: string;
  /** The built SPA. Defaults to the `dist/` bundle shipped in this package. */
  readonly distDir?: string;
}

export interface RunningStudio {
  readonly url: string;
  readonly port: number;
  stop(): void;
}

function parseTarget(raw: string): URL {
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    throw new Error(`the Studio proxy target ${JSON.stringify(raw)} is not a URL`);
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(`the Studio proxy target must be an http or https URL, not ${target.protocol}`);
  }
  return target;
}

/** The dist file a path names, or null when it names none (or escapes dist). */
function staticFile(distDir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const path = resolve(join(distDir, decoded));
  if (path !== distDir && !path.startsWith(distDir + sep)) return null;
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  return path;
}

function acceptsHtml(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/html");
}

export function startStudio(options: StudioServerOptions): RunningStudio {
  const target = parseTarget(options.target);
  const distDir = resolve(options.distDir ?? join(import.meta.dir, "..", "dist"));
  const indexHtml = join(distDir, "index.html");
  if (!existsSync(indexHtml)) {
    throw new Error(
      `the Studio bundle is missing (${indexHtml}) — the published package ships it prebuilt; ` +
        "inside the monorepo, run `bun run build` in packages/studio first",
    );
  }
  const hostname = options.hostname ?? "127.0.0.1";
  const server = Bun.serve<ProxiedSocketData, never>({
    hostname,
    port: options.port ?? STUDIO_DEFAULT_PORT,
    fetch(request, running) {
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return proxyWebSocket(request, running, target);
      }
      if (request.method === "GET" || request.method === "HEAD") {
        const url = new URL(request.url);
        const file = staticFile(distDir, url.pathname);
        if (file !== null) return new Response(Bun.file(file));
        if (acceptsHtml(request)) return new Response(Bun.file(indexHtml));
      }
      return proxyHttp(request, target);
    },
    websocket: proxyWebSocketHandlers,
  });
  return {
    url: `http://${hostname}:${server.port}/`,
    port: server.port!,
    stop: () => server.stop(true),
  };
}
