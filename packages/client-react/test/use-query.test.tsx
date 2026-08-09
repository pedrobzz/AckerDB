import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { actEnvironment, mountPoint } from "ackerdb-test-support/dom";
import { createHarness, type ProviderHarness } from "./support/harness.ts";
import {
  ACKERDB_VERSION,
  type ApplicationError,
  type Identity,
  type ServerMessage,
  type SubscriptionCursor,
} from "@ackerdb/core";
import { AckerDBClient, type QueryRef } from "@ackerdb/client";
import { StrictMode, act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AckerDBProvider, skip, useQuery, type AckerDBQueryState } from "@ackerdb/client-react";
import { QueryStoreEntry } from "../src/query-store.ts";

const SESSION = "use-query-session";
const APP = { url: "http://use-query.test", clientSessionId: SESSION };

type TodoArgs = { readonly list: bigint };
type TodoNotFound = ApplicationError<
  "todo.not-found",
  { readonly list: bigint },
  404
>;
const todos = { $ref: "api.todos.list" } as QueryRef<TodoArgs, string[], TodoNotFound>;

function cursor(commitVersion: bigint): SubscriptionCursor {
  return {
    generation: "generation-1",
    commitVersion,
    authEpoch: 0,
    identity: "api.todos.list:{list:1}",
  };
}

let observed: AckerDBQueryState<string[], TodoNotFound> | undefined;

function describeState(state: AckerDBQueryState<string[], TodoNotFound>): string {
  switch (state.status) {
    case "disabled":
      return "disabled";
    case "pending":
      return "pending";
    case "success":
      return `fresh:${state.data.join(",")}`;
    case "application-error":
      return `application-error:${state.error.code}`;
    case "rejected":
      return `error:${state.error.code}:-`;
    case "unavailable":
      return state.data === undefined
        ? `error:${state.error.code}:-`
        : `stale:${state.data.join(",")}`;
  }
}

function TodoReport({ args }: { args: TodoArgs | typeof skip }): ReactNode {
  const state = useQuery(todos, args);
  observed = state;
  return <span>{describeState(state)}</span>;
}

async function render(root: Root, element: ReactNode): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

function app(harness: ProviderHarness, args: TodoArgs | typeof skip, strict = false): ReactNode {
  const tree = (
    <AckerDBProvider config={harness.config()}>
      <TodoReport args={args} />
    </AckerDBProvider>
  );
  return strict ? <StrictMode>{tree}</StrictMode> : tree;
}

async function receive(harness: ProviderHarness, frame: ServerMessage): Promise<void> {
  await act(async () => {
    harness.live().receive(frame);
  });
}

async function ready(harness: ProviderHarness): Promise<void> {
  await act(async () => {
    harness.live().welcome(SESSION);
  });
}

/** Boots to a fresh success showing ["one"] and returns the subscription id. */
async function bootToSuccess(harness: ProviderHarness, root: Root, container: HTMLElement): Promise<number> {
  await render(root, app(harness, { list: 1n }));
  await ready(harness);
  const id = harness.frames("sub")[0]!.id;
  await receive(harness, {
    v: ACKERDB_VERSION,
    t: "transition",
    id,
    transition: { kind: "reset", from: null, to: cursor(1n), value: ["one"] },
  });
  expect(container.textContent).toBe("fresh:one");
  return id;
}

beforeAll(() => actEnvironment(true));
afterAll(() => actEnvironment(false));

