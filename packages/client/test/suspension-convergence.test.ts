// ISSUE-12: foreground mutation and event convergence across mobile
// suspension. ISSUE-11 proved query recovery on the connection-generation
// model; this suite proves the two other resumable/convergent operation
// families — pending mutations and live event subscriptions — at every
// protocol boundary a background transition can land on: before send, after
// send/before response, mid-response (receipt applied, convergence
// obligations pending), and after settlement. The real-server section proves
// the at-most-one-server-effect guarantee with actual commits, including a
// server stopped and restarted while the application is backgrounded.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  decode,
  parseClientMessage,
  type AuthenticationDescriptor,
  type ClientMessage,
  type Identity,
  type LiveEventCursor,
  type ServerMessage,
  type SubscriptionCursor,
} from "@ackerdb/core";
import {
  AckerDBClient,
  AckerDBClientError,
  type AckerDBClientOptionsBase,
  type AckerDBLifecyclePort,
  type AckerDBLiveEvent,
  type AckerDBWebSocket,
} from "@ackerdb/client";
import { FakeSocket, ManualClock } from "ackerdb-test-support/client-transport";
import { createHarness, cursor, mustOk } from "./support/harness.ts";

import {
  Engine,
  PRODUCTION_LIMITS,
  Registry,
  Runtime,
  v,
  defineEventTable,
  defineSchema,
  defineTable,
  mutation,
  query,
  reconcile,
  serve,
} from "@ackerdb/server";
import {
  FrameProxy,
  assertTcpPortReleased,
} from "../../server/test/support/frame-proxy.ts";
import { until, within } from "ackerdb-test-support/async";

const USER_AUTHENTICATION = {
  principal: "user",
  identity: 1n as Identity,
  provenance: { issuer: "https://issuer.example", subject: "user-1" },
  credentialTtlMs: 60_000,
} satisfies AuthenticationDescriptor;

function eventCursor(
  sequence: bigint,
  generation = "events-1",
  commitVersion = 1n,
): LiveEventCursor {
  return { generation, commitVersion, sequence };
}

function transition(
  id: number,
  to: SubscriptionCursor,
  value: unknown,
  from: SubscriptionCursor | null = null,
): ServerMessage {
  return {
    v: PROTOCOL_VERSION,
    t: "transition",
    id,
    transition:
      from === null
        ? { kind: "reset", from: null, to, value }
        : { kind: "update", from, to, value },
  };
}

function mutationOk(
  frame: Extract<ClientMessage, { t: "m" }>,
  value: unknown,
  options: {
    readonly replay?: "executed" | "replayed";
    readonly commitVersion?: bigint;
    readonly obligations?: readonly number[];
  } = {},
): ServerMessage {
  return {
    v: PROTOCOL_VERSION,
    t: "ok",
    id: frame.id,
    kind: "mutation",
    value,
    receipt: {
      mutationRequestId: frame.mutationRequestId,
      commitVersion: options.commitVersion ?? 1n,
      durability: "production",
      replay: options.replay ?? "executed",
      obligations: options.obligations ?? [],
    },
  };
}

function liveEvent(
  id: number,
  event:
    | { readonly kind: "row"; readonly cursor: LiveEventCursor; readonly row: unknown }
    | { readonly kind: "gap" | "reset"; readonly cursor: LiveEventCursor },
): ServerMessage {
  return { v: PROTOCOL_VERSION, t: "event", id, event };
}

/** Total mutation frames carrying `mutationRequestId` across every socket. */
function mutationSends(sockets: FakeSocket[], mutationRequestId: string): number {
  return sockets
    .flatMap((socket) => socket.framesOf("m"))
    .filter((frame) => frame.mutationRequestId === mutationRequestId).length;
}

