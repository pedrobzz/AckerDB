// PROTOTYPE ONLY — disposable compiler evidence for issue #304.
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export const contributionKinds = [
  "function",
  "http",
  "channel",
  "realtime",
  "mcp",
  "job",
  "lifecycle",
] as const;

export type ContributionKind = (typeof contributionKinds)[number];

export interface Diagnostic {
  readonly phase: string;
  readonly source: string;
  readonly export?: string;
  readonly kind?: string;
  readonly owner?: string;
  readonly message: string;
}

export interface InputRecord {
  readonly source: string;
  readonly digest: string;
  readonly role: "static-config" | "manifest" | "source" | "compiler";
}

export interface Contribution {
  readonly owner: "application";
  readonly source: string;
  readonly export: string;
  readonly kind: ContributionKind;
  readonly identity: string;
  readonly address?: string;
  readonly descriptor?: unknown;
}

export interface StaticCompilation {
  readonly root: string;
  readonly sourceRoot: string;
  readonly generatedRoot: string;
  readonly sources: readonly string[];
  readonly inputs: readonly InputRecord[];
  readonly inputDigest: string;
  readonly contributions: readonly Contribution[];
  readonly appDescriptor?: unknown;
  readonly diagnostics: readonly Diagnostic[];
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly artifactsPublished: boolean;
}

export interface LinkResult {
  readonly modulesEvaluated: readonly string[];
  readonly importCalls: Readonly<Record<string, number>>;
  readonly contributions: readonly Contribution[];
  readonly effects: readonly string[];
  readonly authentic: boolean;
  readonly descriptorParity: boolean;
  readonly promiseReused: boolean;
  readonly namespaces: Readonly<Record<string, Record<string, unknown>>>;
}

const builders = new Set([
  "query",
  "mutation",
  "procedure",
  "rawHttp",
  "channel",
  "realtime",
  "mcp",
  "job",
  "lifecycle",
]);

const ignoredDescriptorKeys = new Set([
  "handler",
  "activate",
  "quiesce",
  "deactivate",
]);

const normalize = (path: string) => path.split(sep).join("/");

export const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

async function walk(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) found.push(path);
  }
  return found.sort((a, b) => normalize(a).localeCompare(normalize(b)));
}

export async function copyFixture(fixture: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "acker-source-topology-"));
  await cp(fixture, root, { recursive: true });
  return root;
}

export async function removeFixture(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

export async function makeFixtureSafe(root: string): Promise<void> {
  await writeFile(
    join(root, "backend", "unsafe.ts"),
    "export const ordinaryServerHelper = { safe: true };\n",
  );
  const workerPath = join(root, "backend", "worker.ts");
  const worker = await readFile(workerPath, "utf8");
  await writeFile(
    workerPath,
    worker
      .replace(", topLevelEffect", "")
      .replace(
        'topLevelEffect("UNOWNED top-level timer/BullMQ tripwire");\n\n',
        "",
      ),
  );
}

export async function repairUnsafeExports(root: string): Promise<void> {
  await writeFile(
    join(root, "backend", "unsafe.ts"),
    "export const ordinaryServerHelper = { safe: true };\n",
  );
}

export async function installEnvironmentManifest(root: string): Promise<void> {
  await cp(join(root, "mutations", "environment-app.ts"), join(root, "app.ts"));
}

export async function installCapturedManifest(root: string): Promise<void> {
  await cp(join(root, "mutations", "captured-app.ts"), join(root, "app.ts"));
}

export async function writeBootstrap(root: string): Promise<void> {
  const generated = join(root, "_generated");
  await mkdir(generated, { recursive: true });
  const path = join(generated, "server.ts");
  const contents =
    `// PROTOTYPE bootstrap: fresh-checkout, non-any recursive reference.\n` +
      `export type BootstrapReference =\n` +
      `  & ((args: unknown) => Promise<unknown>)\n` +
      `  & { readonly [name: string]: BootstrapReference };\n` +
      `const target = (() => Promise.resolve(undefined)) as unknown as BootstrapReference;\n` +
      `export const refs: BootstrapReference = new Proxy(target, {\n` +
      `  get: () => refs,\n` +
      `});\n`;
  let previous: string | undefined;
  try {
    previous = await readFile(path, "utf8");
  } catch {}
  if (previous !== contents) await writeFile(path, contents);
}

function literalText(type: ts.Type): unknown | undefined {
  if (type.flags & ts.TypeFlags.StringLiteral) {
    return (type as ts.StringLiteralType).value;
  }
  if (type.flags & ts.TypeFlags.NumberLiteral) {
    return (type as ts.NumberLiteralType).value;
  }
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    return (type as ts.Type & { intrinsicName?: string }).intrinsicName === "true";
  }
  if (type.flags & ts.TypeFlags.Null) return null;
  if (type.flags & ts.TypeFlags.Undefined) return "[undefined]";
  return undefined;
}

