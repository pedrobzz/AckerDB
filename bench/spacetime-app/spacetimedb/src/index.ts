import { schema, table, t } from "spacetimedb/server";

const DOCUMENT_PARTITIONS = 64;
const DOCUMENTS_PER_PARTITION = 128;
const DOCUMENT_COUNT = DOCUMENT_PARTITIONS * DOCUMENTS_PER_PARTITION;
const ACCOUNT_COUNT = 2_048;
const ACCOUNT_BALANCE = 1_000_000;
const PAYLOAD_BYTES = 128;
const FNV_OFFSET = 2_166_136_261;
const FNV_PRIME = 16_777_619;

function mix(checksum: number, value: number): number {
  return Math.imul(checksum ^ (value >>> 0), FNV_PRIME) >>> 0;
}

function mixText(checksum: number, value: string): number {
  for (let i = 0; i < value.length; i++) checksum = mix(checksum, value.charCodeAt(i));
  return checksum;
}

function payload(prefix: string): string {
  return prefix.padEnd(PAYLOAD_BYTES, "x").slice(0, PAYLOAD_BYTES);
}

function documentPayload(partition: number, rank: number): string {
  return payload(`document:${partition}:rank:${rank}:`);
}

function channelPayload(channel: number, version: number, nonce: number): string {
  return payload(`channel:${channel}:version:${version}:nonce:${nonce}:`);
}

function channelChecksum(channel: number, version: number, nonce: number, body: string): number {
  return mixText(mix(mix(mix(FNV_OFFSET, channel), version), nonce), body);
}

function validateBatch(start: number, count: number, total: number): void {
  if (count === 0 || start + count > total) {
    throw new Error(`invalid batch start=${start} count=${count} total=${total}`);
  }
}

function validateChannelBatch(count: number): void {
  if (count === 0) throw new Error("channel batch must not be empty");
}

const documents = table(
  {
    public: true,
    indexes: [
      {
        accessor: "by_partition_rank",
        algorithm: "btree",
        columns: ["partition", "rank"],
      },
    ],
  },
  {
    id: t.u32().primaryKey(),
    partition: t.u32(),
    rank: t.u32(),
    score: t.u32(),
    payload: t.string(),
  },
);

const accounts = table(
  { public: true },
  {
    account: t.u32().primaryKey(),
    balance: t.u32(),
    version: t.u32(),
  },
);

const channels = table(
  { public: true },
  {
    channel: t.u32().primaryKey(),
    version: t.u32(),
    checksum: t.u32(),
    payload: t.string(),
  },
);

const spacetimedb = schema({ documents, accounts, channels });
export default spacetimedb;

const SearchRow = t.object("SearchRow", {
  rank: t.u32(),
  score: t.u32(),
  payload: t.string(),
});

const SearchResult = t.object("SearchResult", {
  nonce: t.u32(),
  checksum: t.u32(),
  rows: t.array(SearchRow),
});

const AccountStateResult = t.object("AccountStateResult", {
  nonce: t.u32(),
  count: t.u32(),
  totalBalance: t.u32(),
  totalVersion: t.u32(),
  checksum: t.u32(),
});

const ComputeResult = t.object("ComputeResult", {
  nonce: t.u32(),
  checksum: t.u32(),
});

const ProbeResult = t.object("ProbeResult", {
  nonce: t.u32(),
  account: t.u32(),
  balance: t.u32(),
  version: t.u32(),
  checksum: t.u32(),
});

export const seed_documents = spacetimedb.reducer(
  { start: t.u32(), count: t.u32() },
  (ctx, { start, count }) => {
    validateBatch(start, count, DOCUMENT_COUNT);
    for (let index = start; index < start + count; index++) {
      const partition = Math.floor(index / DOCUMENTS_PER_PARTITION);
      const rank = index % DOCUMENTS_PER_PARTITION;
      ctx.db.documents.insert({
        id: index,
        partition,
        rank,
        score: ((partition + 1) * 1_009 + rank * 9_176) % 1_000_003,
        payload: documentPayload(partition, rank),
      });
    }
  },
);

export const seed_accounts = spacetimedb.reducer(
  { start: t.u32(), count: t.u32() },
  (ctx, { start, count }) => {
    validateBatch(start, count, ACCOUNT_COUNT);
    for (let account = start; account < start + count; account++) {
      ctx.db.accounts.insert({ account, balance: ACCOUNT_BALANCE, version: 0 });
    }
  },
);