async function settled(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("mutation convergence across suspension", () => {
  test("boundary before send: a mutation issued while backgrounded is sent exactly once, on the recovery connection", async () => {
    const { client, sockets, port } = createHarness();
    sockets[0]!.welcome(client.clientSessionId);
    port.suspend();

    let settlements = 0;
    const result = client.mutation("api.todos.add", { text: "milk" }).then((value) => {
      settlements++;
      if (!value.ok) throw value.error;
      return value.data;
    });
    await settled();
    // Nothing was sent and nothing dialed: the identity exists only locally.
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.framesOf("m")).toHaveLength(0);
    expect(settlements).toBe(0);

    port.resume();
    const second = sockets[1]!;
    second.welcome(client.clientSessionId);
    const issued = second.lastFrame("m");
    expect(mutationSends(sockets, issued.mutationRequestId)).toBe(1);
    second.receive(mutationOk(issued, 7n));
    expect(await result).toBe(7n);
    expect(settlements).toBe(1);
    client.close();
  });

  test("boundary after send: the recovery connection replays the original identity once and stale receipts stay inert", async () => {
    const { client, sockets, port } = createHarness();
    const first = sockets[0]!;
    first.welcome(client.clientSessionId);

    let settlements = 0;
    const result = client.mutation("api.todos.add", { text: "milk" }).then((value) => {
      settlements++;
      if (!value.ok) throw value.error;
      return value.data;
    });
    const issued = first.lastFrame("m");

    port.suspend();
    // A receipt queued on the retired generation arrives late: it must not
    // settle the pending mutation — its socket already failed the identity
    // proof, and settlement belongs to the replacement connection.
    first.receive(mutationOk(issued, 99n));
    await settled();
    expect(settlements).toBe(0);

    port.resume();
    const second = sockets[1]!;
    second.welcome(client.clientSessionId);
    const replayed = second.lastFrame("m");
    expect(replayed.id).toBe(issued.id);
    expect(replayed.mutationRequestId).toBe(issued.mutationRequestId);
    expect(replayed.issuedAt).toBe(issued.issuedAt);
    expect(mutationSends(sockets, issued.mutationRequestId)).toBe(2);

    second.receive(mutationOk(replayed, 7n, { replay: "replayed" }));
    expect(await result).toBe(7n);
    expect(settlements).toBe(1);
    client.close();
  });

  test("boundary mid-response: a receipt held for convergence survives suspension and settles once with its original result", async () => {
    const { client, sockets, port } = createHarness();
    const updates: unknown[] = [];
    client.subscribe("api.todos.list", { list: 1n }, (value) => updates.push(value));
    const first = sockets[0]!;
    first.welcome(client.clientSessionId);
    const subscription = first.lastFrame("sub");
    const c1 = cursor(1n);
    const c2 = cursor(2n);
    first.receive(transition(subscription.id, c1, ["one"]));

    let settlements = 0;
    const result = client.mutation("api.todos.add", { text: "milk" }).then((value) => {
      settlements++;
      if (!value.ok) throw value.error;
      return value.data;
    });
    const issued = first.lastFrame("m");
    // The server committed and receipted; the subscription has not yet
    // converged to the commit, so the mutation is holding for convergence.
    first.receive(
      mutationOk(issued, 41n, { commitVersion: 2n, obligations: [subscription.id] }),
    );
    await settled();
    expect(settlements).toBe(0);

    port.suspend();
    port.resume();
    const second = sockets[1]!;
    second.welcome(client.clientSessionId);
    // Recovery order: the query subscription resumes from its exact cursor
    // before the mutation replays, so convergence has its reference point.
    const types = second.frames().map((frame) => frame.t);
    expect(types).toEqual(["hello", "sub", "m"]);
    expect(second.lastFrame("sub").cursor).toEqual(c1);
    const replayed = second.lastFrame("m");
    expect(replayed.mutationRequestId).toBe(issued.mutationRequestId);

    // The subscription converges to the receipt's commit: the mutation
    // settles with its original receipt value before any replayed receipt.
    second.receive(transition(subscription.id, c2, ["one", "milk"], c1));
    expect(await result).toBe(41n);
    expect(settlements).toBe(1);
    expect(updates).toEqual([["one"], ["one", "milk"]]);

    // The replayed receipt for the re-sent mutation lands after settlement:
    // the request is gone and nothing settles twice or disturbs the client.
    second.receive(mutationOk(replayed, 41n, { replay: "replayed", commitVersion: 2n }));
    await settled();
    expect(settlements).toBe(1);
    second.receive(transition(subscription.id, cursor(3n), ["one", "milk", "eggs"], c2));
    expect(updates).toEqual([["one"], ["one", "milk"], ["one", "milk", "eggs"]]);
    client.close();
  });

  test("boundary mid-response: a replayed receipt may settle before subscription convergence, and the late transition cannot double-settle", async () => {
    const { client, sockets, port } = createHarness();
    client.subscribe("api.todos.list", { list: 1n }, () => {});
    const first = sockets[0]!;
    first.welcome(client.clientSessionId);
    const subscription = first.lastFrame("sub");
    const c1 = cursor(1n);
    first.receive(transition(subscription.id, c1, ["one"]));

    let settlements = 0;
    const result = client.mutation("api.todos.add", { text: "milk" }).then((value) => {
      settlements++;
      if (!value.ok) throw value.error;
      return value.data;
    });
    const issued = first.lastFrame("m");
    first.receive(
      mutationOk(issued, 41n, { commitVersion: 2n, obligations: [subscription.id] }),
    );

    port.suspend();
    port.resume();
    const second = sockets[1]!;
    second.welcome(client.clientSessionId);
    const replayed = second.lastFrame("m");
    // The replayed receipt names no unconverged obligations: it settles now.
    second.receive(mutationOk(replayed, 41n, { replay: "replayed", commitVersion: 2n }));
    expect(await result).toBe(41n);
    expect(settlements).toBe(1);

    // The subscription's own convergence to the same commit arrives after:
    // one settlement stands.
    second.receive(transition(subscription.id, cursor(2n), ["one", "milk"], c1));
    await settled();
    expect(settlements).toBe(1);
    client.close();
  });

  test("boundary after settlement: recovery does not replay a settled mutation", async () => {
    const { client, sockets, port } = createHarness();
    const first = sockets[0]!;
    first.welcome(client.clientSessionId);

    const result = client.mutation("api.todos.add", { text: "milk" }).then(mustOk);
    const issued = first.lastFrame("m");
    first.receive(mutationOk(issued, 7n));
    expect(await result).toBe(7n);

    port.suspend();
    port.resume();
    const second = sockets[1]!;
    second.welcome(client.clientSessionId);
    expect(second.framesOf("m")).toHaveLength(0);
    expect(mutationSends(sockets, issued.mutationRequestId)).toBe(1);
    client.close();
  });

  test("foreground authentication precedes mutation replay and event reapplication", async () => {
    const { client, sockets, port } = createHarness({
      credential: { kind: "bearer", token: "token-a" },
    });
    const events: AckerDBLiveEvent<{ n: number }>[] = [];
    client.subscribeEvent<Record<never, never>, { n: number }>("api.events.pings", {}, (event) =>
      events.push(event),
    );
    const first = sockets[0]!;
    first.welcome(client.clientSessionId);
    first.receive(liveEvent(first.lastFrame("sub").id, { kind: "reset", cursor: eventCursor(0n) }));

    let settlements = 0;
    const result = client.mutation("api.todos.add", { text: "milk" }).then((value) => {
      settlements++;
      if (!value.ok) throw value.error;
      return value.data;
    });
    const issued = first.lastFrame("m");

    port.suspend();
    port.resume();
    const second = sockets[1]!;
    second.open();
    expect(second.lastFrame("hello").credential).toEqual({ kind: "bearer", token: "token-a" });
    // The credential rotates between the resumed hello and its welcome: the
    // fresh connection must verify it before any retained work is sent.
    const refresh = client.refreshCredential({ kind: "bearer", token: "token-b" });
    second.receive({
      v: PROTOCOL_VERSION,
      t: "welcome",
      clientSessionId: client.clientSessionId,
      authEpoch: 1,
      ...USER_AUTHENTICATION,
    });
    // Welcome verified token-a while token-b is pending: only the credential
    // presentation may be on the wire — no subscription, no mutation.
    expect(second.frames().map((frame) => frame.t)).toEqual(["hello", "auth"]);
    const attempt = second.lastFrame("auth");
    expect(attempt.credential).toEqual({ kind: "bearer", token: "token-b" });

    second.receive({
      v: PROTOCOL_VERSION,
      t: "auth",
      attemptId: attempt.attemptId,
      authEpoch: 2,
      ...USER_AUTHENTICATION,
    });
    expect(await refresh).toEqual({ authEpoch: 2, ...USER_AUTHENTICATION });
    // Confirmed authentication released the retained families, subscriptions
    // first, and the mutation kept its original identity.
    expect(second.frames().map((frame) => frame.t)).toEqual(["hello", "auth", "sub", "m"]);
    const replayed = second.lastFrame("m");
    expect(replayed.mutationRequestId).toBe(issued.mutationRequestId);
    expect(second.lastFrame("sub").cursor).toBeUndefined();

    second.receive(liveEvent(second.lastFrame("sub").id, {
      kind: "reset",
      cursor: eventCursor(0n, "events-2"),
    }));
    second.receive(mutationOk(replayed, 7n, { replay: "replayed" }));
    expect(await result).toBe(7n);
    expect(settlements).toBe(1);
    expect(events.map((event) => event.kind)).toEqual(["reset", "reset"]);
    client.close();
  });

  test("an authentication deadline elapsing during suspension retains the pending mutation until a new credential converges it", async () => {
    const { client, clock, sockets, port } = createHarness({
      credential: { kind: "bearer", token: "token-a" },
    });
    const first = sockets[0]!;
    first.welcome(client.clientSessionId);

    let settlements = 0;
    const result = client.mutation("api.todos.add", { text: "milk" }).then((value) => {
      settlements++;
      if (!value.ok) throw value.error;
      return value.data;
    });
    const issued = first.lastFrame("m");
    const refresh = client.refreshCredential({ kind: "bearer", token: "token-b" }).catch((error) => error);

    port.suspend();
    clock.advance(30_001);
    port.resume();
    const rejection = (await refresh) as AckerDBClientError;
    expect(rejection).toBeInstanceOf(AckerDBClientError);
    expect(rejection.code).toBe("auth_unavailable");
    expect(client.currentConnectionState.phase).toBe("authentication-blocked");
    // The credential expired, not the mutation: its identity is retained for
    // the recovery a new credential will start.
    expect(sockets).toHaveLength(1);
    expect(settlements).toBe(0);

    const recovered = client.refreshCredential({ kind: "bearer", token: "token-c" });
    const second = sockets[1]!;
    second.welcome(client.clientSessionId, { principal: "anonymous" }, 2);
    expect(await recovered).toEqual({ authEpoch: 2, principal: "anonymous" });
    const replayed = second.lastFrame("m");
    expect(replayed.mutationRequestId).toBe(issued.mutationRequestId);
    second.receive(mutationOk(replayed, 7n, { replay: "replayed" }));
    expect(await result).toBe(7n);
    expect(settlements).toBe(1);
    client.close();
  });

  test("a sent mutation's absolute deadline elapsing during suspension settles indeterminate and recovery does not resurrect it", async () => {
    const { client, clock, sockets, port } = createHarness({
      limits: { maxMutationAgeMs: 10_000 },
    });
    const first = sockets[0]!;
    first.welcome(client.clientSessionId);
    const result = client.mutation("api.todos.add", { text: "milk" });
    const issued = first.lastFrame("m");

    port.suspend();
    clock.advance(10_000);
    const rejectionResult = await result;
    expect(rejectionResult.ok).toBe(false);
    if (rejectionResult.ok) throw new Error("expected an indeterminate mutation");
    const rejection = rejectionResult.error;
    expect(rejection).toBeInstanceOf(AckerDBClientError);
    expect(rejection.code).toBe("indeterminate");
    expect(rejection.resource).toBe("idempotency");

    port.resume();
    const second = sockets[1]!;
    second.welcome(client.clientSessionId);
    expect(second.framesOf("m")).toHaveLength(0);
    expect(mutationSends(sockets, issued.mutationRequestId)).toBe(1);
    client.close();
  });

  test("close during suspension settles sent mutations as indeterminate and unsent ones as unavailable", async () => {
    const { client, sockets, port } = createHarness();
    sockets[0]!.welcome(client.clientSessionId);
    const sent = client.mutation("api.todos.add", { text: "milk" });
    port.suspend();
    const unsent = client.mutation("api.todos.add", { text: "bread" });
    client.close();
    const sentResult = await sent;
    const unsentResult = await unsent;
    if (sentResult.ok || unsentResult.ok) throw new Error("expected both mutations to fail");
    expect(sentResult.error.code).toBe("indeterminate");
    expect(unsentResult.error.code).toBe("unavailable");
  });

  test("a server Retry-After deadline holds recovery for both families, then one replay and one fresh reset land", async () => {
    const { client, clock, sockets, port } = createHarness();
    const events: AckerDBLiveEvent<{ n: number }>[] = [];
    client.subscribeEvent<Record<never, never>, { n: number }>("api.events.pings", {}, (event) =>
      events.push(event),
    );
    const first = sockets[0]!;
    first.welcome(client.clientSessionId);
    first.receive(liveEvent(first.lastFrame("sub").id, { kind: "reset", cursor: eventCursor(0n) }));

    let settlements = 0;
    const result = client.mutation("api.todos.add", { text: "milk" }).then((value) => {
      settlements++;
      if (!value.ok) throw value.error;
      return value.data;
    });
    const issued = first.lastFrame("m");
    first.receive({
      v: PROTOCOL_VERSION,
      t: "err",
      id: null,
      outcome: {
        code: "overloaded",
        retryable: true,
        retryAfterMs: 5_000,
        message: "connection admission is full",
        resource: "connection",
      },
    });

    port.suspend();
    clock.advance(2_000);
    port.resume();
    // Activation cannot bypass server admission control: the remaining three
    // seconds hold, and the retained families wait with their identities.
    expect(sockets).toHaveLength(1);
    expect(client.currentConnectionState.phase).toBe("reconnecting");
    expect(clock.nextDueIn()).toBe(3_000);
    clock.advance(3_000);

    const second = sockets[1]!;
    second.welcome(client.clientSessionId);
    const replayed = second.lastFrame("m");
    expect(replayed.mutationRequestId).toBe(issued.mutationRequestId);
    const resub = second.lastFrame("sub");
    expect(resub.cursor).toBeUndefined();
    second.receive(liveEvent(resub.id, { kind: "reset", cursor: eventCursor(0n, "events-2") }));
    second.receive(mutationOk(replayed, 7n, { replay: "replayed" }));
    expect(await result).toBe(7n);
    expect(settlements).toBe(1);
    expect(events.map((event) => event.kind)).toEqual(["reset", "reset"]);
    client.close();
  });
});

