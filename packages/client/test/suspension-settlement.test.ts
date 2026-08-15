/**
 * ISSUE-13: settlement of non-resumable work (procedures and SSE streams)
 * across mobile suspension. Suspension must settle every in-flight procedure
 * and SSE stream promptly with its exact suspension-marked typed outcome,
 * release readers/reservations/acknowledgement machinery, refuse (never
 * queue) non-resumable work started while suspended, and keep activation
 * from silently restarting or being corrupted by any of it. Resumable work
 * (queries, mutations) recovering independently is proven alongside.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACKERDB_VERSION,
  decode,
  encode,
  parseSseAckRequest,
  type SseAckRequest,
} from "@ackerdb/core";
import {
  AckerDBClient,
  AckerDBClientError,
  type AckerDBClientOptions,
  type AckerDBFetch,
  type AckerDBLifecyclePort,
} from "@ackerdb/client";
import { ManualClock } from "ackerdb-test-support/client-transport";
import { createHarness, mustErr, type ClientHarness } from "./support/harness.ts";
import {
  Engine,
  PRODUCTION_LIMITS,
  Registry,
  Runtime,
  v,
  defineSchema,
  procedure,
  reconcile,
  sseProcedure,
  type SseCtx,
} from "@ackerdb/server";
import { deferred, until, waitForAbort, within } from "ackerdb-test-support/async";
import { listen } from "ackerdb-test-support/listen";

const encoder = new TextEncoder();

/** A scripted SSE exchange journal shared by every fake-fetch harness. */
interface HttpJournal {
  /** Chronological per-function stream paths the client dispatched to. */
  readonly dispatches: string[];
  /** Every `/_sse/ack` request the client issued, parsed. */
  readonly acknowledgments: SseAckRequest[];
}

type Route = (init: RequestInit | undefined) => Promise<Response> | Response;

interface Harness extends ClientHarness {
  /** Every SSE dispatch and acknowledgment the client made, in order. */
  readonly journal: HttpJournal;
}

/**
 * The shared client harness plus the HTTP side this suite owns: non-resumable
 * work settles over SSE, so the routes are scripted and every dispatch and
 * acknowledgment is journalled.
 */
function harness(
  routes: { readonly sse?: Route },
  overrides: Partial<AckerDBClientOptions> = {},
): Harness {
  const journal: HttpJournal = { dispatches: [], acknowledgments: [] };
  const fetcher: AckerDBFetch = (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/_sse/ack") {
      journal.acknowledgments.push(parseSseAckRequest(decode(String(init?.body))));
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    journal.dispatches.push(path);
    const route = routes.sse;
    if (!route) throw new Error(`no scripted route for ${path}`);
    return Promise.resolve(route(init));
  };
  const base = createHarness({
    clientSessionId: "settlement-session",
    fetch: fetcher,
    ...overrides,
  });
  return {
    client: base.client,
    clock: base.clock,
    sockets: base.sockets,
    // Forwarded lazily: the port only exists once the client registers, and
    // reading it eagerly here would fail a suite that overrides `lifecycle`.
    get port(): AckerDBLifecyclePort {
      return base.port;
    },
    phases: base.phases,
    stops: base.stops,
    failNextDial: base.failNextDial,
    live: base.live,
    journal,
  };
}

/** A response body whose delivery and cancellation the test controls exactly. */
interface OpenBody {
  readonly response: Response;
  /** Enqueue raw bytes; reports whether the stream could still accept them. */
  push(text: string): boolean;
  error(reason: unknown): void;
  /** Every reason `cancel()` reached the underlying source with. */
  readonly cancels: unknown[];
}

function openBody(init: ResponseInit): OpenBody {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancels: unknown[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
    cancel(reason) {
      cancels.push(reason);
    },
  });
  return {
    response: new Response(body, init),
    push(text) {
      try {
        controller.enqueue(encoder.encode(text));
        return true;
      } catch {
        return false;
      }
    },
    error(reason) {
      try {
        controller.error(reason);
      } catch {
        // The stream may already be past erroring; the test asserts effects.
      }
    },
    cancels,
  };
}