function materializeType(
  checker: ts.TypeChecker,
  type: ts.Type,
  at: ts.Node,
  seen = new Set<number>(),
): unknown {
  const literal = literalText(type);
  if (literal !== undefined || type.flags & ts.TypeFlags.Undefined) return literal;
  if (type.flags & ts.TypeFlags.Any) throw new Error("descriptor contains any");
  if (type.flags & ts.TypeFlags.Unknown) throw new Error("descriptor contains unknown");
  if (type.flags & ts.TypeFlags.String) return "[string]";
  if (type.flags & ts.TypeFlags.Number) return "[number]";
  if (type.flags & ts.TypeFlags.Boolean) return "[boolean]";
  if (type.flags & ts.TypeFlags.BigInt) return "[bigint]";
  if (type.isUnion()) {
    return { union: type.types.map((member) => materializeType(checker, member, at, seen)) };
  }
  if (type.getCallSignatures().length > 0) return "[callable]";

  const identity = (type as ts.Type & { id?: number }).id;
  if (identity !== undefined) {
    if (seen.has(identity)) return "[cycle]";
    seen.add(identity);
  }

  if (checker.isTupleType(type)) {
    const arguments_ = checker.getTypeArguments(type as ts.TypeReference);
    return arguments_.map((item) => materializeType(checker, item, at, seen));
  }
  if (checker.isArrayType(type)) {
    const arguments_ = checker.getTypeArguments(type as ts.TypeReference);
    return arguments_.length === 1
      ? { array: materializeType(checker, arguments_[0]!, at, seen) }
      : { array: "[unknown]" };
  }

  const output: Record<string, unknown> = {};
  for (const property of checker.getPropertiesOfType(type).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (ignoredDescriptorKeys.has(property.name)) continue;
    const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? at;
    const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
    const materialized = materializeType(checker, propertyType, declaration, seen);
    if (materialized !== "[callable]") output[property.name] = materialized;
  }
  if (identity !== undefined) seen.delete(identity);
  if (Object.keys(output).length > 0) return output;
  return `[unsupported:${checker.typeToString(type)}]`;
}

function unwrap(expression: ts.Expression): ts.Expression {
  if (
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isParenthesizedExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return unwrap(expression.expression);
  }
  return expression;
}

function provenance(symbol: ts.Symbol): { valid: boolean; builder?: string } {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) {
    return { valid: false };
  }
  const initializer = declaration.initializer;
  if (
    ts.isAsExpression(initializer) ||
    ts.isTypeAssertionExpression(initializer)
  ) {
    return { valid: false };
  }
  const value = unwrap(initializer);
  if (!ts.isCallExpression(value)) return { valid: false };
  const callee = value.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : undefined;
  return { valid: name !== undefined && builders.has(name), builder: name };
}

const contributionAddress = (
  source: string,
  exportName: string,
  kind: ContributionKind,
) => {
  const module = source.replace(/\.ts$/, "").replace(/\/index$/, "").replaceAll("/", ".");
  if (kind === "function") return `api.${module}.${exportName}`;
  if (kind === "job") return `${module}.${exportName}`;
  return undefined;
};

function sourceDiagnostic(
  root: string,
  diagnostic: ts.Diagnostic,
): Diagnostic {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  return {
    phase: "check",
    source: diagnostic.file
      ? normalize(relative(root, diagnostic.file.fileName))
      : "<compiler>",
    message,
  };
}

