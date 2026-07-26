import {
  defineSchema,
  defineTable,
  v,
  type DbReader,
} from "@ackerdb/server";

const schema = defineSchema({
  documents: defineTable({
    id: v.primaryKey(),
    accountId: v.bigint(),
    title: v.string(),
    embedding: v.vector(3).nullable(),
    summary: v.vector(2),
  }),
  settings: defineTable({
    id: v.primaryKey(),
    key: v.string(),
  }),
});

declare const db: DbReader<typeof schema>;

export async function _nearestTypecheck(): Promise<void> {
  const matches = await db.documents
    .nearest("embedding", [1, 2, 3] as const, { metric: "cosine" })
    .where((row) => row.accountId.eq(1n))
    .take(10);
  const _distance: number = matches[0]!.distance;
  const _title: string = matches[0]!.row.title;

  const first = await db.documents
    .nearest("summary", [1, 2], { metric: "dot" })
    .first();
  const _nullableTitle: string | undefined = first?.row.title;

  // @ts-expect-error nearest accepts only direct vector columns
  db.documents.nearest("title", [1, 2, 3], { metric: "cosine" });
  // @ts-expect-error exact search exposes only cosine, l2, and dot
  db.documents.nearest("embedding", [1, 2, 3], { metric: "manhattan" });
  // @ts-expect-error tables without stored vectors do not expose nearest
  void db.settings.nearest;
  // @ts-expect-error approximate search is intentionally absent from V1
  db.documents.approxNearest("embedding", [1, 2, 3], { metric: "cosine" });

  const nearest = db.documents.nearest("embedding", [1, 2, 3], { metric: "l2" });
  // @ts-expect-error nearest search is always bounded by take() or first()
  nearest.collect();
  // @ts-expect-error nearest results cannot be caller-reordered
  nearest.orderBy((row) => row.id.asc());
  // @ts-expect-error nearest search does not paginate
  nearest.paginate({ pageSize: 10 });

  void _distance;
  void _title;
  void _nullableTitle;
}
