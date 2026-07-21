#!/usr/bin/env bun
/**
 * The `dbzz` CLI.
 *
 *   dbzz dev [dir]      watch + debounced codegen + auto-restarting server
 *   dbzz start [dir]    codegen once, then serve (production)
 *   dbzz codegen [dir]  one-shot codegen
 *   dbzz reset [dir]    delete the local database (dev escape hatch)
 *   dbzz plugin reset|drop <mount> [dir]  clear one consent-gated Plugin scope
 *   dbzz status [dir]   inspect a database as JSON
 *   dbzz backup <file> [dir]   create and verify a backup
 *   dbzz restore <file> [dir]  verify and restore into a fresh target
 *
 * `dbzz dev` is a supervisor that never imports user code itself: codegen and
 * the server run as child processes, so every reload sees fresh modules with
 * zero import-cache staleness. Clients reconnect and resubscribe on restart.
 */
import { existsSync, rmSync, watch } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { resetDatabase, type Renames } from "@dbzz/server";
import { loadConfig, type AppConfig } from "./config.ts";
import { runCodegen } from "./codegen.ts";
import { startApp, StartupInterruptedError } from "./app.ts";
import { runRenameForm, type Ask, type FormResult } from "./migrations/form.ts";
import { renderLedger, runDivergenceForm } from "./migrations/consent.ts";
import { makeDevFlowHandler, type GenerateResult, type PromptOutcome } from "./migrations/dev-flow.ts";
import { computePlan, deriveSlug, planToWire, type PlanWire } from "./migrations/plan.ts";
import { StaleConsentError, writeMigration, type GenerateRequest } from "./migrations/write.ts";
import {
  createVerifiedBackup,
  inspectDatabase,
  parseBackupManifest,
  restoreVerifiedBackup,
  serializeBackupManifest,
  verifyBackupArtifact,
  type FreshProcessVerifier,
} from "./operations.ts";
import {
  applyPluginStorageConsent,
  executePluginStorageCommand,
  planPluginStorage,
  type PluginApplyResult,
  type PluginPlanWire,
  type PluginStorageConsent,
} from "./plugin-storage.ts";

const CLI_PATH = fileURLToPath(import.meta.url);

