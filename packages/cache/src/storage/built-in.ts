import type { PluginMutationCtx, StandardValidator } from "@ackerdb/server";
import {
  expirationDeadline,
  isLive,
  type CacheSetOptions,
  type NormalizedBuiltInConfig,
} from "../plugin/config.ts";
import { CacheEntryTooLargeError, CacheStoreError } from "./errors.ts";
import { encodeCacheKey, utf8Bytes, type CacheKey } from "./key.ts";
import { decodeCacheValue } from "./payload.ts";
import { cacheSchema } from "../plugin/schema.ts";

export async function builtinGet(
  ctx: PluginMutationCtx<typeof cacheSchema>,
  namespace: string,
  validator: StandardValidator<unknown, string> | undefined,
  key: CacheKey,
): Promise<unknown> {
  const encodedKey = encodeCacheKey("", ctx.mount, namespace, key);
  let row;
  try {
    row = await ctx.db.entries.query().where((entry) => entry.key.eq(encodedKey)).unique();
  } catch (error) {
    throw new CacheStoreError("cache read failed", error);
  }
  if (row === null || !isLive(row.deadline, ctx.timestamp)) return undefined;
  return decodeCacheValue(row.payload, validator);
}

export async function builtinSet(
  ctx: PluginMutationCtx<typeof cacheSchema>,
  config: NormalizedBuiltInConfig,
  namespace: string,
  key: CacheKey,
  payload: string,
  options: CacheSetOptions | undefined,
): Promise<boolean> {
  const expiresAt = expirationDeadline(ctx.timestamp, options?.expiresInMs);
  const encodedKey = encodeCacheKey("", ctx.mount, namespace, key);
  const bytes = utf8Bytes(encodedKey) + utf8Bytes(payload);
  if (bytes > config.maxEntryBytes) {
    throw new CacheEntryTooLargeError(bytes, config.maxEntryBytes);
  }

  try {
    const db = ctx.db;
    const existing = await db.entries.query().where((entry) => entry.key.eq(encodedKey)).unique();
    const isPresent = existing !== null && isLive(existing.deadline, ctx.timestamp);
    if (
      (options?.if === "missing" && isPresent) ||
      (options?.if === "present" && !isPresent)
    ) {
      return false;
    }

    const state = await db.state.query().unique();
    let totalBytes = state?.totalBytes ?? 0;
    let entryCount = state?.entryCount ?? 0;
    if (existing !== null) {
      await db.entries.delete(existing.id);
      totalBytes -= existing.bytes;
      entryCount--;
    }

    const exceedsCapacity = (storedBytes: number, storedEntries: number) =>
      storedBytes + bytes > config.maxBytes || storedEntries + 1 > config.maxEntries;
    const evictCandidates = async (
      candidates: readonly { readonly id: bigint; readonly bytes: number }[],
    ): Promise<void> => {
      let selectedCount = 0;
      let nextTotalBytes = totalBytes;
      let nextEntryCount = entryCount;
      while (
        selectedCount < candidates.length &&
        exceedsCapacity(nextTotalBytes, nextEntryCount)
      ) {
        const candidate = candidates[selectedCount]!;
        nextTotalBytes -= candidate.bytes;
        nextEntryCount--;
        selectedCount++;
      }
      if (selectedCount === 0) return;

      const selected = candidates.slice(0, selectedCount);
      const deleted = await db.entries.deleteMany(selected.map((row) => row.id));
      // The candidates were selected and deleted inside one caller transaction.
      // A mismatch therefore signals an internal transaction/storage violation;
      // abort rather than let the exact capacity counters drift.
      if (deleted !== selected.length) {
        throw new Error("cache eviction candidates changed inside the transaction");
      }
      totalBytes = nextTotalBytes;
      entryCount = nextEntryCount;
    };

    const batchSize = Math.min(256, config.maxEntries);
    while (exceedsCapacity(totalBytes, entryCount)) {
      const expired = await db.entries
        .query()
        .where((entry) => entry.deadline.lte(ctx.timestamp))
        .orderBy((entry) => entry.deadline.asc())
        .take(batchSize);
      if (expired.length === 0) break;
      await evictCandidates(expired);
    }
    while (exceedsCapacity(totalBytes, entryCount)) {
      const oldest = await db.entries.query().take(batchSize);
      if (oldest.length === 0) break;
      await evictCandidates(oldest);
    }

    await db.entries.insert({ key: encodedKey, payload, bytes, deadline: expiresAt });
    totalBytes += bytes;
    entryCount++;
    if (state === null) {
      await db.state.insert({ totalBytes, entryCount });
    } else {
      await db.state.patch(state.id, { totalBytes, entryCount });
    }
    return true;
  } catch (error) {
    if (error instanceof CacheStoreError) throw error;
    throw new CacheStoreError("cache write failed", error);
  }
}

export async function builtinDelete(
  ctx: PluginMutationCtx<typeof cacheSchema>,
  namespace: string,
  key: CacheKey,
): Promise<boolean> {
  const encodedKey = encodeCacheKey("", ctx.mount, namespace, key);
  try {
    const row = await ctx.db.entries.query().where((entry) => entry.key.eq(encodedKey)).unique();
    if (row === null) return false;
    const wasLive = isLive(row.deadline, ctx.timestamp);
    const state = await ctx.db.state.query().unique();
    if (state === null) {
      throw new Error("cache state is missing while entries exist");
    }
    await ctx.db.entries.delete(row.id);
    await ctx.db.state.patch(state.id, {
      totalBytes: state.totalBytes - row.bytes,
      entryCount: state.entryCount - 1,
    });
    return wasLive;
  } catch (error) {
    if (error instanceof CacheStoreError) throw error;
    throw new CacheStoreError("cache delete failed", error);
  }
}
