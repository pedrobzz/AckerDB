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
import { basename, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { Renames } from "@dbzz/server";
import { loadConfig, type AppConfig } from "./config.ts";
import { runCodegen } from "./codegen.ts";
import { startApp, StartupInterruptedError } from "./app.ts";
import { runRenameForm, type FormResult } from "./migrations/form.ts";
import {
  computePlan,
  deriveSlug,
  planToWire,
  type PlanWire,
  type RenameCandidates,
} from "./migrations/plan.ts";
import { writeMigration, type GenerateRequest } from "./migrations/write.ts";
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
  dbz generate [name] [app-dir]
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

// -- migration generation flow ------------------------------------------------

/** Parse the JSON the `__generate` child receives: `{ name, renames? }`. */
function parseGenerateRequest(json: string): GenerateRequest {
  const parsed = JSON.parse(json) as { name?: unknown; renames?: unknown };
  if (typeof parsed.name !== "string") throw new Error("__generate request must carry a string name");
  return parsed.renames === undefined
    ? { name: parsed.name }
    : { name: parsed.name, renames: parsed.renames as Renames };
}

/** The last non-empty line of a child's stdout — the one JSON line it prints. */
function lastJsonLine(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error("expected JSON output from the child process");
  return lines[lines.length - 1]!;
}

/** Ask an ephemeral `__plan` child (fresh modules, no user code here) for the plan. */
async function planChild(appDir: string): Promise<PlanWire> {
  const child = Bun.spawn([process.execPath, CLI_PATH, "__plan", appDir], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error("could not compute the migration plan (see the error above)");
  return JSON.parse(lastJsonLine(out)) as PlanWire;
}

/** Drive an ephemeral `__generate` child, returning the written artifact paths. */
async function generateChild(appDir: string, request: GenerateRequest): Promise<string[]> {
  const child = Bun.spawn([process.execPath, CLI_PATH, "__generate", appDir, JSON.stringify(request)], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error("migration generation failed (see the error above)");
  return (JSON.parse(lastJsonLine(out)) as { written: string[] }).written;
}

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/** Run the rename form over a real readline; the caller guarantees a TTY. */
async function promptRenames(candidates: RenameCandidates): Promise<FormResult> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await runRenameForm(candidates, (prompt) => rl.question(prompt));
  } finally {
    rl.close();
  }
}

function countRenames(renames: Renames): number {
  const columns = Object.values(renames.columns ?? {}).reduce((n, cols) => n + Object.keys(cols).length, 0);
  const variants = Object.values(renames.variants ?? {}).reduce((n, vars) => n + Object.keys(vars).length, 0);
  return Object.keys(renames.tables ?? {}).length + columns + variants;
}

/** Report what was scaffolded and point the developer at the holes to fill. */
function reportGenerated(written: string[], renames: Renames, dropsAcknowledged: string[]): void {
  const rel = (path: string) => relative(process.cwd(), path);
  console.log(`[dbz] generated ${written.map(rel).join(", ")}`);
  const renameCount = countRenames(renames);
  if (renameCount > 0) console.log(`[dbz] recorded ${renameCount} rename(s)`);
  if (dropsAcknowledged.length > 0) console.log(`[dbz] delete + add: ${dropsAcknowledged.join(", ")}`);
  console.log(
    `[dbz] fill the TODOs in ${rel(written[0]!)}, then restart — the server applies the migration once it compiles`,
  );
}

/** `dbz generate`: plan in-process, run the form when interactive, then write the scaffold. */
async function generate(nameArg: string | undefined, appDir: string): Promise<void> {
  const config = loadConfig(appDir);
  const outcome = await computePlan(config);
  switch (outcome.status) {
    case "no-database":
      throw new Error(`no database at ${resolve(config.dbDir, "data.db")}; run \`dbz dev\` to initialize it first`);
    case "diverged":
      throw new Error(outcome.message);
    case "pending":
      throw new Error(`apply the ${outcome.pendingCount} pending migration(s) first — start \`dbz dev\``);
    case "clean":
      console.log("[dbz] no changes need a migration; nothing to generate (shape-safe changes apply on their own)");
      return;
    case "changes": {
      let form: FormResult = { renames: {}, dropsAcknowledged: [] };
      if (isInteractive()) {
        form = await promptRenames(outcome.candidates);
      } else {
        console.error(
          "[dbz] rename detection needs a terminal; generating with no renames (drops are acknowledged, adds treated as new)",
        );
      }
      const name = nameArg !== undefined && nameArg.length > 0 ? nameArg : deriveSlug(outcome.refusals);
      const written = await writeMigration(config, { name, renames: form.renames });
      reportGenerated(written, form.renames, form.dropsAcknowledged);
    }
  }
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
  type Child = ReturnType<typeof Bun.spawn>;
  let child: Child | null = null;
  // Children we killed ourselves (reload/shutdown); their non-zero exit is not a crash.
  const stopped = new WeakSet<Child>();
  let handlingCrash = false;

  const spawnChild = () => {
    const started = Bun.spawn([process.execPath, CLI_PATH, "__serve", appDir], {
      stdout: "inherit",
      stderr: "inherit",
    });
    child = started;
    // Watch this child's exit without disturbing the reload flow: a genuine
    // crash (a refused schema change fails startup) is the only trigger.
    void started.exited.then((code) => onChildExit(started, code));
  };

  const stopChild = async () => {
    if (child !== null) {
      stopped.add(child);
      child.kill();
      await child.exited;
      child = null;
    }
  };

  const startChild = async () => {
    await stopChild();
    spawnChild();
  };

  const onChildExit = (exited: Child, code: number) => {
    if (stopped.has(exited)) {
      stopped.delete(exited);
      return; // we killed it for a reload or shutdown
    }
    if (exited !== child) return; // already superseded by a newer child
    if (code === 0) return; // graceful exit
    child = null;
    void handleCrash();
  };

  // A crashed serve child is the interactive migration prompt's entry point. Only
  // one prompt at a time, and only with a real terminal on both ends — a non-TTY
  // dev keeps today's behavior (the child's own stderr already names `dbz generate`).
  const handleCrash = async () => {
    if (handlingCrash || !isInteractive()) return;
    handlingCrash = true;
    try {
      const wire = await planChild(appDir);
      if ("error" in wire || wire.clean) return; // fresh db, or nothing to answer
      if (wire.pendingCount > 0) {
        console.error("[dbz] a scaffolded migration is not applied yet — fill its TODOs; the server reloads when it compiles");
        return;
      }
      if (wire.refusals.length === 0) return;
      const { renames, dropsAcknowledged } = await promptRenames(wire.candidates);
      const written = await generateChild(appDir, { name: deriveSlug(wire.refusals), renames });
      reportGenerated(written, renames, dropsAcknowledged);
    } catch (error) {
      console.error(`[dbz] ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      handlingCrash = false;
    }
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
    if (child !== null) stopped.add(child);
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
      await startApp(config, { prepare: runCodegen });
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
    case "generate": {
      requireArgumentCount(args, 0, 2);
      await generate(args[0], resolve(args[1] ?? "."));
      break;
    }
    case "__plan": {
      requireArgumentCount(args, 1, 1);
      const config = loadConfig(resolve(args[0]!));
      console.log(JSON.stringify(planToWire(await computePlan(config), config)));
      break;
    }
    case "__generate": {
      requireArgumentCount(args, 2, 2);
      const config = loadConfig(resolve(args[0]!));
      const written = await writeMigration(config, parseGenerateRequest(args[1]!));
      console.log(JSON.stringify({ written }));
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
