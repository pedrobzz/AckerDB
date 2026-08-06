/**
 * `acker studio [app-dir] [--url <url>] [--port <n>]`
 *
 * Serves the AckerDB Studio SPA on localhost and same-origin-proxies HTTP,
 * WebSocket, and SSE to the app server — `localhost:<app-port>` from
 * `.ackerdb.config.json` by default, or the `--url` target.
 *
 * The CLI takes no dependency on @ackerdb/studio: the package is resolved from
 * the app's node_modules at run time, and installing it is the opt-in. No
 * auto-open — the URL is printed to copy. A down app server is fine: Studio
 * serves anyway and the proxy answers errors until it comes up.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../app/config.ts";

export const STUDIO_DEFAULT_PORT = 4680;
export const STUDIO_INSTALL_HINT = "bun add -d @ackerdb/studio";

export interface StudioArguments {
  readonly appDir: string;
  /** An explicit proxy target; when absent, the app config names the port. */
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
      // The proxy joins request paths onto the target origin, so a path,
      // query, or fragment here would be silently dropped — refuse it instead.
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

/** Resolve @ackerdb/studio from the app's node_modules; absence is the opt-out. */
export function resolveStudioEntry(appDir: string): string {
  try {
    return Bun.resolveSync("@ackerdb/studio", appDir);
  } catch {
    throw new Error(
      `@ackerdb/studio is not installed in ${appDir} — Studio is opt-in; ` +
        `add it to the app with \`${STUDIO_INSTALL_HINT}\``,
    );
  }
}

/** The proxy target: `--url`, or the app config's listener on loopback. */
export function studioTarget(options: StudioArguments): string {
  if (options.url !== undefined) return options.url;
  const config = loadConfig(options.appDir);
  const hostname = config.hostname === "0.0.0.0" || config.hostname === "::"
    ? "127.0.0.1"
    : config.hostname;
  return `http://${hostname}:${config.port}`;
}

export async function runStudioCommand(options: StudioArguments): Promise<void> {
  const target = studioTarget(options);
  const entry = resolveStudioEntry(options.appDir);
  const studio = await import(pathToFileURL(entry).href) as Partial<StudioModule>;
  if (typeof studio.startStudio !== "function") {
    throw new Error(
      "the installed @ackerdb/studio does not export startStudio — " +
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
