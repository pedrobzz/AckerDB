// Compile-time contract for the public @ackerdb/client-react surface. This file
// is typechecked (see the package tsconfig) and never executed.
import type { SseRef } from "@ackerdb/client";
import {
  AckerDBProvider,
  useConnectionState,
  useEvent,
  useSseProcedure,
  type AckerDBConnectionState,
  type AckerDBLiveEvent,
  type AckerDBProviderConfig,
  type EventRef,
  type SseProcedureCall,
} from "@ackerdb/client-react";
import type { ReactElement, ReactNode } from "react";

// --- provider configuration -------------------------------------------------

const config: AckerDBProviderConfig = {
  url: "http://127.0.0.1:3211",
  credential: { kind: "anonymous" },
};

const fullConfig: AckerDBProviderConfig = {
  url: "http://127.0.0.1:3211",
  credential: { kind: "bearer", token: "token-a" },
  clientSessionId: "session-1",
  limits: { maxPendingItems: 16 },
  reconnect: { baseDelayMs: 50, maxDelayMs: 500 },
};

// @ts-expect-error the server URL is required
const missingUrl: AckerDBProviderConfig = { credential: { kind: "anonymous" } };

// @ts-expect-error an explicit credential is required
const missingCredential: AckerDBProviderConfig = { url: "http://127.0.0.1:3211" };

// @ts-expect-error bearer credentials carry a token
const tokenless: AckerDBProviderConfig = { url: "http://x", credential: { kind: "bearer" } };

const badReconnect: AckerDBProviderConfig = {
  url: "http://x",
  credential: { kind: "anonymous" },
  // @ts-expect-error reconnect options are numbers
  reconnect: { baseDelayMs: "fast" },
};

// --- provider element and React 19 types ------------------------------------

const bare: ReactElement = <AckerDBProvider config={config} />;
const withChildren: ReactElement = (
  <AckerDBProvider config={fullConfig}>
    <div />
    {"text"}
  </AckerDBProvider>
);

// @ts-expect-error config is required
const missingConfig = <AckerDBProvider />;

// @ts-expect-error the provider owns the client; no imperative client prop exists
const clientProp = <AckerDBProvider config={config} client={null} />;

// --- connection-state exhaustiveness ----------------------------------------

function Consumer(): ReactNode {
  const state: AckerDBConnectionState = useConnectionState();
  return describePhase(state);
}

function assertNever(value: never): never {
  throw new Error(String(value));
}

function describePhase(state: AckerDBConnectionState): string {
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

function missesNativePhases(state: AckerDBConnectionState): string {
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

declare const connecting: Extract<AckerDBConnectionState, { phase: "connecting" }>;
// @ts-expect-error only the ready state carries an authentication
connecting.authentication;

declare const ready: Extract<AckerDBConnectionState, { phase: "ready" }>;
// @ts-expect-error the ready state carries no error
ready.error;

// --- typed event subscriptions ----------------------------------------------

declare const pingEvents: EventRef<{ min: number }, { id: bigint; n: number }>;

function EventConsumer(): ReactNode {
  // The reference infers the argument and row payload types end to end, and
  // the live union is exactly what the wire protocol carries: row, gap, reset.
  useEvent(pingEvents, { min: 1 }, (event) => {
    switch (event.kind) {
      case "row": {
        const n: number = event.row.n;
        const id: bigint = event.row.id;
        void [n, id, event.cursor.sequence];
        return;
      }
      case "gap": {
        // @ts-expect-error a gap dropped its rows; only the cursor survives
        void event.row;
        return;
      }
      case "reset":
        void event.cursor.generation;
        return;
      default:
        return assertNever(event);
    }
  });
  return null;
}

function MistypedEventConsumers(): ReactNode {
  // @ts-expect-error arguments are inferred from the event reference
  useEvent(pingEvents, { min: "low" }, () => {});
  useEvent(pingEvents, { min: 1 }, (event) => {
    // @ts-expect-error ackerdb event streams are append-only: the protocol
    // carries no insert/update/delete kinds to compare against
    void (event.kind === "delete");
    if (event.kind === "row") {
      // @ts-expect-error the row payload is exactly the event table's columns
      void event.row.missing;
    }
  });
  useEvent(pingEvents, { min: 1 }, () => {}, (error) => {
    error.code satisfies string;
    error.retryable satisfies boolean;
  });
  return null;
}

function ignoresGap(event: AckerDBLiveEvent<{ n: number }>): string {
  switch (event.kind) {
    case "row":
    case "reset":
      return event.kind;
    default:
      // @ts-expect-error gap events make this handling non-exhaustive
      return assertNever(event);
  }
}

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
  const untyped: ReadableStream<unknown> = useSseProcedure("api.chat.stream")({});
  void [stream, withSignal, wrongChunks, untyped, _call];
  return null;
}

// --- forbidden imperative escape hatches ------------------------------------

type PublicExports = keyof typeof import("@ackerdb/client-react");
type AssertNever<T extends never> = T;

// The value surface is exactly the provider and its hooks: no client getter,
// no close hook, no client class re-export.
type UnexpectedExports = AssertNever<
  Exclude<
    PublicExports,
    | "AckerDBProvider"
    | "useAuthentication"
    | "useChannel"
    | "useConnectionState"
    | "useEvent"
    | "useFileUpload"
    | "useMutation"
    | "usePaginatedQuery"
    | "useProcedure"
    | "useQuery"
    | "useQueryProcedure"
    | "skip"
    | "useSseProcedure"
  >
>;

export {
  Consumer,
  EventConsumer,
  MistypedEventConsumers,
  StreamConsumer,
  badReconnect,
  bare,
  clientProp,
  describePhase,
  ignoresGap,
  missesNativePhases,
  missingConfig,
  missingCredential,
  missingUrl,
  tokenless,
  withChildren,
  type UnexpectedExports,
};