describe("useQuery state transitions", () => {
  test("skip renders disabled and never starts a subscription; real args start one", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    await render(root, app(harness, skip));
    expect(container.textContent).toBe("disabled");
    await ready(harness);
    expect(harness.frames("sub")).toHaveLength(0);

    // Replacing the sentinel with real arguments starts exactly one query.
    await render(root, app(harness, { list: 1n }));
    expect(container.textContent).toBe("pending");
    const subs = harness.frames("sub");
    expect(subs).toHaveLength(1);
    expect(subs[0]!.args).toEqual({ list: 1n });

    await receive(harness, {
      v: ACKERDB_VERSION,
      t: "transition",
      id: subs[0]!.id,
      transition: { kind: "reset", from: null, to: cursor(1n), value: ["one"] },
    });
    expect(container.textContent).toBe("fresh:one");

    // Back to skip: disabled again and the subscription is released.
    await render(root, app(harness, skip));
    expect(container.textContent).toBe("disabled");
    expect(harness.frames("unsub").map((frame) => frame.id)).toEqual([subs[0]!.id]);
    await render(root, <></>);
  });

  test("disconnect keeps data stale; a resume delivery restores fresh with the same rows", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    const id = await bootToSuccess(harness, root, container);
    const fresh = observed!;

    await act(async () => {
      harness.live().close();
    });
    expect(container.textContent).toBe("stale:one");
    const stale = observed!;
    expect(stale.status).toBe("unavailable");
    // Retained rows are the same authoritative array, only the marker moved.
    expect((stale as Extract<typeof stale, { status: "unavailable" }>).data).toBe(
      (fresh as Extract<typeof fresh, { status: "success" }>).data,
    );

    await act(async () => {
      harness.clock.advance(200);
    });
    await ready(harness);
    // Reconnect resumed from the retained cursor and stays stale until the
    // server's authoritative answer arrives.
    expect(harness.live().framesOf("sub")[0]!.cursor).toEqual(cursor(1n));
    expect(container.textContent).toBe("stale:one");

    await receive(harness, {
      v: ACKERDB_VERSION,
      t: "transition",
      id,
      transition: { kind: "resume", from: cursor(1n), to: cursor(1n) },
    });
    expect(container.textContent).toBe("fresh:one");
    await render(root, <></>);
  });

  test("a checkpoint-only resume chain confirms freshness without redelivery", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    const id = await bootToSuccess(harness, root, container);

    await act(async () => {
      harness.live().close();
    });
    await act(async () => {
      harness.clock.advance(200);
    });
    await ready(harness);
    expect(container.textContent).toBe("stale:one");

    // The value did not change while disconnected but the commit version did:
    // the server replays its history as checkpoints, which is authoritative.
    await receive(harness, {
      v: ACKERDB_VERSION,
      t: "transition",
      id,
      transition: { kind: "checkpoint", from: cursor(1n), to: cursor(2n) },
    });
    expect(container.textContent).toBe("fresh:one");
    await render(root, <></>);
  });

  test("a reset delivery after reconnect replaces rows and restores fresh", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    const id = await bootToSuccess(harness, root, container);

    await act(async () => {
      harness.live().close();
    });
    await act(async () => {
      harness.clock.advance(200);
    });
    await ready(harness);
    expect(container.textContent).toBe("stale:one");

    await receive(harness, {
      v: ACKERDB_VERSION,
      t: "transition",
      id,
      transition: { kind: "reset", from: null, to: cursor(5n), value: ["one", "two"] },
    });
    expect(container.textContent).toBe("fresh:one,two");
    await render(root, <></>);
  });

  test("a framework rejection clears prior rows and preserves the exact error", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    const id = await bootToSuccess(harness, root, container);

    await receive(harness, {
      v: ACKERDB_VERSION,
      t: "err",
      id,
      outcome: { code: "unauthorized", retryable: false, message: "access denied" },
    });
    expect(container.textContent).toBe("error:unauthorized:-");
    const state = observed!;
    if (state.status !== "rejected") throw new Error("expected a rejected state");
    expect(state.error.message).toBe("access denied");
    expect(state.error.outcome).toMatchObject({ code: "unauthorized", retryable: false });
    await render(root, <></>);
  });

  test("an application error clears prior data, narrows its body, and can recover", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    const id = await bootToSuccess(harness, root, container);

    await receive(harness, {
      v: ACKERDB_VERSION,
      t: "transition",
      id,
      transition: {
        kind: "application-error",
        from: cursor(1n),
        to: cursor(2n),
        error: {
          kind: "application",
          code: "todo.not-found",
          body: { list: 1n },
          status: 404,
        },
      },
    });
    expect(container.textContent).toBe("application-error:todo.not-found");
    const failed = observed!;
    if (failed.status !== "application-error") {
      throw new Error("expected an application-error state");
    }
    expect(failed.data).toBeUndefined();
    expect(failed.error.body.list).toBe(1n);

    await receive(harness, {
      v: ACKERDB_VERSION,
      t: "transition",
      id,
      transition: { kind: "reset", from: null, to: cursor(3n), value: ["restored"] },
    });
    expect(container.textContent).toBe("fresh:restored");
    await render(root, <></>);
  });

  test("disconnect hides an application error until cursor confirmation restores it", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    const id = await bootToSuccess(harness, root, container);

    await receive(harness, {
      v: ACKERDB_VERSION,
      t: "transition",
      id,
      transition: {
        kind: "application-error",
        from: cursor(1n),
        to: cursor(2n),
        error: {
          kind: "application",
          code: "todo.not-found",
          body: { list: 1n },
          status: 404,
        },
      },
    });
    expect(container.textContent).toBe("application-error:todo.not-found");

    await act(async () => {
      harness.live().close();
    });
    expect(container.textContent).toBe("error:unavailable:-");
    const disconnected = observed!;
    if (disconnected.status !== "unavailable") {
      throw new Error("expected unavailable application-error state");
    }
    expect(disconnected).toMatchObject({
      data: undefined,
      stale: false,
      error: { code: "unavailable" },
    });

    await act(async () => {
      harness.clock.advance(200);
    });
    await ready(harness);
    expect(harness.live().framesOf("sub")[0]!.cursor).toEqual(cursor(2n));
    await receive(harness, {
      v: ACKERDB_VERSION,
      t: "transition",
      id,
      transition: { kind: "resume", from: cursor(2n), to: cursor(2n) },
    });
    expect(container.textContent).toBe("application-error:todo.not-found");
    await render(root, <></>);
  });

  test("a retryable rejection resubscribes on its own and recovers without remounting", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    const id = await bootToSuccess(harness, root, container);

    // The server rejects the subscription with an explicitly retryable error;
    // the base client retains and reschedules the mounted demand.
    await receive(harness, {
      v: ACKERDB_VERSION,
      t: "err",
      id,
      outcome: {
        code: "overloaded",
        retryable: true,
        retryAfterMs: 10,
        message: "subscription rejected",
      },
    });
    expect(container.textContent).toBe("stale:one");

    await act(async () => harness.clock.advance(100));
    const subs = harness.frames("sub");
    expect(subs).toHaveLength(2);
    expect(subs[1]!.args).toEqual({ list: 1n });

    await receive(harness, {
      v: ACKERDB_VERSION,
      t: "transition",
      id: subs[1]!.id,
      transition: { kind: "reset", from: null, to: cursor(2n), value: ["one", "two"] },
    });
    expect(container.textContent).toBe("fresh:one,two");
    await render(root, <></>);
  });

  test("unmounting cancels a scheduled retryable resubscribe", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    const id = await bootToSuccess(harness, root, container);

    await receive(harness, {
      v: ACKERDB_VERSION,
      t: "err",
      id,
      outcome: { code: "overloaded", retryable: true, message: "subscription rejected" },
    });
    await render(root, <></>);
    harness.clock.advance(300);
    expect(harness.frames("sub")).toHaveLength(1);
  });

  test("an error before any delivery retains nothing", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    await render(root, app(harness, { list: 1n }));
    await ready(harness);
    const id = harness.frames("sub")[0]!.id;

    await receive(harness, {
      v: ACKERDB_VERSION,
      t: "err",
      id,
      outcome: { code: "validation", retryable: false, message: "bad query" },
    });
    expect(container.textContent).toBe("error:validation:-");
    await render(root, <></>);
  });

  test("a revoked transition clears prior rows, and a later reset recovers", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    const id = await bootToSuccess(harness, root, container);

    await receive(harness, {
      v: ACKERDB_VERSION,
      t: "transition",
      id,
      transition: {
        kind: "revoked",
        from: cursor(1n),
        to: cursor(2n),
        outcome: { code: "unauthorized", retryable: false, message: "revoked" },
      },
    });
    expect(container.textContent).toBe("error:unauthorized:-");

    // A checkpoint cannot clear the revocation.
    await receive(harness, {
      v: ACKERDB_VERSION,
      t: "transition",
      id,
      transition: { kind: "checkpoint", from: cursor(2n), to: cursor(3n) },
    });
    expect(container.textContent).toBe("error:unauthorized:-");

    await receive(harness, {
      v: ACKERDB_VERSION,
      t: "transition",
      id,
      transition: { kind: "reset", from: null, to: cursor(4n), value: ["one", "two"] },
    });
    expect(container.textContent).toBe("fresh:one,two");
    await render(root, <></>);
  });

  test("changed arguments start a new subscription; equal-valued literals continue the current one", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    const id = await bootToSuccess(harness, root, container);
    const settled = observed!;

    // A new object with equal values is the same query: no resubscribe, and
    // the committed snapshot is the identical object.
    await render(root, app(harness, { list: 1n }));
    expect(harness.frames("sub")).toHaveLength(1);
    expect(observed!).toBe(settled);

    await render(root, app(harness, { list: 2n }));
    expect(container.textContent).toBe("pending");
    const subs = harness.frames("sub");
    expect(subs).toHaveLength(2);
    expect(subs[1]!.args).toEqual({ list: 2n });
    expect(harness.frames("unsub").map((frame) => frame.id)).toEqual([id]);

    await receive(harness, {
      v: ACKERDB_VERSION,
      t: "transition",
      id: subs[1]!.id,
      transition: { kind: "reset", from: null, to: cursor(9n), value: ["two"] },
    });
    expect(container.textContent).toBe("fresh:two");
    await render(root, <></>);
  });

  test("duplicate deliveries leave the committed snapshot referentially unchanged", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    const id = await bootToSuccess(harness, root, container);
    const settled = observed!;

    // A duplicate of the applied transition confirms the held cursor; a fresh
    // snapshot has nothing to change, including its identity.
    await receive(harness, {
      v: ACKERDB_VERSION,
      t: "transition",
      id,
      transition: { kind: "reset", from: null, to: cursor(1n), value: ["one"] },
    });
    expect(observed!).toBe(settled);
    await render(root, <></>);
  });

  test("unmounting the consumer releases the single-consumer subscription", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    const id = await bootToSuccess(harness, root, container);

    // The provider (and its client) stay mounted; only the query consumer
    // leaves, so the release must reach the server as an unsubscribe.
    await render(root, <AckerDBProvider config={harness.config()} />);
    expect(harness.frames("unsub").map((frame) => frame.id)).toEqual([id]);
    await render(root, <></>);
  });

  test("Strict Mode leaves exactly one live subscription and updates flow", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    await render(root, app(harness, { list: 1n }, true));
    await ready(harness);

    // Strict Mode ran subscribe, cleanup, subscribe before the socket was
    // ready, so only the surviving subscription was ever sent.
    const live = harness.live();
    const subs = live.framesOf("sub");
    expect(subs).toHaveLength(1);
    expect(live.framesOf("unsub")).toHaveLength(0);

    await receive(harness, {
      v: ACKERDB_VERSION,
      t: "transition",
      id: subs[0]!.id,
      transition: { kind: "reset", from: null, to: cursor(1n), value: ["one"] },
    });
    expect(container.textContent).toBe("fresh:one");

    await render(
      root,
      <StrictMode>
        <AckerDBProvider config={harness.config()} />
      </StrictMode>,
    );
    expect(live.framesOf("unsub").map((frame) => frame.id)).toEqual([subs[0]!.id]);
    await render(root, <></>);
  });

  // Driven through the store entry directly: authentication recovery has no
  // hook until ISSUE-08, and refreshCredential() lives on the private client.
  test("a deferred retry survives authentication blocking and resubscribes after recovery", async () => {
    const harness = createHarness(APP);
    const client = new AckerDBClient(harness.config());
    const entry = new QueryStoreEntry<string[]>(client, "api.todos.list", { list: 1n });
    const stopListening = entry.listen(() => {});
    const first = harness.live();
    first.welcome(SESSION);
    const id = first.framesOf("sub")[0]!.id;
    first.receive({
      v: ACKERDB_VERSION,
      t: "transition",
      id,
      transition: { kind: "reset", from: null, to: cursor(1n), value: ["one"] },
    });
    expect(entry.snapshot()).toMatchObject({ status: "success", stale: false });

    // The subscription is rejected retryably, then the credential expires
    // before the scheduled retry fires.
    first.receive({
      v: ACKERDB_VERSION,
      t: "err",
      id,
      outcome: { code: "overloaded", retryable: true, retryAfterMs: 10, message: "rejected" },
    });
    first.receive({
      v: ACKERDB_VERSION,
      t: "err",
      id: null,
      outcome: { code: "unauthenticated", retryable: false, message: "credential expired" },
    });
    expect(client.currentConnectionState.phase).toBe("authentication-blocked");
    harness.clock.advance(300);
    // The retry deferred against the blocked client instead of dying.
    expect(harness.frames("sub")).toHaveLength(1);

    // New credentials recover the client; the held demand resubscribes and
    // the query returns to fresh authoritative data.
    const refreshed = client.refreshCredential({ kind: "bearer", token: "token-b" });
    const second = harness.live();
    // The recovery hello presents the refreshed credential, so the welcome
    // resolves the attempt itself: no second auth round-trip precedes the
    // resubscription flush.
    second.welcome(SESSION);
    expect(second.framesOf("auth")).toHaveLength(0);
    await refreshed;
    const resubscribed = second.framesOf("sub");
    expect(resubscribed).toHaveLength(1);
    expect(resubscribed[0]!.args).toEqual({ list: 1n });
    second.receive({
      v: ACKERDB_VERSION,
      t: "transition",
      id: resubscribed[0]!.id,
      transition: { kind: "reset", from: null, to: cursor(2n), value: ["one", "two"] },
    });
    expect(entry.snapshot()).toMatchObject({
      status: "success",
      stale: false,
      data: ["one", "two"],
    });

    stopListening();
    client.close();
  });

  test("binary row payloads stay genuine platform typed arrays inside frozen rows", async () => {
    const harness = createHarness(APP);
    const client = new AckerDBClient(harness.config());
    type BlobRow = { readonly name: string; readonly blob: Uint8Array };
    const entry = new QueryStoreEntry<BlobRow[]>(client, "api.todos.blobs", {});
    const stopListening = entry.listen(() => {});
    const first = harness.live();
    first.welcome(SESSION);
    const id = first.framesOf("sub")[0]!.id;
    first.receive({
      v: ACKERDB_VERSION,
      t: "transition",
      id,
      transition: {
        kind: "reset",
        from: null,
        to: cursor(1n),
        value: [{ name: "a", blob: new Uint8Array([104, 105]) }],
      },
    });
    const state = entry.snapshot();
    if (state.status !== "success") throw new Error("expected success");
    const row = state.data[0]!;
    // The container structure is frozen, but byte leaves must remain real
    // ArrayBuffer views the platform accepts — no read-only wrapper survives
    // TextDecoder, Web Crypto, or Blob serialization.
    expect(Object.isFrozen(state.data)).toBe(true);
    expect(Object.isFrozen(row)).toBe(true);
    expect(row.blob).toBeInstanceOf(Uint8Array);
    expect(ArrayBuffer.isView(row.blob)).toBe(true);
    expect([...row.blob]).toEqual([104, 105]);
    expect(new TextDecoder().decode(row.blob)).toBe("hi");
    const blob = new Blob([row.blob as Uint8Array<ArrayBuffer>]);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([104, 105]));
    stopListening();
    client.close();
  });

  test("delivered rows are immutable through the snapshot", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    await bootToSuccess(harness, root, container);

    const state = observed!;
    if (state.status !== "success") throw new Error("expected success");
    expect(Object.isFrozen(state.data)).toBe(true);
    expect(() => state.data.push("mutated")).toThrow(TypeError);
    expect(container.textContent).toBe("fresh:one");
    await render(root, <></>);
  });

  test("unencodable argument values become the exact validation error state", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);
    const numbers = { $ref: "api.todos.byScore" } as QueryRef<{ score: number }, string[]>;
    let captured: AckerDBQueryState<string[]> | undefined;

    function BadArgs(): ReactNode {
      const state = useQuery(numbers, { score: Number.NaN });
      captured = state;
      return <span>{state.status === "rejected" ? `error:${state.error.code}` : state.status}</span>;
    }

    await render(
      root,
      <AckerDBProvider config={harness.config()}>
        <BadArgs />
      </AckerDBProvider>,
    );
    expect(container.textContent).toBe("error:validation");
    if (captured?.status !== "rejected") throw new Error("expected a rejected state");
    expect(captured.error.message).toBe("cannot encode non-finite number NaN");
    expect(captured.error.outcome).toMatchObject({ retryable: false, resource: "subscription" });
    expect(harness.frames("sub")).toHaveLength(0);
    await render(root, <></>);
  });
});

