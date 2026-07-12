#!/usr/bin/env bun
/**
 * The `dbz` CLI.
 *
 *   dbz dev [dir]      watch + debounced codegen + auto-restarting server
 *   dbz start [dir]    codegen once, then serve (production)
 *   dbz codegen [dir]  one-shot codegen
 *   dbz reset [dir]    delete the local database (dev escape hatch)
 *
 * `dbz dev` is a supervisor that never imports user code itself: codegen and
 * the server run as child processes, so every reload sees fresh modules with
 * zero import-cache staleness. Clients reconnect and resubscribe on restart.
 */
import { existsSync, rmSync, watch } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type AppConfig } from "./config.ts";
import { runCodegen } from "./codegen.ts";
import { startApp } from "./app.ts";

const CLI_PATH = fileURLToPath(import.meta.url);

function usage(): never {
  console.log("usage: dbz <dev|start|codegen|reset> [app-dir]");
  process.exit(2);
}

async function codegenChild(appDir: string): Promise<boolean> {
  const child = Bun.spawn([process.execPath, CLI_PATH, "codegen", appDir], {
    stdout: "inherit",
    stderr: "inherit",
  });
  return (await child.exited) === 0;
}

function shouldIgnore(config: AppConfig, filename: string): boolean {
  const generatedName = basename(config.generatedDir);
  const dbName = basename(config.dbDir);
  return filename
    .split(sep)
    .some(
      (segment) =>
        segment === generatedName ||
        segment === dbName ||
        segment === "node_modules" ||
        segment.startsWith("."),
    );
}

async function dev(appDir: string): Promise<void> {
  const config = loadConfig(appDir);
  let child: ReturnType<typeof Bun.spawn> | null = null;

  const startChild = async () => {
    if (child !== null) {
      child.kill();
      await child.exited;
    }
    child = Bun.spawn([process.execPath, CLI_PATH, "__serve", appDir], {
      stdout: "inherit",
      stderr: "inherit",
    });
  };

  console.log(`[dbz] dev watching ${config.appDir}`);
  if (!(await codegenChild(appDir))) {
    console.error("[dbz] initial codegen failed — fix the errors above; watching for changes");
  }
  await startChild();

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let dirty = false;
  const reload = async () => {
    if (running) {
      dirty = true;
      return;
    }
    running = true;
    do {
      dirty = false;
      const t0 = performance.now();
      const ok = await codegenChild(appDir);
      if (ok) {
        await startChild();
        console.log(`[dbz] reloaded in ${Math.round(performance.now() - t0)}ms`);
      } else {
        console.error("[dbz] codegen failed — server not restarted; fix and save again");
      }
    } while (dirty);
    running = false;
  };
  const trigger = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void reload();
    }, 75);
  };

  watch(config.appDir, { recursive: true }, (_event, filename) => {
    if (filename === null || shouldIgnore(config, String(filename))) return;
    if (!String(filename).endsWith(".ts") && !String(filename).endsWith(".json")) return;
    trigger();
  });

  const shutdown = () => {
    child?.kill();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise(() => {}); // run until killed
}

const [command, dirArg] = process.argv.slice(2);
const appDir = resolve(dirArg ?? ".");

switch (command) {
  case "dev":
    await dev(appDir);
    break;
  case "start": {
    const config = loadConfig(appDir);
    await runCodegen(config);
    await startApp(config);
    break;
  }
  case "__serve":
    await startApp(loadConfig(appDir));
    break;
  case "codegen": {
    const t0 = performance.now();
    const { written } = await runCodegen(loadConfig(appDir));
    console.log(
      `[dbz] codegen ${written.length > 0 ? `wrote ${written.join(", ")}` : "up to date"} (${Math.round(performance.now() - t0)}ms)`,
    );
    break;
  }
  case "reset": {
    const config = loadConfig(appDir);
    if (existsSync(config.dbDir)) {
      rmSync(config.dbDir, { recursive: true, force: true });
      console.log(`[dbz] removed ${config.dbDir}`);
    } else {
      console.log(`[dbz] nothing to remove at ${config.dbDir}`);
    }
    break;
  }
  default:
    usage();
}
