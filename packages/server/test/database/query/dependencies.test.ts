import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Engine,
  defineSchema,
  defineTable,
  emitWriteKeys,
  ixKey,
  makeDbReader,
  scanKey,
  v,
} from "@ackerdb/server";
import {
  MAX_REACTIVE_DEPENDENCY_KEYS,
  recordPredicateDependencies,
} from "../../../src/database/query/dependencies.ts";
import type { PredicateNode } from "../../../src/database/query/predicate.ts";

const schema = defineSchema({
  documents: defineTable({
    id: v.primaryKey(),
    tenantId: v.bigint(),
    status: v.enum("DependencyDocumentStatus", ["active", "archived"]),
    shard: v.int(),
    rank: v.int().nullable(),
    label: v.string(),
    metadata: v.object({ source: v.string() }).nullable(),
    embedding: v.vector(2).nullable(),
  })
    // Equal-depth ties intentionally choose the first declared index.
    .index(["tenantId", "status", "shard"])
    .index(["status", "tenantId"])
    .index(["tenantId"])
    .index(["tenantId", "rank"]),
});

describe("predicate reactive dependencies", () => {
  let directory: string;
  let engine: Engine;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "ackerdb-query-dependencies-"));
    engine = new Engine(schema, join(directory, "data.db"));
    engine.createAll();
  });

  afterEach(() => {
    engine.close("clean");
    rmSync(directory, { recursive: true, force: true });
  });

  function index(columns: readonly string[]) {
    return engine.plan("documents").indexes.find((candidate) =>
      candidate.columns.length === columns.length &&
      candidate.columns.every((column, position) => column === columns[position])
    )!;
  }

  function key(columns: readonly string[], values: readonly unknown[]): string {
    return ixKey("documents", index(columns).name, values);
  }

  function statusTag(status: "active" | "archived"): number {
    return engine.plan("documents").columns.get("status")!.variantTag!(status)!;
  }

  async function dependencies(
    materialize: (documents: any) => Promise<unknown>,
  ): Promise<Set<string>> {
    const recorded = new Set<string>();
    const reader: any = makeDbReader(engine, engine.reader, {
      add: (dependency: string) => recorded.add(dependency),
    });
    await materialize(reader.documents);
    return recorded;
  }

  test("chooses the longest safe prefix independently of predicate order", async () => {
    const recorded = await dependencies((documents) =>
      documents
        .query()
        .where((row: any) =>
          row.shard.gt(2).and(
            row.status.eq("active").and(row.label.ne("hidden")).and(row.tenantId.eq(7n)),
          )
        )
        .first()
    );

    expect(recorded).toEqual(new Set([
      key(["tenantId", "status", "shard"], [7n, statusTag("active")]),
    ]));
  });

  test("keeps positive AND constraints around negative predicates and NOT", async () => {
    const recorded = await dependencies((documents) =>
      documents
        .query()
        .where((row: any) => row.status.eq("archived").not().and(row.tenantId.eq(4n)))
        .where((row: any) => row.rank.isNotNull())
        .count()
    );

    expect(recorded).toEqual(new Set([
      key(["tenantId", "status", "shard"], [4n]),
    ]));
  });

  test("records no dependency for a contradictory exact predicate", async () => {
    const recorded = await dependencies((documents) =>
      documents
        .query()
        .where((row: any) => row.tenantId.eq(1n).and(row.tenantId.eq(2n)))
        .first()
    );

    expect(recorded).toEqual(new Set());
  });

  test("records no dependency for an empty IN predicate", async () => {
    const recorded = await dependencies((documents) =>
      documents.query().where((row: any) => row.tenantId.in([])).first()
    );

    expect(recorded).toEqual(new Set());
  });

  test("uses null as an exact storage value but stops before isNotNull and ranges", async () => {
    const nullRecorded = await dependencies((documents) =>
      documents
        .query()
        .where((row: any) => row.rank.isNull().and(row.tenantId.eq(3n)))
        .first()
    );
    const rangeRecorded = await dependencies((documents) =>
      documents
        .query()
        .where((row: any) => row.tenantId.eq(3n).and(row.rank.between(1, 5)))
        .first()
    );
    const unsafeRange = await dependencies((documents) =>
      documents.query().where((row: any) => row.rank.gte(1)).first()
    );

    expect(nullRecorded).toEqual(new Set([
      key(["tenantId", "rank"], [3n, null]),
    ]));
    expect(rangeRecorded).toEqual(new Set([
      key(["tenantId", "status", "shard"], [3n]),
    ]));
    expect(unsafeRange).toEqual(new Set([scanKey("documents")]));
  });

  test("unions safe OR branches and scans when any branch has no safe prefix", async () => {
    const safe = await dependencies((documents) =>
      documents
        .query()
        .where((row: any) =>
          row.tenantId.eq(1n).and(row.status.eq("active")).or(
            row.tenantId.eq(2n).and(row.status.eq("archived")),
          )
        )
        .first()
    );
    const unsafe = await dependencies((documents) =>
      documents
        .query()
        .where((row: any) => row.tenantId.eq(1n).or(row.label.eq("unindexed")))
        .first()
    );

    expect(safe).toEqual(new Set([
      key(["tenantId", "status", "shard"], [1n, statusTag("active")]),
      key(["tenantId", "status", "shard"], [2n, statusTag("archived")]),
    ]));
    expect(unsafe).toEqual(new Set([scanKey("documents")]));
  });

  test("removes a deeper same-index OR dependency covered by a shallow prefix", async () => {
    const recorded = await dependencies((documents) =>
      documents
        .query()
        .where((row: any) =>
          row.tenantId.eq(1n).and(row.status.eq("active")).or(row.tenantId.eq(1n))
        )
        .first()
    );

    expect(recorded).toEqual(new Set([
      key(["tenantId", "status", "shard"], [1n]),
    ]));
  });

  test("keeps only the uncovered tuples from partially overlapping OR prefixes", async () => {
    const recorded = await dependencies((documents) =>
      documents
        .query()
        .where((row: any) =>
          row.tenantId.in([1n, 2n]).or(
            row.tenantId.in([2n, 3n]).and(row.status.eq("active")),
          )
        )
        .first()
    );

    expect(recorded).toEqual(new Set([
      key(["tenantId", "status", "shard"], [1n]),
      key(["tenantId", "status", "shard"], [2n]),
      key(["tenantId", "status", "shard"], [3n, statusTag("active")]),
    ]));
  });

  test("collapses a transitive same-index depth chain to its shallow prefix", async () => {
    const recorded = await dependencies((documents) =>
      documents
        .query()
        .where((row: any) =>
          row.tenantId.eq(4n).and(row.status.eq("active")).and(row.shard.eq(7)).or(
            row.tenantId.eq(4n).and(row.status.eq("active")),
          ).or(row.tenantId.eq(4n))
        )
        .first()
    );

    expect(recorded).toEqual(new Set([
      key(["tenantId", "status", "shard"], [4n]),
    ]));
  });

  test("does not collapse prefix-like values selected from different indexes", async () => {
    const recorded = await dependencies((documents) =>
      documents
        .query()
        .where((row: any) =>
          row.tenantId.eq(8n).and(row.rank.eq(2)).or(row.tenantId.eq(8n))
        )
        .first()
    );

    expect(recorded).toEqual(new Set([
      key(["tenantId", "status", "shard"], [8n]),
      key(["tenantId", "rank"], [8n, 2]),
    ]));
  });

  test("widens an over-budget OR as one sound dependency", async () => {
    const firstTenants = Array.from({ length: 33 }, (_, index) => BigInt(index + 1));
    const secondTenants = Array.from({ length: 33 }, (_, index) => BigInt(index + 34));

    const recorded = await dependencies((documents) =>
      documents
        .query()
        .where((row: any) =>
          row.tenantId.in(firstTenants).and(row.status.eq("active")).or(
            row.tenantId.in(secondTenants).and(row.status.eq("archived")),
          )
        )
        .first()
    );

    expect(recorded).toEqual(new Set([scanKey("documents")]));
  });

  test("widens more than 64 OR branches to their shared safe prefix", async () => {
    const recorded = await dependencies((documents) =>
      documents
        .query()
        .where((row: any) => {
          const branch = (shard: number) =>
            row.tenantId.eq(12n).and(row.status.eq("active")).and(row.shard.eq(shard));
          let predicate = branch(0);
          for (let shard = 1; shard <= MAX_REACTIVE_DEPENDENCY_KEYS; shard++) {
            predicate = predicate.or(branch(shard));
          }
          return predicate;
        })
        .first()
    );

    expect(recorded).toEqual(new Set([
      key(["tenantId", "status", "shard"], [12n, statusTag("active")]),
    ]));
  });

  test("deduplicates IN values and widens before Cartesian expansion exceeds the budget", async () => {
    const bounded = await dependencies((documents) =>
      documents
        .query()
        .where((row: any) =>
          row.tenantId.in([1n, 1n, 2n]).and(
            row.status.in(["active", "active", "archived"]),
          )
        )
        .first()
    );
    const tooManyShards = Array.from(
      { length: MAX_REACTIVE_DEPENDENCY_KEYS + 1 },
      (_, shard) => shard,
    );
    const widened = await dependencies((documents) =>
      documents
        .query()
        .where((row: any) => row.tenantId.eq(9n).and(row.shard.in(tooManyShards)))
        .first()
    );
    const scanned = await dependencies((documents) =>
      documents.query().where((row: any) => row.shard.in(tooManyShards)).first()
    );

    expect(bounded).toEqual(new Set([
      key(["tenantId", "status", "shard"], [1n, statusTag("active")]),
      key(["tenantId", "status", "shard"], [1n, statusTag("archived")]),
      key(["tenantId", "status", "shard"], [2n, statusTag("active")]),
      key(["tenantId", "status", "shard"], [2n, statusTag("archived")]),
    ]));
    expect(widened).toEqual(new Set([
      key(["tenantId", "status", "shard"], [9n]),
    ]));
    expect(scanned).toEqual(new Set([scanKey("documents")]));
  });

  test("deduplicates numeric exact values with SameValueZero semantics", async () => {
    const recorded = await dependencies((documents) =>
      documents
        .query()
        .where((row: any) => row.tenantId.eq(6n).and(row.rank.in([0, -0, 0])))
        .first()
    );

    expect(recorded).toEqual(new Set([
      key(["tenantId", "rank"], [6n, 0]),
    ]));
  });

  test("deduplicates repeated branches before applying the retained-key budget", async () => {
    const tenantIds = Array.from({ length: 40 }, (_, index) => BigInt(index + 1));
    const recorded = await dependencies((documents) =>
      documents
        .query()
        .where((row: any) => {
          // Selection deduplicates the second winner's concrete tuples before
          // enforcing the 64-key budget, so all 40 precise keys survive.
          const branch = row.tenantId.in(tenantIds);
          return branch.or(branch);
        })
        .first()
    );

    expect(recorded).toEqual(new Set(
      tenantIds.map((tenantId) => key(["tenantId", "status", "shard"], [tenantId])),
    ));
  });

  test("keeps a boundary-size fanout bounded without missing matching writes", async () => {
    const tenantIds = Array.from(
      { length: MAX_REACTIVE_DEPENDENCY_KEYS },
      (_, index) => BigInt(index + 1),
    );
    const recorded = await dependencies((documents) =>
      documents.query().where((row: any) => row.tenantId.in(tenantIds)).first()
    );

    expect(recorded.size).toBe(MAX_REACTIVE_DEPENDENCY_KEYS);
    for (const tenantId of tenantIds) {
      const writes = new Set<string>();
      emitWriteKeys(engine.plan("documents"), {
        id: tenantId,
        tenantId,
        status: "active",
        shard: 0,
        rank: null,
      }, writes);
      expect([...recorded].some((dependency) => writes.has(dependency))).toBe(true);
    }
  });

  test("ordinary and nearest reads extract the same predicate dependencies", async () => {
    const ordinary = await dependencies((documents) =>
      documents.query().where((row: any) => row.tenantId.eq(5n)).take(2)
    );
    const nearest = await dependencies((documents) =>
      documents
        .nearest("embedding", [1, 0], { metric: "l2" })
        .where((row: any) => row.tenantId.eq(5n))
        .take(2)
    );

    expect(nearest).toEqual(ordinary);
    expect(nearest).toEqual(new Set([
      key(["tenantId", "status", "shard"], [5n]),
    ]));
  });

  test("supports null predicates on nullable structured and vector columns", async () => {
    const recorded = await dependencies((documents) =>
      documents
        .query()
        .where((row: any) => row.metadata.isNull().or(row.embedding.isNotNull()))
        .first()
    );

    expect(recorded).toEqual(new Set([scanKey("documents")]));
  });

  test("conservatively intersects every matching write across a small exhaustive domain", () => {
    const active = statusTag("active");
    const archived = statusTag("archived");
    const eq = (column: string, value: unknown): PredicateNode =>
      ({ kind: "comparison", reference: { column }, op: "eq", value });
    const ne = (column: string, value: unknown): PredicateNode =>
      ({ kind: "comparison", reference: { column }, op: "ne", value });
    const cases: readonly (readonly PredicateNode[])[] = [
      [eq("tenantId", 1n), eq("status", active)],
      [{ kind: "in", column: "tenantId", values: [1n, 2n] }, {
        kind: "between",
        column: "shard",
        lower: 0,
        upper: 1,
      }],
      [{
        kind: "or",
        left: { kind: "and", left: eq("tenantId", 1n), right: eq("status", active) },
        right: { kind: "and", left: eq("tenantId", 2n), right: eq("status", archived) },
      }],
      [{
        kind: "and",
        left: eq("tenantId", 1n),
        right: { kind: "not", expression: eq("status", archived) },
      }],
      [{ kind: "and", left: eq("tenantId", 2n), right: ne("label", "hidden") }],
      [{ kind: "and", left: eq("tenantId", 1n), right: { kind: "null", column: "rank", isNull: true } }],
      [{ kind: "or", left: eq("tenantId", 1n), right: eq("label", "visible") }],
    ];
    const rows: Record<string, unknown>[] = [];
    for (const tenantId of [1n, 2n]) {
      for (const status of ["active", "archived"] as const) {
        for (const shard of [0, 1]) {
          for (const rank of [null, 1]) {
            for (const label of ["visible", "hidden"]) {
              rows.push({
                id: BigInt(rows.length + 1),
                tenantId,
                status,
                shard,
                rank,
                label,
                metadata: null,
                embedding: null,
              });
            }
          }
        }
      }
    }

    const plan = engine.plan("documents");
    const storageValue = (row: Record<string, unknown>, column: string): unknown =>
      plan.columns.get(column)!.toSql(row[column]);
    const compare = (left: unknown, right: unknown): number => {
      if (typeof left === "number" && typeof right === "number") return left - right;
      if (typeof left === "bigint" && typeof right === "bigint") {
        return left < right ? -1 : left > right ? 1 : 0;
      }
      if (typeof left === "string" && typeof right === "string") {
        return left < right ? -1 : left > right ? 1 : 0;
      }
      throw new Error("property-test comparison received unlike storage values");
    };
    const evaluate = (node: PredicateNode, row: Record<string, unknown>): boolean => {
      switch (node.kind) {
        case "comparison": {
          const value = storageValue(row, node.reference.column);
          if (value === null) return false;
          switch (node.op) {
            case "eq": return value === node.value;
            case "ne": return value !== node.value;
            case "lt": return compare(value, node.value) < 0;
            case "lte": return compare(value, node.value) <= 0;
            case "gt": return compare(value, node.value) > 0;
            case "gte": return compare(value, node.value) >= 0;
          }
        }
        case "in": {
          const value = storageValue(row, node.column);
          return value !== null && node.values.includes(value);
        }
        case "between": {
          const value = storageValue(row, node.column);
          return value !== null && compare(value, node.lower) >= 0 && compare(value, node.upper) <= 0;
        }
        case "null": return (storageValue(row, node.column) === null) === node.isNull;
        case "and": return evaluate(node.left, row) && evaluate(node.right, row);
        case "or": return evaluate(node.left, row) || evaluate(node.right, row);
        case "not": return !evaluate(node.expression, row);
      }
    };

    for (const predicates of cases) {
      const dependencies = new Set<string>();
      recordPredicateDependencies(plan, predicates, {
        add: (dependency) => dependencies.add(dependency),
      });
      for (const row of rows) {
        if (!predicates.every((predicate) => evaluate(predicate, row))) continue;
        const writes = new Set<string>();
        emitWriteKeys(plan, row, writes);
        expect([...dependencies].some((dependency) => writes.has(dependency))).toBe(true);
      }
    }
  });
});