describe("event convergence across suspension", () => {
  test("backgrounding during subscription application delivers exactly one reset on recovery", () => {
    const { client, sockets, port } = createHarness();
    const events: AckerDBLiveEvent<{ n: number }>[] = [];
    client.subscribeEvent<Record<never, never>, { n: number }>("api.events.pings", {}, (event) =>
      events.push(event),
    );
    const first = sockets[0]!;
    first.welcome(client.clientSessionId);
    const subscription = first.lastFrame("sub");

    // The subscription was applied on the wire but its reset boundary never
    // arrived: backgrounding here must not fabricate one.
    port.suspend();
    expect(events).toEqual([]);

    port.resume();
    const second = sockets[1]!;
    second.welcome(client.clientSessionId);
    const resent = second.lastFrame("sub");
    expect(resent.id).toBe(subscription.id);
    expect(resent.cursor).toBeUndefined();
    second.receive(liveEvent(subscription.id, { kind: "reset", cursor: eventCursor(0n) }));
    second.receive(
      liveEvent(subscription.id, { kind: "row", cursor: eventCursor(1n), row: { n: 1 } }),
    );
    expect(events.map((event) => event.kind)).toEqual(["reset", "row"]);
    client.close();
  });

  test("a byte-identical reset cursor after recovery is still one fresh boundary, and a duplicate within a connection is not", () => {
    const { client, sockets, port } = createHarness();
    const events: AckerDBLiveEvent<{ n: number }>[] = [];
    client.subscribeEvent<Record<never, never>, { n: number }>("api.events.pings", {}, (event) =>
      events.push(event),
    );
    const first = sockets[0]!;
    first.welcome(client.clientSessionId);
    const subscription = first.lastFrame("sub");
    // The attach cursor for an idle event table: no commit moves it, so the
    // recovery attach can produce the exact same cursor value.
    const attach = eventCursor(0n, "events-1", 5n);
    first.receive(liveEvent(subscription.id, { kind: "reset", cursor: attach }));
    expect(events.map((event) => event.kind)).toEqual(["reset"]);

    port.suspend();
    port.resume();
    const second = sockets[1]!;
    second.welcome(client.clientSessionId);
    // The same cursor value is a NEW boundary on the fresh connection: the
    // consumer must observe it or it would never learn the stream restarted.
    second.receive(liveEvent(subscription.id, { kind: "reset", cursor: attach }));
    expect(events.map((event) => event.kind)).toEqual(["reset", "reset"]);
    // Within one connection the same cursor redelivered is a duplicate.
    second.receive(liveEvent(subscription.id, { kind: "reset", cursor: attach }));
    expect(events.map((event) => event.kind)).toEqual(["reset", "reset"]);
    client.close();
  });

  test("backgrounding during live delivery: missed events are never replayed and one reset precedes new rows", () => {
    const { client, sockets, port } = createHarness();
    const events: AckerDBLiveEvent<{ n: number }>[] = [];
    client.subscribeEvent<Record<never, never>, { n: number }>("api.events.pings", {}, (event) =>
      events.push(event),
    );
    const first = sockets[0]!;
    first.welcome(client.clientSessionId);
    const subscription = first.lastFrame("sub");
    first.receive(liveEvent(subscription.id, { kind: "reset", cursor: eventCursor(0n) }));
    first.receive(
      liveEvent(subscription.id, { kind: "row", cursor: eventCursor(1n), row: { n: 1 } }),
    );

    port.suspend();
    // The retired generation flushes everything it had queued: rows, a gap,
    // even a fresh-looking reset. None of it reaches the consumer.
    first.receive(
      liveEvent(subscription.id, { kind: "row", cursor: eventCursor(2n), row: { n: 2 } }),
    );
    first.receive(liveEvent(subscription.id, { kind: "gap", cursor: eventCursor(3n) }));
    first.receive(
      liveEvent(subscription.id, { kind: "reset", cursor: eventCursor(0n, "events-2") }),
    );

    port.resume();
    const second = sockets[1]!;
    second.welcome(client.clientSessionId);
    second.receive(
      liveEvent(subscription.id, { kind: "reset", cursor: eventCursor(0n, "events-2") }),
    );
    second.receive(
      liveEvent(subscription.id, {
        kind: "row",
        cursor: eventCursor(1n, "events-2"),
        row: { n: 9 },
      }),
    );
    expect(events.map((event) => event.kind)).toEqual(["reset", "row", "reset", "row"]);
    expect(events.flatMap((event) => (event.kind === "row" ? [event.row.n] : []))).toEqual([1, 9]);
    client.close();
  });

  test("a consumer that backgrounds synchronously inside delivery converges deterministically", () => {
    const h = createHarness();
    const events: AckerDBLiveEvent<{ n: number }>[] = [];
    h.client.subscribeEvent<Record<never, never>, { n: number }>(
      "api.events.pings",
      {},
      (event) => {
        events.push(event);
        // The application reacts to the first row by backgrounding in the
        // same turn — mid-delivery, before the socket's queue empties.
        if (event.kind === "row" && events.filter((entry) => entry.kind === "row").length === 1) {
          h.port.suspend();
        }
      },
    );
    const first = h.sockets[0]!;
    first.welcome(h.client.clientSessionId);
    const subscription = first.lastFrame("sub");
    first.receive(liveEvent(subscription.id, { kind: "reset", cursor: eventCursor(0n) }));
    first.receive(
      liveEvent(subscription.id, { kind: "row", cursor: eventCursor(1n), row: { n: 1 } }),
    );
    // The delivery that triggered the suspension retired the generation: the
    // rest of its queue is already stale.
    first.receive(
      liveEvent(subscription.id, { kind: "row", cursor: eventCursor(2n), row: { n: 2 } }),
    );
    expect(h.client.currentConnectionState.phase).toBe("suspended");
    expect(events.map((event) => event.kind)).toEqual(["reset", "row"]);

    h.port.resume();
    const second = h.sockets[1]!;
    second.welcome(h.client.clientSessionId);
    second.receive(
      liveEvent(subscription.id, { kind: "reset", cursor: eventCursor(0n, "events-2") }),
    );
    second.receive(
      liveEvent(subscription.id, {
        kind: "row",
        cursor: eventCursor(1n, "events-2"),
        row: { n: 3 },
      }),
    );
    expect(events.map((event) => event.kind)).toEqual(["reset", "row", "reset", "row"]);
    h.client.close();
  });

  test("demand released while suspended stays released: recovery re-attaches nothing", () => {
    const { client, sockets, port } = createHarness();
    const events: AckerDBLiveEvent<{ n: number }>[] = [];
    const unsubscribe = client.subscribeEvent<Record<never, never>, { n: number }>(
      "api.events.pings",
      {},
      (event) => events.push(event),
    );
    const first = sockets[0]!;
    first.welcome(client.clientSessionId);
    first.receive(liveEvent(first.lastFrame("sub").id, { kind: "reset", cursor: eventCursor(0n) }));

    port.suspend();
    unsubscribe();
    port.resume();
    const second = sockets[1]!;
    second.welcome(client.clientSessionId);
    expect(second.framesOf("sub")).toHaveLength(0);
    expect(second.framesOf("unsub")).toHaveLength(0);
    expect(events.map((event) => event.kind)).toEqual(["reset"]);
    client.close();
  });

  test("repeated lifecycle cycles with stale-generation injection cannot duplicate identities, resets, or delivery", async () => {
    const { client, sockets, port } = createHarness();
    const events: AckerDBLiveEvent<{ n: number }>[] = [];
    client.subscribeEvent<Record<never, never>, { n: number }>("api.events.pings", {}, (event) =>
      events.push(event),
    );
    const first = sockets[0]!;
    first.welcome(client.clientSessionId);
    const subscription = first.lastFrame("sub");
    first.receive(liveEvent(subscription.id, { kind: "reset", cursor: eventCursor(0n) }));

    let settlements = 0;
    const result = client.mutation("api.todos.add", { text: "milk" }).then((value) => {
      settlements++;
      if (!value.ok) throw value.error;
      return value.data;
    });
    const issued = first.lastFrame("m");

    for (let cycle = 1; cycle <= 3; cycle++) {
      port.suspend();
      port.suspend();
      // Every retired generation fires everything it could still hold: a
      // welcome, a valid-looking receipt, event traffic, an auth confirmation
      // and its close event. All of it must be inert.
      for (const retired of sockets) {
        retired.open();
        retired.receive({
          v: PROTOCOL_VERSION,
          t: "welcome",
          clientSessionId: client.clientSessionId,
          authEpoch: 9,
          ...USER_AUTHENTICATION,
        });
        retired.receive(mutationOk(issued, 99n));
        retired.receive(
          liveEvent(subscription.id, {
            kind: "reset",
            cursor: eventCursor(0n, `events-stale-${cycle}`),
          }),
        );
        retired.receive(
          liveEvent(subscription.id, {
            kind: "row",
            cursor: eventCursor(1n, `events-stale-${cycle}`),
            row: { n: -cycle },
          }),
        );
        retired.receive({
          v: PROTOCOL_VERSION,
          t: "auth",
          attemptId: 99,
          authEpoch: 9,
          ...USER_AUTHENTICATION,
        });
        retired.onclose?.();
      }
      await settled();
      expect(settlements).toBe(0);

      port.resume();
      port.resume();
      const socket = sockets.at(-1)!;
      socket.welcome(client.clientSessionId);
      // Exactly one subscription application and one identity replay per
      // recovery connection.
      expect(socket.framesOf("sub")).toHaveLength(1);
      const replayed = socket.framesOf("m");
      expect(replayed).toHaveLength(1);
      expect(replayed[0]!.mutationRequestId).toBe(issued.mutationRequestId);
      socket.receive(
        liveEvent(subscription.id, {
          kind: "reset",
          cursor: eventCursor(0n, `events-${cycle + 1}`),
        }),
      );
    }

    // One socket per cycle plus the original; one live at the end.
    expect(sockets).toHaveLength(4);
    expect(sockets.filter((socket) => !socket.closed)).toHaveLength(1);
    // One reset per completed recovery, no rows fabricated anywhere.
    expect(events.map((event) => event.kind)).toEqual(["reset", "reset", "reset", "reset"]);

    const live = sockets.at(-1)!;
    live.receive(mutationOk(live.lastFrame("m"), 7n, { replay: "replayed" }));
    expect(await result).toBe(7n);
    expect(settlements).toBe(1);

    // With the mutation settled, one more cycle replays nothing.
    port.suspend();
    port.resume();
    const final = sockets.at(-1)!;
    final.welcome(client.clientSessionId);
    expect(final.framesOf("m")).toHaveLength(0);
    expect(mutationSends(sockets, issued.mutationRequestId)).toBe(4);
    client.close();
  });
});

