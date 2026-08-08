import { describe, expect, test } from "bun:test";
import type { AckerDBAuthenticationState, AckerDBClientError } from "@ackerdb/client-react";
import type { AdminSystemInfo } from "@ackerdb/core";
import { studioConnection, type StudioConnectionInput } from "../src/app/connection.ts";
import type { StudioProbe } from "../src/app/probe.ts";

// The derivation reads a client error's message and nothing else, so a message
// is the whole double; constructing a real one would need the client package,
// which the SPA bundles but this pure rule does not touch.
function clientError(message: string): AckerDBClientError {
  return { message } as AckerDBClientError;
}

const APPLICATION: AdminSystemInfo = {
  name: "savoria-eu",
  version: "2.1.0",
  ackerdb: "0.17.0",
  protocol: 6,
};

const AUTHENTICATED: AckerDBAuthenticationState = {
  phase: "authenticated",
  authentication: {
    principal: "workload",
    authEpoch: 1,
    credentialTtlMs: 3_600_000,
    provenance: { issuer: "ackerdb:credentials", subject: "cred_1" },
  },
};
const OPEN: StudioProbe = { status: "open", application: APPLICATION };

function input(overrides: Partial<StudioConnectionInput> = {}): StudioConnectionInput {
  return {
    hasCredential: true,
    probe: { status: "pending" },
    authentication: AUTHENTICATED,
    ...overrides,
  };
}

describe("what Studio says about itself", () => {
  test("an unanswered probe says only that it is asking", () => {
    expect(studioConnection(input())).toEqual({ state: "connecting" });
  });

  test("an application that is not answering is read before anything about credentials", () => {
    // The diagnosis `acker studio` exists to show: Studio is up, the
    // application is not, and no credential could be checked if one were typed.
    const probe: StudioProbe = { status: "unreachable", detail: "could not reach the app" };
    expect(studioConnection(input({ hasCredential: false, probe })))
      .toEqual({ state: "unreachable", detail: "could not reach the app" });
    expect(studioConnection(input({ probe })))
      .toEqual({ state: "unreachable", detail: "could not reach the app" });
  });

  test("an empty credential cell is a sign-in, never a refusal", () => {
    expect(studioConnection(input({
      hasCredential: false,
      probe: { status: "refused", detail: "authentication required" },
      authentication: {
        phase: "unauthenticated",
        authentication: { principal: "anonymous", authEpoch: 1 },
      },
    }))).toEqual({ state: "unconfigured" });
  });

  test("a credential that authenticates but holds no admin grant is refused", () => {
    // Why the probe decides rather than the handshake: a credential can be
    // perfectly valid and still reach nothing in the Admin API.
    expect(studioConnection(input({ probe: { status: "refused", detail: "unauthorized" } })))
      .toEqual({ state: "refused", detail: "unauthorized" });
  });

  test("a credential the server rejected on the socket is refused too", () => {
    expect(studioConnection(input({
      probe: OPEN,
      authentication: { phase: "refresh-required", error: clientError("credential is not valid") },
    }))).toEqual({ state: "refused", detail: "credential is not valid" });
  });

  test("a credential that opens the surface but cannot hold a session is not a refusal", () => {
    // Calling this "credential refused" sends the operator hunting for a token
    // that is already correct; it is the session that is broken, not the grant.
    expect(studioConnection(input({
      probe: OPEN,
      authentication: { phase: "failed", error: clientError("internal error") },
    }))).toEqual({ state: "session-failed", detail: "internal error" });
  });

  test("Connected needs both facts, because a request answers before a session exists", () => {
    expect(studioConnection(input({ probe: OPEN })))
      .toEqual({ state: "authenticated", application: APPLICATION });
    // The probe is open and the handshake has not finished: still connecting.
    expect(studioConnection(input({
      probe: OPEN,
      authentication: { phase: "authenticating", credential: "source" },
    }))).toEqual({ state: "connecting" });
    // And a session with no answer from the surface is not Connected either.
    expect(studioConnection(input({ probe: { status: "pending" } })))
      .toEqual({ state: "connecting" });
  });
});
