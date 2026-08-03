/**
 * THROWAWAY audit bench (T5, finding 2). Measures Engine open + reconcile on an
 * existing database with a non-trivial table count, and isolates the cost of the
 * snapshot read/verify pass that reconcile performs.
 *
 * Run from packages/server:  bun ../../.t5scratch/startup-bench.ts [tables] [cols]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v, defineSchema, defineTable, Engine, reconcile } from "@ackerdb/server";

const TABLES = Number(process.argv[2] ?? 60);
const COLS = Number(process.argv[3] ?? 12);
const RUNS = Number(process.argv[4] ?? 40);

function buildSchema() {
  const tables: Record<string, unknown> = {};
  for (let t = 0; t < TABLES; t++) {
    const columns: Record<string, unknown> = { id: v.primaryKey() };
    for (let c = 0; c < COLS; c++) {
      const pick = c % 6;
      const name = `c${c}`;
      columns[name] = pick === 0
        ? v.string()
        : pick === 1
          ? v.int()
          : pick === 2
            ? v.bigint().nullable()
            : pick === 3
              ? v.enum(`E${t}_${c}`, ["a", "b", "c", "d"])
              : pick === 4
                ? v.union(`U${t}_${c}`, { one: v.string(), two: v.int() })
                : v.object({ a: v.string(), b: v.int() });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tables[`t${t}`] = (defineTable(columns as any) as any).index(["c1"]);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return defineSchema(tables as any);
}

function stats(samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return `median ${median.toFixed(3)}ms  mean ${mean.toFixed(3)}ms  min ${sorted[0]!.toFixed(3)}ms  max ${sorted[sorted.length - 1]!.toFixed(3)}ms`;
}

const dir = mkdtempSync(join(tmpdir(), "ackerdb-t5-bench-"));
const path = join(dir, "data.db");
const schema = buildSchema();

try {
  const first = new Engine(schema, path);
  const applied = reconcile(first).applied;
  first.close("clean");
  console.log(`schema: ${TABLES} tables x ${COLS + 1} columns -> ${applied.join(", ")}`);

  // warmup
  for (let i = 0; i < 5; i++) {
    const e = new Engine(schema, path);
    reconcile(e);
    e.close("clean");
  }

  const open: number[] = [];
  const rec: number[] = [];
  const snap: number[] = [];
  const total: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    const engine = new Engine(schema, path);
    const t1 = performance.now();
    reconcile(engine);
    const t2 = performance.now();
    engine.loadSnapshot(); // one isolated read+verify pass, the thing reconcile used to repeat
    const t3 = performance.now();
    engine.close("clean");
    open.push(t1 - t0);
    rec.push(t2 - t1);
    snap.push(t3 - t2);
    total.push(t2 - t0);
  }

  console.log(`Engine open        : ${stats(open)}`);
  console.log(`reconcile          : ${stats(rec)}`);
  console.log(`open + reconcile   : ${stats(total)}`);
  console.log(`one loadSnapshot   : ${stats(snap)}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const g = globalThis as unknown as { __t5parse?: number; __t5verify?: number; __t5calls?: number };
if (g.__t5calls) {
  console.log(`loadSnapshot split over ${g.__t5calls} calls: parse ${(g.__t5parse! / g.__t5calls).toFixed(3)}ms/call, verify ${(g.__t5verify! / g.__t5calls).toFixed(3)}ms/call`);
}
