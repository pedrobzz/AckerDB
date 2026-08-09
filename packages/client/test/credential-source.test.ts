import { describe, expect, test } from "bun:test";
import { ACKERDB_VERSION, type Credential, type Identity } from "@ackerdb/core";
import { AckerDBClient, type AckerDBClientOptions } from "@ackerdb/client";
import { createHarness } from "./support/harness.ts";

const SESSION = "test-session";

function bearer(token: string): Credential {
  return { kind: "bearer", token };
}

/** Settles the source promise chain; socket events are macrotasks and cannot interleave. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function userDescriptor(subject: string, credentialTtlMs = 60_000) {
  return {
    principal: "user" as const,
    identity: 1n as Identity,
    provenance: { issuer: "https://issuer.example", subject },
    credentialTtlMs,
  };
}

describe("credential source", () => {
  test("construction requires exactly one of credential and credentialSource", () => {
    const url = "http://ackerdb.test";
    const none = { url } as unknown as AckerDBClientOptions;
    const both = {
      url,
      credential: { kind: "anonymous" },
      credentialSource: async () => ({ kind: "anonymous" }),
    } as unknown as AckerDBClientOptions;
    expect(() => new AckerDBClient(none)).toThrow(TypeError);
    expect(() => new AckerDBClient(both)).toThrow(TypeError);
  });

  test("the initial connect pulls the source and presents its credential in the hello", async () => {
    let pulls = 0;
    const harness = createHarness({
      credentialSource: async () => {
        pulls += 1;
        return bearer(`token-${pulls}`);
      },
    });
    expect(harness.client.currentAuthenticationState).toEqual({
      phase: "authenticating",
      credential: "source",
    });
    expect(harness.sockets).toHaveLength(0);
    await settled();
    expect(pulls).toBe(1);
    const socket = harness.live();
    socket.welcome(SESSION, userDescriptor("alice", 60_000));
    expect(socket.framesOf("hello")[0]!.credential).toEqual(bearer("token-1"));
    // The welcome verified the pulled credential itself: no auth round-trip.
    expect(socket.framesOf("auth")).toHaveLength(0);
    expect(harness.client.currentAuthenticationState).toMatchObject({
      phase: "authenticated",
      authentication: { credentialTtlMs: 60_000 },
    });
    harness.client.close();
  });

  test("the disclosed TTL schedules a proactive re-pull with no refresh-required transition", async () => {
    let pulls = 0;
    const harness = createHarness({
      credentialSource: async () => {
        pulls += 1;
        return bearer(`token-${pulls}`);
      },
    });
    await settled();
    const socket = harness.live();
    socket.welcome(SESSION, userDescriptor("alice", 60_000));

    // 80% of the disclosed 60s TTL.
    harness.clock.advance(47_999);
    await settled();
    expect(pulls).toBe(1);
    harness.clock.advance(1);
    await settled();
    expect(pulls).toBe(2);

    const auth = harness.live().framesOf("auth");
    expect(auth).toHaveLength(1);
    expect(auth[0]!.credential).toEqual(bearer("token-2"));
    harness.live().receive({
      v: ACKERDB_VERSION,
      t: "auth",
      attemptId: auth[0]!.attemptId,
      authEpoch: 1,
      ...userDescriptor("alice", 60_000),
    });
    await settled();
    expect(harness.client.currentAuthentication).toMatchObject({ authEpoch: 1 });
    // The happy path never blocked: the connection stayed authenticated
    // through the renewal, and the fresh TTL armed the next re-pull.
    expect(harness.phases).not.toContain("authentication-blocked");
    harness.clock.advance(48_000);
    await settled();
    expect(pulls).toBe(3);
    harness.client.close();
  });

  test("a rejected credential re-pulls the source reactively with bounded backoff", async () => {
    let pulls = 0;
    const harness = createHarness({
      credentialSource: async () => {
        pulls += 1;
        return bearer(`token-${pulls}`);
      },
    });
    await settled();
    const first = harness.live();
    first.open();
    first.receive({
      v: ACKERDB_VERSION,
      t: "err",
      id: null,
      outcome: { code: "unauthenticated", retryable: false, message: "bad token" },
    });
    expect(harness.client.currentAuthenticationState.phase).toBe("refresh-required");
    expect(pulls).toBe(1);
    await settled();
    // Backoff, not immediacy: with random pinned to zero the first retry
    // waits exactly the base delay, so a persistently bad credential cannot
    // hot-loop the provider.
    harness.clock.advance(99);
    await settled();
    expect(pulls).toBe(1);
    harness.clock.advance(1);
    await settled();
    expect(pulls).toBe(2);
    const second = harness.live();
    second.welcome(SESSION, userDescriptor("alice", 60_000));
    expect(second.framesOf("hello")[0]!.credential).toEqual(bearer("token-2"));
    expect(harness.client.currentAuthenticationState.phase).toBe("authenticated");
    harness.client.close();
  });

  test("a throwing source retries on the bounded schedule until it recovers", async () => {
    let pulls = 0;
    let failing = true;
    const harness = createHarness({
      credentialSource: async () => {
        pulls += 1;
        if (failing) throw new Error("identity provider offline");
        return bearer("recovered");
      },
    });
    await settled();
    expect(pulls).toBe(1);
    expect(harness.sockets).toHaveLength(0);
    harness.clock.advance(100);
    await settled();
    expect(pulls).toBe(2);
    failing = false;
    harness.clock.advance(200);
    await settled();
    expect(pulls).toBe(3);
    const socket = harness.live();
    socket.open();
    expect(socket.framesOf("hello")[0]!.credential).toEqual(bearer("recovered"));
    harness.client.close();
  });

  test("concurrent explicit refreshes share one queued follow-up pull", async () => {
    let pulls = 0;
    const releases: Array<(credential: Credential) => void> = [];
    const harness = createHarness({
      credentialSource: () => {
        pulls += 1;
        return new Promise<Credential>((resolve) => {
          releases.push(resolve);
        });
      },
    });
    await settled();
    expect(pulls).toBe(1);
    // Both explicit refreshes arrive while the initial pull is in flight:
    // they demand one fresh follow-up between them, never one each and never
    // a silent join of the possibly-stale in-flight pull.
    const one = harness.client.refreshCredential();
    const two = harness.client.refreshCredential();
    expect(pulls).toBe(1);
    // The in-flight pull produces the stale pre-sign-in credential and its
    // presentation settles at the welcome; only then does the shared
    // follow-up pull the source again.
    releases[0]!(bearer("stale"));
    await settled();
    const socket = harness.live();
    socket.welcome(SESSION, userDescriptor("alice", 60_000));
    await settled();
    expect(pulls).toBe(2);
    releases[1]!(bearer("fresh"));
    await settled();
    const auth = socket.framesOf("auth");
    expect(auth).toHaveLength(1);
    expect(auth[0]!.credential).toEqual(bearer("fresh"));
    socket.receive({
      v: ACKERDB_VERSION,
      t: "auth",
      attemptId: auth[0]!.attemptId,
      authEpoch: 1,
      ...userDescriptor("alice", 60_000),
    });
    expect(await one).toMatchObject({ principal: "user" });
    expect(await two).toMatchObject({ principal: "user" });
    expect(pulls).toBe(2);
    harness.client.close();
  });

  test("an explicit refresh during an in-flight pull queues one fresh follow-up pull", async () => {
    let signedIn = false;
    let pulls = 0;
    const harness = createHarness({
      credentialSource: async () => {
        pulls += 1;
        return signedIn ? bearer(`token-${pulls}`) : { kind: "anonymous" as const };
      },
    });
    await settled();
    expect(pulls).toBe(1);
    // The initial anonymous pull is still awaiting its welcome when the user
    // signs in. Joining that flight would discard the sign-in forever: an
    // accepted anonymous principal discloses no TTL, so nothing would ever
    // re-pull the source.
    signedIn = true;
    const refreshed = harness.client.refreshCredential();
    await settled();
    expect(pulls).toBe(1);
    const socket = harness.live();
    socket.welcome(SESSION);
    await settled();
    // The follow-up pulled the fresh bearer and presented it.
    expect(pulls).toBe(2);
    const auth = socket.framesOf("auth");
    expect(auth).toHaveLength(1);
    expect(auth[0]!.credential).toEqual(bearer("token-2"));
    socket.receive({
      v: ACKERDB_VERSION,
      t: "auth",
      attemptId: auth[0]!.attemptId,
      authEpoch: 1,
      ...userDescriptor("alice", 60_000),
    });
    expect(await refreshed).toMatchObject({ principal: "user" });
    harness.client.close();
  });

  test("a hung source is bounded by the query deadline and retried on the schedule", async () => {
    let pulls = 0;
    let hang = true;
    const harness = createHarness({
      credentialSource: () => {
        pulls += 1;
        return hang
          ? new Promise<Credential>(() => {})
          : Promise.resolve(bearer("recovered"));
      },
    });
    await settled();
    expect(pulls).toBe(1);
    // The invocation deadline releases the single-flight slot...
    harness.clock.advance(30_000);
    await settled();
    // ...and the bounded retry pulls again.
    hang = false;
    harness.clock.advance(100);
    await settled();
    expect(pulls).toBe(2);
    const socket = harness.live();
    socket.open();
    expect(socket.framesOf("hello")[0]!.credential).toEqual(bearer("recovered"));
    harness.client.close();
  });

  test("resume gates the dial on a fresh pull instead of presenting the retained credential", async () => {
    let release!: (credential: Credential) => void;
    let pulls = 0;
    const harness = createHarness({
      credentialSource: () => {
        pulls += 1;
        if (pulls === 1) return Promise.resolve(bearer("before-suspend"));
        return new Promise<Credential>((resolve) => {
          release = resolve;
        });
      },
    });
    await settled();
    const first = harness.live();
    first.welcome(SESSION, userDescriptor("alice", 60_000));
    await settled();
    harness.port.suspend();
    expect(harness.client.currentConnectionState.phase).toBe("suspended");

    harness.port.resume();
    await settled();
    // No dial with the retained credential: the account may have changed
    // while backgrounded, and a stale welcome would flush demand under it.
    expect(harness.sockets.filter((socket) => !socket.closed)).toHaveLength(0);
    expect(pulls).toBe(2);
    release(bearer("after-resume"));
    await settled();
    const second = harness.live();
    second.open();
    expect(second.framesOf("hello")[0]!.credential).toEqual(bearer("after-resume"));
    harness.client.close();
  });

  test("refreshCredential enforces the mode split, and a source sign-out is the anonymous pull", async () => {
    const sourced = createHarness({
      credentialSource: async () => ({ kind: "anonymous" }),
    });
    expect(() => sourced.client.refreshCredential(bearer("explicit"))).toThrow(TypeError);
    await settled();
    sourced.live().welcome(SESSION);
    expect(sourced.client.currentAuthenticationState.phase).toBe("unauthenticated");
    sourced.client.close();

    const fixed = createHarness();
    expect(() => fixed.client.refreshCredential()).toThrow(TypeError);
    fixed.client.close();
  });
});

describe("frozen environments", () => {
  // A backgrounded browser tab (or a suspended host) stops running timers:
  // the proactive re-pull never fires, and the server meanwhile kills the
  // session whose credential expired. On wake, the client must not present
  // the credential it can already prove is dead.
  test("a wake past expiry re-pulls before dialing instead of presenting a dead credential", async () => {
    let pulls = 0;
    const harness = createHarness({
      credentialSource: async () => {
        pulls += 1;
        return bearer(`token-${pulls}`);
      },
    });
    await settled();
    const first = harness.live();
    first.welcome(SESSION, userDescriptor("alice", 60_000));
    await settled();
    expect(pulls).toBe(1);

    // Frozen: wall time passes the credential's whole life with every timer
    // asleep, so the ~48s proactive re-pull never ran.
    harness.clock.freeze(90_000);
    // The server dropped the session when the credential expired; the close
    // is only observed once the environment wakes.
    first.close();

    // Waking runs the overdue reconnect work.
    harness.clock.advance(200);
    await settled();

    // The wake pulled a fresh credential rather than dialing with the dead
    // one, so the handshake carries a live token and the connection never
    // published a rejection.
    expect(pulls).toBe(2);
    const second = harness.live();
    second.open();
    expect(second.framesOf("hello")[0]!.credential).toEqual(bearer("token-2"));
    expect(harness.phases).not.toContain("authentication-blocked");
    second.welcome(SESSION, userDescriptor("alice", 60_000));
    await settled();
    expect(harness.client.currentAuthenticationState.phase).toBe("authenticated");
    harness.client.close();
  });

  test("a fixed-credential client still dials after a freeze — it has no other recovery", async () => {
    const harness = createHarness({ credential: { kind: "bearer", token: "fixed" } });
    const first = harness.live();
    first.welcome(SESSION, userDescriptor("alice", 60_000));
    await settled();

    harness.clock.freeze(90_000);
    first.close();
    harness.clock.advance(200);
    await settled();

    const second = harness.live();
    second.open();
    expect(second.framesOf("hello")[0]!.credential).toEqual(bearer("fixed"));
    harness.client.close();
  });
});