describe("awaiting principal change", () => {
  /** Flushes the arming microtask and the source promise chain. */
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  function alice(authEpoch = 1) {
    return {
      descriptor: {
        principal: "user" as const,
        identity: 1n as Identity,
        provenance: { issuer: "https://issuer.example", subject: "alice" },
        credentialTtlMs: 60_000,
      },
      authEpoch,
    };
  }

  test("a demand rejected while anonymous re-demands exactly once after sign-in", async () => {
    const harness = createHarness(APP);
    const client = new AckerDBClient(harness.config());
    const entry = new QueryStoreEntry<string[]>(client, "api.todos.list", { list: 1n });
    const stopListening = entry.listen(() => {});
    const socket = harness.live();
    socket.welcome(SESSION);
    const id = socket.framesOf("sub")[0]!.id;

    // The anonymous principal fails this query's access policy: the client
    // drops the subscription, and the entry starts awaiting principal change.
    socket.receive({
      v: ACKERDB_VERSION,
      t: "err",
      id,
      outcome: { code: "unauthenticated", retryable: false, message: "sign in first" },
    });
    await flush();
    expect(entry.snapshot()).toMatchObject({ status: "rejected" });
    expect(client.currentConnectionState.phase).toBe("ready");
    expect(socket.framesOf("sub")).toHaveLength(1);

    // Sign-in on the live socket: the accepted user principal differs from
    // the anonymous one that rejected, so the held demand re-presents.
    const refreshed = client.refreshCredential({ kind: "bearer", token: "token-a" });
    const attempt = socket.framesOf("auth")[0]!;
    const accepted = alice();
    socket.receive({
      v: ACKERDB_VERSION,
      t: "auth",
      attemptId: attempt.attemptId,
      authEpoch: accepted.authEpoch,
      ...accepted.descriptor,
    });
    await refreshed;
    await flush();
    const subs = socket.framesOf("sub");
    expect(subs).toHaveLength(2);
    expect(subs[1]!.args).toEqual({ list: 1n });
    socket.receive({
      v: ACKERDB_VERSION,
      t: "transition",
      id: subs[1]!.id,
      transition: { kind: "reset", from: null, to: cursor(1n), value: ["mine"] },
    });
    expect(entry.snapshot()).toMatchObject({ status: "success", data: ["mine"] });
    stopListening();
    client.close();
  });

  test("an unauthorized rejection behaves identically to an unauthenticated one", async () => {
    const harness = createHarness(APP);
    const client = new AckerDBClient(harness.config());
    const entry = new QueryStoreEntry<string[]>(client, "api.todos.list", { list: 1n });
    const stopListening = entry.listen(() => {});
    const socket = harness.live();
    socket.welcome(SESSION);
    const id = socket.framesOf("sub")[0]!.id;
    socket.receive({
      v: ACKERDB_VERSION,
      t: "err",
      id,
      outcome: { code: "unauthorized", retryable: false, message: "not yours" },
    });
    await flush();
    const refreshed = client.refreshCredential({ kind: "bearer", token: "token-a" });
    const attempt = socket.framesOf("auth")[0]!;
    const accepted = alice();
    socket.receive({
      v: ACKERDB_VERSION,
      t: "auth",
      attemptId: attempt.attemptId,
      authEpoch: accepted.authEpoch,
      ...accepted.descriptor,
    });
    await refreshed;
    await flush();
    expect(socket.framesOf("sub")).toHaveLength(2);
    stopListening();
    client.close();
  });

  test("rejections are never retried on a timer, and an unchanged principal never re-demands", async () => {
    const harness = createHarness(APP);
    const client = new AckerDBClient(harness.config());
    const entry = new QueryStoreEntry<string[]>(client, "api.todos.list", { list: 1n });
    const stopListening = entry.listen(() => {});
    const first = harness.live();
    first.welcome(SESSION);
    const id = first.framesOf("sub")[0]!.id;
    first.receive({
      v: ACKERDB_VERSION,
      t: "err",
      id,
      outcome: { code: "unauthenticated", retryable: false, message: "sign in first" },
    });
    await flush();

    // No timer resurrects it.
    harness.clock.advance(600_000);
    await flush();
    expect(harness.frames("sub")).toHaveLength(1);

    // A reconnect accepting the same anonymous principal is not a principal
    // change: the rejection would only repeat, so the demand stays parked.
    first.close(4000, "network flake");
    harness.clock.advance(5_000);
    const second = harness.live();
    second.welcome(SESSION);
    await flush();
    expect(second.framesOf("sub")).toHaveLength(0);
    stopListening();
    client.close();
  });
});

