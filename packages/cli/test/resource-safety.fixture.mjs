import { join } from "node:path";
import {
  Engine,
  PRODUCTION_LIMITS,
  Registry,
  Runtime,
  v,
  defineSchema,
  defineServiceLimits,
  defineTable,
  mutation,
  procedure,
  query,
  reconcile,
  serve,
  sseProcedure,
} from "@dbzz/server";

const KiB = 1024;
const port = Number(process.argv[2]);
const directory = process.argv[3];
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || directory === undefined) {
  throw new Error("fixture port and directory are required");
}

const schema = defineSchema({
  items: defineTable({
    id: v.primaryKey(),
    sequence: v.int(),
    payload: v.string(),
  }).index("by_sequence", ["sequence"]),
});

const streamPayload = "x".repeat(30 * KiB);
const functions = {
  items: {
    list: query({
      access: "public",
      args: {},
      handler: (ctx) => ctx.db.items.scan().collect(),
    }),
    large: query({
      access: "public",
      args: {},
      handler: async (ctx) => {
        const count = await ctx.db.items.scan().count();
        console.log("@@large-eval");
        return { count, payload: streamPayload };
      },
    }),
    add: mutation({
      access: "public",
      args: { sequence: v.int() },
      handler: (ctx, args) => ctx.db.items.insert({
        sequence: args.sequence,
        payload: `row-${args.sequence}`,
      }),
    }),
  },
  pressure: {
    echo: procedure({
      access: "public",
      args: { value: v.float() },
      handler: (_ctx, args) => args.value,
    }),
    collect: procedure({
      access: "public",
      args: {},
      handler: () => {
        Bun.gc(true);
        return null;
      },
    }),
    endless: sseProcedure({
      access: "public",
      args: {},
      yields: v.object({ payload: v.string() }),
      handler: () => {
        let emitted = false;
        return new ReadableStream({
          pull(controller) {
            if (emitted) return;
            emitted = true;
            controller.enqueue({ payload: streamPayload });
          },
        });
      },
    }),
    block: procedure({
      access: "authenticated",
      args: {},
      handler: async (ctx) => {
        console.log("@@block-start");
        await new Promise((resolve) => {
          if (ctx.abortSignal.aborted) resolve();
          else ctx.abortSignal.addEventListener("abort", resolve, { once: true });
        });
        console.log("@@block-abort");
        return null;
      },
    }),
  },
};

const verifier = {
  revocationBound: { kind: "token-expiration" },
  async verify(token) {
    // Keep one source-owned HTTP lease open while its peers are rejected, then
    // deterministically collide with the existing block-0 principal lease.
    if (token === "pressure") await Bun.sleep(50);
    const subject = token === "pressure" ? "block-0" : token;
    const principal = {
      issuer: "https://resource.test",
      subject,
      expiresAt: Date.now() + 60_000,
      tokenId: `token-${subject}`,
    };
    return token === "resource-status"
      ? { ...principal, kind: "workload", claims: { scope: "dbzz:status" } }
      : { ...principal, kind: "user", claims: {} };
  },
  subscribeInvalidation: () => () => {},
};

const queue = { maxItems: 4, maxBytes: 128 * KiB, maxAgeMs: 1_000 };
const limits = defineServiceLimits({
  ...PRODUCTION_LIMITS,
  maxConnections: 4,
  maxOperations: 4,
  maxOperationsPerCaller: 1,
  maxOperationsPerConnection: 1,
  readQueue: queue,
  writeQueue: queue,
  maxSubscriptionsPerConnection: 1,
  maxSubscriptions: 3,
  maxSharedSubscriptions: 3,
  maxSharedResultBytes: 128 * KiB,
  revalidationConcurrency: 1,
  revalidationQueue: queue,
  webSocket: { maxBytesPerConnection: 64 * KiB, maxBytes: 256 * KiB, maxStallMs: 2_000 },
  sse: { maxBytesPerStream: 64 * KiB, maxBytes: 96 * KiB, maxStallMs: 300 },
  maxRequestBytes: 32 * KiB,
  maxFrameBytes: 32 * KiB,
  resume: {
    maxTransitionsPerStream: 2,
    maxBytesPerStream: 64 * KiB,
    maxAgeMs: 100,
    maxBytes: 128 * KiB,
  },
  publication: { maxItems: 4, maxBytes: 128 * KiB },
  gracefulShutdownMs: 2_000,
});

const engine = new Engine(schema, join(directory, "data.db"));
reconcile(engine);
const runtime = new Runtime({
  engine,
  registry: new Registry(functions),
  verifier,
  limits,
  telemetry: false,
});
const server = serve({ runtime, port });

let shutdown;
const drain = () => shutdown ??= server.drain().then(
  () => engine.close("clean"),
  (error) => {
    engine.close("unclean");
    throw error;
  },
);
const onSignal = () => void drain().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);
console.log(`@@ready ${server.port}`);
await new Promise(() => {});