export async function compileStatic(root: string): Promise<StaticCompilation> {
  await writeBootstrap(root);
  const configPath = join(root, ".ackerdb.config.json");
  const rawConfig = await readFile(configPath, "utf8");
  const config = JSON.parse(rawConfig) as {
    app: string;
    source: string;
    generated: string;
  };
  const sourceRoot = resolve(root, config.source);
  const generatedRoot = resolve(root, config.generated);
  const sourceFiles = await walk(sourceRoot);
  const appPath = resolve(root, config.app);
  const sdkPath = join(root, "sdk.ts");
  const bootstrapPath = join(generatedRoot, "server.ts");
  const rootNames = [appPath, sdkPath, bootstrapPath, ...sourceFiles];
  const program = ts.createProgram({
    rootNames,
    options: {
      allowImportingTsExtensions: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      types: ["bun"],
    },
  });
  const checker = program.getTypeChecker();
  const diagnostics: Diagnostic[] = ts
    .getPreEmitDiagnostics(program)
    .map((item) => sourceDiagnostic(root, item));
  const contributions: Contribution[] = [];

  if ((await readFile(appPath, "utf8")).includes("process.env")) {
    diagnostics.push({
      phase: "membership",
      source: normalize(relative(root, appPath)),
      export: "default",
      owner: "application",
      message:
        "Application membership depends on process.env; static compilation permits dynamic values only in config.ts, not contribution or Extension membership.",
    });
  }

  for (const file of sourceFiles) {
    const sourceFile = program.getSourceFile(file);
    const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
    if (!sourceFile || !moduleSymbol) continue;
    const source = normalize(relative(sourceRoot, file));
    for (const symbol of checker
      .getExportsOfModule(moduleSymbol)
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0] ?? sourceFile;
      const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
      if (type.flags & ts.TypeFlags.Any) {
        diagnostics.push({
          phase: "classify",
          source,
          export: symbol.name,
          owner: "application",
          message: "Export type is any; no client or plan artifact may be produced.",
        });
        continue;
      }
      if (type.flags & ts.TypeFlags.Unknown) {
        diagnostics.push({
          phase: "classify",
          source,
          export: symbol.name,
          owner: "application",
          message: "Export type is unresolved/unknown.",
        });
        continue;
      }
      const kindProperty = checker.getPropertyOfType(type, "__ackerKind");
      if (!kindProperty) continue;
      const kindAt = kindProperty.valueDeclaration ?? kindProperty.declarations?.[0] ?? declaration;
      const kindType = checker.getTypeOfSymbolAtLocation(kindProperty, kindAt);
      const kind = kindType.isStringLiteral()
        ? (kindType.value as ContributionKind)
        : undefined;
      if (!kind || !contributionKinds.includes(kind)) {
        diagnostics.push({
          phase: "classify",
          source,
          export: symbol.name,
          owner: "application",
          message: `Declaration kind is not one exact known literal: ${checker.typeToString(kindType)}.`,
        });
        continue;
      }
      const origin = provenance(symbol);
      if (!origin.valid) {
        diagnostics.push({
          phase: "provenance",
          source,
          export: symbol.name,
          kind,
          owner: "application",
          message:
            "Declaration type is branded but its initializer has no recognized builder provenance; asserted brands are rejected before artifacts.",
        });
        continue;
      }
      const descriptorProperty = checker.getPropertyOfType(type, "__ackerDescriptor");
      let descriptor: unknown;
      try {
        if (!descriptorProperty) throw new Error("declaration has no descriptor type");
        const descriptorAt =
          descriptorProperty.valueDeclaration ?? descriptorProperty.declarations?.[0] ?? declaration;
        descriptor = materializeType(
          checker,
          checker.getTypeOfSymbolAtLocation(descriptorProperty, descriptorAt),
          descriptorAt,
        );
      } catch (error) {
        diagnostics.push({
          phase: "descriptor",
          source,
          export: symbol.name,
          kind,
          owner: "application",
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      contributions.push({
        owner: "application",
        source,
        export: symbol.name,
        kind,
        identity: `application:${source}#${symbol.name}:${kind}`,
        address: contributionAddress(source, symbol.name, kind),
        descriptor,
      });
    }
  }

  const byAddress = new Map<string, Contribution>();
  for (const contribution of contributions) {
    if (!contribution.address) continue;
    const previous = byAddress.get(contribution.address);
    if (previous) {
      diagnostics.push({
        phase: "collision",
        source: contribution.source,
        export: contribution.export,
        kind: contribution.kind,
        owner: contribution.owner,
        message: `Address ${contribution.address} collides with ${previous.owner}:${previous.source}#${previous.export}:${previous.kind}.`,
      });
    } else byAddress.set(contribution.address, contribution);
  }

  let appDescriptor: unknown;
  const appSource = program.getSourceFile(appPath);
  const appSymbol = appSource && checker.getSymbolAtLocation(appSource);
  const defaultExport = appSymbol
    ? checker.getExportsOfModule(appSymbol).find((item) => item.name === "default")
    : undefined;
  if (defaultExport) {
    const at = defaultExport.valueDeclaration ?? defaultExport.declarations?.[0] ?? appSource!;
    try {
      appDescriptor = materializeType(
        checker,
        checker.getTypeOfSymbolAtLocation(defaultExport, at),
        at,
      );
    } catch (error) {
      diagnostics.push({
        phase: "descriptor",
        source: normalize(relative(root, appPath)),
        export: "default",
        owner: "application",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const inputs: InputRecord[] = [
    {
      source: ".ackerdb.config.json",
      digest: sha256(rawConfig),
      role: "static-config",
    },
    {
      source: normalize(relative(root, appPath)),
      digest: sha256(await readFile(appPath)),
      role: "manifest",
    },
    ...(
      await Promise.all(
        sourceFiles.map(async (file) => ({
          source: normalize(relative(root, file)),
          digest: sha256(await readFile(file)),
          role: "source" as const,
        })),
      )
    ),
    {
      source: "typescript",
      digest: ts.version,
      role: "compiler",
    },
  ];
  const inputDigest = sha256(JSON.stringify(inputs));

  return {
    root,
    sourceRoot,
    generatedRoot,
    sources: sourceFiles.map((file) => normalize(relative(sourceRoot, file))),
    inputs,
    inputDigest,
    contributions: contributions.sort((a, b) => a.identity.localeCompare(b.identity)),
    appDescriptor,
    diagnostics,
    program,
    checker,
    artifactsPublished: diagnostics.length === 0,
  };
}

function cleanRuntime(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "function") return undefined;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[cycle]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => cleanRuntime(item, seen));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.startsWith("__acker"))
      .map(([key, item]) => [key, cleanRuntime(item, seen)])
      .filter(([, item]) => item !== undefined),
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function linkRuntime(
  compilation: StaticCompilation,
): Promise<LinkResult> {
  globalThis.__ackerPrototypeEffects = [];
  const calls = new Map<string, number>();
  const promises = new Map<string, Promise<Record<string, unknown>>>();
  const namespaces: Record<string, Record<string, unknown>> = {};
  const load = (path: string) => {
    const canonical = resolve(path);
    calls.set(canonical, (calls.get(canonical) ?? 0) + 1);
    const previous = promises.get(canonical);
    if (previous) return previous;
    const promise = import(pathToFileURL(canonical).href) as Promise<Record<string, unknown>>;
    promises.set(canonical, promise);
    return promise;
  };

  const sdk = await load(join(compilation.root, "sdk.ts"));
  const authenticate = sdk.isAuthenticDeclaration as (value: unknown) => boolean;
  const linked: Contribution[] = [];
  let authentic = true;
  let promiseReused = true;

  for (const source of compilation.sources) {
    const path = join(compilation.sourceRoot, source);
    const first = load(path);
    const second = load(path);
    promiseReused &&= first === second;
    const namespace = await first;
    promiseReused &&= namespace === (await second);
    namespaces[source] = namespace;
    for (const exportName of Object.keys(namespace).sort()) {
      const value = namespace[exportName] as
        | {
            __ackerKind?: ContributionKind;
            __ackerDescriptor?: unknown;
          }
        | undefined;
      if (!value || typeof value !== "object" || !value.__ackerKind) continue;
      const ok = authenticate(value);
      authentic &&= ok;
      const kind = value.__ackerKind;
      linked.push({
        owner: "application",
        source,
        export: exportName,
        kind,
        identity: `application:${source}#${exportName}:${kind}`,
        address: contributionAddress(source, exportName, kind),
        descriptor: cleanRuntime(value.__ackerDescriptor),
      });
    }
  }

  const compiledDescriptors = new Map(
    compilation.contributions.map((item) => [
      item.identity,
      canonicalJson(item.descriptor),
    ]),
  );
  const descriptorParity = linked.every(
    (item) => compiledDescriptors.get(item.identity) === canonicalJson(item.descriptor),
  );

  return {
    modulesEvaluated: [...promises.keys()].map((path) => normalize(relative(compilation.root, path))),
    importCalls: Object.fromEntries(
      [...calls.entries()].map(([path, count]) => [
        normalize(relative(compilation.root, path)),
        count,
      ]),
    ),
    contributions: linked.sort((a, b) => a.identity.localeCompare(b.identity)),
    effects: [...(globalThis.__ackerPrototypeEffects ?? [])],
    authentic,
    descriptorParity,
    promiseReused,
    namespaces,
  };
}

export function renderTypeProjection(
  compilation: StaticCompilation,
  topology: "conditional" | "flat",
): string {
  const header = `// Application input digest: ${compilation.inputDigest}\n`;
  const functions = compilation.contributions.filter((item) => item.kind === "function");
  const jobs = compilation.contributions.filter((item) => item.kind === "job");
  const imports = compilation.sources
    .map(
      (source, index) =>
        `import type * as module${index} from ${JSON.stringify(`../backend/${source}`)};`,
    )
    .join("\n");
  const indexBySource = new Map(compilation.sources.map((source, index) => [source, index]));

  if (topology === "conditional") {
    return header + `${imports}\n\n` +
      `type Kind = "function" | "job" | "lifecycle" | "http" | "channel" | "realtime" | "mcp";\n` +
      `type Declaration<K extends Kind> = { readonly __ackerKind: K };\n` +
      `type ExportsOfKind<M, K extends Kind> = {\n` +
      `  [P in keyof M as M[P] extends Declaration<K> ? P : never]: M[P]\n` +
      `};\n` +
      `export interface SourceModules {\n${compilation.sources
        .map((source, index) => `  ${JSON.stringify(source)}: typeof module${index};`)
        .join("\n")}\n}\n` +
      `export type ClientFunctions = { [M in keyof SourceModules]: ExportsOfKind<SourceModules[M], "function"> };\n` +
      `export type ServerJobs = { [M in keyof SourceModules]: ExportsOfKind<SourceModules[M], "job"> };\n` +
      `export interface ServerContext { readonly jobs: ServerJobs }\n`;
  }

  return header + `${imports}\n\n` +
    `export interface ClientFunctions {\n${functions
      .map(
        (item) =>
          `  ${JSON.stringify(item.address!)}: typeof module${indexBySource.get(item.source)}[${JSON.stringify(item.export)}];`,
      )
      .join("\n")}\n}\n\n` +
    `export interface ServerJobs {\n${jobs
      .map(
        (item) =>
          `  ${JSON.stringify(item.address!)}: typeof module${indexBySource.get(item.source)}[${JSON.stringify(item.export)}];`,
      )
      .join("\n")}\n}\n\n` +
    `export interface ServerContext { readonly jobs: ServerJobs }\n`;
}

export function runtimeDescriptorSnapshot(compilation: StaticCompilation) {
  return {
    application: compilation.appDescriptor,
    schema: (compilation.appDescriptor as { schema?: unknown } | undefined)?.schema,
    functions: compilation.contributions
      .filter((item) => item.kind === "function")
      .map(({ identity, address, descriptor }) => ({ identity, address, descriptor })),
    routes: compilation.contributions
      .filter((item) => item.kind === "function" || item.kind === "http" || item.kind === "mcp")
      .map(({ identity, address, descriptor }) => ({ identity, address, descriptor })),
    jobs: compilation.contributions
      .filter((item) => item.kind === "job")
      .map(({ identity, address, descriptor }) => ({ identity, address, descriptor })),
    lifecycle: compilation.contributions
      .filter((item) => item.kind === "lifecycle")
      .map(({ identity, descriptor }) => ({ identity, descriptor })),
    openapi: compilation.contributions
      .filter((item) => item.kind === "function")
      .map((item) => ({
        operationId: item.address,
        route: (item.descriptor as { route?: string } | undefined)?.route,
      })),
  };
}

declare global {
  var __ackerPrototypeEffects: string[] | undefined;
}
