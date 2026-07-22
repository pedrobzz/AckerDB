import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, encode, type MutationMessage } from "@dbzz/core";
import {
  ANONYMOUS_PRINCIPAL,
  Engine,
  PRODUCTION_LIMITS,
  Registry,
  Runtime,
  defineSchema,
  defineTable,
  mutation,
  query,
  reconcile,
  v,
  type RuntimePublication,
  type RuntimeRequest,
  type SessionApplicationMessage,
  type SessionRuntimeContext,
} from "@dbzz/server";

const schema = defineSchema({
  documents: defineTable({
    id: v.primaryKey(),
    tenantId: v.bigint(),
    status: v.enum("ReactiveDocumentStatus", ["active", "archived"]),
    score: v.int(),
    title: v.string(),
    embedding: v.vector(2).nullable(),
  }).index(["tenantId", "status"]),
});

// Runtime integration is the boundary under test, not generated application types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

const functions = {
  documents: {
    active: query({
      access: "public",
      args: { tenantId: v.bigint() },
      handler: (ctx: Ctx, args: Ctx) =>
        ctx.db.documents
          .query()
          .where((row: Ctx) => row.tenantId.eq(args.tenantId).and(row.status.eq("active")))
          .collect(),
    }),
    nearest: query({
      access: "public",
      args: { tenantId: v.bigint() },
      handler: (ctx: Ctx, args: Ctx) =>
        ctx.db.documents
          .nearest("embedding", [1, 0], { metric: "l2" })
          .where((row: Ctx) => row.tenantId.eq(args.tenantId))
          .take(1),
    }),
    insert: mutation({
      access: "public",
      args: {
        tenantId: v.bigint(),
        status: v.enum("ReactiveInsertStatus", ["active", "archived"]),
        score: v.int(),
        title: v.string(),
        embedding: v.vector(2).nullable(),
      },
      handler: (ctx: Ctx, args: Ctx) => ctx.db.documents.insert(args),
    }),
    move: mutation({
      access: "public",
      args: { id: v.bigint(), tenantId: v.bigint() },
      handler: (ctx: Ctx, args: Ctx) =>
        ctx.db.documents.patch(args.id, { tenantId: args.tenantId }),
    }),
    setStatus: mutation({
      access: "public",
      args: {
        id: v.bigint(),
        status: v.enum("ReactivePatchStatus", ["active", "archived"]),
      },
      handler: (ctx: Ctx, args: Ctx) =>
        ctx.db.documents.patch(args.id, { status: args.status }),
    }),
    setEmbedding: mutation({
      access: "public",
      args: { id: v.bigint(), embedding: v.vector(2) },
      handler: (ctx: Ctx, args: Ctx) =>
        ctx.db.documents.patch(args.id, { embedding: args.embedding }),
    }),
    remove: mutation({
      access: "public",
      args: { id: v.bigint() },
      handler: (ctx: Ctx, args: Ctx) => ctx.db.documents.delete(args.id),
    }),
  },
};

function request<Message>(message: Message): RuntimeRequest<Message> {
  return { message, bytes: Buffer.byteLength(encode(message)) };
}

function uuidV7(now: number, sequence: number): string {
  const timestamp = now.toString(16).padStart(12, "0");
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

class SessionHarness {
  readonly publications: SessionApplicationMessage[] = [];
  readonly controller = new AbortController();
  readonly context: SessionRuntimeContext;

  constructor(private readonly runtime: Runtime) {
    this.context = Object.freeze({
      clientSessionId: "query-reactivity-session",
      principal: ANONYMOUS_PRINCIPAL,
      fairnessKey: "query-reactivity-test",
      authEpoch: 0,
      signal: this.controller.signal,
      publish: async (publication: RuntimePublication) => {
        this.publications.push(publication.message);
        return true;
      },
    });
  }

  open(): Promise<void> {
    return this.runtime.openSession(this.context);
  }

  mutation(id: number, ref: string, args: unknown) {
    const issuedAt = Date.now();
    const message: MutationMessage = {
      v: PROTOCOL_VERSION,
      t: "m",
      id,
      ref,
      args,
      mutationRequestId: uuidV7(issuedAt, id),
      issuedAt,
    };
    return this.runtime.mutation(this.context, request(message));
  }

  subscribe(id: number, ref: string, args: unknown): Promise<void> {
    return this.runtime.subscribe(this.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id,
      ref,
      args,
    }));
  }

  transitions(id: number) {
    return this.publications.filter((message) => message.t === "transition" && message.id === id);
  }
}

