import { describe, expect, test } from "bun:test";
import {
  LEDGER_SCHEMA_VERSION,
  MAXIMUM_ROWS_PER_RUN,
  formatLedger,
  ledgerPartition,
  ledgerRows,
  mergeLedger,
  parseLedger,
  type LedgerRow,
} from "./ledger.ts";
import {
  DEFAULT_REPETITIONS,
  PAIRED_SCHEMA_VERSION,
  type PairedRunRecord,
  type PairedSeries,
} from "./paired-statistics.ts";
import { benchmarkConfigFromEnv } from "./benchmark.ts";

const provenance = { run: "4242", attempt: 1, head: "bbbbbbb", recordedAt: "2026-08-09T12:00:00.000Z" };

/** A flat base, so the ratio is exactly the multiplier applied to head. */
function series(unitId: string, metric: string, multipliers: readonly number[]): PairedSeries {
  return {
    unitId,
    metric,
    samples: multipliers.map((multiplier, repetition) => ({ repetition, base: 100, head: 100 * multiplier })),
  };
}

function record(overrides: Partial<PairedRunRecord> = {}): PairedRunRecord {
  return {
    schemaVersion: PAIRED_SCHEMA_VERSION,
    base: "aaaaaaa",
    head: "bbbbbbb",
    executionHost: "github-hosted",
    repetitions: DEFAULT_REPETITIONS,
    wallSeconds: 246,
    config: benchmarkConfigFromEnv(),
    units: ["operation:query:latency"],
    profiles: [{
      profile: "default",
      terminalFailures: [],
      series: [
        series("operation:query:latency", "throughput/s", Array(DEFAULT_REPETITIONS).fill(0.99)),
        series("operation:query:latency", "p99 ms", Array(DEFAULT_REPETITIONS).fill(1.4)),
      ],
    }],
    ...overrides,
  };
}

function row(overrides: Partial<LedgerRow> = {}): LedgerRow {
  return { ...ledgerRows(record(), provenance).rows[0]!, ...overrides };
}

describe("deriving rows from a run", () => {
  test("stores the paired ratio and never an absolute number", () => {
    const [throughput] = ledgerRows(record(), provenance).rows;
    expect(throughput!.medianPercent).toBeCloseTo(-1, 4);
    expect(throughput!.signal).toBe("no signal");
    expect(throughput!.repetitions).toBe(DEFAULT_REPETITIONS);
    expect(throughput!.pairs).toBe(DEFAULT_REPETITIONS);
    // Absolute throughput on an ephemeral runner is not comparable across runs;
    // the ratio is what makes a cross-runner history mean anything.
    expect(Object.values(throughput!)).not.toContain(100);
    expect(Object.values(throughput!)).not.toContain(99);
  });

  test("takes the gating disposition from this branch's policy, not from the run", () => {
    const [throughput, tail] = ledgerRows(record(), provenance).rows;
    expect(throughput!.gated).toBe(true);
    expect(tail!.metric).toBe("p99 ms");
    expect(tail!.gated).toBe(false);
  });

  test("recomputes the verdict rather than believing one", () => {
    // A consistent forty-percent throughput loss is a regression however the
    // run that produced the samples would have preferred to describe it.
    const regressed = record({
      profiles: [{
        profile: "default",
        terminalFailures: [],
        series: [series("operation:query:latency", "throughput/s", Array(DEFAULT_REPETITIONS).fill(0.6))],
      }],
    });
    expect(ledgerRows(regressed, provenance).rows[0]!.signal).toBe("regression");
  });

  test("files rows under the run and clock the appender trusts", () => {
    const [first] = ledgerRows(record(), { ...provenance, run: "9", attempt: 3 }).rows;
    expect(first!.run).toBe("9");
    expect(first!.attempt).toBe(3);
    expect(first!.recordedAt).toBe(provenance.recordedAt);
  });

  test("records an unresolvable comparison as null rather than as a number", () => {
    const short = record({
      profiles: [{
        profile: "default",
        terminalFailures: [],
        series: [series("operation:query:latency", "throughput/s", [1, 1])],
      }],
    });
    const [unresolved] = ledgerRows(short, provenance).rows;
    expect(unresolved!.signal).toBe("not measured");
    // NaN does not survive JSON, so a row that pretended to carry one would read
    // back as a silent zero.
    expect(unresolved!.medianPercent).toBeNull();
    expect(JSON.parse(JSON.stringify(unresolved)).medianPercent).toBeNull();
  });

  test("skips a metric this branch has no policy for, and names it", () => {
    const unknown = record({
      profiles: [{
        profile: "default",
        terminalFailures: [],
        series: [series("operation:query:latency", "bytes shuffled", Array(DEFAULT_REPETITIONS).fill(1))],
      }],
    });
    const derived = ledgerRows(unknown, provenance);
    expect(derived.rows).toEqual([]);
    expect(derived.unknownMetrics).toEqual(["bytes shuffled"]);
  });
});

