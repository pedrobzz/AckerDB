/**
 * The dev supervisor's crash flow: what happens between a refused reload and a
 * migration (or a decline). Pure of any terminal or process — the supervisor
 * injects effects, tests script them.
 *
 * The consent question is about a state. When the state changes under an open
 * prompt — the developer saves a file instead of answering — the prompt is
 * RETRACTED: the supervisor cancels it, the flow exits silently, and the next
 * refusal asks again over the fresh ledger. Retraction is not decline (Ctrl+C
 * is): it remembers nothing, so the same ledger re-asks. A crash that arrives
 * while a flow is still unwinding is queued, never swallowed — the flow re-runs
 * against a fresh plan the moment the current one exits.
 */
import { deriveSlug, type PlanWire } from "./plan.ts";
import { renderLedger, runApplyForm, runConsentForm, runDivergenceForm, type Consent } from "./consent.ts";
import { runRenameForm, type Ask, type FormResult } from "./form.ts";
import type { GenerateRequest } from "./write.ts";
import {
  pluginStorageCommand,
  renderPluginStorageRequirement,
  runPluginStorageConsentForm,
  type PluginApplyResult,
  type PluginPlanWire,
  type PluginStorageConsent,
} from "../plugin-storage.ts";

/** What a `__generate` child reports: the artifacts it wrote, or a consent gone stale. */
export type GenerateResult = { written: string[] } | { stale: true };

/** How one interactive question ended: an answer, a Ctrl+C, or a supervisor retraction. */
export type PromptOutcome<T> = { answer: T } | { interrupted: true } | { canceled: true };

export interface DevFlowEffects {
  plan(): Promise<PlanWire>;
  generate(request: GenerateRequest): Promise<GenerateResult>;
  /** Fresh-process projection of the next deterministic Plugin requirement. */
  pluginPlan(): Promise<PluginPlanWire>;
  /** Fresh-process, fingerprint-bound reset/drop of exactly one Plugin mount. */
  applyPlugin(consent: PluginStorageConsent): Promise<PluginApplyResult>;
  /** Run one form on the terminal. At most one prompt is ever open. */
  prompt<T>(form: (ask: Ask) => Promise<T>): Promise<PromptOutcome<T>>;
  deleteFiles(files: string[]): void;
  /**
   * Restart the serve child — with `applyPending` the one start that may run
   * pending migrations (the developer just said yes); without it the child
   * holds pending again.
   */
  startServer(applyPending: boolean): Promise<void>;
  report(written: string[], form: FormResult): void;
  log(line: string): void;
  error(line: string): void;
}

const DECLINED_BANNER =
  "[dbzz] migration declined — server stays down; edit the schema (a clean ledger starts it, a changed one asks again), run `dbzz generate`, or wipe local data with `dbzz reset`";
const APPLY_WAITING_BANNER =
  "[dbzz] not applying — server stays down; fill the TODOs and answer yes (any edit to the migration asks again), delete its files to withdraw it, or wipe local data with `dbzz reset`";

/** What the developer stands declined on: a ledger they said "not yet" to, and/or a pending chain they are not ready to apply. */
interface DeclineMemory {
  ledger: string | null;
  apply: string | null;
  plugin: string | null;
}

function pluginRequirementIdentity(wire: Extract<PluginPlanWire, { clean: false }>): string {
  const requirement = wire.requirement;
  return [
    requirement.kind,
    requirement.mount,
    requirement.currentFingerprint,
    requirement.targetFingerprint,
  ].join("\u0000");
}

function pluginDeclinedBanner(wire: Extract<PluginPlanWire, { clean: false }>): string {
  const requirement = wire.requirement;
  return `[dbzz] Plugin storage ${requirement.kind} declined — server stays down; edit the Plugin manifest, run \`${pluginStorageCommand(requirement)}\`, or wipe all local data with \`dbzz reset\``;
}

/**
 * One pass over a crashed state: plan, present, and resolve, mutating the
 * decline memory as questions are answered. Retraction changes nothing.
 */
