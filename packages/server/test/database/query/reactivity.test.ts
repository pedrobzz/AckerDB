import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACKERDB_VERSION, encode, type MutationMessage } from "@ackerdb/core";
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
} from "@ackerdb/server";

const schema = defineSchema({
  documents: defineTable({
    id: v.primaryKey(),
    tenantId: v.bigint(),
    status: v.enum("ReactiveDocumentStatus", ["active", "archived"]),
    score: v.int(),
    title: v.string(),
    embedding: v.vector(2).nullable(),
  }).index(["tenantId", "status"]),
  permissions: defineTable({
    id: v.primaryKey(),
    allowed: v.boolean(),
  }),
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
    allowedActive: query({
      access: async (ctx: Ctx, args: Ctx) =>
        (await ctx.db.permissions.get(args.permissionId))?.allowed === true,
      args: { tenantId: v.bigint(), permissionId: v.bigint() },
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
    unionBranches: query({
      access: "public",
      args: {},
      handler: (ctx: Ctx) =>
        ctx.db.documents
          .query()
          .where((row: Ctx) =>
            row.tenantId.eq(1n).and(row.status.eq("active")).or(
              row.tenantId.eq(2n).and(row.status.eq("archived")),
            )
          )
          .collect(),
    }),
    membership: query({
      access: "public",
      args: {},
      handler: (ctx: Ctx) =>
        ctx.db.documents
          .query()
          .where((row: Ctx) =>
            row.tenantId.in([3n, 4n]).and(row.status.eq("active"))
          )
          .collect(),
    }),
    range: query({
      access: "public",
      args: {},
      handler: (ctx: Ctx) =>
        ctx.db.documents
          .query()
          .where((row: Ctx) => row.tenantId.eq(5n).and(row.score.between(10, 20)))
          .collect(),
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
    setScore: mutation({
      access: "public",
      args: { id: v.bigint(), score: v.int() },
      handler: (ctx: Ctx, args: Ctx) =>
        ctx.db.documents.patch(args.id, { score: args.score }),
    }),
    setTitle: mutation({
      access: "public",
      args: { id: v.bigint(), title: v.string() },
      handler: (ctx: Ctx, args: Ctx) =>
        ctx.db.documents.patch(args.id, { title: args.title }),
    }),
    remove: mutation({
      access: "public",
      args: { id: v.bigint() },
      handler: (ctx: Ctx, args: Ctx) => ctx.db.documents.delete(args.id),
    }),
  },
  permissions: {
    insert: mutation({
      access: "public",
      args: { allowed: v.boolean() },
      handler: (ctx: Ctx, args: Ctx) => ctx.db.permissions.insert(args),
    }),
    setAllowed: mutation({
      access: "public",
      args: { id: v.bigint(), allowed: v.boolean() },
      handler: (ctx: Ctx, args: Ctx) =>
        ctx.db.permissions.patch(args.id, { allowed: args.allowed }),
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

  constructor(
    private readonly runtime: Runtime,
    clientSessionId = "query-reactivity-session",
  ) {
    this.context = Object.freeze({
      clientSessionId,
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
    directory = mkdtempSync(join(tmpdir(), "ackerdb-query-reactivity-"));
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
    const result = await session.mutation(requestId, "api.documents.insert", {
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
    await session.subscribe(10, "api.documents.active", { tenantId: 1n });
    expect(session.transitions(10).at(-1)).toMatchObject({
      transition: { kind: "reset", value: [] },
    });

    const movedInside = await session.mutation(2, "api.documents.move", { id: outside, tenantId: 1n });
    expect(movedInside.receipt.obligations).toEqual([10]);
    expect(session.transitions(10).at(-1)).toMatchObject({
      transition: { kind: "update", value: [expect.objectContaining({ title: "outside" })] },
    });

    const removedByPredicate = await session.mutation(3, "api.documents.setStatus", {
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
    const deleted = await session.mutation(5, "api.documents.remove", { id: inserted });
    expect(deleted.receipt.obligations).toEqual([10]);
    expect(session.transitions(10).at(-1)).toMatchObject({
      transition: { kind: "update", value: [] },
    });
  });

  test("reacts across OR, IN, and range predicates without unrelated-prefix work", async () => {
    const unionCandidate = await insert(1, 1n, "archived", "union", null);
    const membershipCandidate = await insert(2, 9n, "active", "membership", null);
    const rangeCandidate = await insert(3, 5n, "active", "range", null);
    await session.mutation(4, "api.documents.setScore", { id: rangeCandidate, score: 5 });

    await session.subscribe(40, "api.documents.unionBranches", {});
    await session.subscribe(41, "api.documents.membership", {});
    await session.subscribe(42, "api.documents.range", {});
    for (const id of [40, 41, 42]) {
      expect(session.transitions(id).at(-1)).toMatchObject({
        transition: { kind: "reset", value: [] },
      });
    }

    const transitionCounts = [40, 41, 42].map((id) => session.transitions(id).length);
    const irrelevant = await session.mutation(5, "api.documents.setTitle", {
      id: membershipCandidate,
      title: "still outside",
    });
    expect(irrelevant.receipt.obligations).toEqual([]);
    expect([40, 41, 42].map((id) => session.transitions(id).length)).toEqual(transitionCounts);

    const enteredFirstUnionBranch = await session.mutation(6, "api.documents.setStatus", {
      id: unionCandidate,
      status: "active",
    });
    expect(enteredFirstUnionBranch.receipt.obligations).toEqual([40]);
    expect(session.transitions(40).at(-1)).toMatchObject({
      transition: { kind: "update", value: [expect.objectContaining({ id: unionCandidate })] },
    });
    const leftFirstUnionBranch = await session.mutation(7, "api.documents.setStatus", {
      id: unionCandidate,
      status: "archived",
    });
    expect(leftFirstUnionBranch.receipt.obligations).toEqual([40]);
    expect(session.transitions(40).at(-1)).toMatchObject({
      transition: { kind: "update", value: [] },
    });
    const enteredSecondUnionBranch = await session.mutation(8, "api.documents.move", {
      id: unionCandidate,
      tenantId: 2n,
    });
    expect(enteredSecondUnionBranch.receipt.obligations).toEqual([40]);
    expect(session.transitions(40).at(-1)).toMatchObject({
      transition: { kind: "update", value: [expect.objectContaining({ id: unionCandidate })] },
    });
    const leftSecondUnionBranch = await session.mutation(9, "api.documents.move", {
      id: unionCandidate,
      tenantId: 9n,
    });
    expect(leftSecondUnionBranch.receipt.obligations).toEqual([40]);
    expect(session.transitions(40).at(-1)).toMatchObject({
      transition: { kind: "update", value: [] },
    });

    const enteredMembership = await session.mutation(10, "api.documents.move", {
      id: membershipCandidate,
      tenantId: 3n,
    });
    expect(enteredMembership.receipt.obligations).toEqual([41]);
    expect(session.transitions(41).at(-1)).toMatchObject({
      transition: { kind: "update", value: [expect.objectContaining({ id: membershipCandidate })] },
    });
    const leftMembership = await session.mutation(11, "api.documents.move", {
      id: membershipCandidate,
      tenantId: 9n,
    });
    expect(leftMembership.receipt.obligations).toEqual([41]);
    expect(session.transitions(41).at(-1)).toMatchObject({
      transition: { kind: "update", value: [] },
    });

    const enteredRange = await session.mutation(12, "api.documents.setScore", {
      id: rangeCandidate,
      score: 15,
    });
    expect(enteredRange.receipt.obligations).toEqual([42]);
    expect(session.transitions(42).at(-1)).toMatchObject({
      transition: { kind: "update", value: [expect.objectContaining({ id: rangeCandidate })] },
    });
    const leftRange = await session.mutation(13, "api.documents.setScore", {
      id: rangeCandidate,
      score: 25,
    });
    expect(leftRange.receipt.obligations).toEqual([42]);
    expect(session.transitions(42).at(-1)).toMatchObject({
      transition: { kind: "update", value: [] },
    });
  });

  test("revokes a subscription when its database-backed access policy changes", async () => {
    const writer = new SessionHarness(runtime, "query-reactivity-writer");
    await writer.open();
    const permission = await writer.mutation(1, "api.permissions.insert", { allowed: true });
    await insert(2, 1n, "active", "allowed", null);

    await session.subscribe(30, "api.documents.allowedActive", {
      tenantId: 1n,
      permissionId: permission.value,
    });
    expect(session.transitions(30).at(-1)).toMatchObject({
      transition: {
        kind: "reset",
        value: [expect.objectContaining({ title: "allowed" })],
      },
    });

    await writer.mutation(3, "api.permissions.setAllowed", {
      id: permission.value,
      allowed: false,
    });

    expect(session.transitions(30).at(-1)).toMatchObject({
      transition: { kind: "revoked", outcome: { code: "unauthenticated" } },
    });
    expect(runtime.status().reactive.queryListeners).toBe(0);
  });

  test("suppresses unrelated writes and re-ranks when a nonwinner becomes nearest", async () => {
    const winner = await insert(1, 1n, "active", "current winner", [0, 1]);
    const challenger = await insert(2, 1n, "active", "challenger", [-1, 0]);
    await session.subscribe(20, "api.documents.nearest", { tenantId: 1n });
    expect(session.transitions(20).at(-1)).toMatchObject({
      transition: {
        kind: "reset",
        value: [{ row: expect.objectContaining({ title: "current winner" }) }],
      },
    });

    const renamed = await session.mutation(3, "api.documents.setTitle", {
      id: winner,
      title: "renamed winner",
    });
    expect(renamed.receipt.obligations).toEqual([20]);
    expect(session.transitions(20).at(-1)).toMatchObject({
      transition: {
        kind: "update",
        value: [{ row: expect.objectContaining({ id: winner, title: "renamed winner" }) }],
      },
    });

    const transitionsBeforeUnrelatedWrite = session.transitions(20).length;
    const unrelated = await insert(4, 2n, "active", "other tenant", [1, 0]);
    expect(unrelated).toBeGreaterThan(0n);
    const unrelatedReceipt = session.publications.findLast(
      (message) => message.t === "ok" && message.kind === "mutation" && message.id === 4,
    );
    expect(unrelatedReceipt).toMatchObject({ receipt: { obligations: [] } });
    expect(session.transitions(20)).toHaveLength(transitionsBeforeUnrelatedWrite);

    const reranked = await session.mutation(5, "api.documents.setEmbedding", {
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
