// Compile-time contract for useProcedure. This file is typechecked (see the
// package tsconfig) and never executed.
import type {
  EventRef,
  MutationRef,
  ProcedureRef,
  QueryRef,
  SseRef,
} from "@ackerdb/client";
import { useProcedure, type AckerDBCallOptions, type AckerDBProcedure } from "@ackerdb/client-react";
import type { AckerDBClientError } from "@ackerdb/client";
import type { ReactNode } from "react";

// Generated references as codegen would emit them for one procedure address.
declare const stats: ProcedureRef<{ prefix: string }, { count: number }>;
declare const listQuery: QueryRef<{ prefix: string }, { count: number }>;
declare const record: MutationRef<{ prefix: string }, { count: number }>;
declare const chat: SseRef<{ prefix: string }, { count: number }>;
declare const changes: EventRef<{ prefix: string }, { count: number }>;
declare const signal: AbortSignal;

// --- reference-kind enforcement ----------------------------------------------

function WrongKinds(): ReactNode {
  // @ts-expect-error a query reference is not a procedure
  useProcedure(listQuery);
  // @ts-expect-error a mutation reference is not a procedure
  useProcedure(record);
  // @ts-expect-error an SSE reference is not a procedure
  useProcedure(chat);
  // @ts-expect-error an event reference is not a procedure
  useProcedure(changes);
  // @ts-expect-error raw addresses bypass generated typing and are rejected
  useProcedure("tools.stats");
  return null;
}

// --- argument and result inference -------------------------------------------

function Inference(): ReactNode {
  const run = useProcedure(stats);
  const stable: AckerDBProcedure<{ prefix: string }, { count: number }> = run;

  void run({ prefix: "a" });
  void run({ prefix: "a" }, { signal });
  void run({ prefix: "a" }, {});

  // @ts-expect-error arguments are required
  void run();
  // @ts-expect-error argument fields are typed
  void run({ prefix: 42 });
  // @ts-expect-error unknown argument properties are rejected
  void run({ prefix: "a", extra: true });
  // @ts-expect-error the abort signal must be an AbortSignal
  void run({ prefix: "a" }, { signal: "now" });
  // @ts-expect-error unknown call options are rejected
  void run({ prefix: "a" }, { retry: true });

  void (async () => {
    const result = await run({ prefix: "a" });
    if (!result.ok) {
      const error: AckerDBClientError = result.error;
      void error;
      return;
    }
    const count: number = result.data.count;
    // @ts-expect-error the result carries no other fields
    result.data.total;
    // @ts-expect-error the result field types are exact
    const text: string = result.data.count;
    void count;
    void text;
  })();

  return stable === run ? null : null;
}

// --- the supported call contract is AckerDBCallOptions ---------------------------

declare const options: AckerDBCallOptions;
const optionsSignal: AbortSignal | undefined = options.signal;

export { Inference, WrongKinds, optionsSignal };
