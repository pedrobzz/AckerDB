import { describe, expect, test } from "bun:test";
import {
  makeDevFlowHandler,
  type DevFlowEffects,
  type GenerateResult,
  type PromptOutcome,
} from "../../src/migrations/dev-flow.ts";
import type { PlanWire, RenameCandidates } from "../../src/migrations/plan.ts";
import type {
  PluginApplyResult,
  PluginPlanWire,
} from "../../src/plugins/storage.ts";

const EMPTY: RenameCandidates = { tables: { dropped: [], added: [] }, columns: {}, variants: {} };

const changesWire = (fingerprint: string): PlanWire => ({
  clean: false,
  refusals: [{ table: "t", column: "c", reason: "required-column-added", question: "q" }],
  candidates: EMPTY,
  nextNumber: 1,
  pendingCount: 0,
  safe: [],
  fingerprint,
  stale: false,
  pendingFiles: [],
  pendingLabels: [],
  pendingIdentity: "",
});
const CLEAN: PlanWire = { clean: true };
const pendingWire = (identity: string, stale: boolean): PlanWire => ({
  clean: false,
  refusals: [],
  candidates: EMPTY,
  nextNumber: 2,
  pendingCount: 1,
  safe: [],
  fingerprint: "",
  stale,
  pendingFiles: ["0001_x.ts", "0001_x.types.ts", "0001_x.json"],
  pendingLabels: ["0001_x"],
  pendingIdentity: identity,
});
const stalePendingWire = pendingWire("id-1", true);
const CLEAN_PLUGIN: PluginPlanWire = { clean: true };
const pluginWire = (
  mount: string,
  currentFingerprint: string,
  targetFingerprint: string,
  kind: "reset" | "drop" = "reset",
): PluginPlanWire => ({
  clean: false,
  requirement: kind === "reset"
    ? {
        kind,
        reason: "unsafe-schema",
        mount,
        currentDefinitionId: "test/cache",
        targetDefinitionId: "test/cache",
        currentFingerprint,
        targetFingerprint,
        plan: {
          applied: [],
          refusals: [{ table: "entries", reason: "table-dropped", question: "existing rows would be lost" }],
        },
      }
    : {
        kind,
        reason: "stale-mount",
        mount,
        currentDefinitionId: "test/cache",
        targetDefinitionId: null,
        currentFingerprint,
        targetFingerprint,
        plan: {
          applied: [],
          refusals: [],
        },
      },
});

const CONSENT_YES: PromptOutcome<unknown> = { answer: { generate: true, name: "m" } };
const CONSENT_NO: PromptOutcome<unknown> = { answer: { generate: false } };
const RENAMES_NONE: PromptOutcome<unknown> = { answer: { renames: {}, dropsAcknowledged: [] } };

/** A prompt entry: an immediate outcome, or "open" — held until retracted. */
type PromptScript = PromptOutcome<unknown> | "open";