async function runFlow(fx: DevFlowEffects, declined: DeclineMemory): Promise<void> {
  let deletedScaffold = false;
  for (;;) {
    const wire = await fx.plan();
    if ("error" in wire) return; // fresh db, or a diverged chain the child already reported
    if (wire.clean) {
      const pluginWire = await fx.pluginPlan();
      if (!pluginWire.clean) {
        const identity = pluginRequirementIdentity(pluginWire);
        if (identity === declined.plugin) {
          fx.error(pluginDeclinedBanner(pluginWire));
          return;
        }
        fx.log(renderPluginStorageRequirement(pluginWire.requirement));
        const consent = await fx.prompt((ask) =>
          runPluginStorageConsentForm(pluginWire.requirement, ask)
        );
        if ("canceled" in consent) return;
        if ("interrupted" in consent || !consent.answer) {
          declined.plugin = identity;
          fx.error(pluginDeclinedBanner(pluginWire));
          return;
        }
        const result = await fx.applyPlugin({
          kind: pluginWire.requirement.kind,
          mount: pluginWire.requirement.mount,
          currentFingerprint: pluginWire.requirement.currentFingerprint,
          targetFingerprint: pluginWire.requirement.targetFingerprint,
        });
        if ("stale" in result) {
          fx.error("[dbzz] the Plugin manifest or storage changed while the question was open — re-planning");
          continue;
        }
        declined.plugin = null;
        await fx.startServer(false);
        return;
      }
      // Deleting a stale scaffold can leave nothing to answer — the crash is
      // resolved, so the server comes straight back.
      if (deletedScaffold) await fx.startServer(false);
      return;
    }
    if (wire.pendingCount > 0) {
      if (wire.stale) {
        const res = await fx.prompt((ask) => runDivergenceForm(wire.pendingFiles, ask));
        if ("canceled" in res) return;
        if ("answer" in res && res.answer === "delete") {
          fx.deleteFiles(wire.pendingFiles);
          deletedScaffold = true;
          continue;
        }
        // Keeping (or bailing out of the offer) falls through to the apply
        // question — a kept migration's next step is deciding when it runs.
      }
      if (wire.pendingIdentity === declined.apply) {
        fx.error(APPLY_WAITING_BANNER);
        return;
      }
      const res = await fx.prompt((ask) => runApplyForm(wire.pendingLabels, ask));
      if ("canceled" in res) return;
      if ("interrupted" in res || res.answer === "wait") {
        declined.apply = wire.pendingIdentity;
        fx.error(APPLY_WAITING_BANNER);
        return;
      }
      // The one start allowed to apply. If the migration fails (an unfilled
      // hole against real rows), the crash lands back here with a new identity
      // once the file is edited.
      await fx.startServer(true);
      return;
    }
    if (wire.fingerprint === declined.ledger) {
      fx.error(DECLINED_BANNER);
      return;
    }
    fx.log(renderLedger(wire));
    const consentRes = await fx.prompt((ask) => runConsentForm(deriveSlug(wire.refusals), ask));
    if ("canceled" in consentRes) return;
    const consent: Consent = "interrupted" in consentRes ? { generate: false } : consentRes.answer;
    if (!consent.generate) {
      declined.ledger = wire.fingerprint;
      fx.error(DECLINED_BANNER);
      return;
    }
    const formRes = await fx.prompt((ask) => runRenameForm(wire.candidates, ask));
    if ("canceled" in formRes) return;
    if ("interrupted" in formRes) {
      declined.ledger = wire.fingerprint;
      fx.error(DECLINED_BANNER);
      return;
    }
    const result = await fx.generate({
      name: consent.name,
      renames: formRes.answer.renames,
      consent: wire.fingerprint,
    });
    if ("stale" in result) {
      fx.error("[dbzz] more changes happened while the question was open — the fresh ledger:");
      continue;
    }
    declined.ledger = null; // generated: nothing stands declined anymore
    fx.report(result.written, formRes.answer);
    return;
  }
}

/**
 * The supervisor-facing handler. `onCrash` is called for every serve-child
 * crash; a crash during a running flow retracts the open prompt and queues a
 * re-run, so no refusal ever goes unpresented. `retractPrompt` is also called
 * directly on every file-change trigger — a save means the state the open
 * question was asked about may be gone.
 */
export function makeDevFlowHandler(
  fx: DevFlowEffects,
  gate: () => boolean,
  retractPrompt: () => void,
): { onCrash: () => Promise<void>; retractPrompt: () => void } {
  let running = false;
  let crashPending = false;
  const declined: DeclineMemory = { ledger: null, apply: null, plugin: null };

  const onCrash = async (): Promise<void> => {
    if (!gate()) return;
    if (running) {
      crashPending = true;
      retractPrompt();
      return;
    }
    running = true;
    try {
      do {
        crashPending = false;
        try {
          await runFlow(fx, declined);
        } catch (error) {
          fx.error(`[dbzz] ${error instanceof Error ? error.message : String(error)}`);
        }
      } while (crashPending);
    } finally {
      running = false;
    }
  };

  return { onCrash, retractPrompt };
}
