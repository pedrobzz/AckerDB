#!/usr/bin/env bun
/**
 * The `dbz` CLI.
 *
 *   dbz dev [dir]      watch + debounced codegen + auto-restarting server
 *   dbz start [dir]    codegen once, then serve (production)
 *   dbz codegen [dir]  one-shot codegen
 *   dbz reset [dir]    delete the local database (dev escape hatch)
 *   dbz status [dir]   inspect a database as JSON
 *   dbz backup <file> [dir]   create and verify a backup
 *   dbz restore <file> [dir]  verify and restore into a fresh target
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
import { startApp, StartupInterruptedError } from "./app.ts";
import {
  createVerifiedBackup,
  inspectDatabase,
  parseBackupManifest,
  restoreVerifiedBackup,
  serializeBackupManifest,
  verifyBackupArtifact,
  type FreshProcessVerifier,
} from "./operations.ts";

const CLI_PATH = fileURLToPath(import.meta.url);

function usage(): never {
  console.log(`usage:
  dbz dev [app-dir]
  dbz start [app-dir]
  dbz codegen [app-dir]
  dbz reset [app-dir]
  dbz status [app-dir]
  dbz backup <artifact> [app-dir]
  dbz restore <artifact> [app-dir]`);
  process.exit(2);
}

function requireArgumentCount(args: string[], minimum: number, maximum: number): void {
  if (args.length < minimum || args.length > maximum) usage();
}

const verifyInFreshProcess: FreshProcessVerifier = async (config, artifact, manifest) => {
  const child = Bun.spawn(
    [
      process.execPath,
      CLI_PATH,
      "__verify_backup",
      config.appDir,
      artifact,
      JSON.stringify(serializeBackupManifest(manifest)),
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`fresh-process backup verification failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }
};

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

  const treeWatcher = watch(config.appDir, { recursive: true }, (_event, filename) => {
    if (filename === null || shouldIgnore(config, String(filename))) return;
    if (!String(filename).endsWith(".ts") && !String(filename).endsWith(".json")) return;
    trigger();
  });
  // Bun's recursive macOS watcher can start after the server reaches readiness.
  // Own the schema file separately so an immediate first edit cannot be lost.
  const schemaWatcher = existsSync(config.schemaPath) ? watch(config.schemaPath, trigger) : null;

  const shutdown = () => {
    treeWatcher.close();
    schemaWatcher?.close();
    child?.kill();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise(() => {}); // run until killed
}

const [command, ...args] = process.argv.slice(2);

try {
  switch (command) {
    case "dev": {
      requireArgumentCount(args, 0, 1);
      await dev(resolve(args[0] ?? "."));
      break;
    }
    case "start": {
      requireArgumentCount(args, 0, 1);
      const config = loadConfig(resolve(args[0] ?? "."));
      await startApp(config, runCodegen);
      break;
    }
    case "__serve": {
      requireArgumentCount(args, 1, 1);
      await startApp(loadConfig(resolve(args[0]!)));
      break;
    }
    case "__verify_backup": {
      requireArgumentCount(args, 3, 3);
      const manifest = parseBackupManifest(JSON.parse(args[2]!));
      await verifyBackupArtifact(loadConfig(resolve(args[0]!)), resolve(args[1]!), manifest);
      break;
    }
    case "codegen": {
      requireArgumentCount(args, 0, 1);
      const t0 = performance.now();
      const { written } = await runCodegen(loadConfig(resolve(args[0] ?? ".")));
      console.log(
        `[dbz] codegen ${written.length > 0 ? `wrote ${written.join(", ")}` : "up to date"} (${Math.round(performance.now() - t0)}ms)`,
      );
      break;
    }
    case "reset": {
      requireArgumentCount(args, 0, 1);
      const config = loadConfig(resolve(args[0] ?? "."));
      if (existsSync(config.dbDir)) {
        rmSync(config.dbDir, { recursive: true, force: true });
        console.log(`[dbz] removed ${config.dbDir}`);
      } else {
        console.log(`[dbz] nothing to remove at ${config.dbDir}`);
      }
      break;
    }
    case "status": {
      requireArgumentCount(args, 0, 1);
      console.log(JSON.stringify(await inspectDatabase(loadConfig(resolve(args[0] ?? ".")))));
      break;
    }
    case "backup": {
      requireArgumentCount(args, 1, 2);
      const report = await createVerifiedBackup(
        loadConfig(resolve(args[1] ?? ".")),
        resolve(args[0]!),
        verifyInFreshProcess,
      );
      console.log(JSON.stringify(report));
      break;
    }
    case "restore": {
      requireArgumentCount(args, 1, 2);
      const report = await restoreVerifiedBackup(
        loadConfig(resolve(args[1] ?? ".")),
        resolve(args[0]!),
        verifyInFreshProcess,
      );
      console.log(JSON.stringify(report));
      break;
    }
    default:
      usage();
  }
} catch (error) {
  if (error instanceof StartupInterruptedError) process.exit(0);
  console.error(`[dbz] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
