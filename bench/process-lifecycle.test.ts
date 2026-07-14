import { afterEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import {
  activePhaseIds,
  benchmarkFailure,
  BenchmarkError,
  BoundedTextTail,
  stopSubprocess,
} from "./process-lifecycle.ts";

const children = new Set<Subprocess>();

afterEach(async () => {
  await Promise.all([...children].map(async (child) => {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }));
  children.clear();
});

describe("bounded process diagnostics", () => {
  test("retains a streaming UTF-8 tail within the configured character bound", () => {
    const tail = new BoundedTextTail(8);
    const encoded = new TextEncoder().encode("prefix-🙂-tail");
    tail.write(encoded.slice(0, 9));
    tail.write(encoded.slice(9, 12));
    tail.write(encoded.slice(12));
    tail.finish();
    expect(tail.output()).toBe("-🙂-tail");
    expect(tail.output().length).toBe(8);
  });

  test("preserves failure order, stage summaries, active phase, and a bounded tail", () => {
    const workload = new Error("capacity drain timed out");
    const shutdown = new Error("graceful shutdown timed out");
    const starts = new Map([["completed", 1], ["subscriptions:partitioned:capacity-500", 2]]);
    const completed = new Map([["completed", { startMs: 1, endMs: 2 }]]);
    const error = benchmarkFailure("dbzz benchmark", [
      { stage: "workload", error: workload },
      { stage: "shutdown", error: shutdown },
    ], {
      summary: [`active phases: ${activePhaseIds(starts, completed).join(", ")}`],
      tail: `${"discard-me".repeat(10_000)}server-tail-marker`,
    });

    expect(error).toBeInstanceOf(BenchmarkError);
    expect(error.errors).toEqual([workload, shutdown]);
    expect(error.message).toContain("workload: capacity drain timed out");
    expect(error.message).toContain("shutdown: graceful shutdown timed out");
    expect(error.message).toContain("subscriptions:partitioned:capacity-500");
    expect(error.message).toEndWith("server-tail-marker");
  });

  test("kills and reaps a subprocess that ignores graceful termination", async () => {
    const child = Bun.spawn([
      process.execPath,
      "-e",
      "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)",
    ], { stdout: "pipe", stderr: "pipe" });
    children.add(child);
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("ready");
    reader.releaseLock();

    const stopped = await stopSubprocess(child, 20);
    expect(stopped.timedOut).toBe(true);
    expect(() => process.kill(child.pid, 0)).toThrow();
    children.delete(child);
  });

  test("reaps a subprocess through graceful termination when it cooperates", async () => {
    const child = Bun.spawn([
      process.execPath,
      "-e",
      "console.log('ready');setInterval(()=>{},1000)",
    ], { stdout: "pipe", stderr: "pipe" });
    children.add(child);
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("ready");
    reader.releaseLock();

    const stopped = await stopSubprocess(child, 1_000);
    expect(stopped.timedOut).toBe(false);
    expect(() => process.kill(child.pid, 0)).toThrow();
    children.delete(child);
  });
});
