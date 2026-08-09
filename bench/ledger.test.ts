import { describe, expect, test } from "bun:test";
import {
  LEDGER_SCHEMA_VERSION,
  MAXIMUM_ROWS_PER_RUN,
  formatLedger,
  ledgerPartition,
  ledgerRow,
  mergeLedger,
  parseLedger,
  stampLedger,
  type LedgerRow,
} from "./ledger.ts";
import { comparePaired, DEFAULT_POLICY, DEFAULT_REPETITIONS } from "./paired-statistics.ts";

const facts = {
  run: "local",
  recordedAt: "2026-08-09T12:00:00.000Z",
  host: "github-hosted",
  base: "aaaaaaa",
  head: "bbbbbbb",
  repetitions: DEFAULT_REPETITIONS,
};

function row(overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    ...ledgerRow(facts, {
      profile: "disabled",
      unit: "operation:query:latency",
      metric: "throughput/s",
      gated: true,
      comparison: comparePaired(
        Array(DEFAULT_REPETITIONS).fill({ base: 100, head: 99 }),
        { ...DEFAULT_POLICY, better: "higher" },
      ),
    }),
    ...overrides,
  };
}

describe("a ledger row", () => {
  test("stores the paired ratio and never an absolute number", () => {
    const written = row();
    expect(written.medianPercent).toBeCloseTo(-1, 4);
    expect(written.signal).toBe("no signal");
    expect(written.gated).toBe(true);
    expect(written.repetitions).toBe(DEFAULT_REPETITIONS);
    // Absolute throughput on an ephemeral runner is not comparable across runs;
    // the ratio is what makes a cross-runner history mean anything.
    expect(Object.values(written)).not.toContain(100);
    expect(Object.values(written)).not.toContain(99);
  });

  test("records an unresolvable comparison as null rather than as a number", () => {
    const unresolved = row({
      ...ledgerRow(facts, {
        profile: "disabled",
        unit: "operation:query:latency",
        metric: "throughput/s",
        gated: true,
        comparison: comparePaired(
          [{ base: 1, head: 1 }, { base: 1, head: 1 }],
          { ...DEFAULT_POLICY, better: "higher" },
        ),
      }),
    });
    expect(unresolved.signal).toBe("not measured");
    expect(unresolved.medianPercent).toBeNull();
    // NaN does not survive JSON, so a row that pretended to carry one would
    // read back as a silent zero.
    expect(JSON.parse(JSON.stringify(unresolved)).medianPercent).toBeNull();
  });

  test("survives a round trip through the file format", () => {
    expect(parseLedger(formatLedger([row(), row({ metric: "p95 ms" })]))).toHaveLength(2);
    expect(parseLedger(formatLedger([]))).toEqual([]);
  });
});

describe("reading rows a pull request wrote", () => {
  const refuses = (overrides: Record<string, unknown>, why: RegExp) =>
    expect(() => parseLedger(JSON.stringify({ ...row(), ...overrides }))).toThrow(why);

  test("refuses a row whose fields are not what they claim", () => {
    refuses({ schema: LEDGER_SCHEMA_VERSION + 1 }, /declares schema/);
    refuses({ head: "not-a-commit" }, /not a commit/);
    refuses({ unit: "x".repeat(500) }, /unusable unit/);
    refuses({ unit: "" }, /unusable unit/);
    refuses({ repetitions: -1 }, /unusable repetitions/);
    refuses({ repetitions: 1.5 }, /unusable repetitions/);
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

describe("provenance", () => {
  test("files rows under the run the appender trusts, not the one they claim", () => {
    const [stamped] = stampLedger([row({ run: "9999" })], {
      run: "4242",
      head: facts.head,
      recordedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(stamped!.run).toBe("4242");
    expect(stamped!.recordedAt).toBe("2026-09-01T00:00:00.000Z");
  });

  test("refuses rows that describe a commit this run did not measure", () => {
    expect(() =>
      stampLedger([row()], { run: "1", head: "ccccccc", recordedAt: facts.recordedAt })
    ).toThrow(/claims head bbbbbbb/);
  });

  test("refuses a run that files more rows than the workload can produce", () => {
    const flood = Array.from({ length: MAXIMUM_ROWS_PER_RUN + 1 }, (_, index) =>
      row({ metric: `throughput/s ${index}` }));
    expect(() => stampLedger(flood, { run: "1", head: facts.head, recordedAt: facts.recordedAt }))
      .toThrow(/the cap is/);
  });
});

describe("folding a run into the ledger", () => {
  const runRows = (run: string, recordedAt: string) =>
    [row({ run, recordedAt }), row({ run, recordedAt, metric: "p95 ms" })];

  test("a second run appends rather than overwriting the first", () => {
    const first = mergeLedger([], runRows("1", "2026-08-09T12:00:00.000Z"));
    const both = mergeLedger(first, runRows("2", "2026-08-09T13:00:00.000Z"));
    expect(both).toHaveLength(4);
    expect(new Set(both.map((entry) => entry.run))).toEqual(new Set(["1", "2"]));
  });

  test("re-running one workflow replaces its rows instead of counting them twice", () => {
    const first = mergeLedger([], runRows("1", "2026-08-09T12:00:00.000Z"));
    const again = mergeLedger(first, [row({ run: "1", recordedAt: "2026-08-09T14:00:00.000Z" })]);
    expect(again).toHaveLength(1);
    expect(again[0]!.recordedAt).toBe("2026-08-09T14:00:00.000Z");
  });

  test("two runs fold to the same ledger whichever lands first", () => {
    const a = runRows("1", "2026-08-09T12:00:00.000Z");
    const b = runRows("2", "2026-08-09T13:00:00.000Z");
    // This is what lets a rejected push be resolved by fetching and folding
    // again: the result does not depend on who won the race.
    expect(mergeLedger(mergeLedger([], a), b)).toEqual(mergeLedger(mergeLedger([], b), a));
  });
});

describe("partitions", () => {
  test("one file per month, so an append is a small blob", () => {
    expect(ledgerPartition("2026-08-09T12:00:00.000Z")).toBe("2026-08");
    expect(ledgerPartition("2027-01-31T23:59:59.999Z")).toBe("2027-01");
  });
});