function waitForPhase(client: AckerDBClient, phase: string): Promise<void> {
  if (client.currentConnectionState.phase === phase) return Promise.resolve();
  const waiting = Promise.withResolvers<void>();
  const stop = client.subscribeConnectionState((state) => {
    if (state.phase !== phase) return;
    stop();
    waiting.resolve(undefined);
  });
  return within(waiting.promise, `the ${phase} phase`);
}

const realSchema = defineSchema({
  messages: defineTable({
    id: v.primaryKey(),
    channelId: v.bigint(),
    body: v.string(),
  }).index(["channelId"]),
  pings: defineEventTable({
    id: v.primaryKey(),
    n: v.int(),
  }, {
    args: { min: v.int() },
    access: "public",
    matches: (row, args) => row.n >= args.min,
  }),
});

// Public integration fixtures intentionally exercise inferred application handlers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

/**
 * A test-controlled pause inside the real `api.messages.send` handler, keyed by
 * message body: the one deterministic way to background a client while its
 * mutation is admitted but not yet committed. `entries` counts handler
 * executions — the direct observation that a replay arriving during the
 * original's execution cannot run the handler twice.
 */
interface SendGate {
  readonly entered: Promise<void>;
  release(): void;
  entries(): number;
}

const sendGates = new Map<
  string,
  { signalEntered: () => void; blocked: Promise<void>; entries: number }