function openSse(stream = "stream-1"): OpenBody & { chunk(seq: number, value: unknown): boolean } {
  const open = openBody({
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "x-ackerdb-sse-stream": stream,
      "x-ackerdb-sse-max-stall-ms": "5000",
    },
  });
  return {
    ...open,
    chunk(seq, value) {
      return open.push(
        `data: ${encode({ v: ACKERDB_VERSION, t: "sse_chunk", seq, proof: `proof-${seq}`, value })}\n\n`,
      );
    },
  };
}

/** The exact suspension-marked settlement shape. */
function expectSuspensionOutcome(
  error: unknown,
  expected: { code: string; message: string; resource: string },
): void {
  expect(error).toBeInstanceOf(AckerDBClientError);
  const settled = error as AckerDBClientError;
  expect(settled.code).toBe(expected.code as AckerDBClientError["code"]);
  expect(settled.message).toBe(expected.message);
  expect(settled.resource).toBe(expected.resource as AckerDBClientError["resource"]);
  expect(settled.retryable).toBe(false);
  expect(settled.interruption).toBe("suspension");
}

describe("non-resumable work started while suspended", () => {
  test("a procedure settles determinately with the marked refusal and never dispatches", async () => {
    const { client, clock, sockets, port, journal } = harness({});
    port.suspend();

    const refusal = await client.procedure("api.tools.echo", {});
    if (refusal.ok) throw new Error("expected a suspended procedure to fail");
    expectSuspensionOutcome(refusal.error, {
      code: "unavailable",
      message: "client is suspended",
      resource: "operation",
    });
    expect(journal.dispatches).toEqual([]);
    expect(clock.taskCount).toBe(0);

    // Activation restarts nothing: the refused call was settled, not queued.
    port.resume();
    clock.advance(60_000);
    expect(journal.dispatches).toEqual([]);
    expect(sockets).toHaveLength(2);

    // The client itself is fully usable again after activation.
    const resumed = client.procedure<Record<never, never>, string>("api.tools.echo", {});
    expect(sockets).toHaveLength(2);
    sockets[1]!.welcome(client.clientSessionId);
    const request = sockets[1]!.lastFrame("p");
    sockets[1]!.receive({
      t: "ok",
      id: request.id,
      kind: "procedure",
      value: "late",
    });
    const resumedResult = await resumed;
    if (!resumedResult.ok) throw resumedResult.error;
    expect(resumedResult.data).toBe("late");
    expect(journal.dispatches).toEqual([]);
    client.close();
  });

  test("an SSE stream first pulled while suspended settles determinately and never dispatches", async () => {
    const { client, clock, port, journal } = harness({
      sse: () => {
        const scripted = openSse();
        scripted.chunk(1, { tick: 0 });
        return scripted.response;
      },
    });
    port.suspend();

    const iterator = client.sse("api.stream.ticks", {})[Symbol.asyncIterator]();
    const refusal = await iterator.next().catch((error) => error);
    expectSuspensionOutcome(refusal, {
      code: "unavailable",
      message: "client is suspended",
      resource: "sse",
    });
    // Exactly one terminal outcome: the finished generator only reports done.
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(journal.dispatches).toEqual([]);
    expect(journal.acknowledgments).toEqual([]);
    expect(clock.taskCount).toBe(0);

    port.resume();
    clock.advance(60_000);
    expect(journal.dispatches).toEqual([]);

    // A fresh stream after activation is ordinary work.
    const fresh = client.sse<Record<never, never>, { tick: number }>("api.stream.ticks", {})[
      Symbol.asyncIterator
    ]();
    expect(await fresh.next()).toEqual({ done: false, value: { tick: 0 } });
    expect(journal.dispatches).toEqual(["/api/stream/ticks"]);
    await fresh.return(undefined);
    client.close();
  });

  test("suspension ownership keys on the first pull: a stream created while suspended but first pulled while active is fresh foreground work", async () => {
    // The lazy-stream twin of the refusal contract, pinned deliberately: the
    // generator object is a description of work, and the work itself starts
    // at the first pull — exactly procedure()'s call-time rule. A stream
    // never pulled during the gap holds no state, hangs no caller, and has
    // nothing for activation to restart, so its first pull while active is
    // ordinary demand-driven work, never a phantom suspension outcome.
    const scripted = openSse();
    const { client, port, journal } = harness({ sse: () => scripted.response });

    port.suspend();
    const createdSuspended = client.sse<Record<never, never>, { tick: number }>("api.stream.hold", {})[
      Symbol.asyncIterator
    ]();
    // Nothing dispatched, nothing reserved, nothing pending: no work exists.
    expect(journal.dispatches).toEqual([]);
    port.resume();

    scripted.chunk(1, { tick: 0 });
    expect(await createdSuspended.next()).toEqual({ done: false, value: { tick: 0 } });
    expect(journal.dispatches).toEqual(["/api/stream/hold"]);
    await createdSuspended.return(undefined);
    client.close();
  });

  test("a caller's pre-aborted signal outranks the suspension refusal", async () => {
    const { client, port } = harness({});
    port.suspend();
    const controller = new AbortController();
    controller.abort();

    const procedureOutcome = mustErr(
      await client.procedure("api.tools.echo", {}, { signal: controller.signal }),
    );
    expect(procedureOutcome.message).toBe("procedure request was canceled");
    expect(procedureOutcome.interruption).toBeUndefined();

    const sseOutcome = (await client
      .sse("api.stream.ticks", {}, { signal: controller.signal })
      .next()
      .catch((error) => error)) as AckerDBClientError;
    expect(sseOutcome.message).toBe("SSE request was canceled");
    expect(sseOutcome.interruption).toBeUndefined();
    client.close();
  });
});

