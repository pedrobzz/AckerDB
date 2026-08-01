/**
 * The Service supervisor in isolation: declaration, deterministic start order,
 * rollback on setup failure, reverse cleanup, and the shutdown deadline.
 */
import { describe, expect, test } from "bun:test";
import {
  declareServices,
  isService,
  service,
  type DeclaredService,
} from "../../src/services/definition.ts";
import { ServiceError, ServiceRuntime } from "../../src/services/runtime.ts";
import type { SystemRunner } from "../../src/app/system.ts";

// The supervisor never inspects the authority it forwards.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const system = { run: async () => undefined } as unknown as SystemRunner<any>;

function runtimeOf(services: DeclaredService[]): ServiceRuntime {
  return new ServiceRuntime({ services, system });
}

describe("service definition", () => {
  test("brands a definition and rejects malformed ones", () => {
    const declared = service({ start: () => {} });
    expect(isService(declared)).toBe(true);
    expect(isService({ start: () => {} })).toBe(false);

    expect(() => service({ start: "no" } as never)).toThrow("service start must be a function");
    expect(() => service({ start: () => {}, restart: true } as never))
      .toThrow('unknown service option "restart"');
    expect(() => service(null as never)).toThrow("service definition must be a plain object");
  });

  test("names services by module key and export, in deterministic order", () => {
    const declared = declareServices({
      providers: { tuya: service({ start: () => {} }), tcl: service({ start: () => {} }) },
      jobs: { notifications: service({ start: () => {} }) },
    });
    expect(declared.map((entry) => entry.name)).toEqual([
      "jobs.notifications",
      "providers.tcl",
      "providers.tuya",
    ]);
  });

  test("ignores helper exports but refuses an unbranded service shape", () => {
    const declared = declareServices({
      providers: {
        connect: () => "helper",
        TOPIC: "devices/#",
        tuya: service({ start: () => {} }),
      },
    });
    expect(declared.map((entry) => entry.name)).toEqual(["providers.tuya"]);

    expect(() => declareServices({ providers: { tuya: { start: () => {} } } })).toThrow(
      'service module export "providers.tuya" has a start function but was not created with service(...)',
    );
  });

  test("refuses the same service exported at two names", () => {
    const shared = service({ start: () => {} });
    expect(() => runtimeOf([
      { name: "providers.tuya", service: shared },
      { name: "providers.tcl", service: shared },
    ])).toThrow('service is exported at both "providers.tuya" and "providers.tcl"');
  });
});