>();

function armSendGate(body: string): SendGate {
  const entered = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<void>();
  const state = {
    signalEntered: () => entered.resolve(undefined),
    blocked: blocked.promise,
    entries: 0,
  };
  sendGates.set(body, state);
  return {
    entered: entered.promise,
    release: () => blocked.resolve(undefined),
    entries: () => state.entries,
  };
}

function realRegistry(): Registry {
  return new Registry({
    messages: {
      list: query({
        access: "public",
        args: { channelId: v.bigint() },
        handler: async (ctx: Ctx, args: Ctx) =>
          await ctx.db.messages
            .query()
            .where((message: Ctx) => message.channelId.eq(args.channelId))
            .collect(),
      }),
      send: mutation({
        access: "public",
        args: { channelId: v.bigint(), body: v.string() },
        handler: async (ctx: Ctx, args: Ctx) => {
          const gate = sendGates.get(args.body);
          if (gate) {
            gate.entries++;
            gate.signalEntered();
            await gate.blocked;
          }
          return await ctx.db.messages.insert(args);
        },
      }),
    },
    pings: {
      emit: mutation({
        access: "public",
        args: { n: v.int() },
        handler: async (ctx: Ctx, args: Ctx) => {
          await ctx.db.pings.insert({ n: args.n });
          return args.n;
        },
      }),
    },
  });
}

interface MessageRow {
  readonly id: bigint;
  readonly channelId: bigint;
  readonly body: string;
}

interface RealApp {
  readonly proxy: FrameProxy;
  readonly observer: AckerDBClient;
  close(): Promise<void>;
}

async function createRealApp(): Promise<RealApp> {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-suspension-convergence-"));
  const engine = new Engine(realSchema, join(directory, "data.db"));
  reconcile(engine);
  const runtime = new Runtime({
    engine,
    registry: realRegistry(),
    limits: PRODUCTION_LIMITS,
    telemetry: false,
  });
  const server = serve({ runtime, port: 0 });
  const proxy = await FrameProxy.listen({ upstreamPort: server.port });
  const observer = new AckerDBClient({
    url: `http://127.0.0.1:${server.port}`,
    credential: { kind: "anonymous" },
  });
  return {
    proxy,
    observer,
    async close() {
      const proxyPort = proxy.port;
      const serverPort = server.port;
      observer.close();
      proxy.assertBytePreserving();
      await proxy.close();
      await server.drain();
      engine.close("clean");
      rmSync(directory, { recursive: true, force: true });
      await assertTcpPortReleased(proxyPort);
      await assertTcpPortReleased(serverPort);
    },
  };
}

interface SuspendableClient {
  readonly client: AckerDBClient;
  readonly port: AckerDBLifecyclePort;
  readonly clientFrames: ClientMessage[];
}

/**
 * A real client whose lifecycle notifications the test drives and whose
 * timers are all inert (a manual clock that is never advanced): every
 * recovery this section observes runs on lifecycle notifications and socket
 * events alone. Tests that need the ordinary reconnect policy to run
 * override the clock through `overrides`.
 */
function suspendableClient(
  url: string,
  overrides: Partial<AckerDBClientOptionsBase> = {},
): SuspendableClient {
  let port: AckerDBLifecyclePort | undefined;
  const clientFrames: ClientMessage[] = [];
  const client = new AckerDBClient({
    url,
    credential: { kind: "anonymous" },
    clock: new ManualClock(Date.now()),
    createWebSocket: (target) => {
      const socket = new WebSocket(target) as unknown as AckerDBWebSocket;
      const send = socket.send.bind(socket);
      socket.send = (data: string) => {
        clientFrames.push(parseClientMessage(decode(data)));
        send(data);
      };
      return socket;
    },
    lifecycle: (livePort) => {
      port = livePort;
      return () => {};
    },
    ...overrides,
  });
  return {
    client,
    get port(): AckerDBLifecyclePort {
      if (!port) throw new Error("lifecycle port not captured");
      return port;
    },
    clientFrames,
  };
}

function proxiedMutations(proxy: FrameProxy, body: string): Extract<ClientMessage, { t: "m" }>[] {
  return proxy.clientFrames.flatMap(({ message }) =>
    message.t === "m" && (message.args as { body?: unknown }).body === body ? [message] : [],
  );
}

async function committedRows(app: RealApp, channelId: bigint, body: string): Promise<MessageRow[]> {
  const rows = mustOk(await app.observer.query("api.messages.list", { channelId })) as MessageRow[];
  return rows.filter((row) => row.body === body);
}

let app: RealApp;
beforeAll(async () => {
  app = await createRealApp();
});
afterAll(async () => {
  await app.close();
});

