import { describe, expect, test } from "bun:test";
import {
  defineSchema,
  defineTable,
  diffSnapshots,
  snapshotOf,
  v,
  type SchemaSnapshot,
} from "@dbzz/server";

const columns = () => ({
  id: v.primaryKey(),
  tenantId: v.bigint(),
  status: v.string(),
});

describe("structural indexes", () => {
  test("derives stable identities while preserving composite, prefix, and reversed indexes", () => {
    const table = defineTable(columns())
      .index(["tenantId"])
      .index(["tenantId", "status"])
      .index(["status", "tenantId"]);
    const equivalent = defineTable(columns())
      .index(["tenantId"])
      .index(["tenantId", "status"])
      .index(["status", "tenantId"]);

    expect(table.indexes.map(({ name }) => name)).toEqual(
      equivalent.indexes.map(({ name }) => name),
    );
    expect(new Set(table.indexes.map(({ name }) => name))).toHaveLength(3);
  });

  test("rejects repeated ordered columns even when configuration conflicts", () => {
    expect(() =>
      defineTable(columns())
        .index(["tenantId"])
        .index(["tenantId"], { unique: true }),
    ).toThrow("duplicate index columns");
  });

  test("treats former public names as ordinary drop/create snapshot changes", () => {
    const target = snapshotOf(
      defineSchema({ entries: defineTable(columns()).index(["tenantId"]) }),
    );
    const current: SchemaSnapshot = {
      version: 2,
      tables: {
        entries: {
          ...target.tables.entries!,
          indexes: [{
            name: "by_tenant",
            columns: ["tenantId"],
            unique: false,
            algorithm: "btree",
          }],
        },
      },
    };

    expect(diffSnapshots(current, target)[0]).toMatchObject({
      op: "table-altered",
      indexes: [
        { name: "by_tenant", op: "dropped" },
        { name: target.tables.entries!.indexes[0]!.name, op: "added" },
      ],
    });
  });
});
