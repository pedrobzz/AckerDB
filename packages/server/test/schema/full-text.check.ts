import {
  defineTable,
  v,
  type TableFullTextColumns,
} from "@ackerdb/server";

const documents = defineTable({
  id: v.primaryKey(),
  title: v.string(),
  body: v.string().nullable(),
  count: v.int(),
})
  .fullText(["title", "body"])
  .index(["title"]);

type Targets = TableFullTextColumns<typeof documents>[number];

const _title: Targets = "title";
const _body: Targets = "body";

// @ts-expect-error undeclared string columns are not full-text targets
const _missing: Targets = "missing";

defineTable({
  id: v.primaryKey(),
  body: v.string(),
  count: v.int(),
})
  // @ts-expect-error fullText accepts only direct string or nullable-string columns
  .fullText(["count"]);

void _title;
void _body;
void _missing;
