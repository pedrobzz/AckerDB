import { describe, expect, test } from "bun:test";
import { runFlood } from "./telemetry-flood.ts";

describe("telemetry under an error storm", () => {
  test("driving the error rate to 100% does not multiply the store's growth", async () => {
    // A small byte target so a few seconds of traffic reaches the pressure a
    // production-sized store meets after hours of the same attack. The
    // mechanism under test is the same one either way.
    // Driven through the real path — Telemetry, recordSpan, and the exemplar a
    // retained trace becomes — not a synthetic collector production never calls.
    const result = await runFlood(1_000, 3, 8 * 1024 * 1024);
    const [healthy, flood] = result.phases;

    // The defect this guards: tail sampling retains every error as a full
    // exemplar, so a flood turns essentially all traffic into 2 kB specimens
    // where a healthy application produced a few per cent of them. Unbounded,
    // that fills the store about seven times faster precisely when the
    // application is under attack.
    expect(result.amplification).toBeLessThan(2);
    // The flood sheds most of what selection chose; the healthy phase sheds a
    // minority of far fewer. The absolute counts depend on how quickly the byte
    // target is reached, so the shares are what is asserted.
    expect(flood!.exemplarsShed / flood!.retainedTraces).toBeGreaterThan(0.5);
    expect(healthy!.exemplarsShed / healthy!.retainedTraces).toBeLessThan(0.5);

    // And the shape survives: the aggregate is bounded by cardinality, so it
    // saw every observation in both phases whatever admission did to the
    // specimens, and the error COUNT is therefore exact even though almost
    // every error's individual trace was shed.
    expect(result.aggregateSawEverything).toBe(true);
    expect(result.onDisk.aggregateErrorCount).toBeGreaterThanOrEqual(flood!.operations);
    expect(result.shedByReason.rate_limited).toBeGreaterThan(0);
  }, 60_000);
});