describe("suspension settles in-flight procedures", () => {
  test("after dispatch the outcome is marked; caller aborts and close stay unmarked", async () => {
    const abortable = new AbortController();
    const { client, clock, sockets, port } = harness({});

    // A caller abort before suspension keeps the plain indeterminate outcome.
    const canceled = client
      .procedure("api.tools.echo", {}, { signal: abortable.signal })
      .then(mustErr);
    sockets[0]!.welcome(client.clientSessionId);
    const canceledRequest = sockets[0]!.lastFrame("p");
    abortable.abort();
    const callerOutcome = (await canceled) as AckerDBClientError;
    expect(callerOutcome.code).toBe("indeterminate");
    expect(callerOutcome.message).toBe("procedure completion is unknown");
    expect(callerOutcome.interruption).toBeUndefined();
    expect(sockets[0]!.lastFrame("cancel").id).toBe(canceledRequest.id);

    const suspended = client.procedure("api.tools.echo", {}).then(mustErr);
    const suspendedRequest = sockets[0]!.lastFrame("p");
    port.suspend();
    expectSuspensionOutcome(await suspended, {
      code: "indeterminate",
      message: "procedure completion is unknown",
      resource: "operation",
    });
    expect(sockets[0]!.lastFrame("cancel").id).toBe(suspendedRequest.id);
    // Settlement released the request's own deadline timer with it.
    expect(clock.taskCount).toBe(0);
    client.close();

    // close() on a fresh client settles the same boundary without the marker.
    const closing = harness({});
    const closed = closing.client.procedure("api.tools.echo", {}).then(mustErr);
    closing.sockets[0]!.welcome(closing.client.clientSessionId);
    closing.client.close();
    const closedOutcome = (await closed) as AckerDBClientError;
    expect(closedOutcome.code).toBe("indeterminate");
    expect(closedOutcome.interruption).toBeUndefined();
  });

  test("suspension sends a best-effort cancel and a late result is inert", async () => {
    const { client, clock, sockets, port } = harness({});
    const call = client.procedure("api.tools.echo", {}).then(mustErr);
    sockets[0]!.welcome(client.clientSessionId);
    const request = sockets[0]!.lastFrame("p");
    port.suspend();
    expectSuspensionOutcome(await call, {
      code: "indeterminate",
      message: "procedure completion is unknown",
      resource: "operation",
    });
    expect(sockets[0]!.lastFrame("cancel").id).toBe(request.id);
    sockets[0]!.receive({
      t: "ok",
      id: request.id,
      kind: "procedure",
      value: "late",
    });
    expect(clock.taskCount).toBe(0);
    client.close();
  });

  test("a stale frame after resume settles nothing on the replacement generation", async () => {
    const { client, sockets, port, journal } = harness({});

    const interrupted = client.procedure("api.tools.echo", {});
    sockets[0]!.welcome(client.clientSessionId);
    const staleRequest = sockets[0]!.lastFrame("p");
    port.suspend();
    const interruptedResult = await interrupted;
    if (interruptedResult.ok) throw new Error("expected the interrupted procedure to fail");
    expectSuspensionOutcome(interruptedResult.error, {
      code: "indeterminate",
      message: "procedure completion is unknown",
      resource: "operation",
    });

    port.resume();
    const replacement = client.procedure("api.tools.echo", {});
    expect(sockets).toHaveLength(2);
    sockets[1]!.welcome(client.clientSessionId);
    const replacementRequest = sockets[1]!.lastFrame("p");

    sockets[0]!.receive({
      t: "ok",
      id: staleRequest.id,
      kind: "procedure",
      value: "stale",
    });
    sockets[1]!.receive({
      t: "ok",
      id: replacementRequest.id,
      kind: "procedure",
      value: "fresh",
    });
    const replacementResult = await replacement;
    if (!replacementResult.ok) throw replacementResult.error;
    expect(replacementResult.data).toBe("fresh");
    expect(journal.dispatches).toHaveLength(0);
    client.close();
  });
});

