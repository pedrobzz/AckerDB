/**
 * Compile-time assertions for the typed ctx.db surface. This file is never
 * executed — `bun run typecheck` failing (including an unused
 * @ts-expect-error) is the test.
 */
import {
  v,
  defineEventTable,
  defineSchema,
  defineTable,
  type DbReader,
  type DbWriter,
  type EventArgsOf,
} from "@dbzz/server";

const schema = defineSchema({
  payments: defineTable({
    id: v.primaryKey(),
    userId: v.bigint(),
    status: v.enum("PayStatusT", ["active", "failed"]),
    amount: v.float(),
    note: v.string().nullable(),
  })
    .index(["userId"])
    .index(["userId", "status", "amount"]),
  users: defineTable({
    id: v.primaryKey(),
    email: v.string(),
    name: v.string(),
    payload: v.union("UPayloadT", { text: v.string(), nothing: v.tag() }),
  })
    .index(["email"], { unique: true })
    .index(["payload"]),
  pings: defineEventTable({
    id: v.primaryKey(),
    channel: v.bigint(),
  }, {
    args: {
      channel: v.bigint(),
      label: v.string().nullable(),
      cursor: v.string().optional(),
      replacement: v.string().nullish(),
    },
    access: "public",
    matches: (row, args) => row.channel === args.channel,
  }),
});

type S = typeof schema;
type PingArgs = EventArgsOf<S, "pings">;
declare const rdb: DbReader<S>;
declare const wdb: DbWriter<S>;

export async function _typecheckUsage(): Promise<void> {
  const pingArgs: PingArgs = { channel: 1n, label: null };
  const completePingArgs: PingArgs = {
    channel: 1n,
    label: "live",
    cursor: undefined,
    replacement: null,
  };
  void pingArgs;
  void completePingArgs;
  // @ts-expect-error event subscription args retain their validator types
  const invalidPingArgs: PingArgs = { channel: 1, label: null };
  // @ts-expect-error nullable event args remain required; only optional/nullish keys may be omitted
  const missingNullablePingArg: PingArgs = { channel: 1n };
  void invalidPingArgs;
  void missingNullablePingArg;
  // rows come out exactly typed
  const p = await rdb.payments.get(1n);
  if (p !== null) {
    const _amount: number = p.amount;
    const _note: string | null = p.note;
    const _id: bigint = p.id;
  }

  // typed predicates are independent from declared index order
  const rows = await rdb.payments
    .query()
    .where((row) =>
      row.userId.eq(1n)
        .and(row.status.eq("active"))
        .and(row.amount.between(1, 2)),
    )
    .collect();
  const _amounts: number[] = rows.map((r) => r.amount);

  await rdb.payments.query().where((row) => row.userId.eq(1n)).count();
  await rdb.payments.query().where((row) => row.status.eq("active")).count();

  // @ts-expect-error unknown enum variant
  rdb.payments.query().where((row) => row.status.eq("bogus"));
  // @ts-expect-error bigint column takes bigint, not number
  rdb.payments.query().where((row) => row.userId.eq(1));
  // @ts-expect-error ranges over enum tags are not meaningful
  rdb.payments.query().where((row) => row.status.gte("active"));
  // @ts-expect-error named index accessors are not part of the public API
  void rdb.payments.byUserStatusAmount;

  // union variant predicates narrow the row type to the variant payload
  const texts = await rdb.users.query().where((row) => row.payload.is("text")).collect();
  const _payloadValue: string = texts[0]!.payload.value;

  // @ts-expect-error write methods do not exist on a query's ctx.db
  void rdb.payments.insert;

  // writer: insert / patch / upsert
  const id = await wdb.payments.insert({ userId: 1n, status: "active", amount: 5 }); // note optional
  await wdb.payments.patch(id, { note: null, amount: undefined });

  // .returning() resolves to the exact row type on every write
  const insertedRow = await wdb.payments.insert({ userId: 1n, status: "active", amount: 5 }).returning();
  const _insStatus: "active" | "failed" = insertedRow.status;
  const patchedRow = await wdb.payments.patch(id, { amount: 6 }).returning();
  const _patchNote: string | null = patchedRow.note;
  const removedRow = await wdb.payments.delete(id).returning(); // removed row or null
  // @ts-expect-error delete's returning row is nullable — the no-op case
  const _removedAmount: number = removedRow.amount;
  if (removedRow !== null) {
    const _amount: number = removedRow.amount;
  }
  const _deletedCount: number = await wdb.payments.deleteMany([id]);
  // @ts-expect-error bulk deletion accepts only primary-key bigints
  await wdb.payments.deleteMany([1]);
  const upserted = await wdb.users
    .upsert({ email: "a@x.com" }, { name: "A", payload: { tag: "nothing", value: null } })
    .returning();
  const _upsertEmail: string = upserted.email;
  // @ts-expect-error the primary key is assigned by the database
  await wdb.payments.insert({ id: 1n, userId: 1n, status: "active", amount: 5 });

  await wdb.users.upsert(
    { email: "a@x.com" },
    { name: "A", payload: { tag: "nothing", value: null } },
  );
  await wdb.users.upsert({ email: "a@x.com" }, (existing) => ({
    name: existing?.name ?? "A",
    payload: { tag: "nothing", value: null },
  }));
  // @ts-expect-error upsert only exists on tables with a non-null unique index
  void wdb.payments.upsert;

  // event tables: writer is insert-only, reader has no accessor at all
  await wdb.pings.insert({ channel: 1n });
  // @ts-expect-error event tables cannot be read
  void wdb.pings.get;
  // @ts-expect-error event tables do not exist on a reader
  void rdb.pings;
}