function makeHarness(
  plans: PlanWire[],
  prompts: PromptScript[],
  generates: GenerateResult[] = [],
  pluginPlans: PluginPlanWire[] = [CLEAN_PLUGIN],
  pluginApplies: PluginApplyResult[] = [],
) {
  const calls: string[] = [];
  let openPrompt: ((outcome: PromptOutcome<unknown>) => void) | null = null;
  const fx: DevFlowEffects = {
    plan: async () => {
      calls.push("plan");
      const next = plans.shift();
      if (next === undefined) throw new Error("no plan scripted");
      return next;
    },
    generate: async (request) => {
      calls.push(`generate:${request.consent}`);
      const next = generates.shift();
      if (next === undefined) throw new Error("no generate scripted");
      return next;
    },
    pluginPlan: async () => {
      calls.push("pluginPlan");
      const next = pluginPlans.shift();
      if (next === undefined) throw new Error("no Plugin plan scripted");
      return next;
    },
    applyPlugin: async (consent) => {
      calls.push(`pluginApply:${consent.mount}:${consent.currentFingerprint}:${consent.targetFingerprint}`);
      const next = pluginApplies.shift();
      if (next === undefined) throw new Error("no Plugin apply scripted");
      return next;
    },
    prompt: async <T,>(): Promise<PromptOutcome<T>> => {
      calls.push("prompt");
      const next = prompts.shift();
      if (next === undefined) throw new Error("no prompt scripted");
      if (next !== "open") return next as PromptOutcome<T>;
      return new Promise<PromptOutcome<T>>((resolve) => {
        openPrompt = resolve as (outcome: PromptOutcome<unknown>) => void;
      });
    },
    deleteFiles: (files) => calls.push(`delete:${files.length}`),
    startServer: async (applyPending) => {
      calls.push(applyPending ? "start:apply" : "start");
    },
    report: () => calls.push("report"),
    log: (line) => calls.push(line.includes("Plugin storage mount") ? "pluginLedger" : "ledger"),
    error: (line) => calls.push(
      line.includes("Plugin storage") && line.includes("declined")
        ? "pluginBanner"
        : line.includes("declined")
          ? "banner"
          : "error",
    ),
  };
  const retract = () => {
    calls.push("retract");
    openPrompt?.({ canceled: true });
    openPrompt = null;
  };
  const handler = makeDevFlowHandler(fx, () => true, retract);
  const settled = async () => {
    // Let the queued microtasks (promise chains inside the flow) run out.
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  return { calls, handler, settled };
}

describe("dev flow: retraction and supersede", () => {
  test("a crash during an open prompt retracts it and re-presents the fresh state (the wedge bug)", async () => {
    const { calls, handler, settled } = makeHarness(
      [changesWire("A"), changesWire("B")],
      ["open", CONSENT_NO],
    );
    const first = handler.onCrash();
    await settled();
    expect(calls).toEqual(["plan", "ledger", "prompt"]); // question open, awaiting the developer

    // The schema moved and the new serve child crashed while the question hung.
    await handler.onCrash();
    await first;
    // Retracted, re-planned, re-asked over the fresh ledger — never wedged.
    expect(calls).toEqual(["plan", "ledger", "prompt", "retract", "plan", "ledger", "prompt", "banner"]);
  });

  test("retraction remembers nothing: the same ledger asks again", async () => {
    const { calls, handler, settled } = makeHarness(
      [changesWire("A"), changesWire("A")],
      ["open", CONSENT_NO],
    );
    const first = handler.onCrash();
    await settled();
    handler.retractPrompt(); // a save that rescued nothing — just retract, no queued crash
    await first;
    expect(calls).toEqual(["plan", "ledger", "prompt", "retract"]);

    await handler.onCrash(); // identical fingerprint crashes again
    expect(calls.slice(4)).toEqual(["plan", "ledger", "prompt", "banner"]); // asked, not banner-only
  });

  test("decline remembers: an identical ledger re-prints the banner, a changed one asks again", async () => {
    const { calls, handler } = makeHarness(
      [changesWire("A"), changesWire("A"), changesWire("B")],
      [CONSENT_NO, CONSENT_NO],
    );
    await handler.onCrash();
    expect(calls).toEqual(["plan", "ledger", "prompt", "banner"]);
    await handler.onCrash();
    expect(calls.slice(4)).toEqual(["plan", "banner"]); // no prompt: already answered "not yet"
    await handler.onCrash();
    expect(calls.slice(6)).toEqual(["plan", "ledger", "prompt", "banner"]); // new ledger, new question
  });

  test("Ctrl+C declines: the fingerprint is remembered like an explicit no", async () => {
    const { calls, handler } = makeHarness(
      [changesWire("A"), changesWire("A")],
      [{ interrupted: true }],
    );
    await handler.onCrash();
    expect(calls).toEqual(["plan", "ledger", "prompt", "banner"]);
    await handler.onCrash();
    expect(calls.slice(4)).toEqual(["plan", "banner"]);
  });

  test("stale consent re-plans and re-asks; the fresh yes generates and clears the decline memory", async () => {
    const { calls, handler } = makeHarness(
      [changesWire("A"), changesWire("B"), changesWire("C")],
      [CONSENT_YES, RENAMES_NONE, CONSENT_YES, RENAMES_NONE, CONSENT_NO],
      [{ stale: true }, { written: ["0001_m.ts"] }],
    );
    await handler.onCrash();
    expect(calls).toEqual([
      "plan", "ledger", "prompt", "prompt", "generate:A", "error", // stale: the schema moved under the yes
      "plan", "ledger", "prompt", "prompt", "generate:B", "report",
    ]);
    await handler.onCrash(); // generation cleared any decline memory: a new ledger asks
    expect(calls.slice(12)).toEqual(["plan", "ledger", "prompt", "banner"]);
  });

  test("deleting a stale scaffold that leaves a clean plan restarts the server", async () => {
    const { calls, handler } = makeHarness(
      [stalePendingWire, CLEAN],
      [{ answer: "delete" }],
    );
    await handler.onCrash();
    expect(calls).toEqual(["plan", "prompt", "delete:3", "plan", "pluginPlan", "start"]);
  });

  test("keeping a stale scaffold falls through to the apply question; waiting deletes nothing", async () => {
    const keep = makeHarness([stalePendingWire], [{ answer: "keep" }, { answer: "wait" }]);
    await keep.handler.onCrash();
    expect(keep.calls).toEqual(["plan", "prompt", "prompt", "error"]);

    const interrupted = makeHarness([stalePendingWire], [{ interrupted: true }, { answer: "wait" }]);
    await interrupted.handler.onCrash();
    expect(interrupted.calls).toEqual(["plan", "prompt", "prompt", "error"]);
  });

  test("pending migrations apply only on an explicit yes", async () => {
    const { calls, handler } = makeHarness([pendingWire("id-1", false)], [{ answer: "apply" }]);
    await handler.onCrash();
    expect(calls).toEqual(["plan", "prompt", "start:apply"]);
  });

  test("a declined apply is remembered against the chain identity; an edited migration asks again", async () => {
    const { calls, handler } = makeHarness(
      [pendingWire("id-1", false), pendingWire("id-1", false), pendingWire("id-2", false)],
      [{ answer: "wait" }, { answer: "apply" }],
    );
    await handler.onCrash();
    expect(calls).toEqual(["plan", "prompt", "error"]); // waiting: banner, server down
    await handler.onCrash();
    expect(calls.slice(3)).toEqual(["plan", "error"]); // same identity: banner only, no re-ask
    await handler.onCrash(); // the file was edited (a TODO filled) — identity moved
    expect(calls.slice(5)).toEqual(["plan", "prompt", "start:apply"]);
  });

  test("interrupting the apply question waits, and is remembered like a no", async () => {
    const { calls, handler } = makeHarness(
      [pendingWire("id-1", false), pendingWire("id-1", false)],
      [{ interrupted: true }],
    );
    await handler.onCrash();
    expect(calls).toEqual(["plan", "prompt", "error"]);
    await handler.onCrash();
    expect(calls.slice(3)).toEqual(["plan", "error"]);
  });

  test("a canceled apply question is retraction: same identity asks again", async () => {
    const { calls, handler } = makeHarness(
      [pendingWire("id-1", false), pendingWire("id-1", false)],
      [{ canceled: true }, { answer: "apply" }],
    );
    await handler.onCrash();
    expect(calls).toEqual(["plan", "prompt"]); // retracted: no banner, nothing remembered
    await handler.onCrash();
    expect(calls.slice(2)).toEqual(["plan", "prompt", "start:apply"]);
  });

  test("a canceled rename form abandons generation without declining", async () => {
    const { calls, handler } = makeHarness(
      [changesWire("A"), changesWire("A")],
      [CONSENT_YES, { canceled: true }],
    );
    await handler.onCrash();
    expect(calls).toEqual(["plan", "ledger", "prompt", "prompt"]); // no banner, no generate
    // Same ledger crashes again: asks again (nothing was declined).
    const again = makeHarness([changesWire("A")], [CONSENT_NO]);
    await again.handler.onCrash();
    expect(again.calls).toEqual(["plan", "ledger", "prompt", "banner"]);
  });

  test("Plugin consent is fingerprint-bound, stale consent re-plans, and one mount is reset at a time", async () => {
    const { calls, handler } = makeHarness(
      [CLEAN, CLEAN],
      [{ answer: true }, { answer: true }],
      [],
      [pluginWire("cache", "current-A", "target-A"), pluginWire("sessions", "current-B", "target-B")],
      [{ stale: true }, { applied: true }],
    );
    await handler.onCrash();
    expect(calls).toEqual([
      "plan",
      "pluginPlan",
      "pluginLedger",
      "prompt",
      "pluginApply:cache:current-A:target-A",
      "error",
      "plan",
      "pluginPlan",
      "pluginLedger",
      "prompt",
      "pluginApply:sessions:current-B:target-B",
      "start",
    ]);
  });

  test("declining or interrupting Plugin consent never invokes destructive apply and remembers only the exact requirement", async () => {
    const { calls, handler } = makeHarness(
      [CLEAN, CLEAN, CLEAN],
      [{ answer: false }, { interrupted: true }],
      [],
      [
        pluginWire("cache", "current-A", "target-A"),
        pluginWire("cache", "current-A", "target-A"),
        pluginWire("cache", "current-A", "target-B"),
      ],
    );
    await handler.onCrash();
    expect(calls).toEqual(["plan", "pluginPlan", "pluginLedger", "prompt", "pluginBanner"]);
    await handler.onCrash();
    expect(calls.slice(5)).toEqual(["plan", "pluginPlan", "pluginBanner"]);
    await handler.onCrash();
    expect(calls.slice(8)).toEqual(["plan", "pluginPlan", "pluginLedger", "prompt", "pluginBanner"]);
    expect(calls.some((call) => call.startsWith("pluginApply:"))).toBe(false);
  });

  test("canceling Plugin consent is a file-change retraction and does not authorize a reset", async () => {
    const { calls, handler } = makeHarness(
      [CLEAN, CLEAN],
      [{ canceled: true }, { answer: false }],
      [],
      [pluginWire("cache", "current", "target"), pluginWire("cache", "current", "target")],
    );
    await handler.onCrash();
    expect(calls).toEqual(["plan", "pluginPlan", "pluginLedger", "prompt"]);
    await handler.onCrash();
    expect(calls.slice(4)).toEqual(["plan", "pluginPlan", "pluginLedger", "prompt", "pluginBanner"]);
    expect(calls.some((call) => call.startsWith("pluginApply:"))).toBe(false);
  });

  test("the non-TTY gate presents nothing", async () => {
    const calls: string[] = [];
    const fx = {
      plan: async () => {
        calls.push("plan");
        return CLEAN;
      },
    } as unknown as DevFlowEffects;
    const handler = makeDevFlowHandler(fx, () => false, () => {});
    await handler.onCrash();
    expect(calls).toEqual([]);
  });
});