describe("query prefix reactivity", () => {
  let directory: string;
  let engine: Engine;
  let runtime: Runtime;
  let session: SessionHarness;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "dbzz-query-reactivity-"));
    engine = new Engine(schema, join(directory, "data.db"));
    reconcile(engine);
    runtime = new Runtime({
      engine,
      registry: new Registry(functions),
      limits: PRODUCTION_LIMITS,
      telemetry: false,
    });
    session = new SessionHarness(runtime);
    await session.open();
  });

  afterEach(async () => {
    session.controller.abort();
    await runtime.drain().catch(() => {});
    engine.close("clean");
    rmSync(directory, { recursive: true, force: true });
  });

  async function insert(
    requestId: number,
    tenantId: bigint,
    status: "active" | "archived",
    title: string,
    embedding: readonly number[] | null,
  ): Promise<bigint> {
    const result = await session.mutation(requestId, "documents.insert", {
      tenantId,
      status,
      score: requestId,
      title,
      embedding,
    });
    return result.value as bigint;
  }

  test("updates across a filtered predicate on insert, patch, and delete", async () => {
    const outside = await insert(1, 2n, "active", "outside", null);
    await session.subscribe(10, "documents.active", { tenantId: 1n });
    expect(session.transitions(10).at(-1)).toMatchObject({
      transition: { kind: "reset", value: [] },
    });

    const movedInside = await session.mutation(2, "documents.move", { id: outside, tenantId: 1n });
    expect(movedInside.receipt.obligations).toEqual([10]);
    expect(session.transitions(10).at(-1)).toMatchObject({
      transition: { kind: "update", value: [expect.objectContaining({ title: "outside" })] },
    });

    const removedByPredicate = await session.mutation(3, "documents.setStatus", {
      id: outside,
      status: "archived",
    });
    expect(removedByPredicate.receipt.obligations).toEqual([10]);
    expect(session.transitions(10).at(-1)).toMatchObject({
      transition: { kind: "update", value: [] },
    });

    const inserted = await insert(4, 1n, "active", "inserted", null);
    expect(session.transitions(10).at(-1)).toMatchObject({
      transition: { kind: "update", value: [expect.objectContaining({ id: inserted })] },
    });
    const deleted = await session.mutation(5, "documents.remove", { id: inserted });
    expect(deleted.receipt.obligations).toEqual([10]);
    expect(session.transitions(10).at(-1)).toMatchObject({
      transition: { kind: "update", value: [] },
    });
  });

  test("suppresses unrelated writes and re-ranks when a nonwinner becomes nearest", async () => {
    await insert(1, 1n, "active", "current winner", [0, 1]);
    const challenger = await insert(2, 1n, "active", "challenger", [-1, 0]);
    await session.subscribe(20, "documents.nearest", { tenantId: 1n });
    expect(session.transitions(20).at(-1)).toMatchObject({
      transition: {
        kind: "reset",
        value: [{ row: expect.objectContaining({ title: "current winner" }) }],
      },
    });

    const transitionsBeforeUnrelatedWrite = session.transitions(20).length;
    const unrelated = await insert(3, 2n, "active", "other tenant", [1, 0]);
    expect(unrelated).toBeGreaterThan(0n);
    const unrelatedReceipt = session.publications.findLast(
      (message) => message.t === "ok" && message.kind === "mutation" && message.id === 3,
    );
    expect(unrelatedReceipt).toMatchObject({ receipt: { obligations: [] } });
    expect(session.transitions(20)).toHaveLength(transitionsBeforeUnrelatedWrite);

    const reranked = await session.mutation(4, "documents.setEmbedding", {
      id: challenger,
      embedding: [1, 0],
    });
    expect(reranked.receipt.obligations).toEqual([20]);
    expect(session.transitions(20).at(-1)).toMatchObject({
      transition: {
        kind: "update",
        value: [{ row: expect.objectContaining({ id: challenger, title: "challenger" }), distance: 0 }],
      },
    });
  });
});
