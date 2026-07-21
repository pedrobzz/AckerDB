import {
  assemblePlugins,
  definePlugin,
  definePluginContract,
  pluginMutation,
  pluginProcedure,
  pluginQuery,
  type PluginMutationCapabilities,
  type PluginProcedureCapabilities,
  type PluginQueryCapabilities,
} from "../src/plugins.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import { v, type StandardValidator } from "../src/v.ts";

const storeContract = definePluginContract({
  values: {
    read: pluginQuery({
      args: { key: v.string() },
      returns: v.string().optional(),
      expose: (call) => (key: string) => call({ key }),
    }),
    write: pluginMutation({
      args: { key: v.string(), value: v.string() },
      returns: v.boolean(),
      expose: (call) => (key: string, value: string) => call({ key, value }),
    }),
  },
  maintenance: {
    refresh: pluginProcedure({
      args: { eager: v.boolean().optional() },
      returns: v.int(),
    }),
  },
});

declare const queryCapability: PluginQueryCapabilities<typeof storeContract>;
declare const mutationCapability: PluginMutationCapabilities<typeof storeContract>;
declare const procedureCapability: PluginProcedureCapabilities<typeof storeContract>;

const queryRead: Promise<string | undefined> = queryCapability.values.read("key");
// @ts-expect-error expose replaces the canonical object argument exactly
queryCapability.values.read({ key: "key" });
// @ts-expect-error queries cannot call mutation operations
queryCapability.values.write;
// @ts-expect-error namespaces with no query operations are absent
queryCapability.maintenance;

const mutationRead: Promise<string | undefined> = mutationCapability.values.read("key");
const mutationWrite: Promise<boolean> = mutationCapability.values.write("key", "value");
// @ts-expect-error mutations cannot call procedure operations
mutationCapability.maintenance;

const procedureRead: Promise<string | undefined> = procedureCapability.values.read("key");
const procedureWrite: Promise<boolean> = procedureCapability.values.write("key", "value");
const procedureRefresh: Promise<number> = procedureCapability.maintenance.refresh({ eager: true });
// @ts-expect-error the default exposure is exactly one object argument
procedureCapability.maintenance.refresh(true);

void queryRead;
void mutationRead;
void mutationWrite;
void procedureRead;
void procedureWrite;
void procedureRefresh;

const privateSchema = defineSchema({
  entries: defineTable({
    id: v.primaryKey(),
    key: v.string(),
    value: v.string(),
  }).index("by_key", ["key"], { unique: true }),
});

const providerContract = definePluginContract({
  values: {
    read: pluginQuery({
      args: { key: v.string() },
      returns: v.string().optional(),
      expose: (call) => (key: string) => call({ key }),
    }),
    write: pluginMutation({
      args: { key: v.string(), value: v.string() },
      returns: v.boolean(),
      expose: (call) => (key: string, value: string) => call({ key, value }),
    }),
  },
  maintenance: {
    refresh: pluginProcedure({
      args: { eager: v.boolean().optional() },
      returns: v.int(),
    }),
  },
  extra: pluginQuery({ args: {}, returns: v.boolean() }),
});

const providerPlugin = definePlugin({
  id: "@checks/provider",
  schema: privateSchema,
  create: ({ query, mutation, procedure }) => ({
    exports: {
      values: {
        read: query(providerContract.values.read, async (ctx, args) => {
          const timestamp: number = ctx.timestamp;
          const mount: string = ctx.mount;
          const row = await ctx.db.entries.byKey((range) => range.eq("key", args.key)).unique();
          // @ts-expect-error Plugin handlers receive no ambient application auth
          ctx.auth;
          // @ts-expect-error Plugin private db exposes only its own schema
          ctx.db.applicationUsers;
          void timestamp;
          void mount;
          return row?.value;
        }),
        write: mutation(providerContract.values.write, async (ctx, args) => {
          const existing = await ctx.db.entries
            .byKey((range) => range.eq("key", args.key))
            .unique();
          if (existing === null) {
            await ctx.db.entries.insert({ key: args.key, value: args.value });
          } else {
            await ctx.db.entries.patch(existing.id, { value: args.value });
          }
          return true;
        }),
      },
      maintenance: {
        refresh: procedure(providerContract.maintenance.refresh, async (ctx, args) => {
          const aborted: boolean = ctx.abortSignal.aborted;
          const count = await ctx.tx(async (tx) => {
            const entries = await tx.db.entries.scan().collect();
            // @ts-expect-error transaction contexts do not gain procedure-only fields
            tx.abortSignal;
            return entries.length;
          });
          void aborted;
          return args.eager === true ? count : 0;
        }),
      },
      extra: query(providerContract.extra, () => true),
    },
  }),
});

const provider = providerPlugin();

const consumerPlugin = definePlugin({
  id: "@checks/consumer",
  schema: defineSchema({}),
  dependencies: { store: storeContract },
  create: ({ query, mutation, procedure }, config: { prefix: string }) => {
    // @ts-expect-error concrete providers are extracted before construction
    config.store;
    return {
      exports: {
        inspect: query({
          args: { key: v.string() },
          returns: v.string().optional(),
          handler: (ctx, args) => {
            ctx.store.values.read(`${config.prefix}:${args.key}`);
            // @ts-expect-error query dependencies expose no mutations
            ctx.store.values.write;
            // @ts-expect-error query dependencies expose no procedures
            ctx.store.maintenance;
            return undefined;
          },
        }),
        update: mutation({
          args: { key: v.string(), value: v.string() },
          returns: v.boolean(),
          handler: async (ctx, args) => {
            await ctx.store.values.read(args.key);
            await ctx.store.values.write(args.key, args.value);
            // @ts-expect-error mutation dependencies expose no procedures
            ctx.store.maintenance;
            return true;
          },
        }),
        refresh: procedure({
          args: {},
          returns: v.int(),
          handler: async (ctx) => {
            await ctx.store.values.read("key");
            await ctx.store.values.write("key", "value");
            await ctx.store.maintenance.refresh({});
            return ctx.tx(async (tx) => {
              await tx.store.values.read("key");
              await tx.store.values.write("key", "value");
              // @ts-expect-error explicit transactions exclude procedure operations
              tx.store.maintenance;
              return 1;
            });
          },
        }),
      },
    };
  },
});

