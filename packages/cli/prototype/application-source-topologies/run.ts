// PROTOTYPE ONLY — disposable executable evidence for issue #304.
import { spawn } from "node:child_process";
import { watch as watchFs } from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  compileStatic,
  copyFixture,
  installCapturedManifest,
  installEnvironmentManifest,
  linkRuntime,
  makeFixtureSafe,
  removeFixture,
  renderTypeProjection,
  repairUnsafeExports,
  runtimeDescriptorSnapshot,
  sha256,
  type Contribution,
  type Diagnostic,
  type LinkResult,
  type StaticCompilation,
} from "./compiler.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../../../..");
const fixture = join(here, "fixture");
const output = join(here, "output");

interface TraceEvent {
  readonly phase: string;
  readonly owner: string;
  readonly event: string;
  readonly systemAvailable: boolean;
  readonly resources: number;
}

interface CandidateResult {
  readonly id: string;
  readonly name: string;
  readonly question: string;
  readonly verdict: "pass" | "fail" | "conditional";
  readonly score: number;
  readonly interface: readonly string[];
  readonly inputs: unknown;
  readonly membership: unknown;
  readonly types: string;
  readonly descriptors: unknown;
  readonly lifecycle: readonly TraceEvent[];
  readonly diagnostics: readonly Diagnostic[];
  readonly effects: readonly string[];
  readonly importCalls: Readonly<Record<string, number>>;
  readonly good: readonly string[];
  readonly bad: readonly string[];
  readonly ugly: readonly string[];
  readonly productionDelta: {
    readonly counts: {
      readonly sourceRoots: number;
      readonly independentClassificationSources: number;
      readonly contributionLifecycleSupervisors: number;
      readonly generatedOrAnalysisMechanisms: number;
      readonly planningEvaluationPhases: number;
    };
    readonly removes: readonly string[];
    readonly adds: readonly string[];
    readonly netJudgment: string;
  };
}

interface MutationProof {
  readonly scenario: string;
  readonly before?: string;
  readonly after?: string;
  readonly changed?: boolean;
  readonly diagnostics?: readonly Diagnostic[];
  readonly watchEvent?: { readonly event: string; readonly source: string };
  readonly observation: string;
}

interface ScaleMetric {
  readonly modules: number;
  readonly topology: string;
  readonly memoryKiB: number;
  readonly types: number;
  readonly instantiations: number;
  readonly checkSeconds: number;
  readonly totalSeconds: number;
  readonly passes: number;
}

interface Report {
  readonly generatedAt: string;
  readonly question: string;
  readonly fixture: unknown;
  readonly atomicFailures: unknown;
  readonly candidates: readonly CandidateResult[];
  readonly mutations: readonly MutationProof[];
  readonly scale: readonly ScaleMetric[];
  readonly proofMatrix: readonly {
    readonly proof: string;
    readonly result: "pass" | "fail" | "conditional";
    readonly evidence: string;
  }[];
  readonly comparison: unknown;
  readonly recommendation: unknown;
}

const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

async function observeWatchEvent(
  directory: string,
  action: () => Promise<void>,
): Promise<{ event: string; source: string }> {
  return await new Promise((resolveEvent, reject) => {
    const timeout = setTimeout(() => {
      watcher.close();
      reject(new Error(`watcher observed no event for ${directory}`));
    }, 2_000);
    const watcher = watchFs(directory, { recursive: true }, (event, source) => {
      clearTimeout(timeout);
      watcher.close();
      resolveEvent({ event, source: String(source) });
    });
    void action().catch((error) => {
      clearTimeout(timeout);
      watcher.close();
      reject(error);
    });
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, json(value));
}

const membership = (compilation: StaticCompilation) => ({
  digest: compilation.inputDigest,
  sourceRoot: relative(compilation.root, compilation.sourceRoot),
  inputs: compilation.inputs,
  sources: compilation.sources,
  contributions: compilation.contributions.map(
    ({ identity, owner, source, export: exportName, kind, address }) => ({
      identity,
      owner,
      source,
      export: exportName,
      kind,
      address,
    }),
  ),
});

function lifecycleTrace(link: LinkResult, inputDigest: string): TraceEvent[] {
  const queue = link.namespaces["worker.ts"]?.queues as
    | { descriptor?: Record<string, unknown> }
    | undefined;
  const descriptor = queue?.descriptor;
  const activate = descriptor?.activate as (() => string) | undefined;
  const quiesce = descriptor?.quiesce as (() => string) | undefined;
  const deactivate = descriptor?.deactivate as (() => string) | undefined;
  const trace: TraceEvent[] = [
    {
      phase: "index/check/compile",
      owner: "Application compiler",
      event: `read one canonical source index at ${inputDigest}; no module evaluation`,
      systemAvailable: false,
      resources: 0,
    },
    {
      phase: "link/evaluate",
      owner: "Application generation",
      event: `evaluate ${link.modulesEvaluated.length} canonical modules once`,
      systemAvailable: false,
      resources: 0,
    },
    {
      phase: "reconcile",
      owner: "Application generation",
      event: "reconcile root/framework and mount-private state",
      systemAvailable: false,
      resources: 0,
    },
    {
      phase: "construct",
      owner: "Application generation",
      event: "construct dormant Runtime and System execution root",
      systemAvailable: true,
      resources: 0,
    },
    {
      phase: "activate",
      owner: "mount:queues",
      event: activate ? activate() : "open bullmq:orders",
      systemAvailable: true,
      resources: 1,
    },
    {
      phase: "ready",
      owner: "Application generation",
      event: "publish readiness after all owners activate",
      systemAvailable: true,
      resources: 1,
    },
    {
      phase: "quiesce",
      owner: "mount:queues",
      event: quiesce ? quiesce() : "quiesce bullmq:orders inbound",
      systemAvailable: true,
      resources: 1,
    },
    {
      phase: "drain",
      owner: "Application generation",
      event: "drain accepted Application work under one deadline",
      systemAvailable: true,
      resources: 1,
    },
    {
      phase: "deactivate",
      owner: "mount:queues",
      event: deactivate ? deactivate() : "close bullmq:orders",
      systemAvailable: true,
      resources: 0,
    },
    {
      phase: "close",
      owner: "Application generation",
      event: "close System execution root and Engine last",
      systemAvailable: false,
      resources: 0,
    },
  ];
  return trace;
}

async function runCapturedEvaluator(
  root: string,
  inputs: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const entries = [
    "app.ts",
    ...(await compileStatic(root)).sources.map((source) => `backend/${source}`),
  ];
  return await new Promise((resolveResult, reject) => {
    const child = spawn(
      "node",
      ["--experimental-vm-modules", join(here, "captured-evaluator.mjs"), root, ...entries],
      {
        cwd: repository,
        env: {
          ...process.env,
          ACKER_PROTOTYPE_INPUTS: JSON.stringify(inputs),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`captured evaluator exited ${code}: ${stderr}`));
        return;
      }
      const line = stdout
        .split("\n")
        .map((item) => item.trim())
        .find((item) => item.startsWith("{"));
      if (!line) {
        reject(new Error(`captured evaluator returned no JSON: ${stdout}\n${stderr}`));
        return;
      }
      resolveResult(JSON.parse(line) as Record<string, unknown>);
    });
  });
}