describe("suspension settles in-flight SSE streams at every boundary", () => {
  test("before the first chunk: prompt marked settlement, late response canceled, no acknowledgement", async () => {
    const pending = deferred<Response>();
    const { client, clock, port, journal } = harness({ sse: () => pending.promise });

    const iterator = client.sse("api.stream.hold", {})[Symbol.asyncIterator]();
    const first = iterator.next().catch((error) => error);
    await Bun.sleep(0);
    expect(journal.dispatches).toEqual(["/api/stream/hold"]);

    port.suspend();
    expectSuspensionOutcome(await first, {
      code: "unavailable",
      message: "SSE stream was interrupted by suspension",
      resource: "sse",
    });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(clock.taskCount).toBe(0);

    // The retired generation's response resolves after activation: its body
    // is released with the marked reason and nothing is acknowledged.
    port.resume();
    const late = openSse();
    pending.resolve(late.response);
    await Bun.sleep(0);
    expect(late.cancels).toHaveLength(1);
    expect((late.cancels[0] as AckerDBClientError).interruption).toBe("suspension");
    expect(journal.acknowledgments).toEqual([]);
    expect(journal.dispatches).toHaveLength(1);
    client.close();
  });

  test("parked between chunks with the chunk unacknowledged: source released, phantom delivery impossible", async () => {
    const scripted = openSse();
    const { client, clock, port, journal } = harness({ sse: () => scripted.response });

    const iterator = client.sse<Record<never, never>, { tick: number }>("api.stream.hold", {})[
      Symbol.asyncIterator
    ]();
    scripted.chunk(1, { tick: 0 });
    expect(await iterator.next()).toEqual({ done: false, value: { tick: 0 } });
    // Chunk 1's credit is only sent by the next pull: it is outstanding now.
    expect(journal.acknowledgments).toEqual([]);

    port.suspend();
    await Bun.sleep(0);
    // Cancellation reached the source reader promptly — the server-side
    // release signal — carrying the marked reason.
    expect(scripted.cancels).toHaveLength(1);
    expect((scripted.cancels[0] as AckerDBClientError).interruption).toBe("suspension");
    // A phantom chunk can no longer be delivered through the retired stream.
    expect(scripted.chunk(2, { tick: 1 })).toBe(false);

    // The next pull observes the one terminal outcome; the outstanding
    // acknowledgement is released, never sent late.
    expectSuspensionOutcome(await iterator.next().catch((error) => error), {
      code: "unavailable",
      message: "SSE stream was interrupted by suspension",
      resource: "sse",
    });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(journal.acknowledgments).toEqual([]);
    expect(clock.taskCount).toBe(0);

    port.resume();
    clock.advance(60_000);
    expect(journal.dispatches).toHaveLength(1);
    expect(journal.acknowledgments).toEqual([]);
    client.close();
  });

  test("during a downstream pull: the pending pull settles promptly with the marked outcome", async () => {
    const scripted = openSse();
    const { client, clock, port, journal } = harness({ sse: () => scripted.response });

    const iterator = client.sse<Record<never, never>, { tick: number }>("api.stream.hold", {})[
      Symbol.asyncIterator
    ]();
    scripted.chunk(1, { tick: 0 });
    expect(await iterator.next()).toEqual({ done: false, value: { tick: 0 } });

    // The second pull acknowledges chunk 1, then parks on the source read.
    const second = iterator.next().catch((error) => error);
    await Bun.sleep(0);
    expect(journal.acknowledgments).toEqual([
      { v: ACKERDB_VERSION, t: "sse_ack", stream: "stream-1", seq: 1, proof: "proof-1" },
    ]);

    port.suspend();
    expectSuspensionOutcome(await second, {
      code: "unavailable",
      message: "SSE stream was interrupted by suspension",
      resource: "sse",
    });
    expect(scripted.cancels).toHaveLength(1);
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(journal.acknowledgments).toHaveLength(1);
    expect(clock.taskCount).toBe(0);
    client.close();
  });

  test("during an in-flight acknowledgement: marked settlement and the ack machinery fully stops", async () => {
    const scripted = openSse();
    const clock = new ManualClock();
    let heldAcks = 0;
    const journalAcks: SseAckRequest[] = [];
    const { client, port } = harness(
      { sse: () => scripted.response },
      {
        clock,
        fetch: (url, init) => {
          const path = new URL(url).pathname;
          if (path === "/_sse/ack") {
            heldAcks++;
            journalAcks.push(parseSseAckRequest(decode(String(init?.body))));
            return new Promise<Response>(() => {});
          }
          return Promise.resolve(scripted.response);
        },
      },
    );

    const iterator = client.sse<Record<never, never>, { tick: number }>("api.stream.hold", {})[
      Symbol.asyncIterator
    ]();
    scripted.chunk(1, { tick: 0 });
    expect(await iterator.next()).toEqual({ done: false, value: { tick: 0 } });

    // The second pull is parked inside the chunk-1 acknowledgement.
    const second = iterator.next().catch((error) => error);
    await Bun.sleep(0);
    expect(heldAcks).toBe(1);

    port.suspend();
    expectSuspensionOutcome(await second, {
      code: "unavailable",
      message: "SSE stream was interrupted by suspension",
      resource: "sse",
    });
    // The acknowledgement deadline timer and retry loop died with the stream.
    expect(clock.taskCount).toBe(0);
    port.resume();
    clock.advance(60_000);
    expect(heldAcks).toBe(1);
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    client.close();
  });

  test("during a non-OK response body read: the marked outcome, not a plain read cancellation", async () => {
    // The server rejected the stream (503) but its error body is still
    // arriving when the app backgrounds: settlement must carry the
    // suspension marker exactly like every other boundary.
    const errorBody = openBody({ status: 503 });
    const { client, port } = harness({ sse: () => errorBody.response });

    const iterator = client.sse("api.stream.hold", {})[Symbol.asyncIterator]();
    const first = iterator.next().catch((error) => error);
    await Bun.sleep(0);

    port.suspend();
    expectSuspensionOutcome(await first, {
      code: "unavailable",
      message: "SSE stream was interrupted by suspension",
      resource: "sse",
    });
    await Bun.sleep(0);
    expect(errorBody.cancels).toHaveLength(1);
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    client.close();
  });

  test("a source failure landing after suspension cannot produce a second outcome", async () => {
    const scripted = openSse();
    const { client, port } = harness({ sse: () => scripted.response });

    const iterator = client.sse<Record<never, never>, { tick: number }>("api.stream.hold", {})[
      Symbol.asyncIterator
    ]();
    scripted.chunk(1, { tick: 0 });
    expect(await iterator.next()).toEqual({ done: false, value: { tick: 0 } });
    const second = iterator.next().catch((error) => error);
    await Bun.sleep(0);

    port.suspend();
    // The disconnecting source errors after the abort has already settled
    // ownership: cancellation owns the outcome.
    scripted.error(new Error("connection reset"));
    expectSuspensionOutcome(await second, {
      code: "unavailable",
      message: "SSE stream was interrupted by suspension",
      resource: "sse",
    });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    client.close();
  });

  test("a stale SSE response resolving after resume cannot deliver into replacement work", async () => {
    const stale = deferred<Response>();
    const replacement = openSse("stream-2");
    let dispatches = 0;
    const { client, port, journal } = harness({
      sse: () => (++dispatches === 1 ? stale.promise : replacement.response),
    });

    const interrupted = client.sse("api.stream.hold", {})[Symbol.asyncIterator]();
    const first = interrupted.next().catch((error) => error);
    await Bun.sleep(0);
    port.suspend();
    expectSuspensionOutcome(await first, {
      code: "unavailable",
      message: "SSE stream was interrupted by suspension",
      resource: "sse",
    });
    port.resume();

    // Replacement stream on the fresh generation.
    const fresh = client.sse<Record<never, never>, { tick: number }>("api.stream.hold", {})[
      Symbol.asyncIterator
    ]();
    replacement.chunk(1, { tick: 7 });
    expect(await fresh.next()).toEqual({ done: false, value: { tick: 7 } });

    // The retired generation's response arrives now, carrying chunks.
    const staleBody = openSse("stream-1");
    staleBody.chunk(1, { tick: 666 });
    stale.resolve(staleBody.response);
    await Bun.sleep(0);
    expect(staleBody.cancels).toHaveLength(1);

    // The replacement stream runs to completion undisturbed, and every credit
    // the client sends names the replacement stream, never the retired one.
    replacement.chunk(2, { tick: 8 });
    expect(await fresh.next()).toEqual({ done: false, value: { tick: 8 } });
    replacement.push(
      `data: ${encode({ v: ACKERDB_VERSION, t: "sse_done", seq: 3, proof: "proof-3" })}\n\n`,
    );
    expect(await fresh.next()).toEqual({ done: true, value: undefined });
    expect(journal.acknowledgments.map((acknowledgment) => acknowledgment.stream)).toEqual([
      "stream-2",
      "stream-2",
      "stream-2",
    ]);
    expect(journal.acknowledgments.map((acknowledgment) => acknowledgment.seq)).toEqual([1, 2, 3]);
    client.close();
  });
});

