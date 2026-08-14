/**
 * Application services end to end through `startApp`: declaration in a
 * `services/` directory, typed system authority, readiness that waits, rollback
 * on setup failure, and shutdown that releases services while `system.run` is
 * still live.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/app/config.ts";
import { startApp } from "../../src/app/start.ts";
import { makeFixture } from "../support/fixture.ts";
import { freePort } from "../support/port.ts";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const APP = `
import { defineApp, defineSchema, defineTable, v } from "@ackerdb/server";

const schema = defineSchema({
  deviceEvents: defineTable({
    id: v.primaryKey(),
    source: v.string(),
  }).index(["source"]),
});

export default defineApp({ schema });
`;

/** Services append to one file so start, cleanup, and their order are provable. */
const RECORDER = `
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const log = join(import.meta.dir, "..", "events.log");

export function record(event) {
  appendFileSync(log, event + "\\n");
}
`;

function events(dir: string): string[] {
  const log = join(dir, "events.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter((line) => line.length > 0);
}

function rows(dir: string): string[] {
  const db = new Database(join(dir, ".ackerdb", "data.db"), { readonly: true });
  try {
    return (db.query("SELECT source FROM deviceEvents ORDER BY id").all() as Array<
      { source: string }
    >).map((row) => row.source);
  } finally {
    db.close();
  }
}

function fixture(services: Record<string, string>, port: number): string {
  const dir = makeFixture({
    "app.ts": APP,
    ".ackerdb.config.json": JSON.stringify({ port }),
    "lib/record.ts": RECORDER,
    ...services,
  });
  dirs.push(dir);
  return dir;
}

describe("application services", () => {
  test("starts every declared service with working system authority", async () => {
    const port = await freePort();
    const dir = fixture({
      "services/providers.ts": `
import { service } from "@ackerdb/server";
import { record } from "../lib/record.ts";

async function persist(system, source) {
  await system.run("devices.event", (ctx) => {
    return ctx.tx((tx) => tx.db.deviceEvents.insert({ source }));
  });
}

export const tuya = service({
  start: async ({ system }) => {
    record("start:tuya");
    await persist(system, "tuya");
    return () => record("cleanup:tuya");
  },
});

export const tcl = service({
  start: async ({ system }) => {
    record("start:tcl");
    await persist(system, "tcl");
    return () => record("cleanup:tcl");
  },
});
`,
    }, port);

    const running = await startApp(loadConfig(dir));
    try {
      expect(running.services).toEqual(["providers.tcl", "providers.tuya"]);
      // Sorted by module key then export, so tcl precedes tuya.
      expect(events(dir)).toEqual(["start:tcl", "start:tuya"]);
      expect(rows(dir)).toEqual(["tcl", "tuya"]);

      const ready = await (await fetch(`http://127.0.0.1:${port}/ready`)).json();
      expect(ready).toMatchObject({ ready: true });
    } finally {
      await running.drain();
    }

    expect(events(dir)).toEqual([
      "start:tcl",
      "start:tuya",
      // Reverse start order.
      "cleanup:tuya",
      "cleanup:tcl",
    ]);
  }, 20_000);

  test("a callback firing after setup persists through system.run", async () => {
    const port = await freePort();
    const dir = fixture({
      "services/providers.ts": `
import { service } from "@ackerdb/server";
import { record } from "../lib/record.ts";

// The shape every broker adapter has: setup subscribes, and the work happens
// later, in a callback nothing awaits.
export const tuya = service({
  start: ({ system, abortSignal }) => {
    const timer = setInterval(() => {
      void system.run("devices.event", (ctx) =>
        ctx.tx((tx) => tx.db.deviceEvents.insert({ source: "callback" })))
        .then(() => record("persisted"))
        .catch(() => record("rejected"));
    }, 5);
    return () => clearInterval(timer);
  },
});
`,
    }, port);

    const running = await startApp(loadConfig(dir));
    try {
      // Wait for the callback to land at least one row after readiness.
      const deadline = Date.now() + 5_000;
      while (rows(dir).length === 0 && Date.now() < deadline) await Bun.sleep(10);
      expect(rows(dir)[0]).toBe("callback");
      expect(events(dir)).toContain("persisted");
    } finally {
      await running.drain();
    }
  }, 20_000);

  test("a service that dies during another's setup fails startup", async () => {
    const port = await freePort();
    const dir = fixture({
      "services/providers.ts": `
import { service } from "@ackerdb/server";
import { record } from "../lib/record.ts";

export const alpha = service({
  start: ({ fail }) => {
    setTimeout(() => fail(new Error("broker dropped immediately")), 1);
    return () => record("cleanup:alpha");
  },
});

export const beta = service({
  start: async () => {
    await Bun.sleep(30);
    record("start:beta");
    return () => record("cleanup:beta");
  },
});
`,
    }, port);

    // Readiness is never published for a generation that was not whole.
    await expect(startApp(loadConfig(dir))).rejects.toThrow(
      'service "providers.alpha" failed during runtime: broker dropped immediately',
    );
    expect(events(dir)).toEqual(["start:beta", "cleanup:beta", "cleanup:alpha"]);
    await expect(fetch(`http://127.0.0.1:${port}/ready`)).rejects.toThrow();
  }, 20_000);

  test("readiness is not published until every setup resolves", async () => {
    const port = await freePort();
    const dir = fixture({
      "services/gate.ts": `
import { service } from "@ackerdb/server";
import { record } from "../lib/record.ts";

export const slow = service({
  start: async () => {
    const response = await fetch("http://127.0.0.1:${port}/ready");
    const body = await response.json();
    record("ready-during-setup:" + body.ready + ":" + body.state);
    await Bun.sleep(20);
  },
});
`,
    }, port);

    const running = await startApp(loadConfig(dir));
    try {
      expect(events(dir)).toEqual(["ready-during-setup:false:starting"]);
    } finally {
      await running.drain();
    }
  }, 20_000);

  test("readiness names the service currently starting", async () => {
    const port = await freePort();
    const dir = fixture({
      "services/providers.ts": `
import { service } from "@ackerdb/server";
import { record } from "../lib/record.ts";

async function reportReadiness() {
  const body = await (await fetch("http://127.0.0.1:${port}/ready")).json();
  record(body.phase + ":" + (body.service ?? "none"));
}

export const alpha = service({ start: reportReadiness });
export const beta = service({ start: reportReadiness });
`,
    }, port);

    const running = await startApp(loadConfig(dir));
    try {
      expect(events(dir)).toEqual([
        "starting-services:providers.alpha",
        "starting-services:providers.beta",
      ]);
      // The phase clears once the application is ready.
      const ready = await (await fetch(`http://127.0.0.1:${port}/ready`)).json();
      expect(ready.phase).toBeUndefined();
      expect(ready.service).toBeUndefined();
      expect(running.server.status()).toMatchObject({
        startupPhase: null,
        startupService: null,
      });
    } finally {
      await running.drain();
    }
  }, 20_000);

  test("an application with no services never enters the service phase", async () => {
    const port = await freePort();
    const dir = fixture({}, port);
    const running = await startApp(loadConfig(dir));
    try {
      expect(running.server.status()).toMatchObject({ startupService: null });
    } finally {
      await running.drain();
    }
  }, 20_000);

  test("a setup failure fails startup, names the service, and rolls earlier ones back", async () => {
    const port = await freePort();
    const dir = fixture({
      "services/providers.ts": `
import { service } from "@ackerdb/server";
import { record } from "../lib/record.ts";

export const first = service({
  start: () => {
    record("start:first");
    return () => record("cleanup:first");
  },
});

export const second = service({
  start: () => {
    record("start:second");
    throw new Error("broker refused the connection");
  },
});
`,
    }, port);

    await expect(startApp(loadConfig(dir))).rejects.toThrow(
      'service "providers.second" failed during setup',
    );

    expect(events(dir)).toEqual(["start:first", "start:second", "cleanup:first"]);
    // Nothing is left listening on a failed startup.
    await expect(fetch(`http://127.0.0.1:${port}/ready`)).rejects.toThrow();
  }, 20_000);

  test("cleanup still holds system authority and its writes are durable", async () => {
    const port = await freePort();
    const dir = fixture({
      "services/flusher.ts": `
import { service } from "@ackerdb/server";
import { record } from "../lib/record.ts";

export const pending = service({
  start: ({ system, abortSignal }) => {
    abortSignal.addEventListener("abort", () => record("aborted"));
    return async () => {
      record("cleanup");
      await system.run("devices.flush", (ctx) =>
        ctx.tx((tx) => tx.db.deviceEvents.insert({ source: "flushed-at-shutdown" })));
      record("flushed");
    };
  },
});
`,
    }, port);

    const running = await startApp(loadConfig(dir));
    await running.drain();

    // The signal fires before cleanup, so a blocking consumer can begin
    // cooperative cancellation while cleanup is still allowed to persist.
    expect(events(dir)).toEqual(["aborted", "cleanup", "flushed"]);
    expect(rows(dir)).toEqual(["flushed-at-shutdown"]);
  }, 20_000);

  test("a failing cleanup is reported by name and does not strand the server", async () => {
    const port = await freePort();
    const dir = fixture({
      "services/providers.ts": `
import { service } from "@ackerdb/server";
import { record } from "../lib/record.ts";

export const stubborn = service({
  start: () => () => { throw new Error("socket refused to close"); },
});

export const polite = service({
  start: () => () => record("cleanup:polite"),
});
`,
    }, port);

    const running = await startApp(loadConfig(dir));
    await expect(running.drain()).rejects.toThrow(
      'service "providers.stubborn" failed during cleanup',
    );

    // The polite service still got its cleanup, and the listener is gone.
    expect(events(dir)).toEqual(["cleanup:polite"]);
    expect(running.server.state).toBe("stopped");
    await expect(fetch(`http://127.0.0.1:${port}/ready`)).rejects.toThrow();
  }, 20_000);

  test("a fatal post-setup failure surfaces to the host with its owner named", async () => {
    const port = await freePort();
    const dir = fixture({
      "services/worker.ts": `
import { service } from "@ackerdb/server";
import { record } from "../lib/record.ts";

export const queue = service({
  start: ({ fail }) => {
    // The shape a real worker has: nothing awaits this callback.
    setTimeout(() => fail(new Error("queue connection ended")), 5);
    return () => record("cleanup:queue");
  },
});
`,
    }, port);

    const running = await startApp(loadConfig(dir));
    const failure = await running.serviceFailure;

    expect(failure.service).toBe("worker.queue");
    expect(failure.message).toBe(
      'service "worker.queue" failed during runtime: queue connection ended',
    );
    // The host stays in control: nothing shut down until it says so.
    expect(running.server.state).toBe("ready");

    await running.drain();
    expect(events(dir)).toEqual(["cleanup:queue"]);
  }, 20_000);

  test("an unbranded service shape fails startup instead of silently doing nothing", async () => {
    const port = await freePort();
    const dir = fixture({
      "services/providers.ts": `
export const forgotten = { start: () => {} };
`,
    }, port);

    await expect(startApp(loadConfig(dir))).rejects.toThrow(
      'service module export "providers.forgotten" has a start function but was not created with service(...)',
    );
  }, 20_000);

  test("an application with no services directory starts unchanged", async () => {
    const port = await freePort();
    const dir = fixture({}, port);

    const running = await startApp(loadConfig(dir));
    try {
      expect(running.services).toEqual([]);
    } finally {
      await running.drain();
    }
  }, 20_000);
});