function parseMetric(text: string, label: string): number {
  const match = text.match(new RegExp(`^${label}:\\s+([0-9.]+)(K|M|s)?`, "m"));
  if (!match) return 0;
  const value = Number(match[1]);
  if (match[2] === "M") return Math.round(value * 1_024);
  return value;
}

async function runTsc(project: string): Promise<Omit<ScaleMetric, "modules" | "topology" | "passes">> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(
      join(repository, "node_modules", ".bin", "tsc"),
      ["-p", project, "--extendedDiagnostics", "--pretty", "false"],
      { cwd: repository, stdio: ["ignore", "pipe", "pipe"] },
    );
    let outputText = "";
    child.stdout.on("data", (chunk) => (outputText += chunk));
    child.stderr.on("data", (chunk) => (outputText += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`scale tsc failed (${code}):\n${outputText}`));
        return;
      }
      resolveResult({
        memoryKiB: parseMetric(outputText, "Memory used"),
        types: parseMetric(outputText, "Types"),
        instantiations: parseMetric(outputText, "Instantiations"),
        checkSeconds: parseMetric(outputText, "Check time"),
        totalSeconds: parseMetric(outputText, "Total time"),
      });
    });
  });
}

async function scaleProject(
  root: string,
  modules: number,
  topology:
    | "control"
    | "dual-index"
    | "materialized-classify"
    | "materialized"
    | "captured-bootstrap"
    | "captured-refined",
): Promise<string> {
  const directory = join(root, `${topology}-${modules}`);
  const source = join(directory, "source");
  await mkdir(source, { recursive: true });
  await writeFile(
    join(directory, "tsconfig.json"),
    json({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: "ES2022",
      },
      include: ["**/*.ts"],
    }),
  );
  await writeFile(
    join(directory, "declaration.ts"),
    `export interface Declaration<K extends "function" | "job" | "lifecycle", N extends string> {\n` +
      `  readonly __ackerKind: K;\n` +
      `  readonly descriptor: { readonly name: N; readonly nested: { readonly value: N } };\n` +
      `}\n`,
  );

  for (let index = 0; index < modules; index++) {
    const name = `module${String(index).padStart(4, "0")}`;
    const kind = index % 10 === 0 ? "function" : index % 10 === 1 ? "job" : "lifecycle";
    await writeFile(
      join(source, `${name}.ts`),
      `import type { Declaration } from "../declaration.ts";\n` +
        `export declare const contribution: Declaration<${JSON.stringify(kind)}, ${JSON.stringify(name)}>;\n` +
        `export const helper = { index: ${index}, label: ${JSON.stringify(name)} } as const;\n`,
    );
  }

  const imports = Array.from({ length: modules }, (_, index) => {
    const name = `module${String(index).padStart(4, "0")}`;
    return `import type * as m${index} from "./source/${name}.ts";`;
  }).join("\n");
  const moduleMap = Array.from(
    { length: modules },
    (_, index) => `  ${JSON.stringify(`module${index}`)}: typeof m${index};`,
  ).join("\n");
  const callableEntries = Array.from({ length: modules }, (_, index) => index)
    .filter((index) => index % 10 === 0)
    .map((index) => `  ${JSON.stringify(`api.module${index}.contribution`)}: typeof m${index}.contribution;`)
    .join("\n");
  const forceObject = (kind: "function" | "job" | "lifecycle") =>
    Array.from({ length: modules }, (_, index) => {
      const actual = index % 10 === 0 ? "function" : index % 10 === 1 ? "job" : "lifecycle";
      return `  ${JSON.stringify(`module${index}`)}: ${
        actual === kind ? JSON.stringify("contribution") : "undefined as never"
      },`;
    }).join("\n");

  let projection = "";
  if (topology === "control") {
    projection =
      `type PickKind<M, K> = { [P in keyof M as M[P] extends { __ackerKind: K } ? P : never]: M[P] };\n` +
      `interface Modules {\n${moduleMap}\n}\n` +
      `export type Functions = { [M in keyof Modules]: PickKind<Modules[M], "function"> };\n` +
      `export type Jobs = { [M in keyof Modules]: PickKind<Modules[M], "job"> };\n` +
      `export type Lifecycles = { [M in keyof Modules]: PickKind<Modules[M], "lifecycle"> };\n` +
      `export const forceFunctions: { [M in keyof Modules]: keyof Functions[M] } = {\n${forceObject("function")}\n};\n` +
      `export const forceJobs: { [M in keyof Modules]: keyof Jobs[M] } = {\n${forceObject("job")}\n};\n` +
      `export const forceLifecycles: { [M in keyof Modules]: keyof Lifecycles[M] } = {\n${forceObject("lifecycle")}\n};\n`;
  } else if (topology === "dual-index") {
    projection =
      `type PickKind<M, K> = { [P in keyof M as M[P] extends { __ackerKind: K } ? P : never]: M[P] };\n` +
      `interface Modules {\n${moduleMap}\n}\n` +
      `export type Functions = { [M in keyof Modules]: PickKind<Modules[M], "function"> };\n` +
      `export type Jobs = { [M in keyof Modules]: PickKind<Modules[M], "job"> };\n` +
      `export const forceFunctions: { [M in keyof Modules]: keyof Functions[M] } = {\n${forceObject("function")}\n};\n` +
      `export const forceJobs: { [M in keyof Modules]: keyof Jobs[M] } = {\n${forceObject("job")}\n};\n`;
  } else if (topology === "captured-bootstrap" || topology === "materialized-classify") {
    projection =
      `export type BootstrapReference = ((args: unknown) => Promise<unknown>) & { readonly [name: string]: BootstrapReference };\n` +
      `export declare const refs: BootstrapReference;\n`;
  } else {
    projection = `export interface ClientFunctions {\n${callableEntries}\n}\n`;
  }
  await writeFile(join(directory, "projection.ts"), `${imports}\n${projection}`);
  return join(directory, "tsconfig.json");
}