describe("mutation boundaries against a real ackerdb server", () => {
  test("background before send: activation delivers one execution and one settlement", async () => {
    const { client, port } = suspendableClient(app.proxy.url);
    await waitForPhase(client, "ready");

    port.suspend();
    let settlements = 0;
    const result = client
      .mutation("api.messages.send", { channelId: 10n, body: "before-send" })
      .then((value) => {
        settlements++;
        if (!value.ok) throw value.error;
        return value.data;
      });
    await Bun.sleep(20);
    expect(proxiedMutations(app.proxy, "before-send")).toHaveLength(0);

    port.resume();
    const id = await within(result, "the before-send settlement");
    const requests = proxiedMutations(app.proxy, "before-send");
    expect(requests).toHaveLength(1);
    expect(await committedRows(app, 10n, "before-send")).toEqual([
      { id: id as bigint, channelId: 10n, body: "before-send" },
    ]);
    expect(settlements).toBe(1);
    client.close();
  });

  test("background after send, before the server saw it: the replay executes once under the original identity", async () => {
    const { client, port } = suspendableClient(app.proxy.url);
    await waitForPhase(client, "ready");

    const held = app.proxy.holdNextClientFrame(
      (message) => message.t === "m" && (message.args as { body?: unknown }).body === "held-send",
    );
    let settlements = 0;
    const result = client
      .mutation("api.messages.send", { channelId: 11n, body: "held-send" })
      .then((value) => {
        settlements++;
        if (!value.ok) throw value.error;
        return value.data;
      });
    // The frame left the client but never reached the server.
    const captured = await held;

    port.suspend();
    captured.drop();
    port.resume();
    const id = await within(result, "the held-send settlement");

    const requests = proxiedMutations(app.proxy, "held-send");
    expect(requests).toHaveLength(2);
    expect(new Set(requests.map(({ mutationRequestId }) => mutationRequestId)).size).toBe(1);
    expect(new Set(requests.map(({ issuedAt }) => issuedAt)).size).toBe(1);
    // Only the replay was forwarded, and the server executed it fresh.
    const forwarded = app.proxy.clientFrames.filter(
      ({ message, forwardedBytes }) =>
        forwardedBytes !== undefined &&
        message.t === "m" &&
        (message.args as { body?: unknown }).body === "held-send",
    );
    expect(forwarded).toHaveLength(1);
    const receipt = await app.proxy.waitForForwardedServerFrame(
      forwarded[0]!.connectionId,
      (message) =>
        message.t === "ok" &&
        message.kind === "mutation" &&
        message.receipt.mutationRequestId === requests[0]!.mutationRequestId,
    );
    if (receipt.message.t !== "ok" || receipt.message.kind !== "mutation") {
      throw new Error("expected a mutation receipt");
    }
    expect(receipt.message.receipt.replay).toBe("executed");
    expect(await committedRows(app, 11n, "held-send")).toEqual([
      { id: id as bigint, channelId: 11n, body: "held-send" },
    ]);
    expect(settlements).toBe(1);
    client.close();
  });

  test(
    "background while the original is still executing: activation cannot be admitted past it, and one effect settles once it drains",
    async () => {
      // The ordinary reconnect policy must run here: the server refuses a
      // second session for this clientSessionId until the original's
      // in-flight work drains, so recovery goes through real retries.
      const { client, port } = suspendableClient(app.proxy.url, {
        clock: undefined,
        reconnect: { baseDelayMs: 10, maxDelayMs: 40, stableOpenMs: 10_000 },
      });
      await waitForPhase(client, "ready");

      const gate = armSendGate("in-flight");
      try {
        let settlements = 0;
        const result = client
          .mutation("api.messages.send", { channelId: 15n, body: "in-flight" })
          .then((value) => {
            settlements++;
            if (!value.ok) throw value.error;
            return value.data;
          });
        // The server admitted the mutation and its handler is executing.
        await within(gate.entered, "the gated handler entry");

        const framesBeforeResume = app.proxy.serverFrames.length;
        port.suspend();
        port.resume();
        // The dangerous interval: activation while the original executes. The
        // server's session admission is the in-flight idempotency boundary —
        // no second session for this clientSessionId exists until the
        // original's operation drains, so no replay can reach an executing
        // mutation. The protocol-level barrier proving the overlap was
        // actually challenged: a recovery hello reached server admission and
        // was refused with the session conflict while the handler is still
        // gated (only recovery attempts can produce it — the original
        // connection was admitted cleanly).
        const conflictRejections = (): number =>
          app.proxy.serverFrames
            .slice(framesBeforeResume)
            .filter(
              ({ message, forwardedBytes }) =>
                forwardedBytes !== undefined &&
                message.t === "err" &&
                message.id === null &&
                message.outcome.code === "conflict",
            ).length;
        await until(() => conflictRejections() >= 1, "a refused recovery admission");
        const forwardedWhileExecuting = app.proxy.clientFrames.filter(
          ({ message, forwardedBytes }) =>
            forwardedBytes !== undefined &&
            message.t === "m" &&
            (message.args as { body?: unknown }).body === "in-flight",
        );
        expect(forwardedWhileExecuting).toHaveLength(1);
        expect(gate.entries()).toBe(1);
        expect(settlements).toBe(0);

        // The original drains: it commits, its receipt dies with its session,
        // the next reconnect attempt is admitted, and the replay settles from
        // the durable record.
        gate.release();
        const id = await within(result, "the in-flight settlement");

        const requests = proxiedMutations(app.proxy, "in-flight");
        expect(requests).toHaveLength(2);
        expect(new Set(requests.map(({ mutationRequestId }) => mutationRequestId)).size).toBe(1);
        // One handler execution ever: the replay settled from the record.
        expect(gate.entries()).toBe(1);
        const forwardedReceipts = app.proxy.serverFrames.filter(
          ({ message, forwardedBytes }) =>
            forwardedBytes !== undefined &&
            message.t === "ok" &&
            message.kind === "mutation" &&
            message.receipt.mutationRequestId === requests[0]!.mutationRequestId,
        );
        expect(forwardedReceipts).toHaveLength(1);
        const receipt = forwardedReceipts[0]!.message;
        if (receipt.t !== "ok" || receipt.kind !== "mutation") {
          throw new Error("expected a mutation receipt");
        }
        expect(receipt.receipt.replay).toBe("replayed");
        expect(await committedRows(app, 15n, "in-flight")).toEqual([
          { id: id as bigint, channelId: 15n, body: "in-flight" },
        ]);
        expect(settlements).toBe(1);
      } finally {
        // A failure above must not leave the shared app's writer gated.
        gate.release();
      }
      client.close();
    },
    15_000,
  );

  test("background mid-response: the committed receipt is lost, the replay dedupes to one effect", async () => {
    const { client, port } = suspendableClient(app.proxy.url);
    await waitForPhase(client, "ready");

    const held = app.proxy.holdNextServerFrame(
      (message) =>
        message.t === "ok" &&
        message.kind === "mutation" &&
        message.receipt.mutationRequestId ===
          proxiedMutations(app.proxy, "held-receipt")[0]?.mutationRequestId,
    );
    let settlements = 0;
    const result = client
      .mutation("api.messages.send", { channelId: 12n, body: "held-receipt" })
      .then((value) => {
        settlements++;
        if (!value.ok) throw value.error;
        return value.data;
      });
    // The server committed and acknowledged; the acknowledgment never arrives.
    const captured = await held;

    port.suspend();
    captured.drop();
    await settled();
    expect(settlements).toBe(0);

    port.resume();
    const id = await within(result, "the held-receipt settlement");

    const requests = proxiedMutations(app.proxy, "held-receipt");
    expect(requests).toHaveLength(2);
    expect(new Set(requests.map(({ mutationRequestId }) => mutationRequestId)).size).toBe(1);
    const requestId = requests[0]!.mutationRequestId;
    const forwardedReceipts = app.proxy.serverFrames.filter(
      ({ message, forwardedBytes }) =>
        forwardedBytes !== undefined &&
        message.t === "ok" &&
        message.kind === "mutation" &&
        message.receipt.mutationRequestId === requestId,
    );
    expect(forwardedReceipts).toHaveLength(1);
    const receipt = forwardedReceipts[0]!.message;
    if (receipt.t !== "ok" || receipt.kind !== "mutation") {
      throw new Error("expected a mutation receipt");
    }
    expect(receipt.receipt.replay).toBe("replayed");
    expect(await committedRows(app, 12n, "held-receipt")).toEqual([
      { id: id as bigint, channelId: 12n, body: "held-receipt" },
    ]);
    expect(settlements).toBe(1);
    client.close();
  });

  test("background mid-convergence: a live subscription and the replay converge to one effect and one settlement", async () => {
    const { client, port } = suspendableClient(app.proxy.url);
    const updates: MessageRow[][] = [];
    client.subscribe("api.messages.list", { channelId: 14n }, (value) =>
      updates.push(value as MessageRow[]),
    );
    await waitForPhase(client, "ready");
    await until(() => updates.length >= 1, "the initial query snapshot");

    // Convergence for this commit needs the subscription's transition; hold
    // it so the mutation cannot settle before the application backgrounds.
    // (Whichever of the receipt and the transition the server emits first,
    // the held pipe keeps the pair from completing convergence.)
    const held = app.proxy.holdNextServerFrame((message) => message.t === "transition");
    let settlements = 0;
    const result = client
      .mutation("api.messages.send", { channelId: 14n, body: "converge" })
      .then((value) => {
        settlements++;
        if (!value.ok) throw value.error;
        return value.data;
      });
    const captured = await held;
    await settled();
    expect(settlements).toBe(0);

    port.suspend();
    captured.drop();
    port.resume();
    const id = await within(result, "the mid-convergence settlement");

    const requests = proxiedMutations(app.proxy, "converge");
    expect(requests).toHaveLength(2);
    expect(new Set(requests.map(({ mutationRequestId }) => mutationRequestId)).size).toBe(1);
    expect(await committedRows(app, 14n, "converge")).toEqual([
      { id: id as bigint, channelId: 14n, body: "converge" },
    ]);
    expect(settlements).toBe(1);
    // The resumed subscription converged to the same single effect.
    await until(
      () => updates.at(-1)?.some((row) => row.body === "converge") ?? false,
      "the resumed subscription's converged value",
    );
    expect(updates.at(-1)!.filter((row) => row.body === "converge")).toHaveLength(1);
    client.close();
  });

  test("background after the receipt: recovery replays nothing", async () => {
    const { client, port } = suspendableClient(app.proxy.url);
    await waitForPhase(client, "ready");

    let settlements = 0;
    const result = client
      .mutation("api.messages.send", { channelId: 13n, body: "settled" })
      .then((value) => {
        settlements++;
        if (!value.ok) throw value.error;
        return value.data;
      });
    const id = await within(result, "the settled mutation");
    expect(proxiedMutations(app.proxy, "settled")).toHaveLength(1);

    port.suspend();
    port.resume();
    await waitForPhase(client, "ready");
    // A round-trip through the recovered connection is the barrier proving
    // the recovery flush finished without replaying the settled identity.
    await within(client.query("api.messages.list", { channelId: 13n }), "the barrier query");
    expect(proxiedMutations(app.proxy, "settled")).toHaveLength(1);
    expect(await committedRows(app, 13n, "settled")).toEqual([
      { id: id as bigint, channelId: 13n, body: "settled" },
    ]);
    expect(settlements).toBe(1);
    client.close();
  });
});