export const seed_channels = spacetimedb.reducer(
  { start: t.u32(), count: t.u32() },
  (ctx, { start, count }) => {
    validateChannelBatch(count);
    for (let channel = start; channel < start + count; channel++) {
      const body = channelPayload(channel, 0, 0);
      ctx.db.channels.insert({
        channel,
        version: 0,
        checksum: channelChecksum(channel, 0, 0, body),
        payload: body,
      });
    }
  },
);

export const search = spacetimedb.procedure(
  { partition: t.u32(), nonce: t.u32() },
  SearchResult,
  (ctx, { partition, nonce }) =>
    ctx.withTx(tx => {
      const rows: Array<{ rank: number; score: number; payload: string }> = [];
      let checksum = mix(FNV_OFFSET, nonce);

      // 2.6.1 types collapse a one-column composite prefix to `number`, while
      // its runtime requires the prefix to remain an array.
      const partitionPrefix = [partition] as unknown as number;
      for (const { rank, score, payload } of tx.db.documents.by_partition_rank.filter(partitionPrefix)) {
        rows.push({ rank, score, payload });
        checksum = mix(checksum, rank);
        checksum = mix(checksum, score);
        checksum = mixText(checksum, payload);
        if (rows.length === 20) break;
      }

      return { nonce, checksum, rows };
    }),
);

export const transfer = spacetimedb.reducer(
  { pair: t.u32(), direction: t.u32(), amount: t.u32(), nonce: t.u32() },
  (ctx, { pair, direction, amount, nonce }) => {
    if (pair >= ACCOUNT_COUNT / 2) throw new Error(`invalid pair ${pair}`);
    if (direction !== 0 && direction !== 1) throw new Error(`invalid direction ${direction}`);
    if (amount === 0) throw new Error(`invalid amount ${amount}`);

    const left = ctx.db.accounts.account.find(pair * 2);
    const right = ctx.db.accounts.account.find(pair * 2 + 1);
    if (left === null || right === null) throw new Error(`account pair ${pair} is not seeded`);

    const from = direction === 0 ? left : right;
    const to = direction === 0 ? right : left;
    if (from.balance < amount) throw new Error(`account ${from.account} has insufficient funds`);

    ctx.db.accounts.account.update({
      ...from,
      balance: from.balance - amount,
      version: from.version + 1,
    });
    ctx.db.accounts.account.update({
      ...to,
      balance: to.balance + amount,
      version: to.version + 1,
    });
    void nonce;
  },
);

export const account_state = spacetimedb.procedure(
  { nonce: t.u32() },
  AccountStateResult,
  (ctx, { nonce }) =>
    ctx.withTx(tx => {
      const rows = Array.from(tx.db.accounts).sort((a, b) => a.account - b.account);
      let totalBalance = 0;
      let totalVersion = 0;
      let checksum = mix(FNV_OFFSET, nonce);
      for (const account of rows) {
        totalBalance += account.balance;
        totalVersion += account.version;
        checksum = mix(checksum, account.account);
        checksum = mix(checksum, account.balance);
        checksum = mix(checksum, account.version);
      }
      return { nonce, count: rows.length, totalBalance, totalVersion, checksum };
    }),
);

export const update_channel = spacetimedb.reducer(
  { channel: t.u32(), nonce: t.u32() },
  (ctx, { channel, nonce }) => {
    const row = ctx.db.channels.channel.find(channel);
    if (row === null) throw new Error(`channel ${channel} is not seeded`);

    const version = row.version + 1;
    const body = channelPayload(channel, version, nonce);
    ctx.db.channels.channel.update({
      channel,
      version,
      checksum: channelChecksum(channel, version, nonce, body),
      payload: body,
    });
  },
);

export const compute = spacetimedb.procedure(
  { nonce: t.u32(), seed: t.u32(), payload: t.string(), rounds: t.u32() },
  ComputeResult,
  (_ctx, { nonce, seed, payload, rounds }) => {
    if (rounds === 0 || rounds > 1_024) throw new Error(`invalid rounds ${rounds}`);
    let checksum = mix(mix(FNV_OFFSET, nonce), seed);
    for (let round = 0; round < rounds; round++) checksum = mixText(mix(checksum, round), payload);
    return { nonce, checksum };
  },
);

export const probe = spacetimedb.procedure(
  { nonce: t.u32() },
  ProbeResult,
  (ctx, { nonce }) =>
    ctx.withTx(tx => {
      const account = nonce % ACCOUNT_COUNT;
      const row = tx.db.accounts.account.find(account);
      if (row === null) throw new Error(`account ${account} is not seeded`);
      let checksum = mix(FNV_OFFSET, nonce);
      checksum = mix(checksum, row.account);
      checksum = mix(checksum, row.balance);
      checksum = mix(checksum, row.version);
      return { nonce, ...row, checksum };
    }),
);