describe("same-principal epoch advance", () => {
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  test("a same-account re-presentation with changed claims revives parked demand", async () => {
    const harness = createHarness(APP);
    const client = new AckerDBClient(harness.config({ credential: { kind: "bearer", token: "viewer" } }));
    const entry = new QueryStoreEntry<string[]>(client, "api.todos.list", { list: 1n });
    const stopListening = entry.listen(() => {});
    const socket = harness.live();
    const alice = {
      principal: "user" as const,
      identity: 1n as Identity,
      provenance: { issuer: "https://issuer.example", subject: "alice" },
      credentialTtlMs: 60_000,
    };
    socket.welcome(SESSION, alice);
    const id = socket.framesOf("sub")[0]!.id;
    // The viewer-role token fails the access policy.
    socket.receive({
      v: ACKERDB_VERSION,
      t: "err",
      id,
      outcome: { code: "unauthorized", retryable: false, message: "viewers cannot read this" },
    });
    await flush();
    expect(socket.framesOf("sub")).toHaveLength(1);

    // Same subject, same identity — but a new presentation whose claims may
    // carry a different role. Access policies see claims, so it re-presents.
    const refreshed = client.refreshCredential({ kind: "bearer", token: "admin" });
    const attempt = socket.framesOf("auth")[0]!;
    socket.receive({
      v: ACKERDB_VERSION,
      t: "auth",
      attemptId: attempt.attemptId,
      authEpoch: 1,
      ...alice,
    });
    await refreshed;
    await flush();
    expect(socket.framesOf("sub")).toHaveLength(2);
    stopListening();
    client.close();
  });
});