describe("what a run may not do to the ledger", () => {
  test("refuses a run that describes a commit this workflow did not measure", () => {
    expect(() => ledgerRows(record({ head: "ccccccc" }), provenance))
      .toThrow(/describes head ccccccc where this workflow measured bbbbbbb/);
  });

  test("refuses a schema it does not know", () => {
    expect(() => ledgerRows(record({ schemaVersion: 99 }), provenance)).toThrow(/unsupported paired/);
  });

  test("refuses the same metric reported twice", () => {
    const duplicated = record({
      profiles: [{
        profile: "default",
        terminalFailures: [],
        series: [
          series("operation:query:latency", "throughput/s", Array(DEFAULT_REPETITIONS).fill(1)),
          series("operation:query:latency", "throughput/s", Array(DEFAULT_REPETITIONS).fill(0.5)),
        ],
      }],
    });
    expect(() => ledgerRows(duplicated, provenance)).toThrow(/more than once/);
  });

  test("refuses a run filing more rows than the workload can produce", () => {
    const flood = record({
      profiles: [{
        profile: "default",
        terminalFailures: [],
        series: Array.from({ length: MAXIMUM_ROWS_PER_RUN + 1 }, (_, index) =>
          series(`operation:invented:${index}`, "throughput/s", Array(DEFAULT_REPETITIONS).fill(1))),
      }],
    });
    expect(() => ledgerRows(flood, provenance)).toThrow(/the cap is/);
  });

  test("refuses a field it cannot use, wherever it came from", () => {
    expect(() => ledgerRows(record({ executionHost: "x".repeat(500) }), provenance))
      .toThrow(/unusable host/);
    expect(() => ledgerRows(record({ base: "not-a-commit" }), provenance))
      .toThrow(/base that is not a commit/);
  });
});

describe("reading the stored ledger back", () => {
  const refuses = (overrides: Record<string, unknown>, why: RegExp) =>
    expect(() => parseLedger(JSON.stringify({ ...row(), ...overrides }))).toThrow(why);

  test("survives a round trip through the file format", () => {
    expect(parseLedger(formatLedger([row(), row({ metric: "p95 ms" })]))).toHaveLength(2);
    expect(parseLedger(formatLedger([]))).toEqual([]);
  });

  test("refuses a row whose fields are not what they claim", () => {
    refuses({ schema: LEDGER_SCHEMA_VERSION + 1 }, /declares schema/);
    refuses({ head: "not-a-commit" }, /not a commit/);
    refuses({ unit: "x".repeat(500) }, /unusable unit/);
    refuses({ unit: "" }, /unusable unit/);
    refuses({ repetitions: -1 }, /unusable repetitions/);
    refuses({ attempt: 1.5 }, /unusable attempt/);
    refuses({ gated: "yes" }, /no gating disposition/);
    refuses({ signal: "fine" }, /unknown signal/);
    refuses({ medianPercent: "-1" }, /unusable medianPercent/);
    refuses({ medianPercent: 1e9 }, /unusable medianPercent/);
    refuses({ recordedAt: "whenever" }, /unreadable recordedAt/);
  });

  test("refuses a line that is not an object at all", () => {
    expect(() => parseLedger("[1,2,3]")).toThrow(/is not an object/);
    expect(() => parseLedger("{oh no")).toThrow(/is not JSON/);
  });

  test("names the line so a poisoned file says where it went wrong", () => {
    expect(() => parseLedger(`${JSON.stringify(row())}\n{"schema":99}`)).toThrow(/line 2/);
  });
});

describe("folding a run into the ledger", () => {
  const runRows = (run: string, attempt: number, recordedAt: string) =>
    [row({ run, attempt, recordedAt }), row({ run, attempt, recordedAt, metric: "p95 ms" })];

  test("a second run appends rather than overwriting the first", () => {
    const first = mergeLedger([], runRows("1", 1, "2026-08-09T12:00:00.000Z"));
    const both = mergeLedger(first, runRows("2", 1, "2026-08-09T13:00:00.000Z"));
    expect(both).toHaveLength(4);
    expect(new Set(both.map((entry) => entry.run))).toEqual(new Set(["1", "2"]));
  });

  test("two runs fold to the same ledger whichever lands first", () => {
    const a = runRows("1", 1, "2026-08-09T12:00:00.000Z");
    const b = runRows("2", 1, "2026-08-09T13:00:00.000Z");
    // This is what lets a rejected push be resolved by fetching and folding
    // again: the result does not depend on who won the race.
    expect(mergeLedger(mergeLedger([], a), b)).toEqual(mergeLedger(mergeLedger([], b), a));
  });

  test("a later attempt of one run replaces the earlier one, in either order", () => {
    const first = runRows("1", 1, "2026-08-09T12:00:00.000Z");
    const second = runRows("1", 2, "2026-08-09T14:00:00.000Z");
    // GitHub keeps the run id across a re-run, so arrival order is not attempt
    // order: an early attempt's appender that finishes late must not put stale
    // measurements back.
    for (const folded of [mergeLedger(first, second), mergeLedger(second, first)]) {
      expect(folded).toHaveLength(2);
      expect(folded.every((entry) => entry.attempt === 2)).toBe(true);
    }
  });

  test("re-folding one attempt replaces it instead of counting it twice", () => {
    const once = mergeLedger([], runRows("1", 1, "2026-08-09T12:00:00.000Z"));
    expect(mergeLedger(once, runRows("1", 1, "2026-08-09T12:30:00.000Z"))).toHaveLength(2);
  });
});

describe("partitions", () => {
  test("one file per month, so an append is a small blob", () => {
    expect(ledgerPartition("2026-08-09T12:00:00.000Z")).toBe("2026-08");
    expect(ledgerPartition("2027-01-31T23:59:59.999Z")).toBe("2027-01");
  });
});