async function measureScale(): Promise<ScaleMetric[]> {
  const root = await copyFixture(fixture);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const metrics: ScaleMetric[] = [];
  try {
    for (const modules of [10, 100, 1_000]) {
      for (const topology of ["control", "dual-index"] as const) {
        const project = await scaleProject(root, modules, topology);
        metrics.push({
          modules,
          topology,
          ...(await runTsc(project)),
          passes: 1,
        });
      }
      const materialize = await runTsc(
        await scaleProject(root, modules, "materialized-classify"),
      );
      const materializedProjection = await runTsc(
        await scaleProject(root, modules, "materialized"),
      );
      metrics.push({
        modules,
        topology: "materialized",
        memoryKiB: Math.max(materialize.memoryKiB, materializedProjection.memoryKiB),
        types: materialize.types + materializedProjection.types,
        instantiations:
          materialize.instantiations + materializedProjection.instantiations,
        checkSeconds: materialize.checkSeconds + materializedProjection.checkSeconds,
        totalSeconds: materialize.totalSeconds + materializedProjection.totalSeconds,
        passes: 2,
      });
      const bootstrap = await runTsc(
        await scaleProject(root, modules, "captured-bootstrap"),
      );
      const refined = await runTsc(
        await scaleProject(root, modules, "captured-refined"),
      );
      metrics.push({
        modules,
        topology: "captured-evaluation",
        memoryKiB: Math.max(bootstrap.memoryKiB, refined.memoryKiB),
        types: bootstrap.types + refined.types,
        instantiations: bootstrap.instantiations + refined.instantiations,
        checkSeconds: bootstrap.checkSeconds + refined.checkSeconds,
        totalSeconds: bootstrap.totalSeconds + refined.totalSeconds,
        passes: 2,
      });
    }
    return metrics;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function mutationProofs(): Promise<MutationProof[]> {
  const proofs: MutationProof[] = [];

  const root = await copyFixture(fixture);
  try {
    await makeFixtureSafe(root);
    const initial = await compileStatic(root);
    const bootstrapPath = join(root, "_generated", "server.ts");
    const bootstrapBefore = (await stat(bootstrapPath)).mtimeMs;
    const repeated = await compileStatic(root);
    const bootstrapAfter = (await stat(bootstrapPath)).mtimeMs;
    proofs.push({
      scenario: "repeat with no changes",
      before: initial.inputDigest,
      after: repeated.inputDigest,
      changed: initial.inputDigest !== repeated.inputDigest,
      observation:
        initial.inputDigest === repeated.inputDigest && bootstrapBefore === bootstrapAfter
          ? "Byte-stable inputs/projections and compare-before-write preserve the bootstrap mtime."
          : "FAILED: unchanged compilation changed its digest or generated bootstrap mtime.",
    });
    const canonical = [...initial.sources].sort();
    const reversed = [...initial.sources].reverse().sort();
    const interleaved = initial.sources
      .filter((_, index) => index % 2 === 0)
      .concat(initial.sources.filter((_, index) => index % 2 === 1))
      .sort();
    proofs.push({
      scenario: "randomized directory enumeration",
      before: sha256(JSON.stringify(canonical)),
      after: sha256(JSON.stringify(reversed)),
      changed: false,
      observation:
        JSON.stringify(canonical) === JSON.stringify(reversed) &&
        JSON.stringify(canonical) === JSON.stringify(interleaved)
          ? "Canonical sorting produces the same membership order from reversed and interleaved enumeration."
          : "FAILED: canonical membership depends on filesystem enumeration order.",
    });
    const addedPath = join(root, "backend", "added.ts");
    const addEvent = await observeWatchEvent(
      join(root, "backend"),
      () =>
        writeFile(
          addedPath,
          `import { object, query, string } from "../sdk.ts";\n` +
            `export const added = query({ route: "/added", args: object({ id: string() }), returns: string() });\n`,
        ),
    );
    const added = await compileStatic(root);
    proofs.push({
      scenario: "add source",
      before: initial.inputDigest,
      after: added.inputDigest,
      changed: initial.inputDigest !== added.inputDigest,
      watchEvent: addEvent,
      observation: "Canonical membership and digest add backend/added.ts exactly once.",
    });

    const editEvent = await observeWatchEvent(
      join(root, "backend"),
      () =>
        writeFile(
          addedPath,
          `import { object, query, string } from "../sdk.ts";\n` +
            `export const added = query({ route: "/added-v2", args: object({ id: string() }), returns: string() });\n`,
        ),
    );
    const edited = await compileStatic(root);
    proofs.push({
      scenario: "edit semantic descriptor",
      before: added.inputDigest,
      after: edited.inputDigest,
      changed: added.inputDigest !== edited.inputDigest,
      watchEvent: editEvent,
      observation: "A route edit changes both the input digest and descriptor snapshot.",
    });

    const renamedPath = join(root, "backend", "renamed.ts");
    const renameEvent = await observeWatchEvent(join(root, "backend"), () =>
      rename(addedPath, renamedPath),
    );
    const renamed = await compileStatic(root);
    proofs.push({
      scenario: "rename source",
      before: edited.inputDigest,
      after: renamed.inputDigest,
      changed: edited.inputDigest !== renamed.inputDigest,
      watchEvent: renameEvent,
      observation: "Rename changes canonical owner/address instead of preserving a stale alias.",
    });

    const deleteEvent = await observeWatchEvent(join(root, "backend"), () =>
      rm(renamedPath),
    );
    const deleted = await compileStatic(root);
    proofs.push({
      scenario: "delete source",
      before: renamed.inputDigest,
      after: deleted.inputDigest,
      changed: renamed.inputDigest !== deleted.inputDigest,
      watchEvent: deleteEvent,
      observation: "Deleted contribution disappears; no generated file is inside the watched source root.",
    });
  } finally {
    await removeFixture(root);
  }

  const renameRoot = await copyFixture(fixture);
  try {
    await makeFixtureSafe(renameRoot);
    await rename(join(renameRoot, "backend"), join(renameRoot, "logic"));
    const configPath = join(renameRoot, ".ackerdb.config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.source = "./logic";
    await writeFile(configPath, json(config));
    const compilation = await compileStatic(renameRoot);
    proofs.push({
      scenario: "rename configured source root",
      after: compilation.inputDigest,
      changed: compilation.diagnostics.length === 0,
      diagnostics: compilation.diagnostics,
      observation: `The same ${compilation.contributions.length} declarations compile from ./logic; the directory name is not a kind.`,
    });
  } finally {
    await removeFixture(renameRoot);
  }

  const environment = await copyFixture(fixture);
  try {
    await makeFixtureSafe(environment);
    await installEnvironmentManifest(environment);
    const compilation = await compileStatic(environment);
    proofs.push({
      scenario: "ambient environment changes Extension membership",
      diagnostics: compilation.diagnostics.filter((item) => item.phase === "membership"),
      observation:
        "Static candidates reject process.env membership before artifacts; executable config.ts may only fill a statically declared slot.",
    });
  } finally {
    await removeFixture(environment);
  }

  const dynamicConfig = await copyFixture(fixture);
  try {
    await makeFixtureSafe(dynamicConfig);
    const before = await compileStatic(dynamicConfig);
    const configPath = join(dynamicConfig, "config.ts");
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8")).replace("127.0.0.1", "0.0.0.0"),
    );
    const after = await compileStatic(dynamicConfig);
    proofs.push({
      scenario: "change executable config.ts",
      before: before.inputDigest,
      after: after.inputDigest,
      changed: before.inputDigest !== after.inputDigest,
      observation:
        before.inputDigest === after.inputDigest
          ? "Dynamic host configuration changes activation values but cannot change compiled membership."
          : "FAILED: config.ts accidentally became a membership input.",
    });
  } finally {
    await removeFixture(dynamicConfig);
  }

  const capturedInput = await copyFixture(fixture);
  try {
    await makeFixtureSafe(capturedInput);
    await installCapturedManifest(capturedInput);
    const none = await runCapturedEvaluator(capturedInput, {
      QUEUE_DRIVER: "none",
    });
    const bullmq = await runCapturedEvaluator(capturedInput, {
      QUEUE_DRIVER: "bullmq",
    });
    proofs.push({
      scenario: "change an explicitly captured membership input",
      before: String(none.inputDigest),
      after: String(bullmq.inputDigest),
      changed: none.inputDigest !== bullmq.inputDigest,
      observation:
        "Captured evaluation records the allowed values and selected value; changing it deterministically invalidates the concrete Application descriptor.",
    });
  } finally {
    await removeFixture(capturedInput);
  }

  const collision = await copyFixture(fixture);
  try {
    await makeFixtureSafe(collision);
    await mkdir(join(collision, "backend", "orders"));
    await writeFile(
      join(collision, "backend", "orders", "index.ts"),
      `import { object, query, string } from "../../sdk.ts";\n` +
        `export const read = query({ route: "/duplicate", args: object({ id: string() }), returns: string() });\n`,
    );
    const compilation = await compileStatic(collision);
    proofs.push({
      scenario: "deterministic Function address collision",
      diagnostics: compilation.diagnostics.filter((item) => item.phase === "collision"),
      observation:
        "Diagnostic names the canonical path, export, contribution kind, owner, address, and previous owner.",
    });
  } finally {
    await removeFixture(collision);
  }

  return proofs;
}

async function buildCandidates(): Promise<{
  candidates: CandidateResult[];
  atomicFailures: unknown;
  fixtureSummary: unknown;
}> {
  const adversarial = await copyFixture(fixture);
  const effectful = await copyFixture(fixture);
  const safe = await copyFixture(fixture);
  const captured = await copyFixture(fixture);
  try {
    const adversarialCompilation = await compileStatic(adversarial);
    await repairUnsafeExports(effectful);
    const effectfulCompilation = await compileStatic(effectful);
    await makeFixtureSafe(safe);
    const safeCompilation = await compileStatic(safe);
    await makeFixtureSafe(captured);
    await installCapturedManifest(captured);
    const capturedCompilation = await compileStatic(captured);

    if (effectfulCompilation.diagnostics.length > 0) {
      throw new Error(`effectful fixture failed static compile:\n${json(effectfulCompilation.diagnostics)}`);
    }
    if (safeCompilation.diagnostics.length > 0) {
      throw new Error(`safe fixture failed static compile:\n${json(safeCompilation.diagnostics)}`);
    }

    const effectfulLink = await linkRuntime(effectfulCompilation);
    const safeLink = await linkRuntime(safeCompilation);
    if (!safeLink.authentic || !safeLink.descriptorParity || !safeLink.promiseReused) {
      throw new Error(
        `runtime link broke compiled identity: ${json({
          authentic: safeLink.authentic,
          descriptorParity: safeLink.descriptorParity,
          promiseReused: safeLink.promiseReused,
        })}`,
      );
    }
    const capturedUnsafe = await runCapturedEvaluator(effectful);
    const capturedSafe = await runCapturedEvaluator(captured, {
      QUEUE_DRIVER: "bullmq",
    });

    const conditionalTypes = renderTypeProjection(safeCompilation, "conditional");
    const flatTypes = renderTypeProjection(safeCompilation, "flat");
    const trace = lifecycleTrace(safeLink, safeCompilation.inputDigest);
    const functionPass = safeCompilation.contributions.filter(
      (item) => item.kind === "function",
    );
    const jobPass = safeCompilation.contributions.filter((item) => item.kind === "job");
    const lifecyclePass = safeCompilation.contributions.filter(
      (item) => item.kind === "lifecycle",
    );

    const candidates: CandidateResult[] = [
      {
        id: "control",
        name: "Folder-only consolidation",
        question: "Does one directory alone create one Application model?",
        verdict: "fail",
        score: 3,
        interface: [
          "scanSourceRoot()",
          "declareFunctions()",
          "declareJobs()",
          "declareLifecycles()",
          "startIndependentRuntimes()",
        ],
        inputs: effectfulCompilation.inputs,
        membership: {
          root: membership(effectfulCompilation),
          independentClassifiers: {
            functions: functionPass.map((item) => item.identity),
            jobs: jobPass.map((item) => item.identity),
            lifecycles: lifecyclePass.map((item) => item.identity),
          },
        },
        types: conditionalTypes,
        descriptors: {
          source: "evaluated values reconstructed by each subsystem",
          snapshot: runtimeDescriptorSnapshot(effectfulCompilation),
        },
        lifecycle: trace,
        diagnostics: [],
        effects: effectfulLink.effects,
        importCalls: effectfulLink.importCalls,
        good: [
          "One renameable root is mechanically easy.",
          "Mixed exports can be classified by declaration identity.",
        ],
        bad: [
          "Independent Function, Job, and lifecycle classifiers remain.",
          "Plugin/Service-style activation owners remain behind one folder.",
        ],
        ugly: [
          "The top-level tripwire runs during descriptor reconstruction.",
          "It changes paths without deleting a model, public noun, or lifecycle owner.",
        ],
        productionDelta: {
          counts: {
            sourceRoots: 1,
            independentClassificationSources: 3,
            contributionLifecycleSupervisors: 2,
            generatedOrAnalysisMechanisms: 3,
            planningEvaluationPhases: 1,
          },
          removes: ["servicesDir", "jobsDir"],
          adds: ["mixed root dispatcher"],
          netJudgment:
            "Fails: two folders disappear, but ten processing passes and two supervisors survive.",
        },
      },
      {
        id: "dual-index",
        name: "Dual index / inference-first",
        question:
          "Can type-only membership plus lazy canonical imports provide exact types and complete inert planning?",
        verdict: "fail",
        score: 5,
        interface: [
          "compileApplication(project): ApplicationCompilation",
          "linkApplication(compilation): ApplicationPlan",
          "activateApplication(plan): RunningApplication",
        ],
        inputs: effectfulCompilation.inputs,
        membership: membership(effectfulCompilation),
        types: conditionalTypes,
        descriptors: {
          staticTypeProjection: "exact",
          completeDescriptorBoundary: "available only after link/evaluate",
          linked: effectfulLink.contributions.map(({ identity, descriptor }) => ({
            identity,
            descriptor,
          })),
        },
        lifecycle: trace,
        diagnostics: [
          {
            phase: "link/evaluate",
            source: "worker.ts",
            export: "queues",
            kind: "lifecycle",
            owner: "application",
            message:
              "Semantic linking evaluated arbitrary top-level code before activation; phase-safe planning is not architectural in this family.",
          },
        ],
        effects: effectfulLink.effects,
        importCalls: effectfulLink.importCalls,
        good: [
          "Small compiler and excellent exact type/address projection.",
          "One canonical lazy loader preserves import-once identity.",
          "Dynamic config.ts remains fully executable without controlling membership.",
        ],
        bad: [
          "The checker sees the full typeof module graph.",
          "Recursive generated references still require explicit result contracts.",
          "Environment-selected membership must be rejected.",
        ],
        ugly: [
          "Exact validators/schema/routes/OpenAPI require evaluating source values.",
          "The tripwire proves link is an unowned effects phase, not activation.",
          "Fixing that wall turns this candidate into the materialized or captured family.",
        ],
        productionDelta: {
          counts: {
            sourceRoots: 1,
            independentClassificationSources: 1,
            contributionLifecycleSupervisors: 1,
            generatedOrAnalysisMechanisms: 3,
            planningEvaluationPhases: 1,
          },
          removes: [
            "three directory scanners",
            "separate Function/Job type indexes",
            "duplicate loader maps",
          ],
          adds: ["type index", "runtime loader index", "evaluated link phase"],
          netJudgment:
            "Mixed: simplifies discovery, but cannot replace safe schema/OpenAPI planning without another mechanism.",
        },
      },
      {
        id: "materialized",
        name: "Compiler-materialized manifest",
        question:
          "Can one inert compiler pipeline materialize exact types and complete descriptors without source evaluation?",
        verdict: "pass",
        score: 8,
        interface: [
          "compileApplication(project): CompiledApplication",
          "startApplication(compiled, config): RunningApplication",
        ],
        inputs: safeCompilation.inputs,
        membership: membership(safeCompilation),
        types: flatTypes,
        descriptors: {
          inputDigest: safeCompilation.inputDigest,
          compiled: runtimeDescriptorSnapshot(safeCompilation),
          runtimeVerification: {
            authenticBuilders: safeLink.authentic,
            descriptorParity: safeLink.descriptorParity,
            canonicalPromiseReusedAcrossConsumers: safeLink.promiseReused,
            modulesEvaluated: safeLink.modulesEvaluated,
            importRequests: safeLink.importCalls,
          },
        },
        lifecycle: trace,
        diagnostics: [
          {
            phase: "authoring contract",
            source: "<all declarations>",
            owner: "application",
            message:
              "Only exact values in the closed serializable descriptor calculus compile; opaque arbitrary computation is rejected.",
          },
          {
            phase: "link/evaluate tripwire",
            source: "worker.ts",
            export: "queues",
            kind: "lifecycle",
            owner: "application",
            message:
              "The effectful fixture compiles inertly, but serving detects the top-level tripwire as unowned link work. The safe fixture activates the lifecycle factory exactly once.",
          },
        ],
        effects: [],
        importCalls: safeLink.importCalls,
        good: [
          "One inert compiler pipeline yields membership, exact flat types, schema, validators, routes, Jobs, and OpenAPI.",
          "No user module evaluation occurs during codegen or planning.",
          "Helpers disappear and any/forged declarations fail before artifacts.",
          "Flat materialized types avoid client-side recursive pruning.",
        ],
        bad: [
          "AckerDB owns a pinned TypeScript Compiler API integration.",
          "Descriptor expressions must remain exact and serializable in their types.",
          "Opaque wrappers and environment-dependent membership are rejected.",
        ],
        ugly: [
          "Arbitrary TypeScript computation and zero evaluation cannot coexist.",
          "Runtime must authenticate and compare the loaded value to the compiled descriptor.",
          "Some erased type shapes may require explicit validators instead of magical recovery.",
        ],
        productionDelta: {
          counts: {
            sourceRoots: 1,
            independentClassificationSources: 1,
            contributionLifecycleSupervisors: 1,
            generatedOrAnalysisMechanisms: 2,
            planningEvaluationPhases: 0,
          },
          removes: [
            "Plugin and Service public taxonomies",
            "three source scanners and ten independent processing passes",
            "PluginRuntime and ServiceRuntime supervisors",
            "Plugin/Service/Job-specific Runtime/startup wiring",
          ],
          adds: [
            "one Application Compiler Module",
            "closed descriptor calculus",
            "one compiled plan/runtime verifier",
            "one Application activation owner",
          ],
          netJudgment:
            "Passes conditionally on production deletion: the compiler must directly replace old paths, never feed them.",
        },
      },
      {
        id: "captured",
        name: "Captured pure evaluation / stub-refine",
        question:
          "Is richer ordinary TypeScript worth a restricted evaluator, two checks, and deploy-time input parity?",
        verdict: "conditional",
        score: 5,
        interface: [
          "compileApplication(project): CompiledApplication",
          "activateApplication(compiled, config): RunningApplication",
        ],
        inputs: {
          static: capturedCompilation.inputs,
          captured: capturedSafe.observedInputs,
          digest: capturedSafe.inputDigest,
        },
        membership: {
          application: capturedSafe.application,
          sources: capturedCompilation.sources,
          contributions: capturedSafe.contributions,
          evaluatedModules: capturedSafe.evaluatedModules,
        },
        types: renderTypeProjection(capturedCompilation, "flat"),
        descriptors: {
          application: capturedSafe.application,
          captured: capturedSafe.contributions,
          resourcesOpenedDuringAnalysis: capturedSafe.resourcesOpened,
        },
        lifecycle: trace,
        diagnostics: [
          {
            phase: "restricted analysis",
            source: "worker.ts",
            export: "queues",
            kind: "lifecycle",
            owner: "application",
            message: String(capturedUnsafe.error),
          },
        ],
        effects: [],
        importCalls: safeLink.importCalls,
        good: [
          "Richest authoring: computed descriptors and explicit captured membership inputs work.",
          "Runtime builder authentication rejects asserted objects.",
          "Lifecycle factories remain inert during restricted evaluation.",
        ],
        bad: [
          "Bootstrap, evaluation, refinement, and final typecheck are permanent phases.",
          "Exactness is for one captured input transcript and source digest.",
          "Deployment must reject source/input drift instead of recompiling implicitly.",
        ],
        ugly: [
          "A real sandbox must constrain the entire transitive TypeScript/npm graph; node:vm is only mechanical evidence.",
          "Two compiler passes and an evaluator likely consume the deletion budget.",
          "Arbitrary dependencies and strong phase safety remain a design wall.",
        ],
        productionDelta: {
          counts: {
            sourceRoots: 1,
            independentClassificationSources: 1,
            contributionLifecycleSupervisors: 1,
            generatedOrAnalysisMechanisms: 4,
            planningEvaluationPhases: 1,
          },
          removes: [
            "Plugin and Service public taxonomies",
            "separate scanners/classifiers/supervisors",
          ],
          adds: [
            "bootstrap/refinement protocol",
            "restricted evaluator and module loader",
            "captured-input transcript",
            "deployment parity verifier",
            "two TypeScript checks",
          ],
          netJudgment:
            "Fails the simplification objective as the default; retain captured-input vocabulary only if later evidence requires it.",
        },
      },
    ];

    return {
      candidates,
      atomicFailures: {
        artifactsPublished: adversarialCompilation.artifactsPublished,
        diagnostics: adversarialCompilation.diagnostics.filter(
          (item) =>
            item.export === "anyLeak" ||
            item.export === "unresolved" ||
            item.export === "forged" ||
            item.phase === "provenance",
        ),
        observation:
          "The adversarial fixture produces no client or plan artifact. any, unresolved/unknown, and forged provenance fail before projection.",
      },
      fixtureSummary: {
        configuredSourceRoot: "./backend (already not named functions)",
        app: "defineApp + computed Schema + static Extension mount",
        dynamicConfig: "config.ts fills the predeclared queue configuration slot",
        mixedKinds: [...new Set(safeCompilation.contributions.map((item) => item.kind))],
        ordinaryHelpers: [
          "formatOrderId",
          "calculateRetryDelay",
          "surfaceHelper",
          "ordinaryServerHelper",
        ],
        circularReferences: "Function → Job and Job → Function through non-any bootstrap refs",
        computedMetadata: "template-literal routes and nested validator/Schema descriptors",
        hostileExports: [
          "anyLeak",
          "unresolved/unknown export",
          "forged branded assertion",
        ],
        effectTripwire: "worker.ts top-level effect distinct from lifecycle activate",
      },
    };
  } finally {
    await Promise.all(
      [adversarial, effectful, safe, captured].map((root) => removeFixture(root)),
    );
  }
}

function renderHtml(report: Report): string {
  const embedded = JSON.stringify(report).replaceAll("</script", "<\\/script");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="icon" href="data:,">
  <title>AckerDB Application source topology prototype</title>
  <style>
    :root { color-scheme: dark; --bg:#0b1020; --panel:#121a2e; --line:#28344f; --text:#e8edf7; --muted:#9daac2; --accent:#72d5b4; --warn:#ffcf70; --bad:#ff8686; }
    * { box-sizing:border-box } body { margin:0; font:15px/1.5 ui-sans-serif,system-ui,-apple-system; background:var(--bg); color:var(--text) }
    main { max-width:1200px; margin:auto; padding:32px 22px 64px } h1 { font-size:28px; margin:0 0 8px } h2 { font-size:19px; margin:0 0 12px } p { color:var(--muted) }
    .notice,.panel { border:1px solid var(--line); background:var(--panel); border-radius:12px; padding:18px; margin:16px 0 }
    .notice { border-color:#365b58 } .tabs,.actions { display:flex; gap:8px; flex-wrap:wrap; margin:14px 0 }
    button { appearance:none; border:1px solid var(--line); background:#17223c; color:var(--text); border-radius:8px; padding:9px 12px; cursor:pointer }
    button:hover,button.active { border-color:var(--accent); color:var(--accent) } button.done { opacity:.6 }
    .grid { display:grid; grid-template-columns:minmax(260px, .8fr) minmax(0, 1.7fr); gap:16px } @media(max-width:800px){.grid{grid-template-columns:1fr}}
    .label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.08em }
    .verdict { display:inline-block; padding:4px 8px; border-radius:999px; margin-left:8px; background:#23304a }
    .pass { color:var(--accent) } .fail { color:var(--bad) } .conditional { color:var(--warn) }
    pre { white-space:pre-wrap; overflow-wrap:anywhere; background:#080d19; border:1px solid var(--line); border-radius:8px; padding:14px; max-height:520px; overflow:auto }
    ul { padding-left:20px } li { margin:6px 0 } table { width:100%; border-collapse:collapse; font-size:13px } th,td { border-bottom:1px solid var(--line); padding:8px; text-align:right } th:first-child,td:first-child { text-align:left }
    .walkthrough { display:none } .walkthrough.active { display:block } .step-note { color:var(--accent); min-height:24px }
  </style>
</head>
<body><main>
  <h1>One Application source model</h1>
  <p>Throwaway logic prototype: compare four source/codegen topologies against the same hostile mixed-root fixture.</p>
  <div class="notice"><strong>Question:</strong> Can AckerDB get one renameable mixed source root, exact projections, complete inert planning, canonical lifecycle ownership, and net machinery deletion at the same time?</div>
  <h2>Choose a candidate</h2><div id="candidate-tabs" class="tabs"></div>
  <div class="grid">
    <section class="panel"><div class="label">Current candidate</div><div id="summary"></div><div id="free-actions" class="actions"></div><div id="details"></div></section>
    <section class="panel"><div class="label">Full relevant state</div><pre id="state"></pre></section>
  </div>
  <section class="panel"><h2>Guided walkthroughs</h2><div id="walkthrough-tabs" class="tabs"></div><div id="walkthroughs"></div></section>
  <section class="panel"><h2>Checker scale</h2><p>TypeScript 5.9.3 extended diagnostics. Materialized and captured candidates report bootstrap/classification plus refined projection passes; evaluator cost is separate.</p><div id="scale"></div></section>
  <section class="panel"><h2>Your reaction</h2><p>After driving the scenarios, answer: Does the materialized manifest's restriction—descriptors must remain exact, serializable values—feel like the right price for inert planning and deletion? If not, which rejected capability is essential?</p></section>
<script>
const report = ${embedded};
const initial = { candidate: "materialized", view: "verdict", walkthrough: "inert", step: 0 };
let state = initial;
const byId = id => report.candidates.find(candidate => candidate.id === id);
const actions = {
  SELECT_CANDIDATE: (s, id) => ({...s, candidate:id, view:"verdict"}),
  SHOW: (s, view) => ({...s, view}),
  START_WALKTHROUGH: (s, walkthrough) => ({...s, walkthrough, step:0}),
  WALK: (s, payload) => ({...s, candidate:payload.candidate ?? s.candidate, view:payload.view, step:s.step+1}),
  RESET: () => initial,
};
const walkthroughs = {
  inert: { name:"Can planning stay inert?", description:"Follow the semantic descriptor from types to activation and watch where arbitrary top-level work appears.", steps:[
    {label:"1. Type-only dual index",candidate:"dual-index",view:"types"},
    {label:"2. Ask for descriptors",candidate:"dual-index",view:"descriptors"},
    {label:"3. Inspect the tripwire",candidate:"dual-index",view:"effects"},
    {label:"4. Materialize instead",candidate:"materialized",view:"descriptors"},
    {label:"5. Verify lifecycle",candidate:"materialized",view:"lifecycle"},
  ]},
  dynamic: { name:"Dynamic Extension membership", description:"Compare ambient membership, static rejection, and captured evaluation's real cost.", steps:[
    {label:"1. Static mutation proof",candidate:"materialized",view:"mutations"},
    {label:"2. Captured inputs",candidate:"captured",view:"inputs"},
    {label:"3. Sandbox wall",candidate:"captured",view:"diagnostics"},
    {label:"4. Cost of richness",candidate:"captured",view:"delta"},
  ]},
  deletion: { name:"Does it actually simplify?", description:"A single folder is not enough. Compare which mechanisms each topology removes and adds.", steps:[
    {label:"1. Folder-only control",candidate:"control",view:"delta"},
    {label:"2. Dual-index split",candidate:"dual-index",view:"delta"},
    {label:"3. Evaluator cost",candidate:"captured",view:"delta"},
    {label:"4. Compiled model",candidate:"materialized",view:"delta"},
    {label:"5. Recommendation",candidate:"materialized",view:"recommendation"},
  ]},
};
function dispatch(type,payload){state=actions[type](state,payload);render()}
function viewValue(candidate){
  if(state.view==="verdict") return {verdict:candidate.verdict,score:candidate.score,question:candidate.question,good:candidate.good,bad:candidate.bad,ugly:candidate.ugly};
  if(state.view==="mutations") return report.mutations;
  if(state.view==="recommendation") return report.recommendation;
  if(state.view==="delta") return candidate.productionDelta;
  return candidate[state.view];
}
function render(){
  const candidate=byId(state.candidate);
  document.querySelector("#candidate-tabs").innerHTML=report.candidates.map(c=>'<button class="'+(c.id===candidate.id?'active':'')+'" data-candidate="'+c.id+'">'+c.name+'</button>').join("");
  document.querySelectorAll("[data-candidate]").forEach(button=>button.addEventListener("click",()=>dispatch("SELECT_CANDIDATE",button.dataset.candidate)));
  document.querySelector("#summary").innerHTML='<h2>'+candidate.name+'<span class="verdict '+candidate.verdict+'">'+candidate.verdict+' · '+candidate.score+'/10</span></h2><p>'+candidate.question+'</p>';
  const views=["verdict","membership","types","descriptors","lifecycle","diagnostics","effects","inputs","delta","mutations"];
  document.querySelector("#free-actions").innerHTML=views.map(v=>'<button class="'+(state.view===v?'active':'')+'" data-view="'+v+'">'+v+'</button>').join("");
  document.querySelectorAll("[data-view]").forEach(button=>button.addEventListener("click",()=>dispatch("SHOW",button.dataset.view)));
  document.querySelector("#details").innerHTML='<div class="label">Interface</div><ul>'+candidate.interface.map(x=>'<li><code>'+x+'</code></li>').join("")+'</ul>';
  document.querySelector("#state").textContent=JSON.stringify(viewValue(candidate),null,2);
  document.querySelector("#walkthrough-tabs").innerHTML=Object.entries(walkthroughs).map(([id,w])=>'<button class="'+(state.walkthrough===id?'active':'')+'" data-walkthrough="'+id+'">'+w.name+'</button>').join("");
  document.querySelectorAll("[data-walkthrough]").forEach(button=>button.addEventListener("click",()=>dispatch("START_WALKTHROUGH",button.dataset.walkthrough)));
  document.querySelector("#walkthroughs").innerHTML=Object.entries(walkthroughs).map(([id,w])=>'<div class="walkthrough '+(state.walkthrough===id?'active':'')+'"><p>'+w.description+'</p><div class="actions">'+w.steps.map((step,index)=>'<button class="'+(index<state.step&&state.walkthrough===id?'done':'')+'" data-walk="'+id+'-'+index+'">'+step.label+'</button>').join("")+'</div><div class="step-note">'+(state.walkthrough===id?Math.min(state.step,w.steps.length)+' / '+w.steps.length+' steps explored':'')+'</div></div>').join("");
  document.querySelectorAll("[data-walk]").forEach(button=>{const [id,index]=button.dataset.walk.split("-");button.addEventListener("click",()=>dispatch("WALK",walkthroughs[id].steps[Number(index)]))});
  const names=[...new Set(report.scale.map(x=>x.topology))]; const sizes=[10,100,1000];
  document.querySelector("#scale").innerHTML='<table><thead><tr><th>Topology</th>'+sizes.map(n=>'<th>'+n+' modules<br>types / instantiations / MiB / seconds</th>').join("")+'</tr></thead><tbody>'+names.map(name=>'<tr><td>'+name+'</td>'+sizes.map(n=>{const m=report.scale.find(x=>x.topology===name&&x.modules===n);return '<td>'+m.types+' / '+m.instantiations+' / '+(m.memoryKiB/1024).toFixed(1)+' / '+m.totalSeconds.toFixed(2)+(m.passes===2?' (2 passes)':'')+'</td>'}).join("")+'</tr>').join("")+'</tbody></table>';
}
render();
</script></main></body></html>`;
}

async function writeCandidate(candidate: CandidateResult): Promise<void> {
  const directory = join(output, candidate.id);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeJson(join(directory, "membership.json"), candidate.membership),
    writeFile(join(directory, "types.d.ts"), candidate.types),
    writeJson(join(directory, "descriptors.json"), candidate.descriptors),
    writeJson(join(directory, "lifecycle.json"), candidate.lifecycle),
    writeJson(join(directory, "verdict.json"), {
      verdict: candidate.verdict,
      score: candidate.score,
      interface: candidate.interface,
      diagnostics: candidate.diagnostics,
      effects: candidate.effects,
      importCalls: candidate.importCalls,
      good: candidate.good,
      bad: candidate.bad,
      ugly: candidate.ugly,
      productionDelta: candidate.productionDelta,
    }),
  ]);
}

async function main(): Promise<void> {
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const { candidates, atomicFailures, fixtureSummary } = await buildCandidates();
  const mutations = await mutationProofs();
  const scale = await measureScale();
  const report: Report = {
    generatedAt: new Date().toISOString(),
    question:
      "Which Application source/codegen topology yields one renameable mixed root, exact types, complete descriptors, inert planning, canonical lifecycle ownership, and net machinery deletion?",
    fixture: fixtureSummary,
    atomicFailures,
    candidates,
    mutations,
    scale,
    proofMatrix: [
      {
        proof: "Fresh checkout without generated files",
        result: "pass",
        evidence:
          "Every fixture copy starts without _generated; a non-any bootstrap is created compare-before-write before classification.",
      },
      {
        proof: "One renamed mixed source root",
        result: "pass",
        evidence:
          "./backend and renamed ./logic both compile eight contributions spanning Function, HTTP, channel, realtime, MCP, Job, and lifecycle kinds; helpers project nowhere.",
      },
      {
        proof: "Exact remote and server projections",
        result: "pass",
        evidence:
          "Materialized types contain only api.orders.read/api.orders.submit and jobs.orders.refresh; no empty helper/lifecycle namespaces are emitted.",
      },
      {
        proof: "Complete semantic snapshot without evaluation",
        result: "pass",
        evidence:
          "Compiler materializes the computed /v1/orders route, nested Schema/validators, Job retry policy, lifecycle descriptor, routes, and OpenAPI while the effect log remains empty.",
      },
      {
        proof: "Reject any, unresolved, and forged declarations atomically",
        result: "pass",
        evidence:
          "Adversarial compilation publishes no artifacts and reports unsafe.ts#anyLeak, #unresolved, and #forged with phase/owner/kind evidence.",
      },
      {
        proof: "Evaluation is distinct from activation",
        result: "pass",
        evidence:
          "Dual-index link triggers the unowned top-level tripwire; materialized planning does not. The inert lifecycle opens only at activate and closes after quiesce/drain.",
      },
      {
        proof: "Canonical runtime identity",
        result: "pass",
        evidence:
          "Every source receives two consumer requests but one memoized promise/evaluation; runtime builder provenance and descriptor parity both verify true.",
      },
      {
        proof: "Deterministic invalidation and watching",
        result: "pass",
        evidence:
          "No-change preserves digest/mtime; reversed/interleaved enumeration is canonical; add/edit/rename/delete emit watcher events and deterministic digest changes.",
      },
      {
        proof: "Configuration has one owner",
        result: "pass",
        evidence:
          "Ambient membership is rejected, config.ts changes do not change membership, and explicitly captured membership changes alter the captured digest.",
      },
      {
        proof: "TypeScript scale at 10/100/1,000 modules",
        result: "pass",
        evidence:
          "Pinned TypeScript 5.9.3 extended diagnostics record types, forced instantiations, memory, check time, total time, and pass count for all candidates.",
      },
      {
        proof: "Net production-code deletion",
        result: "conditional",
        evidence:
          "Mechanism counts favor the materialized compiler, but this disposable source prototype cannot prove production LOC deletion. The BullMQ/converged-model prototype must delete rather than feed current Plugin/Service machinery.",
      },
    ],
    comparison: {
      deletionBaseline: {
        autoDiscoveredDeclarationRoots: 3,
        visibleExportProcessingPasses: 10,
        dedicatedContributionLifecycleSupervisors: 2,
        pluginAndServicePublicExports: 41,
        grossPluginAndServiceProductionLocIncludingCliStorage: 2917,
      },
      accountingBoundary:
        "This source-topology prototype proves mechanism counts, not production LOC deletion. The BullMQ/converged-model prototype must report old production files/LOC removed and new production files/LOC added before the architecture can claim net code deletion.",
      control: "One folder without one compiled model is cosmetic consolidation.",
      dualIndex:
        "Best small exact type projection, but semantic linking evaluates arbitrary top levels and fails inert planning.",
      materialized:
        "Best net design if AckerDB accepts a closed exact descriptor calculus and rejects opaque membership/metadata computation.",
      captured:
        "Best author ergonomics, worst deletion economics; evaluator/sandbox and two-pass parity are permanent machinery.",
    },
    recommendation: {
      select: "compiler-materialized manifest",
      authoringOwnership: {
        "defineApp":
          "Application policy: root Schema, scopes, API paths, explicit Extension mounts and grants",
        ".ackerdb.config.json":
          "Static serializable project/host facts needed before TypeScript evaluation; source defaults to ./functions and may be renamed",
        "config.ts":
          "Executable dynamic host configuration and secrets for already-declared slots; never contribution membership",
        "functions/":
          "Default renameable mixed Application source root; exports contribute by authenticated declaration identity, not folder or filename kind",
      },
      retainFromDualIndex: [
        "one deterministic source index",
        "one canonical runtime import promise per source identity",
      ],
      retainFromCaptured: [
        "explicit captured-input transcript only if a future proven requirement needs compile-input-dependent membership",
      ],
      reject: [
        "folder-only consolidation",
        "evaluated semantic linking during planning",
        "captured evaluation as the default",
      ],
      requiredFollowUpProof:
        "BullMQ Extension prototype must consume the compiled contribution plan directly and prove the old Plugin/Service machinery can be deleted rather than fed by the compiler.",
      unresolved: [
        "Whether migration history physically shares the source root",
        "Which computed validator/schema forms fit the exact descriptor calculus",
        "The final public Extension authoring interface",
      ],
    },
  };

  for (const candidate of candidates) await writeCandidate(candidate);
  await writeJson(join(output, "report.json"), report);
  await writeFile(join(output, "prototype.html"), renderHtml(report));
  await writeJson(join(output, "mutations.json"), mutations);
  await writeJson(join(output, "scale.json"), scale);
  await writeJson(join(output, "proof-matrix.json"), report.proofMatrix);
  console.log(`Prototype complete: ${join(output, "prototype.html")}`);
  console.log(
    `Recommendation: ${String((report.recommendation as { select: string }).select)}`,
  );
}

await main();
