/**
 * The Studio launcher: one origin serving the prebuilt SPA bundle and
 * same-origin-proxying everything else — HTTP, WebSocket, SSE — to the
 * application server. `acker studio` resolves this module from the
 * application's node_modules and calls {@link startStudio}; installing
 * `@ackerdb/studio` is the opt-in, and the CLI keeps no static dependency on it.
 *
 * Routing is `studioRoute` and nothing else — see `../origin.ts` for why the
 * SPA owns a prefix instead of guessing from `Accept`. The launcher's own job
 * is the two things that rule cannot decide: which bundled file a Studio path
 * names, and whether a request to the application is an upgrade.
 *
 * The bundle is required at start. Studio serving without a shell would be a
 * port that answers and shows nothing, which is the failure the "serve even
 * when the application is down" rule exists to avoid — the application being
 * down is a diagnosis Studio draws, and it cannot draw it without its bundle.
 */
import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { STUDIO_METHODS, STUDIO_PATH_PREFIX, studioRoute } from "../origin.ts";
import {
  MAX_UNDELIVERED_BYTES,
  proxyHttp,
  proxyWebSocket,
  proxyWebSocketHandlers,
  type ProxiedSocketData,
} from "./proxy.ts";

export interface StudioServerOptions {
  /** The application origin to proxy to, e.g. `http://127.0.0.1:3211`. */
  readonly target: string;
  /** The port to serve on; `0` picks a free one. The caller owns the default. */
  readonly port: number;
  /** Bind interface. Default 127.0.0.1 — exposing Studio is the operator's call. */
  readonly hostname?: string;
  /** The built SPA. Defaults to the `dist/` bundle shipped in this package. */
  readonly distDir?: string;
}

export interface RunningStudio {
  /** The URL to open: the origin plus the SPA's prefix, ready to copy. */
  readonly url: string;
  readonly port: number;
  stop(): void;
}

/**
 * The proxy joins each request's path onto this origin, so a target carrying a
 * path of its own would have it dropped on every call. Reducing to the origin
 * here states that rather than performing it silently; `acker studio` refuses
 * such a `--url` outright, where it can name what the operator typed.
 */
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
  return new URL(target.origin);
}

/** The bundled file a Studio path names, or null when it names none. */
function bundledFile(distDir: string, path: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  const resolved = resolve(join(distDir, decoded));
  // Resolution happens before the disk is touched, so a traversal never even
  // asks about a file outside the bundle; it becomes an ordinary SPA route.
  if (resolved !== distDir && !resolved.startsWith(distDir + sep)) return null;
  if (!existsSync(resolved) || !statSync(resolved).isFile()) return null;
  return resolved;
}

export function startStudio(options: StudioServerOptions): RunningStudio {
  const target = parseTarget(options.target);
  const distDir = resolve(options.distDir ?? join(import.meta.dir, "..", "..", "dist"));
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
    port: options.port,
    fetch(request, running) {
      const { pathname } = new URL(request.url);
      const route = studioRoute(request.method, pathname);
      switch (route.kind) {
        case "redirect":
          // A relative Location, deliberately: Studio may be reached through a
          // reverse proxy, and an absolute self-URL would name the origin it
          // was bound to rather than the one the browser used.
          return new Response(null, { status: 302, headers: { location: route.location } });
        case "refused":
          return new Response("the AckerDB Studio bundle serves documents only", {
            status: 405,
            headers: { allow: STUDIO_METHODS },
          });
        case "studio": {
          const file = bundledFile(distDir, route.path);
          // No such file means a client-side route, which the shell owns: the
          // SPA's own paths are the only unknowns that never reach the
          // application.
          return new Response(Bun.file(file ?? indexHtml));
        }
        case "application":
          return request.headers.get("upgrade")?.toLowerCase() === "websocket"
            ? proxyWebSocket(request, running, target)
            : proxyHttp(request, target);
      }
    },
    websocket: {
      ...proxyWebSocketHandlers,
      // The browser half of the same budget the bridge holds upstream: a tab
      // that stopped reading closes rather than accumulating behind Bun.
      backpressureLimit: MAX_UNDELIVERED_BYTES,
      closeOnBackpressureLimit: true,
    },
  });
  return {
    url: `http://${hostname}:${server.port}${STUDIO_PATH_PREFIX}`,
    port: server.port!,
    stop: () => server.stop(true),
  };
}
