// Compile-time contract for the public @dbzz/client-react surface. This file
// is typechecked (see the package tsconfig) and never executed.
import type { SseRef } from "@dbzz/client";
import {
  DbzzProvider,
  useConnectionState,
  useSseProcedure,
  type DbzzConnectionState,
  type DbzzProviderConfig,
  type SseProcedureCall,
} from "@dbzz/client-react";
import type { ReactElement, ReactNode } from "react";

// --- provider configuration -------------------------------------------------

const config: DbzzProviderConfig = {
  url: "http://127.0.0.1:3211",
  credential: { kind: "anonymous" },
};

const fullConfig: DbzzProviderConfig = {
  url: "http://127.0.0.1:3211",
  credential: { kind: "bearer", token: "token-a" },
  clientSessionId: "session-1",
  limits: { maxPendingItems: 16 },
  reconnect: { baseDelayMs: 50, maxDelayMs: 500 },
};

// @ts-expect-error the server URL is required
const missingUrl: DbzzProviderConfig = { credential: { kind: "anonymous" } };

// @ts-expect-error an explicit credential is required
const missingCredential: DbzzProviderConfig = { url: "http://127.0.0.1:3211" };

// @ts-expect-error bearer credentials carry a token
const tokenless: DbzzProviderConfig = { url: "http://x", credential: { kind: "bearer" } };

const badReconnect: DbzzProviderConfig = {
  url: "http://x",
  credential: { kind: "anonymous" },
  // @ts-expect-error reconnect options are numbers
  reconnect: { baseDelayMs: "fast" },
};

// --- provider element and React 19 types ------------------------------------

const bare: ReactElement = <DbzzProvider config={config} />;
const withChildren: ReactElement = (
  <DbzzProvider config={fullConfig}>
    <div />
    {"text"}
  </DbzzProvider>
);

// @ts-expect-error config is required
const missingConfig = <DbzzProvider />;

// @ts-expect-error the provider owns the client; no imperative client prop exists
const clientProp = <DbzzProvider config={config} client={null} />;

// --- connection-state exhaustiveness ----------------------------------------

function Consumer(): ReactNode {
  const state: DbzzConnectionState = useConnectionState();
  return describePhase(state);
}

function assertNever(value: never): never {
  throw new Error(String(value));
}

function describePhase(state: DbzzConnectionState): string {
  switch (state.phase) {
    case "connecting":
      return "connecting";
    case "ready":
      return `${state.authentication.principal}@${state.authentication.authEpoch}`;
    case "reconnecting":
      return "reconnecting";
    case "authentication-blocked":
      return state.error.code;
    case "terminal-error":
      return state.error.message;
    case "closed":
      return "closed";
    case "suspended":
      return "suspended";
    case "resuming":
      return "resuming";
    default:
      return assertNever(state);
  }
}

function missesNativePhases(state: DbzzConnectionState): string {
  switch (state.phase) {
    case "connecting":
    case "ready":
    case "reconnecting":
    case "authentication-blocked":
    case "terminal-error":
    case "closed":
      return state.phase;
    default:
      // @ts-expect-error the native-only phases make this handling non-exhaustive
      return assertNever(state);
  }
}

declare const connecting: Extract<DbzzConnectionState, { phase: "connecting" }>;
// @ts-expect-error only the ready state carries an authentication
connecting.authentication;

declare const ready: Extract<DbzzConnectionState, { phase: "ready" }>;
// @ts-expect-error the ready state carries no error
ready.error;

// --- SSE procedure hook: ref-driven argument and chunk inference -------------

declare const chatRef: SseRef<{ prompt: string }, { delta: string }>;

function StreamConsumer(): ReactNode {
  const start = useSseProcedure(chatRef);
  const _call: SseProcedureCall<{ prompt: string }, { delta: string }> = start;
  const stream: ReadableStream<{ delta: string }> = start({ prompt: "hi" });
  const withSignal: ReadableStream<{ delta: string }> = start(
    { prompt: "hi" },
    { signal: new AbortController().signal },
  );
  // @ts-expect-error arguments are inferred from the generated reference
  start({ prompt: 1 });
  // @ts-expect-error the chunk type is the server-validated yield type
  const wrongChunks: ReadableStream<number> = start({ prompt: "hi" });
  // Raw addresses remain usable but infer nothing.
  const untyped: ReadableStream<unknown> = useSseProcedure("chat.stream")({});
  void [stream, withSignal, wrongChunks, untyped, _call];
  return null;
}

// --- forbidden imperative escape hatches ------------------------------------

type PublicExports = keyof typeof import("@dbzz/client-react");
type AssertNever<T extends never> = T;

// The value surface is exactly the provider and its hooks: no client getter,
// no close hook, no client class re-export.
type UnexpectedExports = AssertNever<
  Exclude<PublicExports, "DbzzProvider" | "useConnectionState" | "useSseProcedure">
>;
type NoImperativeEscape = AssertNever<
  Extract<PublicExports, "useDbzzClient" | "useClient" | "useClose" | "close" | "DbzzClient">
>;

export {
  Consumer,
  StreamConsumer,
  badReconnect,
  bare,
  clientProp,
  describePhase,
  missesNativePhases,
  missingConfig,
  missingCredential,
  missingUrl,
  tokenless,
  withChildren,
  type NoImperativeEscape,
  type UnexpectedExports,
};
