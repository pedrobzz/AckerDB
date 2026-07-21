import {
  defineApp,
  type AppPluginCapabilities,
  type AppPlugins,
  type AppSchema,
} from "../src/app.ts";
import { definePlugin } from "../src/plugins.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import { v } from "../src/v.ts";

const rootSchema = defineSchema({
  users: defineTable({ id: v.primaryKey() }),
});

const emptyApp = defineApp({ schema: rootSchema });
const exactSchema: AppSchema<typeof emptyApp> = rootSchema;
void exactSchema;
// @ts-expect-error omitted Plugins produce an exact empty mount map
const absentMount: keyof AppPlugins<typeof emptyApp> = "store";
void absentMount;

const storePlugin = definePlugin({
  id: "@checks/app-store",
  schema: defineSchema({}),
  create: ({ query, mutation, procedure }) => ({
    exports: {
      read: query({
        args: { key: v.string() },
        returns: v.string().optional(),
        expose: (call) => (key: string) => call({ key }),
        handler: () => undefined,
      }),
      write: mutation({
        args: { key: v.string(), value: v.string() },
        returns: v.boolean(),
        expose: (call) => (key: string, value: string) => call({ key, value }),
        handler: () => true,
      }),
      refresh: procedure({
        args: {},
        returns: v.int(),
        expose: (call) => () => call({}),
        handler: () => 0,
      }),
    },
  }),
});

const store = storePlugin();
const mountedApp = defineApp({ schema: rootSchema, plugins: { store } });
const mountedStore: typeof store = mountedApp.plugins.store;
void mountedStore;
// @ts-expect-error mount names remain exact
mountedApp.plugins.other;
// @ts-expect-error assembled mount maps are readonly
mountedApp.plugins.store = store;

declare const queryPlugins: AppPluginCapabilities<typeof mountedApp, "query">;
const queryRead: Promise<string | undefined> = queryPlugins.store.read("key");
// @ts-expect-error query contexts expose no Plugin mutations
queryPlugins.store.write;
// @ts-expect-error query contexts expose no Plugin procedures
queryPlugins.store.refresh;

declare const mutationPlugins: AppPluginCapabilities<typeof mountedApp, "mutation">;
const mutationRead: Promise<string | undefined> = mutationPlugins.store.read("key");
const mutationWrite: Promise<boolean> = mutationPlugins.store.write("key", "value");
// @ts-expect-error mutation and transaction contexts expose no Plugin procedures
mutationPlugins.store.refresh;

declare const procedurePlugins: AppPluginCapabilities<typeof mountedApp, "procedure">;
const procedureRead: Promise<string | undefined> = procedurePlugins.store.read("key");
const procedureWrite: Promise<boolean> = procedurePlugins.store.write("key", "value");
const procedureRefresh: Promise<number> = procedurePlugins.store.refresh();

const mutationOnlyPlugin = definePlugin({
  id: "@checks/app-mutation-only",
  schema: defineSchema({}),
  create: ({ mutation }) => ({
    exports: {
      write: mutation({
        args: { value: v.string() },
        returns: v.boolean(),
        expose: (call) => (value: string) => call({ value }),
        handler: () => true,
      }),
    },
  }),
});
const mutationOnlyApp = defineApp({
  schema: rootSchema,
  plugins: { writer: mutationOnlyPlugin() },
});
declare const mutationOnlyQueryPlugins: AppPluginCapabilities<
  typeof mutationOnlyApp,
  "query"
>;
// @ts-expect-error a mount with no legal operations is absent, not an empty object
mutationOnlyQueryPlugins.writer;
declare const mutationOnlyMutationPlugins: AppPluginCapabilities<
  typeof mutationOnlyApp,
  "mutation"
>;
const mutationOnlyWrite: Promise<boolean> = mutationOnlyMutationPlugins.writer.write(
  "value",
);

void queryRead;
void mutationRead;
void mutationWrite;
void procedureRead;
void procedureWrite;
void procedureRefresh;
void mutationOnlyWrite;

// @ts-expect-error components is not an application assembly surface
defineApp({ schema: rootSchema, components: { store } });