describe("rejection during an in-flight presentation", () => {
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  // The Clerk field study's sign-out → sign-in race: the server decides a
  // policy rejection under the still-accepted anonymous principal while the
  // bearer presentation is already in flight, so the rejection's arming
  // sample observes phase "authenticating". Dropping it parked the demand
  // through the very sign-in that should revive it.
  test("a rejection decided under the old principal still re-demands when the new one lands", async () => {
    const harness = createHarness(APP);
    const client = new AckerDBClient(harness.config());
    const entry = new QueryStoreEntry<string[]>(client, "api.todos.list", { list: 1n });
    const stopListening = entry.listen(() => {});
    const socket = harness.live();
    socket.welcome(SESSION);
    const id = socket.framesOf("sub")[0]!.id;

    // The sign-in presentation goes in flight first...
    const refreshed = client.refreshCredential({ kind: "bearer", token: "token-a" });
    expect(client.currentAuthenticationState.phase).toBe("authenticating");
    // ...then the server's rejection of the still-anonymous demand arrives.
    socket.receive({
      v: ACKERDB_VERSION,
      t: "err",
      id,
      outcome: { code: "unauthenticated", retryable: false, message: "sign in first" },
    });
    await flush();

    const attempt = socket.framesOf("auth")[0]!;
    socket.receive({
      v: ACKERDB_VERSION,
      t: "auth",
      attemptId: attempt.attemptId,
      authEpoch: 1,
      principal: "user",
      identity: 1n as Identity,
      provenance: { issuer: "https://issuer.example", subject: "alice" },
      credentialTtlMs: 60_000,
    });
    await refreshed;
    await flush();
    const subs = socket.framesOf("sub");
    expect(subs).toHaveLength(2);
    socket.receive({
      v: ACKERDB_VERSION,
      t: "transition",
      id: subs[1]!.id,
      transition: { kind: "reset", from: null, to: cursor(1n), value: ["revived"] },
    });
    expect(entry.snapshot()).toMatchObject({ status: "success", data: ["revived"] });
    stopListening();
    client.close();
  });
});