const externalOnlyContract = definePluginContract({
  fetch: pluginProcedure({ args: {}, returns: v.string() }),
});

definePlugin({
  id: "@checks/external-consumer",
  schema: defineSchema({}),
  dependencies: { external: externalOnlyContract },
  create: ({ query, mutation, procedure }) => ({
    exports: {
      inspect: query({
        args: {},
        returns: v.boolean(),
        handler: (ctx) => {
          // @ts-expect-error dependency slots with no legal query operations are absent
          ctx.external;
          return true;
        },
      }),
      update: mutation({
        args: {},
        returns: v.boolean(),
        handler: (ctx) => {
          // @ts-expect-error dependency slots with no legal mutation operations are absent
          ctx.external;
          return true;
        },
      }),
      run: procedure({
        args: {},
        returns: v.string(),
        handler: (ctx) => {
          void ctx.external.fetch({});
          return ctx.tx((tx) => {
            // @ts-expect-error explicit transactions exclude procedure-only dependency slots
            tx.external;
            return "ok";
          });
        },
      }),
    },
  }),
});

const consumer = consumerPlugin({ store: provider, prefix: "tenant" });
const assembly = assemblePlugins({ provider, consumer });
const providerMount = assembly.mounts.provider;
const startupOrder: readonly ("provider" | "consumer")[] = assembly.order;
void providerMount;
void startupOrder;

// @ts-expect-error dependency slots are required in the one flat options object
consumerPlugin({ prefix: "tenant" });

const incompatiblePlugin = definePlugin({
  id: "@checks/incompatible",
  schema: defineSchema({}),
  create: ({ query }) => ({
    exports: {
      values: {
        read: query({
          args: { key: v.string() },
          returns: v.int(),
          handler: () => 1,
        }),
      },
    },
  }),
});

// @ts-expect-error provider result contracts are structurally incompatible
consumerPlugin({ store: incompatiblePlugin(), prefix: "tenant" });

// @ts-expect-error config keys cannot overlap declared dependency slots
definePlugin({
  id: "@checks/collision",
  schema: defineSchema({}),
  dependencies: { store: storeContract },
  create: (_builders, _config: { store: string }) => ({ exports: {} }),
});

const semanticContract = definePluginContract({
  transform: pluginQuery({
    args: { value: v.string() },
    returns: v.string(),
  }),
});
const semanticConsumerPlugin = definePlugin({
  id: "@checks/semantic-consumer",
  schema: defineSchema({}),
  dependencies: { transformer: semanticContract },
  create: () => ({ exports: {} }),
});

declare const normalizingText: StandardValidator<number, "string", string>;
const normalizingProvider = definePlugin({
  id: "@checks/normalizing-provider",
  schema: defineSchema({}),
  create: ({ query }) => ({
    exports: {
      transform: query({
        args: { value: normalizingText },
        returns: v.string(),
        handler: (_ctx, args) => args.value.toString(),
      }),
    },
  }),
})();

// Provider normalization is private; compatibility compares its accepted input.
semanticConsumerPlugin({ transformer: normalizingProvider });

declare const numberInputText: StandardValidator<number, "string", number>;
const wrongSemanticInput = definePlugin({
  id: "@checks/wrong-semantic-input",
  schema: defineSchema({}),
  create: ({ query }) => ({
    exports: {
      transform: query({
        args: { value: numberInputText },
        returns: v.string(),
        handler: (_ctx, args) => args.value.toString(),
      }),
    },
  }),
})();
// @ts-expect-error provider canonical input is incompatible
semanticConsumerPlugin({ transformer: wrongSemanticInput });

const wrongSemanticResult = definePlugin({
  id: "@checks/wrong-semantic-result",
  schema: defineSchema({}),
  create: ({ query }) => ({
    exports: {
      transform: query({
        args: { value: normalizingText },
        returns: v.int(),
        handler: () => 1,
      }),
    },
  }),
})();
// @ts-expect-error provider canonical result is incompatible
semanticConsumerPlugin({ transformer: wrongSemanticResult });

const wrongSemanticKind = definePlugin({
  id: "@checks/wrong-semantic-kind",
  schema: defineSchema({}),
  create: ({ mutation }) => ({
    exports: {
      transform: mutation({
        args: { value: normalizingText },
        returns: v.string(),
        handler: (_ctx, args) => args.value.toString(),
      }),
    },
  }),
})();
// @ts-expect-error provider operation kind is incompatible
semanticConsumerPlugin({ transformer: wrongSemanticKind });

const missingSemanticOperation = definePlugin({
  id: "@checks/missing-semantic-operation",
  schema: defineSchema({}),
  create: () => ({ exports: {} }),
})();
// @ts-expect-error required provider operation is missing
semanticConsumerPlugin({ transformer: missingSemanticOperation });
