import {
  AckerDBServer,
  PRODUCTION_LIMITS,
  Registry,
  Runtime,
  collectDefinitions,
  type AckerDBServerOptions,
  type CollectedDefinition,
  type RuntimeOptions,
} from "@ackerdb/server";

export type TestDefinitionModules = Readonly<
  Record<string, Readonly<Record<string, unknown>>>
>;

/** Give in-memory modules the same collected shape as production discovery. */
export function testDefinitions(
  ...sources: readonly TestDefinitionModules[]
): readonly CollectedDefinition[] {
  return collectDefinitions(sources.flatMap((modules, source) =>
    Object.entries(modules).map(([name, exports]) => ({
      name,
      origin: `<test:${source}:${name}>`,
      exports,
    }))));
}

/** Build the addressed Registry used by direct Runtime tests. */
export function testRegistry(...sources: readonly TestDefinitionModules[]): Registry {
  return Registry.from(testDefinitions(...sources));
}

export interface TestServerOptions extends Omit<RuntimeOptions, "registry"> {
  readonly definitions: readonly CollectedDefinition[];
  readonly port?: number;
  readonly server?: Omit<AckerDBServerOptions, "limits" | "port">;
}

/** Own the ordinary real-listener lifecycle used by integration tests. */
export async function startTestServer(options: TestServerOptions) {
  const {
    definitions,
    port = 0,
    server: serverOptions,
    ...runtimeOptions
  } = options;
  const limits = options.limits ?? PRODUCTION_LIMITS;
  const server = new AckerDBServer({
    ...serverOptions,
    limits,
    port,
  });
  const runtime = new Runtime({
    ...runtimeOptions,
    limits,
    registry: server.registerDefinitions(definitions),
  });
  await runtime.start();
  server.activate(runtime);

  return {
    server,
    runtime,
    base: `http://127.0.0.1:${server.port}`,
    async close(): Promise<void> {
      await server.drain();
      options.engine.close("clean");
    },
  };
}