describe("event boundaries against a real ackerdb server", () => {
  test("suspension across live delivery: missed events stay missed and exactly one reset precedes new rows", async () => {
    const { client, port } = suspendableClient(app.proxy.url);
    const events: AckerDBLiveEvent<{ id: bigint; n: number }>[] = [];
    const kinds = (): string[] => events.map((event) => event.kind);
    client.subscribeEvent<{ min: number }, { id: bigint; n: number }>(
      "api.events.pings",
      { min: 100 },
      (event) => events.push(event),
    );
    await waitForPhase(client, "ready");
    await until(() => kinds().length === 1, "the initial reset boundary");
    expect(kinds()).toEqual(["reset"]);

    await app.observer.mutation("api.pings.emit", { n: 101 });
    await until(() => kinds().length === 2, "the first live row");
    expect(events[1]).toMatchObject({ kind: "row", row: { n: 101 } });

    port.suspend();
    // Published while backgrounded: lost for good, never replayed.
    await app.observer.mutation("api.pings.emit", { n: 102 });
    await Bun.sleep(50);
    expect(kinds()).toEqual(["reset", "row"]);

    port.resume();
    await until(() => kinds().length === 3, "the recovery reset boundary");
    expect(kinds()).toEqual(["reset", "row", "reset"]);
    await app.observer.mutation("api.pings.emit", { n: 103 });
    await until(() => kinds().length === 4, "the first row after recovery");
    expect(kinds()).toEqual(["reset", "row", "reset", "row"]);
    expect(events.flatMap((event) => (event.kind === "row" ? [event.row.n] : []))).toEqual([
      101, 103,
    ]);
    client.close();
  });

  test("suspension during subscription application: the one reset the consumer sees is the recovery's", async () => {
    const { client, port } = suspendableClient(app.proxy.url);
    await waitForPhase(client, "ready");

    const held = app.proxy.holdNextServerFrame(
      (message) => message.t === "event" && message.event.kind === "reset",
    );
    const events: AckerDBLiveEvent<{ id: bigint; n: number }>[] = [];
    client.subscribeEvent<{ min: number }, { id: bigint; n: number }>(
      "api.events.pings",
      { min: 200 },
      (event) => events.push(event),
    );
    // The subscription reached the server and its reset boundary was sent,
    // but it never reaches the client.
    const captured = await held;

    port.suspend();
    captured.drop();
    expect(events).toEqual([]);

    port.resume();
    await until(() => events.length === 1, "the recovery reset boundary");
    expect(events.map((event) => event.kind)).toEqual(["reset"]);
    await app.observer.mutation("api.pings.emit", { n: 201 });
    await until(() => events.length === 2, "the first row after recovery");
    expect(events[1]).toMatchObject({ kind: "row", row: { n: 201 } });
    client.close();
  });
});

