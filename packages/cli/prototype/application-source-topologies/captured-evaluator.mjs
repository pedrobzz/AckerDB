// PROTOTYPE ONLY: restricted evaluation evidence, not a production sandbox.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import process from "node:process";
import vm from "node:vm";
import ts from "typescript";

const [projectRoot, ...entryArguments] = process.argv.slice(2);
const entries = entryArguments.map((entry) => resolve(projectRoot, entry));
const selectedInputs = JSON.parse(process.env.ACKER_PROTOTYPE_INPUTS ?? "{}");
const observedInputs = [];

const context = vm.createContext({
  console,
  __ackerAnalysisMode: true,
  selectApplicationInput(name, allowed) {
    if (!Object.hasOwn(selectedInputs, name)) {
      throw new Error(`uncaptured Application input: ${name}`);
    }
    const selected = selectedInputs[name];
    if (!allowed.includes(selected)) {
      throw new Error(
        `Application input ${name}=${JSON.stringify(selected)} is not one of ${allowed.join(", ")}`,
      );
    }
    observedInputs.push({ name, allowed, selected });
    return selected;
  },
});

const modules = new Map();

const resolveSpecifier = (specifier, parent) => {
  if (!specifier.startsWith(".")) {
    throw new Error(`analysis denied import: ${specifier}`);
  }
  const candidate = resolve(dirname(parent), specifier);
  return extname(candidate) ? candidate : `${candidate}.ts`;
};

async function loadModule(file) {
  const canonical = resolve(file);
  const existing = modules.get(canonical);
  if (existing) return existing;

  const source = await readFile(canonical, "utf8");
  const javascript = ts.transpileModule(source, {
    fileName: canonical,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
    },
  }).outputText;

  const module = new vm.SourceTextModule(javascript, {
    context,
    identifier: canonical,
    initializeImportMeta(meta) {
      meta.url = `prototype:${canonical}`;
    },
  });
  modules.set(canonical, module);
  await module.link((specifier, referencing) =>
    loadModule(resolveSpecifier(specifier, referencing.identifier)),
  );
  return module;
}

const clean = (value, seen = new WeakSet()) => {
  if (typeof value === "function") return undefined;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[cycle]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => clean(item, seen));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.startsWith("__acker"))
      .map(([key, item]) => [key, clean(item, seen)])
      .filter(([, item]) => item !== undefined),
  );
};

try {
  for (const entry of entries) {
    const module = await loadModule(entry);
    await module.evaluate();
  }

  const sdkPath = resolve(projectRoot, "sdk.ts");
  const sdk = await loadModule(sdkPath);
  if (sdk.status !== "evaluated") await sdk.evaluate();
  const authenticate = sdk.namespace.isAuthenticDeclaration;
  const contributions = [];
  const applicationModule = await loadModule(entries[0]);
  const application = clean(applicationModule.namespace.default);

  for (const entry of entries) {
    if (!entry.includes(`${process.platform === "win32" ? "\\" : "/"}backend`)) {
      continue;
    }
    const module = await loadModule(entry);
    for (const name of Object.getOwnPropertyNames(module.namespace).sort()) {
      const value = module.namespace[name];
      if (!value || typeof value !== "object" || !("__ackerKind" in value)) {
        continue;
      }
      if (!authenticate(value)) {
        throw new Error(`forged runtime declaration: ${entry}#${name}`);
      }
      contributions.push({
        source: entry.slice(projectRoot.length + 1),
        export: name,
        kind: value.__ackerKind,
        descriptor: clean(value.__ackerDescriptor),
      });
    }
  }

  const digest = createHash("sha256")
    .update(JSON.stringify(observedInputs))
    .digest("hex");
  console.log(
    JSON.stringify({
      ok: true,
      evaluatedModules: [...modules.keys()].map((file) =>
        file.slice(projectRoot.length + 1),
      ),
      observedInputs,
      inputDigest: digest,
      application,
      contributions,
      resourcesOpened: 0,
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      observedInputs,
      evaluatedModules: [...modules.keys()].map((file) =>
        file.slice(projectRoot.length + 1),
      ),
      resourcesOpened: 0,
    }),
  );
}
