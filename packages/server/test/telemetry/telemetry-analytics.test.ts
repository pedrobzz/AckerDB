import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TelemetryJournal,
  TelemetryStore,
  type AnalyticsEventRecord,
  type Identity,
} from "@ackerdb/server";

const DAY_MS = 86_400_000;
const NOW = 1_700_000_000_000;
const TODAY = Math.floor(NOW / DAY_MS) * DAY_MS;

const directories = new Set<string>();

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

function createJournal(): TelemetryJournal {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-telemetry-analytics-"));
  directories.add(directory);
  const store = new TelemetryStore({
    path: join(directory, "telemetry.db"),
    now: () => NOW,
  });
  return new TelemetryJournal({ store });
}

let sequence = 0n;

function event(
  name: string,
  timestamp: number,
  identity?: bigint,
): AnalyticsEventRecord {
  return Object.freeze({
    kind: "analytics",
    processGeneration: "analytics-rollup-test",
    sequence: ++sequence,
    timestamp,
    event: name,
    ...(identity === undefined ? {} : { identity: identity as Identity }),
    truncated: false,
    malformed: false,
    functionAddress: "tests.track",
    functionKind: "mutation",
  });
}

function rollups(journal: TelemetryJournal): Record<string, unknown>[] {
  return journal.store.database.query(`
    SELECT day, event, count, uniques
    FROM _ackerdb_telemetry_analytics_rollup
    ORDER BY day, event
  `).all() as Record<string, unknown>[];
}

describe("analytics daily rollup", () => {
  test("writes exact count and count-distinct-Identity per day and event at flush", async () => {
    const journal = createJournal();
    expect(journal.append(event("signup", TODAY + 1_000, 1n))).toBe(true);
    expect(journal.append(event("signup", TODAY + 2_000, 2n))).toBe(true);
    expect(journal.append(event("signup", TODAY + 3_000, 1n))).toBe(true);
    expect(journal.append(event("checkout", TODAY + 4_000, 1n))).toBe(true);
    expect(journal.append(event("heartbeat", TODAY + 5_000))).toBe(true);
    await journal.flush();

    expect(rollups(journal)).toEqual([
      { day: BigInt(TODAY), event: "checkout", count: 1n, uniques: 1n },
      { day: BigInt(TODAY), event: "heartbeat", count: 1n, uniques: 0n },
      { day: BigInt(TODAY), event: "signup", count: 3n, uniques: 2n },
    ]);
    await journal.drain();
    journal.store.close();
  });

  test("buckets by UTC day and upserts across later flushes", async () => {
    const journal = createJournal();
    expect(journal.append(event("signup", TODAY - DAY_MS + 500, 1n))).toBe(true);
    expect(journal.append(event("signup", TODAY + 500, 1n))).toBe(true);
    await journal.flush();
    expect(journal.append(event("signup", TODAY + 900, 3n))).toBe(true);
    await journal.flush();

    expect(rollups(journal)).toEqual([
      { day: BigInt(TODAY - DAY_MS), event: "signup", count: 1n, uniques: 1n },
      { day: BigInt(TODAY), event: "signup", count: 2n, uniques: 2n },
    ]);
    await journal.drain();
    journal.store.close();
  });

  test("rollups outlive raw analytics and expire on the 1y clock", async () => {
    const journal = createJournal();
    // Old enough for the raw 90d clock, young enough for the 1y rollup clock.
    expect(journal.append(event("signup", NOW - 100 * DAY_MS, 1n))).toBe(true);
    // Beyond the 1y rollup clock as well.
    expect(journal.append(event("legacy", NOW - 400 * DAY_MS, 1n))).toBe(true);
    await journal.flush();
    for (let pass = 0; pass < 4; pass++) journal.store.maintain();

    const raw = journal.store.database.query(
      "SELECT COUNT(*) AS rows FROM _ackerdb_telemetry_journal WHERE kind = 'analytics'",
    ).get() as { readonly rows: bigint };
    expect(raw.rows).toBe(0n);
    const surviving = rollups(journal);
    expect(surviving).toHaveLength(1);
    expect(surviving[0]).toMatchObject({ event: "signup", count: 1n, uniques: 1n });
    await journal.drain();
    journal.store.close();
  });
});
