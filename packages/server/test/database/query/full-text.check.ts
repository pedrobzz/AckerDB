import {
  defineSchema,
  defineTable,
  v,
  type DbReader,
  type DbWriter,
} from "@dbzz/server";

const schema = defineSchema({
  documents: defineTable({
    id: v.primaryKey(),
    accountId: v.bigint(),
    title: v.string(),
    body: v.string().nullable(),
    embedding: v.vector(2).nullable(),
  })
    .fullText(["title", "body"])
    .index(["accountId"]),
  settings: defineTable({
    id: v.primaryKey(),
    key: v.string(),
  }),
});

declare const reader: DbReader<typeof schema>;
declare const writer: DbWriter<typeof schema>;

export async function _fullTextTypecheck(): Promise<void> {
  const rows = await reader.documents
    .fullText("body", "quiet restaurant")
    .where((row) => row.accountId.eq(1n))
    .take(10);
  const _title: string = rows[0]!.title;
  const _body: string | null = rows[0]!.body;

  const first = await writer.documents.fullText("title", "guide").first();
  const _firstTitle: string | undefined = first?.title;
  const nearest = reader.documents.nearest(
    "embedding",
    [1, 0],
    { metric: "cosine" },
  );

  // @ts-expect-error only explicitly declared full-text columns are accepted
  reader.documents.fullText("accountId", "1");
  // @ts-expect-error tables without declared targets do not expose fullText
  void reader.settings.fullText;

  const query = reader.documents.fullText("body", "restaurant");
  // @ts-expect-error full-text search is always bounded by take() or first()
  query.collect();
  // @ts-expect-error full-text rank order cannot be overridden
  query.orderBy((row) => row.id.asc());
  // @ts-expect-error full-text search does not paginate
  query.paginate({ pageSize: 10 });
  // @ts-expect-error full-text search does not expose an unbounded count
  query.count();
  // @ts-expect-error ranked retrievals cannot be combined into one query
  query.nearest("embedding", [1, 0], { metric: "cosine" });
  // @ts-expect-error ranked retrievals cannot be combined into one query
  nearest.fullText("body", "restaurant");
  // @ts-expect-error DBzz does not own hybrid rank fusion
  void reader.documents.hybridSearch;

  void _title;
  void _body;
  void _firstTitle;
}
