import { v } from "convex/values";
import { action, mutation, query } from "./_generated/server";

const DOCUMENT_PARTITIONS = 64;
const DOCUMENTS_PER_PARTITION = 128;
const DOCUMENT_COUNT = DOCUMENT_PARTITIONS * DOCUMENTS_PER_PARTITION;
const ACCOUNT_COUNT = 2_048;
const ACCOUNT_BALANCE = 1_000_000;
const PAYLOAD_BYTES = 128;
const FNV_OFFSET = 2_166_136_261;
const FNV_PRIME = 16_777_619;

const batchResult = v.object({ start: v.float64(), count: v.float64() });
const documentResult = v.object({ rank: v.float64(), score: v.float64(), payload: v.string() });
const searchResult = v.object({
  nonce: v.float64(),
  checksum: v.float64(),
  rows: v.array(documentResult),
});
const accountStateResult = v.object({
  nonce: v.float64(),
  count: v.float64(),
  totalBalance: v.float64(),
  totalVersion: v.float64(),
  checksum: v.float64(),
});
const channelResult = v.object({
  channel: v.float64(),
  version: v.float64(),
  checksum: v.float64(),
  payload: v.string(),
});
const computeResult = v.object({ nonce: v.float64(), checksum: v.float64() });
const probeResult = v.object({
  nonce: v.float64(),
  account: v.float64(),
  balance: v.float64(),
  version: v.float64(),
  checksum: v.float64(),
});

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
  if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count <= 0 || start + count > total) {
    throw new Error(`invalid batch start=${start} count=${count} total=${total}`);
  }
}

function validateChannelBatch(start: number, count: number): void {
  if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count <= 0) {
    throw new Error(`invalid channel batch start=${start} count=${count}`);
  }
}

export const seedDocuments = mutation({
  args: { start: v.float64(), count: v.float64() },
  returns: batchResult,
  handler: async (ctx, { start, count }) => {
    validateBatch(start, count, DOCUMENT_COUNT);
    for (let index = start; index < start + count; index++) {
      const partition = Math.floor(index / DOCUMENTS_PER_PARTITION);
      const rank = index % DOCUMENTS_PER_PARTITION;
      await ctx.db.insert("documents", {
        partition,
        rank,
        score: ((partition + 1) * 1_009 + rank * 9_176) % 1_000_003,
        payload: documentPayload(partition, rank),
      });
    }
    return { start, count };
  },
});

export const seedAccounts = mutation({
  args: { start: v.float64(), count: v.float64() },
  returns: batchResult,
  handler: async (ctx, { start, count }) => {
    validateBatch(start, count, ACCOUNT_COUNT);
    for (let account = start; account < start + count; account++) {
      await ctx.db.insert("accounts", { account, balance: ACCOUNT_BALANCE, version: 0 });
    }
    return { start, count };
  },
});

export const seedChannels = mutation({
  args: { start: v.float64(), count: v.float64() },
  returns: batchResult,
  handler: async (ctx, { start, count }) => {
    validateChannelBatch(start, count);
    for (let channel = start; channel < start + count; channel++) {
      const body = channelPayload(channel, 0, 0);
      await ctx.db.insert("channels", {
        channel,
        version: 0,
        checksum: channelChecksum(channel, 0, 0, body),
        payload: body,
      });
    }
    return { start, count };
  },
});

export const search = query({
  args: { partition: v.float64(), nonce: v.float64() },
  returns: searchResult,
  handler: async (ctx, { partition, nonce }) => {
    const documents = await ctx.db
      .query("documents")
      .withIndex("by_partition_rank", (q) => q.eq("partition", partition))
      .order("asc")
      .take(20);
    const rows = documents.map(({ rank, score, payload }) => ({ rank, score, payload }));
    let checksum = mix(FNV_OFFSET, nonce);
    for (const row of rows) {
      checksum = mix(checksum, row.rank);
      checksum = mix(checksum, row.score);
      checksum = mixText(checksum, row.payload);
    }
    return { nonce, checksum, rows };
  },
});