describe("server unavailable at activation against a real ackerdb server", () => {
  test(
    "activation with the server stopped enters ordinary reconnect; both families recover when it restarts",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "ackerdb-convergence-restart-"));
      const database = join(directory, "data.db");
      const engine = new Engine(realSchema, database);
      reconcile(engine);
      const runtime = new Runtime({
        engine,
        registry: realRegistry(),
        limits: PRODUCTION_LIMITS,
        telemetry: false,
      });
      const server = serve({ runtime, port: 0 });
      const serverPort = server.port;

      let lifecyclePort: AckerDBLifecyclePort | undefined;
      const clientFrames: ClientMessage[] = [];
      const phases: string[] = [];
      const client = new AckerDBClient({
        url: `http://127.0.0.1:${serverPort}`,
        credential: { kind: "anonymous" },
        // Real timers: activation against a stopped server must hand off to
        // the ordinary bounded reconnect policy and recover through it.
        reconnect: { baseDelayMs: 25, maxDelayMs: 100, stableOpenMs: 10_000 },
        createWebSocket: (target) => {
          const socket = new WebSocket(target) as unknown as AckerDBWebSocket;
          const send = socket.send.bind(socket);
          socket.send = (data: string) => {
            clientFrames.push(parseClientMessage(decode(data)));
            send(data);
          };
          return socket;
        },
        lifecycle: (livePort) => {
          lifecyclePort = livePort;
          return () => {};
        },
      });
      client.subscribeConnectionState((state) => phases.push(state.phase));
      let restarted: { server: ReturnType<typeof serve>; engine: Engine } | undefined;
      try {
        const events: AckerDBLiveEvent<{ id: bigint; n: number }>[] = [];
        const kinds = (): string[] => events.map((event) => event.kind);
        client.subscribeEvent<{ min: number }, { id: bigint; n: number }>(
          "api.events.pings",
          { min: 300 },
          (event) => events.push(event),
        );
        await waitForPhase(client, "ready");
        await until(() => kinds().length === 1, "the initial reset boundary");

        lifecyclePort!.suspend();
        let settlements = 0;
        const result = client
          .mutation("api.messages.send", { channelId: 30n, body: "restart" })
          .then((value) => {
            settlements++;
            if (!value.ok) throw value.error;
            return value.data;
          });

        // The server goes away entirely while the application is backgrounded.
        await server.drain();
        engine.close("clean");
        await assertTcpPortReleased(serverPort);

        lifecyclePort!.resume();
        // The immediate attempt fails: ordinary reconnect, no special retry.
        await until(
          () => phases.includes("reconnecting"),
          "the ordinary reconnect phase",
        );
        await Bun.sleep(150);
        expect(settlements).toBe(0);

        // The server returns at the same address with the same durable state.
        const engine2 = new Engine(realSchema, database);
        reconcile(engine2);
        const runtime2 = new Runtime({
          engine: engine2,
          registry: realRegistry(),
          limits: PRODUCTION_LIMITS,
          telemetry: false,
        });
        restarted = { server: serve({ runtime: runtime2, port: serverPort }), engine: engine2 };

        const id = await within(result, "the post-restart settlement");
        expect(settlements).toBe(1);
        // One replay identity across however many dials it took.
        const sends = clientFrames.filter(
          (frame) => frame.t === "m" && (frame.args as { body?: unknown }).body === "restart",
        ) as Extract<ClientMessage, { t: "m" }>[];
        expect(sends.length).toBeGreaterThanOrEqual(1);
        expect(new Set(sends.map(({ mutationRequestId }) => mutationRequestId)).size).toBe(1);

        // Exactly one server effect exists.
        const observer = new AckerDBClient({
          url: `http://127.0.0.1:${serverPort}`,
          credential: { kind: "anonymous" },
        });
        try {
          const rows = mustOk(
            await observer.query("api.messages.list", { channelId: 30n }),
          ) as MessageRow[];
          expect(rows.filter(({ body }) => body === "restart")).toEqual([
            { id: id as bigint, channelId: 30n, body: "restart" },
          ]);

          // The event family recovered behind exactly one fresh boundary —
          // failed dials while the server was down added none.
          await until(() => kinds().length === 2, "the post-restart reset boundary");
          expect(kinds()).toEqual(["reset", "reset"]);
          await observer.mutation("api.pings.emit", { n: 301 });
          await until(() => kinds().length === 3, "the first row after restart");
          expect(kinds()).toEqual(["reset", "reset", "row"]);
        } finally {
          observer.close();
        }
      } finally {
        client.close();
        if (restarted) {
          await restarted.server.drain();
          restarted.engine.close("clean");
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
    20_000,
  );

  test(
    "a mutation committed before the restart replays from the durable record with its recorded result",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "ackerdb-convergence-durable-"));
      const database = join(directory, "data.db");
      const engine = new Engine(realSchema, database);
      reconcile(engine);
      const runtime = new Runtime({
        engine,
        registry: realRegistry(),
        limits: PRODUCTION_LIMITS,
        telemetry: false,
      });
      const server = serve({ runtime, port: 0 });
      const upstreamPort = server.port;
      const proxy = await FrameProxy.listen({ upstreamPort });
      const { client, port } = suspendableClient(proxy.url);
      let restarted: { server: ReturnType<typeof serve>; engine: Engine } | undefined;
      try {
        const events: AckerDBLiveEvent<{ id: bigint; n: number }>[] = [];
        const kinds = (): string[] => events.map((event) => event.kind);
        client.subscribeEvent<{ min: number }, { id: bigint; n: number }>(
          "api.events.pings",
          { min: 400 },
          (event) => events.push(event),
        );
        await waitForPhase(client, "ready");
        await until(() => kinds().length === 1, "the initial reset boundary");

        // The server commits and acknowledges; the acknowledgment never
        // reaches the client, and the application backgrounds.
        const held = proxy.holdNextServerFrame(
          (message) => message.t === "ok" && message.kind === "mutation",
        );
        let settlements = 0;
        const result = client
          .mutation("api.messages.send", { channelId: 40n, body: "durable" })
          .then((value) => {
            settlements++;
            if (!value.ok) throw value.error;
            return value.data;
          });
        const captured = await held;
        port.suspend();
        captured.drop();
        await settled();
        expect(settlements).toBe(0);

        // The commit is durable on the original server.
        const observerBefore = new AckerDBClient({
          url: `http://127.0.0.1:${upstreamPort}`,
          credential: { kind: "anonymous" },
        });
        let committedId: bigint;
        try {
          const rows = mustOk(
            await observerBefore.query("api.messages.list", { channelId: 40n }),
          ) as MessageRow[];
          expect(rows.filter(({ body }) => body === "durable")).toHaveLength(1);
          committedId = rows.find(({ body }) => body === "durable")!.id;
        } finally {
          observerBefore.close();
        }

        // The server restarts from the same database while the application
        // stays backgrounded (a deploy through the background gap).
        await server.drain();
        engine.close("clean");
        await assertTcpPortReleased(upstreamPort);
        const engine2 = new Engine(realSchema, database);
        reconcile(engine2);
        const runtime2 = new Runtime({
          engine: engine2,
          registry: realRegistry(),
          limits: PRODUCTION_LIMITS,
          telemetry: false,
        });
        restarted = { server: serve({ runtime: runtime2, port: upstreamPort }), engine: engine2 };

        port.resume();
        const id = await within(result, "the durable replay settlement");
        // The replay settled from the durable record: the recorded result of
        // the pre-restart commit, not a fresh execution's.
        expect(id).toBe(committedId);
        expect(settlements).toBe(1);

        const requests = proxiedMutations(proxy, "durable");
        expect(requests).toHaveLength(2);
        expect(new Set(requests.map(({ mutationRequestId }) => mutationRequestId)).size).toBe(1);
        expect(new Set(requests.map(({ issuedAt }) => issuedAt)).size).toBe(1);
        // The only receipt that reached the client is the restarted server's,
        // and it names the durable replay.
        const forwardedReceipts = proxy.serverFrames.filter(
          ({ message, forwardedBytes }) =>
            forwardedBytes !== undefined &&
            message.t === "ok" &&
            message.kind === "mutation" &&
            message.receipt.mutationRequestId === requests[0]!.mutationRequestId,
        );
        expect(forwardedReceipts).toHaveLength(1);
        const receipt = forwardedReceipts[0]!.message;
        if (receipt.t !== "ok" || receipt.kind !== "mutation") {
          throw new Error("expected a mutation receipt");
        }
        expect(receipt.receipt.replay).toBe("replayed");

        // Exactly one effect survived the restart, and the event family
        // recovered behind exactly one fresh boundary.
        const observerAfter = new AckerDBClient({
          url: `http://127.0.0.1:${upstreamPort}`,
          credential: { kind: "anonymous" },
        });
        try {
          const rows = mustOk(
            await observerAfter.query("api.messages.list", { channelId: 40n }),
          ) as MessageRow[];
          expect(rows.filter(({ body }) => body === "durable")).toEqual([
            { id: committedId, channelId: 40n, body: "durable" },
          ]);
          await until(() => kinds().length === 2, "the post-restart reset boundary");
          expect(kinds()).toEqual(["reset", "reset"]);
          await observerAfter.mutation("api.pings.emit", { n: 401 });
          await until(() => kinds().length === 3, "the first row after the durable replay");
          expect(kinds()).toEqual(["reset", "reset", "row"]);
        } finally {
          observerAfter.close();
        }
      } finally {
        client.close();
        proxy.assertBytePreserving();
        await proxy.close();
        if (restarted) {
          await restarted.server.drain();
          restarted.engine.close("clean");
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