describe("suspension settlement against a real ackerdb server", () => {
  test("mid-stream suspension releases the server iterator and settles the client stream once", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ackerdb-settlement-real-"));
    const engine = new Engine(defineSchema({}), join(directory, "data.db"));
    reconcile(engine);
    const holdReleased = deferred<void>();
    const procedureStarted = deferred<void>();
    const procedureGate = deferred<void>();
    const registry = new Registry({
      stream: {
        holdAfterFirst: sseProcedure({
          access: "public",
          http: true,
          args: {},
          yields: v.object({ phase: v.string() }),
          handler: async function* (ctx: SseCtx) {
            try {
              yield { phase: "one" };
              await waitForAbort(ctx.abortSignal);
            } finally {
              holdReleased.resolve(undefined);
            }
          },
        }),
        ticks: sseProcedure({
          access: "public",
          http: true,
          args: {},
          yields: v.object({ tick: v.int() }),
          handler: async function* () {
            yield { tick: 0 };
          },
        }),
      },
      tools: {
        hold: procedure({
          access: "public",
          args: {},
          handler: async () => {
            procedureStarted.resolve(undefined);
            await procedureGate.promise;
            return "late";
          },
        }),
      },
    });
    const runtime = new Runtime({ engine, registry, limits: PRODUCTION_LIMITS });
    await runtime.start();
    const server = listen(runtime);
    // A fake clock against the real server: settlement reaching the caller
    // proves the whole progression runs on abort events alone — no timers.
    const clock = new ManualClock(Date.now());
    let port: AckerDBLifecyclePort | undefined;
    const requests: string[] = [];
    const client = new AckerDBClient({
      url: `http://127.0.0.1:${server.port}`,
      credential: { kind: "anonymous" },
      clock,
      fetch: (url, init) => {
        const path = new URL(url).pathname;
        if (path !== "/_sse/ack") requests.push(path);
        return fetch(url, init);
      },
      lifecycle: (livePort) => {
        port = livePort;
        return () => {};
      },
    });
    try {
      const iterator = client.sse<Record<never, never>, { phase: string }>(
        "api.stream.holdAfterFirst",
        {},
      )[Symbol.asyncIterator]();
      expect(await within(iterator.next(), "the first chunk")).toEqual({
        done: false,
        value: { phase: "one" },
      });
      const pull = iterator.next().catch((error) => error);
      await until(() => runtime.status().activeSse === 1, "the server stream to register");

      // A real procedure held open on the server at the same moment.
      const held = client.procedure("api.tools.hold", {}).then(mustErr);
      await within(procedureStarted.promise, "the held procedure to start");

      port!.suspend();
      expectSuspensionOutcome(await within(pull, "the marked stream settlement"), {
        code: "unavailable",
        message: "SSE stream was interrupted by suspension",
        resource: "sse",
      });
      expectSuspensionOutcome(await within(held, "the marked procedure settlement"), {
        code: "indeterminate",
        message: "procedure completion is unknown",
        resource: "operation",
      });
      // Cancellation reached the source iterator on the server, and the
      // server released the stream's acknowledgement state.
      await within(holdReleased.promise, "the handler finally block");
      await until(() => runtime.status().activeSse === 0, "the server stream to settle");
      expect(await iterator.next()).toEqual({ done: true, value: undefined });

      // The held procedure completing on the server after settlement is inert.
      procedureGate.resolve(undefined);
      await Bun.sleep(10);

      // Activation restarts nothing, and fresh work flows normally.
      const dispatched = requests.length;
      port!.resume();
      await Bun.sleep(10);
      expect(requests.length).toBe(dispatched);
      const fresh = client.sse<Record<never, never>, { tick: number }>("api.stream.ticks", {})[
        Symbol.asyncIterator
      ]();
      expect(await within(fresh.next(), "the fresh stream's chunk")).toEqual({
        done: false,
        value: { tick: 0 },
      });
      await fresh.return(undefined);
      await until(() => runtime.status().activeSse === 0, "the fresh stream to settle");
    } finally {
      client.close();
      await server.drain();
      engine.close("clean");
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
