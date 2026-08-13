export const declarationBrand: unique symbol = Symbol.for(
  "ackerdb.source-topology-prototype",
) as never;

export type ContributionKind =
  | "function"
  | "http"
  | "channel"
  | "realtime"
  | "mcp"
  | "job"
  | "lifecycle";

export type Declaration<
  Kind extends ContributionKind,
  Descriptor,
  Result = unknown,
> = {
  readonly [declarationBrand]: Kind;
  readonly __ackerKind: Kind;
  readonly __ackerDescriptor: Descriptor;
  readonly descriptor: Descriptor;
  readonly result: Result;
};

const authentic = new WeakSet<object>();

function declaration<
  const Kind extends ContributionKind,
  const Descriptor extends Record<string, unknown>,
  Result = unknown,
>(kind: Kind, descriptor: Descriptor): Declaration<Kind, Descriptor, Result> {
  const value = {
    [declarationBrand]: kind,
    __ackerKind: kind,
    __ackerDescriptor: descriptor,
    descriptor,
    result: undefined,
  } as unknown as Declaration<Kind, Descriptor, Result>;
  authentic.add(value);
  return value;
}

export const isAuthenticDeclaration = (value: unknown): value is Declaration<
  ContributionKind,
  Record<string, unknown>
> => typeof value === "object" && value !== null && authentic.has(value);

export const string = () => ({ kind: "string" } as const);
export const number = () => ({ kind: "number" } as const);
export const object = <const Shape extends Record<string, unknown>>(shape: Shape) =>
  ({ kind: "object", shape } as const);
export const array = <const Value>(value: Value) =>
  ({ kind: "array", value } as const);

type FunctionDescriptor = {
  readonly route: string;
  readonly args: unknown;
  readonly returns: unknown;
  readonly access?: "public" | "protected";
  readonly handler?: (...args: never[]) => unknown;
};

export const query = <const Descriptor extends FunctionDescriptor, Result = unknown>(
  descriptor: Descriptor,
) => declaration<"function", Descriptor, Result>("function", descriptor);

export const mutation = <
  const Descriptor extends FunctionDescriptor,
  Result = unknown,
>(descriptor: Descriptor) =>
  declaration<"function", Descriptor, Result>("function", descriptor);

export const procedure = <
  const Descriptor extends FunctionDescriptor,
  Result = unknown,
>(descriptor: Descriptor) =>
  declaration<"function", Descriptor, Result>("function", descriptor);

export const rawHttp = <const Descriptor extends Record<string, unknown>>(
  descriptor: Descriptor,
) => declaration("http", descriptor);
export const channel = <const Descriptor extends Record<string, unknown>>(
  descriptor: Descriptor,
) => declaration("channel", descriptor);
export const realtime = <const Descriptor extends Record<string, unknown>>(
  descriptor: Descriptor,
) => declaration("realtime", descriptor);
export const mcp = <const Descriptor extends Record<string, unknown>>(
  descriptor: Descriptor,
) => declaration("mcp", descriptor);
export const job = <const Descriptor extends Record<string, unknown>, Result = unknown>(
  descriptor: Descriptor,
) => declaration<"job", Descriptor, Result>("job", descriptor);
export const lifecycle = <const Descriptor extends Record<string, unknown>>(
  descriptor: Descriptor,
) => declaration("lifecycle", descriptor);

export const defineApp = <const App extends Record<string, unknown>>(app: App) =>
  Object.freeze(app);
export const defineConfig = <const Config extends Record<string, unknown>>(
  config: Config,
) => Object.freeze(config);

declare global {
  var __ackerPrototypeEffects: string[] | undefined;
}

export function topLevelEffect(name: string): void {
  if ((globalThis as { __ackerAnalysisMode?: boolean }).__ackerAnalysisMode) {
    throw new Error(`analysis denied effect: ${name}`);
  }
  globalThis.__ackerPrototypeEffects ??= [];
  globalThis.__ackerPrototypeEffects.push(name);
}
