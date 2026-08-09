/**
 * `acker studio [app-dir] [--url <url>] [--port <n>]`
 *
 * Serves the AckerDB Studio bundle and same-origin-proxies HTTP, WebSocket, and
 * SSE to the application server — `localhost:<app-port>` read from
 * `.ackerdb.config.json`, or the `--url` target. One port to expose, no CORS,
 * and no way for the browser to be pointed anywhere else.
 *
 * The CLI takes no dependency on `@ackerdb/studio`: the package is resolved
 * from the application's node_modules at run time, so **installing it is the
 * opt-in**. Nothing opens a browser — the URL is printed to copy, because the
 * command is as likely to run over SSH as on a laptop. A down application
 * server is not an error either: Studio serves anyway and its proxy answers the
 * diagnosis until the application comes up.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../app/config.ts";
import { resolveAppPackage } from "../app/optional-package.ts";

/**
 * Studio's own port, owned here because the CLI is the only thing that starts
 * it: the launcher takes the port it is given rather than carrying a second
 * copy of this number across a dynamic import.
 */
export const STUDIO_DEFAULT_PORT = 4680;
export const STUDIO_PACKAGE = "@ackerdb/studio";
export const STUDIO_INSTALL_HINT = "bun add -d @ackerdb/studio";

export interface StudioArguments {
  readonly appDir: string;
  /** An explicit proxy target; when absent, the application config names the port. */
  readonly url?: string;
  readonly port: number;
}

/** The launcher contract @ackerdb/studio exports; structural, never imported. */
interface StudioModule {
  startStudio(options: { target: string; port: number }):
    | { url: string; stop(): void }
    | Promise<{ url: string; stop(): void }>;
}

/** Parse `studio` arguments; null means "print usage". */
export function parseStudioArguments(args: readonly string[]): StudioArguments | null {
  const positional: string[] = [];
  let url: string | undefined;
  let port: number | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--url") {
      const value = args[++index];
      if (value === undefined || url !== undefined) return null;
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        return null;
      }
      // The proxy joins each request's path onto the target origin, so a path,
      // query, or fragment here would be dropped on every call. Refusing it is
      // the only place that can name what the operator actually typed.
      if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.pathname !== "/" ||
        parsed.search !== "" ||
        parsed.hash !== ""
      ) {
        return null;
      }
      url = parsed.origin;
    } else if (argument === "--port") {
      const value = Number(args[++index]);
      if (port !== undefined || !Number.isSafeInteger(value) || value < 1 || value > 65_535) {
        return null;
      }
      port = value;
    } else if (argument.startsWith("--")) {
      return null;
    } else {
      positional.push(argument);
    }
  }
  if (positional.length > 1) return null;
  return {
    appDir: resolve(positional[0] ?? "."),
    ...(url === undefined ? {} : { url }),
    port: port ?? STUDIO_DEFAULT_PORT,
  };
}

/** Resolve @ackerdb/studio from the application's node_modules; absence is the opt-out. */
export function resolveStudioEntry(appDir: string): string {
  const entry = resolveAppPackage(appDir, STUDIO_PACKAGE);
  if (entry === null) {
    throw new Error(
      `${STUDIO_PACKAGE} is not installed in ${appDir} — Studio is opt-in; ` +
        `add it to the app with \`${STUDIO_INSTALL_HINT}\``,
    );
  }
  return entry;
}

/**
 * An IPv6 literal is bracketed in a URL and every other host is not. A
 * configured `::1` would otherwise produce `http://::1:3211`, which parses as
 * nothing at all.
 */
function asUrlHost(hostname: string): string {
  return hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
}

/**
 * The proxy target: `--url`, or the application config's listener on loopback.
 * A wildcard bind is an interface list, not an address to dial, so it becomes
 * the loopback address the listener is certainly reachable on.
 */
export function studioTarget(options: StudioArguments): string {
  if (options.url !== undefined) return options.url;
  const config = loadConfig(options.appDir);
  const hostname = config.hostname === "0.0.0.0" || config.hostname === "::"
    ? "127.0.0.1"
    : config.hostname;
  return `http://${asUrlHost(hostname)}:${config.port}`;
}

export async function runStudioCommand(options: StudioArguments): Promise<void> {
  const target = studioTarget(options);
  const entry = resolveStudioEntry(options.appDir);
  const studio = await import(pathToFileURL(entry).href) as Partial<StudioModule>;
  if (typeof studio.startStudio !== "function") {
    throw new Error(
      `the installed ${STUDIO_PACKAGE} does not export startStudio — ` +
        `update it to this workspace's version (${STUDIO_INSTALL_HINT})`,
    );
  }
  const running = await studio.startStudio({ target, port: options.port });
  console.log(`[ackerdb] Studio serving at ${running.url} — proxying to ${target}`);
  console.log("[ackerdb] copy the URL into a browser; Ctrl+C stops Studio");
  await new Promise<void>((finished) => {
    const stop = () => {
      running.stop();
      finished();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
