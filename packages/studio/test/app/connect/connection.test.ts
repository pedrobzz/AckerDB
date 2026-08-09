import { describe, expect, test } from "bun:test";
import type { AckerDBAuthenticationState, AckerDBClientError } from "@ackerdb/client-react";
import { PROTOCOL_VERSION, type AdminSystemInfo } from "@ackerdb/core";
import { studioConnection, type StudioConnectionInput } from "../../../src/app/connect/connection.ts";
import type { StudioProbe } from "../../../src/app/connect/probe.ts";

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
  protocol: PROTOCOL_VERSION,
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

const PHASES: readonly AckerDBAuthenticationState[] = [
  { phase: "authenticating", credential: "source" },
  { phase: "unauthenticated", authentication: { principal: "anonymous", authEpoch: 1 } },
  AUTHENTICATED,
  { phase: "refresh-required", error: clientError("rejected") },
  { phase: "failed", error: clientError("stopped") },
  { phase: "closed" },
];

describe("what Studio says about itself", () => {
  test("nothing is claimed while the probe is unanswered, whatever the session says", () => {
    // Every state names a settled fact about a live application; reporting one
    // from an unanswered request would be a guess wearing a diagnosis.
    for (const authentication of PHASES) {
      for (const hasCredential of [true, false]) {
        expect(studioConnection(input({ hasCredential, authentication })))
          .toEqual({ state: "connecting" });
      }
    }
  });

  test("an application that is not answering is read before anything about credentials", () => {
    // The diagnosis `acker studio` exists to show: Studio is up, the
    // application is not, and no credential could be checked if one were typed.
    const probe: StudioProbe = { status: "unreachable", detail: "could not reach the app" };
    for (const authentication of PHASES) {
      expect(studioConnection(input({ hasCredential: false, probe, authentication })))
        .toEqual({ state: "unreachable", detail: "could not reach the app" });
      expect(studioConnection(input({ probe, authentication })))
        .toEqual({ state: "unreachable", detail: "could not reach the app" });
    }
  });

  test("an empty credential cell is a sign-in, never a refusal", () => {
    for (const probe of [OPEN, { status: "refused", detail: "authentication required" } as StudioProbe]) {
      expect(studioConnection(input({ hasCredential: false, probe })))
        .toEqual({ state: "unconfigured" });
    }
  });

  test("the surface decides refusal, and it is the only thing that can", () => {
    // A credential can authenticate perfectly and reach nothing in the Admin
    // API; only the funnel that ran against it knows.
    const probe: StudioProbe = { status: "refused", detail: "unauthorized" };
    for (const authentication of PHASES) {
      expect(studioConnection(input({ probe, authentication })))
        .toEqual({ state: "refused", detail: "unauthorized" });
    }
  });

  test("a protocol the two do not share is named, not handed over as a transport error", () => {
    // The cause this state reaches in practice: the Admin API answers over
    // plain HTTP, which negotiates no version, while the socket handshake
    // refuses one it cannot speak. The probe already reported the
    // application's protocol, so the screen can say which package to install.
    const older: AdminSystemInfo = { ...APPLICATION, ackerdb: "0.16.0", protocol: PROTOCOL_VERSION - 1 };
    expect(studioConnection(input({
      probe: { status: "open", application: older },
      authentication: { phase: "failed", error: clientError("internal error") },
    }))).toEqual({
      state: "session-failed",
      detail: `this application speaks protocol ${PROTOCOL_VERSION - 1} and Studio speaks ` +
        `${PROTOCOL_VERSION} — install the Studio matching AckerDB 0.16.0`,
    });
  });

  test("with the surface open, every session phase describes the session", () => {
    // Not the grant: calling any of these a credential refusal would send the
    // operator hunting for a token that is already correct.
    expect(studioConnection(input({ probe: OPEN })))
      .toEqual({ state: "authenticated", application: APPLICATION });
    expect(studioConnection(input({
      probe: OPEN,
      authentication: { phase: "authenticating", credential: "source" },
    }))).toEqual({ state: "connecting" });
    expect(studioConnection(input({
      probe: OPEN,
      authentication: { phase: "refresh-required", error: clientError("credential is not valid") },
    }))).toEqual({ state: "session-failed", detail: "credential is not valid" });
    expect(studioConnection(input({
      probe: OPEN,
      authentication: { phase: "failed", error: clientError("internal error") },
    }))).toEqual({ state: "session-failed", detail: "internal error" });
    expect(studioConnection(input({
      probe: OPEN,
      authentication: { phase: "unauthenticated", authentication: { principal: "anonymous", authEpoch: 1 } },
    }))).toEqual({
      state: "session-failed",
      detail: "the server confirmed an anonymous session for a credential that opens the Admin API",
    });
    expect(studioConnection(input({ probe: OPEN, authentication: { phase: "closed" } })))
      .toEqual({ state: "session-failed", detail: "the Studio client was closed" });
  });
});