describe("service startup", () => {
  test("starts sequentially in declaration order and reaches ready", async () => {
    const order: string[] = [];
    const runtime = runtimeOf([
      { name: "a", service: service({ start: async () => { await Bun.sleep(10); order.push("a"); } }) },
      { name: "b", service: service({ start: () => { order.push("b"); } }) },
    ]);

    await runtime.start();

    expect(order).toEqual(["a", "b"]);
    expect(runtime.state).toBe("ready");
    expect(runtime.names).toEqual(["a", "b"]);
  });

  test("hands every service the same live abort signal", async () => {
    const signals: AbortSignal[] = [];
    const runtime = runtimeOf([
      { name: "a", service: service({ start: (ctx) => { signals.push(ctx.abortSignal); } }) },
      { name: "b", service: service({ start: (ctx) => { signals.push(ctx.abortSignal); } }) },
    ]);

    await runtime.start();
    expect(signals.every((signal) => !signal.aborted)).toBe(true);

    await runtime.stop();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  test("a setup failure names the service and rolls back earlier services", async () => {
    const cleaned: string[] = [];
    const boom = new Error("broker refused");
    const runtime = runtimeOf([
      { name: "first", service: service({ start: () => () => { cleaned.push("first"); } }) },
      { name: "second", service: service({ start: () => () => { cleaned.push("second"); } }) },
      { name: "third", service: service({ start: () => { throw boom; } }) },
    ]);

    const failure = await runtime.start().then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(ServiceError);
    expect((failure as ServiceError).service).toBe("third");
    expect((failure as ServiceError).cause).toBe(boom);
    // Reverse start order, and only the services that actually started.
    expect(cleaned).toEqual(["second", "first"]);
    expect(runtime.state).toBe("failed");
  });

  test("a setup returning a non-function is a named startup failure", async () => {
    const runtime = runtimeOf([
      { name: "bad", service: service({ start: () => 42 as never }) },
    ]);
    await expect(runtime.start()).rejects.toThrow('service "bad" failed during setup');
  });

  test("starting twice returns the same start, never a second setup", async () => {
    let starts = 0;
    const runtime = runtimeOf([
      { name: "once", service: service({ start: () => { starts += 1; } }) },
    ]);

    await Promise.all([runtime.start(), runtime.start()]);
    await runtime.start();

    expect(starts).toBe(1);
  });

  test("reports the service currently in setup", async () => {
    const seen: Array<string | null> = [];
    const runtime = new ServiceRuntime({
      services: [
        { name: "a", service: service({ start: () => {} }) },
        { name: "b", service: service({ start: () => {} }) },
      ],
      system,
      onStarting: (name) => seen.push(name),
    });

    await runtime.start();
    expect(seen).toEqual(["a", "b", null]);
  });
});

describe("fatal failure after setup", () => {
  function failing(): {
    runtime: ServiceRuntime;
    reported: ServiceError[];
    fail: (error: unknown) => void;
  } {
    const reported: ServiceError[] = [];
    let capture!: (error: unknown) => void;
    const runtime = new ServiceRuntime({
      services: [
        { name: "worker", service: service({ start: (ctx) => { capture = ctx.fail; } }) },
      ],
      system,
      onFatal: (error) => reported.push(error),
    });
    return { runtime, reported, fail: (error) => capture(error) };
  }

  test("reports the failure named, with its cause, exactly once", async () => {
    const { runtime, reported, fail } = failing();
    await runtime.start();

    const cause = new Error("broker connection ended");
    fail(cause);
    fail(new Error("and again"));

    expect(reported).toHaveLength(1);
    expect(reported[0]!.service).toBe("worker");
    expect(reported[0]!.phase).toBe("runtime");
    expect(reported[0]!.cause).toBe(cause);
    expect(reported[0]!.message).toBe(
      'service "worker" failed during runtime: broker connection ended',
    );
  });

  test("is ignored once shutdown has begun", async () => {
    const { runtime, reported, fail } = failing();
    await runtime.start();
    await runtime.stop();

    fail(new Error("noticed while closing"));

    expect(reported).toEqual([]);
  });
});

describe("service shutdown", () => {
  test("aborts, then cleans up in reverse start order", async () => {
    const events: string[] = [];
    const runtime = runtimeOf([
      { name: "a", service: service({ start: (ctx) => {
        ctx.abortSignal.addEventListener("abort", () => events.push("abort:a"));
        return () => { events.push("cleanup:a"); };
      } }) },
      { name: "b", service: service({ start: (ctx) => {
        ctx.abortSignal.addEventListener("abort", () => events.push("abort:b"));
        return () => { events.push("cleanup:b"); };
      } }) },
    ]);

    await runtime.start();
    await runtime.stop();

    expect(events).toEqual(["abort:a", "abort:b", "cleanup:b", "cleanup:a"]);
    expect(runtime.state).toBe("stopped");
  });

  test("stopping twice runs cleanups exactly once", async () => {
    let cleanups = 0;
    const runtime = runtimeOf([
      { name: "a", service: service({ start: () => () => { cleanups += 1; } }) },
    ]);

    await runtime.start();
    await Promise.all([runtime.stop(), runtime.stop()]);
    await runtime.stop();

    expect(cleanups).toBe(1);
  });

  test("reports every failing cleanup by name without hiding the others", async () => {
    const runtime = runtimeOf([
      { name: "a", service: service({ start: () => () => { throw new Error("a down"); } }) },
      { name: "b", service: service({ start: () => () => { throw new Error("b down"); } }) },
    ]);

    await runtime.start();
    const failure = await runtime.stop().then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    const errors = (failure as AggregateError).errors as ServiceError[];
    expect(errors.map((error) => error.service)).toEqual(["b", "a"]);
    expect(runtime.state).toBe("failed");
  });

  test("a hung cleanup is bounded by the caller's deadline", async () => {
    const runtime = runtimeOf([
      { name: "wedged", service: service({ start: () => () => new Promise(() => {}) }) },
    ]);

    await runtime.start();
    const startedAt = performance.now();
    const failure = await runtime.stop(new Error("stopping"), Date.now() + 40).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ code: "deadline_exceeded" });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(runtime.state).toBe("failed");
  });

  test("stopping a runtime that never started is a no-op", async () => {
    const runtime = runtimeOf([
      { name: "a", service: service({ start: () => { throw new Error("never reached"); } }) },
    ]);
    await runtime.stop();
    expect(runtime.state).toBe("stopped");
    await expect(runtime.start()).rejects.toThrow("service runtime cannot start from stopped");
  });

  test("stopping mid-startup waits for the start path to roll back", async () => {
    const cleaned: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = runtimeOf([
      { name: "a", service: service({ start: () => () => { cleaned.push("a"); } }) },
      { name: "b", service: service({ start: async () => { await gate; } }) },
    ]);

    const starting = runtime.start().catch(() => undefined);
    await Bun.sleep(5);
    const stopping = runtime.stop();
    release();
    await Promise.all([starting, stopping]);

    expect(cleaned).toEqual(["a"]);
    expect(runtime.state).toBe("stopped");
  });
});