export const transfer = mutation({
  args: {
    pair: v.float64(),
    direction: v.float64(),
    amount: v.float64(),
    nonce: v.float64(),
  },
  returns: v.null(),
  handler: async (ctx, { pair, direction, amount, nonce }) => {
    if (!Number.isInteger(pair) || pair < 0 || pair >= ACCOUNT_COUNT / 2) throw new Error(`invalid pair ${pair}`);
    if (direction !== 0 && direction !== 1) throw new Error(`invalid direction ${direction}`);
    if (!Number.isInteger(amount) || amount <= 0) throw new Error(`invalid amount ${amount}`);

    const left = await ctx.db
      .query("accounts")
      .withIndex("by_account", (q) => q.eq("account", pair * 2))
      .unique();
    const right = await ctx.db
      .query("accounts")
      .withIndex("by_account", (q) => q.eq("account", pair * 2 + 1))
      .unique();
    if (left === null || right === null) throw new Error(`account pair ${pair} is not seeded`);

    const from = direction === 0 ? left : right;
    const to = direction === 0 ? right : left;
    if (from.balance < amount) throw new Error(`account ${from.account} has insufficient funds`);

    const fromBalance = from.balance - amount;
    const toBalance = to.balance + amount;
    const fromVersion = from.version + 1;
    const toVersion = to.version + 1;
    await ctx.db.patch(from._id, { balance: fromBalance, version: fromVersion });
    await ctx.db.patch(to._id, { balance: toBalance, version: toVersion });
    return null;
  },
});

export const accountState = query({
  args: { nonce: v.float64() },
  returns: accountStateResult,
  handler: async (ctx, { nonce }) => {
    const accounts = await ctx.db.query("accounts").collect();
    accounts.sort((a, b) => a.account - b.account);
    let totalBalance = 0;
    let totalVersion = 0;
    let checksum = mix(FNV_OFFSET, nonce);
    for (const account of accounts) {
      totalBalance += account.balance;
      totalVersion += account.version;
      checksum = mix(checksum, account.account);
      checksum = mix(checksum, account.balance);
      checksum = mix(checksum, account.version);
    }
    return { nonce, count: accounts.length, totalBalance, totalVersion, checksum };
  },
});

export const channel = query({
  args: { channel: v.float64() },
  returns: v.union(channelResult, v.null()),
  handler: async (ctx, { channel }) => {
    const row = await ctx.db
      .query("channels")
      .withIndex("by_channel", (q) => q.eq("channel", channel))
      .unique();
    if (row === null) return null;
    return { channel: row.channel, version: row.version, checksum: row.checksum, payload: row.payload };
  },
});

export const updateChannel = mutation({
  args: { channel: v.float64(), nonce: v.float64() },
  returns: v.null(),
  handler: async (ctx, { channel, nonce }) => {
    const row = await ctx.db
      .query("channels")
      .withIndex("by_channel", (q) => q.eq("channel", channel))
      .unique();
    if (row === null) throw new Error(`channel ${channel} is not seeded`);
    const version = row.version + 1;
    const body = channelPayload(channel, version, nonce);
    const checksum = channelChecksum(channel, version, nonce, body);
    await ctx.db.patch(row._id, { version, checksum, payload: body });
    return null;
  },
});

export const compute = action({
  args: {
    nonce: v.float64(),
    seed: v.float64(),
    payload: v.string(),
    rounds: v.float64(),
  },
  returns: computeResult,
  handler: (_ctx, { nonce, seed, payload, rounds }) => {
    if (!Number.isInteger(rounds) || rounds <= 0 || rounds > 1_024) throw new Error(`invalid rounds ${rounds}`);
    let checksum = mix(mix(FNV_OFFSET, nonce), seed);
    for (let round = 0; round < rounds; round++) checksum = mixText(mix(checksum, round), payload);
    return { nonce, checksum };
  },
});

export const probe = query({
  args: { nonce: v.float64() },
  returns: probeResult,
  handler: async (ctx, { nonce }) => {
    const account = ((nonce % ACCOUNT_COUNT) + ACCOUNT_COUNT) % ACCOUNT_COUNT;
    const row = await ctx.db
      .query("accounts")
      .withIndex("by_account", (q) => q.eq("account", account))
      .unique();
    if (row === null) throw new Error(`account ${account} is not seeded`);
    let checksum = mix(FNV_OFFSET, nonce);
    checksum = mix(checksum, row.account);
    checksum = mix(checksum, row.balance);
    checksum = mix(checksum, row.version);
    return { nonce, account: row.account, balance: row.balance, version: row.version, checksum };
  },
});
