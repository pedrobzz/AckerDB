/** Compile-time assertions for the planner-independent `ctx.db` surface. */
import {
  defineSchema,
  defineTable,
  v,
  type DbReader,
  type DbWriter,
} from "@ackerdb/server";

const schema = defineSchema({
  documents: defineTable({
    id: v.primaryKey(),
    tenantId: v.bigint(),
    status: v.enum("QueryCheckStatus", ["active", "archived"]),
    score: v.float(),
    note: v.string().nullable(),
    metadata: v.object({ source: v.string() }),
    nullableMetadata: v.object({ source: v.string() }).nullable(),
    embedding: v.vector(3).nullable(),
  }).index(["tenantId", "status"]),
  users: defineTable({
    id: v.primaryKey(),
    email: v.string(),
    externalId: v.string().nullable(),
    name: v.string(),
    payload: v.union("QueryCheckPayload", {
      text: v.string(),
      count: v.int(),
      empty: v.tag(),
    }),
  })
    .index(["email"], { unique: true })
    .index(["externalId"], { unique: true }),
  unionKeys: defineTable({
    id: v.primaryKey(),
    slug: v.string(),
    key: v.union("QueryCheckUnionKey", {
      text: v.string(),
      count: v.int(),
      empty: v.tag(),
    }),
    name: v.string(),
  })
    .index(["slug"], { unique: true })
    .index(["key"], { unique: true }),
});

declare const reader: DbReader<typeof schema>;
declare const writer: DbWriter<typeof schema>;

export async function _queryTypecheck(): Promise<void> {
  const rows = await reader.documents
    .query()
    .where((row) => row.tenantId.eq(1n))
    .where((row) =>
      row.status
        .in(["active", "archived"])
        .and(row.score.between(1, 5))
        .and(row.note.isNull().or(row.note.eq("kept"))),
    )
    .orderBy((row) => row.score.desc())
    .thenBy((row) => row.tenantId.asc())
    .take(10);
  const _score: number = rows[0]!.score;

  const page = await reader.documents.query().paginate({ pageSize: 10 });
  await reader.documents.query().paginate({ pageSize: 10, cursor: page.nextCursor });

  await reader.documents
    .query()
    .where((row) => row.nullableMetadata.isNull().or(row.embedding.isNotNull()))
    .collect();

  const textRows = await reader.users
    .query()
    .where((row) => row.payload.is("text"))
    .collect();
  const _text: string = textRows[0]!.payload.value;

  const textOrCount = await reader.users
    .query()
    .where((row) => row.payload.is("text").or(row.payload.is("count")))
    .collect();
  const _tag: "text" | "count" = textOrCount[0]!.payload.tag;

  const notText = await reader.users
    .query()
    .where((row) => row.payload.is("text").not())
    .collect();
  // @ts-expect-error negation does not claim a positive payload refinement
  const _notTextValue: string = notText[0]!.payload.value;

  // @ts-expect-error named index accessors were removed
  void reader.documents.byTenantIdStatus;
  // @ts-expect-error scans were replaced by query()
  void reader.documents.scan;
  // @ts-expect-error thenBy requires an initial orderBy
  reader.documents.query().thenBy((row) => row.id.asc());
  // @ts-expect-error a non-null column has no null predicate
  reader.documents.query().where((row) => row.status.isNull());
  // @ts-expect-error enums do not expose ordered range comparisons
  reader.documents.query().where((row) => row.status.lt("active"));
  // @ts-expect-error enum storage tags are stable identities, not logical sort order
  reader.documents.query().orderBy((row) => row.status.asc());
  // @ts-expect-error structured values have no scalar equality operator
  reader.documents.query().where((row) => row.metadata.eq({ source: "x" }));
  // @ts-expect-error nullable structured values add null checks, not scalar equality
  reader.documents.query().where((row) => row.nullableMetadata.eq({ source: "x" }));
  // @ts-expect-error vector values have no ordinary scalar equality operator
  reader.documents.query().where((row) => row.embedding.eq([1, 2, 3]));
  // @ts-expect-error unsupported columns are not predicate expressions
  reader.documents.query().where((row) => row.metadata);
  // @ts-expect-error unsupported columns are not order expressions
  reader.documents.query().orderBy((row) => row.embedding);
  // @ts-expect-error predicate expressions carry an unforgeable runtime-owned brand
  reader.documents.query().where(() => ({}));
  // @ts-expect-error order expressions carry an unforgeable runtime-owned brand
  reader.documents.query().orderBy(() => ({}));

  await writer.users.upsert(
    { email: "a@example.com" },
    { name: "A", payload: { tag: "empty", value: null } },
  );
  await writer.users.upsert({ email: "a@example.com" }, (existing) => ({
    name: existing?.name ?? "A",
    payload: existing?.payload ?? { tag: "empty", value: null },
  }));
  await writer.users.upsert(
    // @ts-expect-error nullable unique indexes are not structural upsert keys
    { externalId: "external" },
    { email: "a@example.com", name: "A", payload: { tag: "empty", value: null } },
  );
  await writer.users.upsert(
    { email: "a@example.com" },
    // @ts-expect-error key fields cannot also appear in upsert values
    { email: "changed@example.com", name: "A", payload: { tag: "empty", value: null } },
  );
  // @ts-expect-error upsert requires a non-null unique index key
  void writer.documents.upsert;

  await writer.unionKeys.upsert(
    { slug: "safe" },
    { key: { tag: "text", value: "payload" }, name: "Safe" },
  );
  await writer.unionKeys.upsert(
    { key: { tag: "text", value: "payload" } },
    { slug: "unsafe", name: "Unsafe" },
  );
  await writer.unionKeys.upsert(
    { key: { tag: "empty", value: null } },
    { slug: "empty", name: "Empty" },
  );
}