function usage(): never {
  console.log(`usage:
  dbzz dev [app-dir]
  dbzz start [app-dir]
  dbzz codegen [app-dir]
  dbzz generate [name] [app-dir]
  dbzz plugin reset <mount> [app-dir]
  dbzz plugin drop <mount> [app-dir]
  dbzz reset [app-dir]
  dbzz status [app-dir]
  dbzz backup <artifact> [app-dir]
  dbzz restore <artifact> [app-dir]`);
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

/** Parse the JSON the `__generate` child receives: `{ name, renames?, consent? }`. */
function parseGenerateRequest(json: string): GenerateRequest {
  const parsed = JSON.parse(json) as { name?: unknown; renames?: unknown; consent?: unknown };
  if (typeof parsed.name !== "string") throw new Error("__generate request must carry a string name");
  if (parsed.consent !== undefined && typeof parsed.consent !== "string") {
    throw new Error("__generate consent must be a string fingerprint");
  }
  const request: GenerateRequest = { name: parsed.name };
  if (parsed.renames !== undefined) request.renames = parsed.renames as Renames;
  if (parsed.consent !== undefined) request.consent = parsed.consent;
  return request;
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

/** Drive an ephemeral `__generate` child. */
async function generateChild(appDir: string, request: GenerateRequest): Promise<GenerateResult> {
  const child = Bun.spawn([process.execPath, CLI_PATH, "__generate", appDir, JSON.stringify(request)], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error("migration generation failed (see the error above)");
  return JSON.parse(lastJsonLine(out)) as GenerateResult;
}

/** Inspect the next Plugin requirement in a child with fresh user modules. */
async function pluginPlanChild(appDir: string): Promise<PluginPlanWire> {
  const child = Bun.spawn([process.execPath, CLI_PATH, "__plugin_plan", appDir], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error("could not inspect Plugin storage (see the error above)");
  return JSON.parse(lastJsonLine(out)) as PluginPlanWire;
}

/** Apply one displayed Plugin consent in a fresh child that re-proves it. */
async function applyPluginChild(
  appDir: string,
  consent: PluginStorageConsent,
): Promise<PluginApplyResult> {
  const child = Bun.spawn([
    process.execPath,
    CLI_PATH,
    "__plugin_apply",
    appDir,
    JSON.stringify(consent),
  ], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error("Plugin storage change failed (see the error above)");
  return JSON.parse(lastJsonLine(out)) as PluginApplyResult;
}

function parsePluginConsent(json: string): PluginStorageConsent {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).some((key) =>
      key !== "kind" && key !== "mount" && key !== "currentFingerprint" && key !== "targetFingerprint"
    ) ||
    (parsed.kind !== "reset" && parsed.kind !== "drop") ||
    typeof parsed.mount !== "string" ||
    typeof parsed.currentFingerprint !== "string" ||
    typeof parsed.targetFingerprint !== "string"
  ) {
    throw new Error("__plugin_apply requires an exact Plugin storage consent");
  }
  return {
    kind: parsed.kind,
    mount: parsed.mount,
    currentFingerprint: parsed.currentFingerprint,
    targetFingerprint: parsed.targetFingerprint,
  };
}

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/** Ctrl+C while a prompt was open. Bailing out of a question is always safe. */
class PromptInterruptedError extends Error {}
/** The supervisor retracted the prompt — the state it asked about changed. */
class PromptCanceledError extends Error {}

/**
 * Map an interrupted prompt to that prompt's safe answer — decline for the
 * consent question, keep for the divergence offer — so Ctrl+C never writes,
 * never deletes, and never tears the supervisor down mid-question.
 */
const interruptAs =
  <T,>(fallback: T) =>
  (error: unknown): T => {
    if (error instanceof PromptInterruptedError) return fallback;
    throw error;
  };

/**
 * Run one prompt form over a real readline; the caller guarantees a TTY.
 * Ctrl+C surfaces as PromptInterruptedError; an abort of `cancel` — the
 * supervisor retracting the question because a file changed under it — as
 * PromptCanceledError.
 */
async function withReadline<T>(form: (ask: Ask) => Promise<T>, cancel?: AbortSignal): Promise<T> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const aborted = new AbortController();
  let retracted = false;
  rl.on("SIGINT", () => aborted.abort());
  const retract = () => {
    retracted = true;
    aborted.abort();
  };
  cancel?.addEventListener("abort", retract, { once: true });
  if (cancel?.aborted) retract();
  try {
    return await form((prompt) =>
      rl.question(prompt, { signal: aborted.signal }).catch((error) => {
        if (!aborted.signal.aborted) throw error;
        throw retracted ? new PromptCanceledError() : new PromptInterruptedError();
      }),
    );
  } finally {
    cancel?.removeEventListener("abort", retract);
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
  console.log(`[dbzz] generated ${written.map(rel).join(", ")}`);
  const renameCount = countRenames(renames);
  if (renameCount > 0) console.log(`[dbzz] recorded ${renameCount} rename(s)`);
  if (dropsAcknowledged.length > 0) console.log(`[dbzz] delete + add: ${dropsAcknowledged.join(", ")}`);
  console.log(
    `[dbzz] fill the TODOs in ${rel(written[0]!)}, then restart — the server applies the migration once it compiles`,
  );
}

/** Delete a stale pending scaffold's artifacts so one migration can be re-derived. */
function deletePendingFiles(files: string[]): void {
  for (const file of files) rmSync(file, { force: true });
  console.log(`[dbzz] deleted ${files.length} migration file(s); re-deriving`);
}

/**
 * `dbzz generate`: plan in-process, print the ledger, run the rename form when
 * interactive, then write the scaffold. Invoking the command IS the consent —
 * no fingerprint rides along, and the plan is re-derived at write time anyway.
 * A stale pending chain gets the same delete-or-keep offer the dev supervisor
 * makes (as guidance text without a terminal), then the loop re-plans.
 */
async function generate(nameArg: string | undefined, appDir: string): Promise<void> {
  const config = loadConfig(appDir);
  for (;;) {
    const outcome = await computePlan(config);
    switch (outcome.status) {
      case "no-database":
        throw new Error(`no database at ${resolve(config.dbDir, "data.db")}; run \`dbzz dev\` to initialize it first`);
      case "diverged":
        throw new Error(outcome.message);
      case "pending": {
        const apply = `apply the ${outcome.pendingCount} pending migration(s) first — start \`dbzz dev\``;
        if (!outcome.stale) throw new Error(apply);
        if (!isInteractive()) {
          throw new Error(
            `${apply}\nthe schema changed after the pending migration was scaffolded; ` +
              `delete its files to re-derive one migration covering everything:\n` +
              outcome.pendingFiles.map((file) => `  ${file}`).join("\n"),
          );
        }
        const choice = await withReadline((ask) => runDivergenceForm(outcome.pendingFiles, ask)).catch(
          interruptAs("keep" as const),
        );
        if (choice === "keep") throw new Error(apply);
        deletePendingFiles(outcome.pendingFiles);
        continue;
      }
      case "clean":
        console.log("[dbzz] no changes need a migration; nothing to generate (shape-safe changes apply on their own)");
        return;
      case "changes": {
        console.log(renderLedger(outcome));
        let form: FormResult | null = { renames: {}, dropsAcknowledged: [] };
        if (isInteractive()) {
          form = await withReadline((ask) => runRenameForm(outcome.candidates, ask)).catch(interruptAs(null));
          if (form === null) throw new Error("interrupted; nothing was written");
        } else {
          console.error(
            "[dbzz] rename detection needs a terminal; generating with no renames (drops are acknowledged, adds treated as new)",
          );
        }
        const name = nameArg !== undefined && nameArg.length > 0 ? nameArg : deriveSlug(outcome.refusals);
        const result = await writeMigration(config, { name, renames: form.renames });
        reportGenerated(result, form.renames, form.dropsAcknowledged);
        return;
      }
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

  // Interactive dev children hold pending migrations (exit instead of
  // applying) so the flow below can ask first; the one start after a yes drops
  // the hold. Non-TTY dev keeps applying at startup, exactly like production.
  const spawnChild = (applyPending: boolean) => {
    const args = [process.execPath, CLI_PATH, "__serve", appDir];
    if (isInteractive() && !applyPending) args.push("--hold-pending");
    const started = Bun.spawn(args, {
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

  const startChild = async (applyPending = false) => {
    await stopChild();
    spawnChild(applyPending);
  };

  const onChildExit = (exited: Child, code: number) => {
    if (stopped.has(exited)) {
      stopped.delete(exited);
      return; // we killed it for a reload or shutdown
    }
    if (exited !== child) return; // already superseded by a newer child
    if (code === 0) return; // graceful exit
    child = null;
    void devFlow.onCrash();
  };

  // A crashed serve child is the interactive consent flow's entry point; the
  // flow itself lives in dev-flow.ts (state machine, decline memory, retract
  // semantics) — this is only its terminal-and-process wiring. Only with a
  // real terminal on both ends: a non-TTY dev keeps today's behavior (the
  // child's own stderr already names `dbzz generate`). At most one readline is
  // open at a time; `promptCancel` is how the supervisor retracts it.
  let promptCancel: AbortController | null = null;
  const devFlow = makeDevFlowHandler(
    {
      plan: () => planChild(appDir),
      generate: (request) => generateChild(appDir, request),
      pluginPlan: () => pluginPlanChild(appDir),
      applyPlugin: (consent) => applyPluginChild(appDir, consent),
      prompt: async <T,>(form: (ask: Ask) => Promise<T>): Promise<PromptOutcome<T>> => {
        promptCancel = new AbortController();
        try {
          return { answer: await withReadline(form, promptCancel.signal) };
        } catch (error) {
          if (error instanceof PromptCanceledError) return { canceled: true };
          if (error instanceof PromptInterruptedError) return { interrupted: true };
          throw error;
        } finally {
          promptCancel = null;
        }
      },
      deleteFiles: deletePendingFiles,
      startServer: (applyPending) => startChild(applyPending),
      report: (written, form) => reportGenerated(written, form.renames, form.dropsAcknowledged),
      log: console.log,
      error: console.error,
    },
    isInteractive,
    () => promptCancel?.abort(),
  );

  console.log(`[dbzz] dev watching ${config.appDir}`);
  if (!(await codegenChild(appDir))) {
    console.error("[dbzz] initial codegen failed — fix the errors above; watching for changes");
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
        console.log(`[dbzz] reloaded in ${Math.round(performance.now() - t0)}ms`);
      } else {
        console.error("[dbzz] codegen failed — server not restarted; fix and save again");
      }
    } while (dirty);
    running = false;
  };
  const trigger = () => {
    // A save may change the very state an open question was asked about —
    // retract it; the next refusal asks again over the fresh ledger.
    devFlow.retractPrompt();
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
  // Own the manifest separately so an immediate first edit cannot be lost.
  const appWatcher = existsSync(config.appPath) ? watch(config.appPath, trigger) : null;

  const shutdown = () => {
    treeWatcher.close();
    appWatcher?.close();
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
      requireArgumentCount(args, 1, 2);
      if (args[1] !== undefined && args[1] !== "--hold-pending") usage();
      await startApp(loadConfig(resolve(args[0]!)), args[1] === "--hold-pending" ? { holdPendingMigrations: true } : {});
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
        `[dbzz] codegen ${written.length > 0 ? `wrote ${written.join(", ")}` : "up to date"} (${Math.round(performance.now() - t0)}ms)`,
      );
      break;
    }
    case "generate": {
      requireArgumentCount(args, 0, 2);
      await generate(args[0], resolve(args[1] ?? "."));
      break;
    }
    case "plugin": {
      requireArgumentCount(args, 2, 3);
      const action = args[0];
      if (action !== "reset" && action !== "drop") usage();
      const config = loadConfig(resolve(args[2] ?? "."));
      const requirement = await executePluginStorageCommand(config, action, args[1]!);
      console.log(`[dbzz] ${action === "reset" ? "reset" : "dropped"} Plugin storage mount "${requirement.mount}"`);
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
      try {
        const written = await writeMigration(config, parseGenerateRequest(args[1]!));
        console.log(JSON.stringify({ written }));
      } catch (error) {
        // Stale consent is an answer, not a failure: the supervisor re-plans
        // and asks again over the fresh ledger.
        if (!(error instanceof StaleConsentError)) throw error;
        console.log(JSON.stringify({ stale: true }));
      }
      break;
    }
    case "__plugin_plan": {
      requireArgumentCount(args, 1, 1);
      console.log(JSON.stringify(await planPluginStorage(loadConfig(resolve(args[0]!)))));
      break;
    }
    case "__plugin_apply": {
      requireArgumentCount(args, 2, 2);
      console.log(JSON.stringify(await applyPluginStorageConsent(
        loadConfig(resolve(args[0]!)),
        parsePluginConsent(args[1]!),
      )));
      break;
    }
    case "reset": {
      requireArgumentCount(args, 0, 1);
      const config = loadConfig(resolve(args[0] ?? "."));
      const database = join(config.dbDir, "data.db");
      const result = resetDatabase(database);
      if (result.removed.length > 0) {
        const noun = result.removed.length === 1 ? "artifact" : "artifacts";
        console.log(`[dbzz] removed ${result.removed.length} database ${noun} for ${database}; coordination retained`);
      } else {
        console.log(`[dbzz] nothing to remove for ${database}; coordination retained`);
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
  console.error(`[dbzz] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
