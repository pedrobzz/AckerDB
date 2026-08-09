import { afterEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import {
  activePhaseIds,
  benchmarkFailure,
  BenchmarkError,
  BoundedTextTail,
  stopSubprocess,
} from "./process-lifecycle.ts";
import { ProcessTreeMonitor, readProcessTable } from "./process-tree.ts";

const children = new Set<Subprocess>();

afterEach(async () => {
  await Promise.all([...children].map(async (child) => {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }));
  children.clear();
});

describe("bounded process diagnostics", () => {
  test("holds workload phases until the parent samples the client process", async () => {
    const lifecycleUrl = new URL("./process-lifecycle.ts", import.meta.url).href;
    const child = Bun.spawn([
      process.execPath,
      "-e",
      `import { parentCommands } from ${JSON.stringify(lifecycleUrl)};` +
      `console.log("ready");for await (const line of parentCommands()) { if (line === "go") break; }` +
      `console.log(performance.timeOrigin + performance.now());` +
      `await Bun.sleep(60);console.log(performance.timeOrigin + performance.now())`,
    ], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    children.add(child);
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toBe("ready\n");

    const phaseOutput = reader.read();
    expect(await Promise.race([
      phaseOutput.then(() => "started" as const),
      Bun.sleep(25).then(() => "blocked" as const),
    ])).toBe("blocked");
    const monitors = [new ProcessTreeMonitor(child.pid, 20), new ProcessTreeMonitor(child.pid, 20)];
    const baselineTable = readProcessTable();
    const baselines = monitors.map((monitor) => monitor.sampleNow(baselineTable));

    child.stdin.write("go\n");
    child.stdin.end();
    const phaseStartedAt = Number(decoder.decode((await phaseOutput).value).trim());
    await Bun.sleep(25);
    const phaseTable = readProcessTable();
    for (const monitor of monitors) monitor.sampleNow(phaseTable);
    const phaseEndedAt = Number(decoder.decode((await reader.read()).value).trim());
    expect(await child.exited).toBe(0);
    const finalTable = readProcessTable();
    const finalSamples = monitors.map((monitor) => monitor.sampleNow(finalTable));
    for (let index = 0; index < monitors.length; index++) {
      expect(phaseStartedAt).toBeGreaterThanOrEqual(baselines[index]!.timestampMs);
      expect(phaseEndedAt).toBeLessThanOrEqual(finalSamples[index]!.timestampMs);
      expect(monitors[index]!.summarize(phaseStartedAt, phaseEndedAt).sampleCount).toBeGreaterThan(0);
    }
    reader.releaseLock();
    children.delete(child);
  });

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
    const error = benchmarkFailure("ackerdb benchmark", [
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

  // stopSubprocess takes any process exposing exitCode/exited/kill, so the
  // branches that do not depend on real signal delivery are proven against a
  // scripted one: no spawn, no timing, and the escalation test above stays the
  // single place a real operating-system process is required.
  test("terminates cooperatively without escalating, and refuses an unusable budget", async () => {
    const signals: string[] = [];
    const child = {
      exitCode: null as number | null,
      exited: Promise.resolve(3),
      kill(signal?: number | NodeJS.Signals) {
        signals.push(String(signal));
        return true;
      },
    };

    expect(await stopSubprocess(child, 1_000)).toEqual({ exitCode: 3, timedOut: false });
    // One SIGTERM and no SIGKILL: a child that exits in budget is never forced.
    expect(signals).toEqual(["SIGTERM"]);

    // An already-exited child is not signalled again.
    child.exitCode = 3;
    expect(await stopSubprocess(child, 1_000)).toEqual({ exitCode: 3, timedOut: false });
    expect(signals).toEqual(["SIGTERM"]);

    // A budget that cannot bound anything is a programmer error, not a stop.
    for (const budget of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(stopSubprocess(child, budget)).rejects.toBeInstanceOf(RangeError);
    }
  });
});
