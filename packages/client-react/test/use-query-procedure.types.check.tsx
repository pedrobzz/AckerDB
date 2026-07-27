// Compile-time contract for useQueryProcedure: generated procedure inference,
// query-shaped state, skip, configuration, and reference-kind enforcement.
import type {
  EventRef,
  MutationRef,
  ProcedureRef,
  QueryRef,
  SseRef,
} from "@ackerdb/client";
import type { ApplicationError } from "@ackerdb/core";
import {
  skip,
  useQueryProcedure,
  type AckerDBClientError,
  type AckerDBQueryProcedureState,
} from "@ackerdb/client-react";

type StatsUnavailable = ApplicationError<
  "stats.unavailable",
  { readonly source: string },
  503
>;
declare const stats: ProcedureRef<
  { readonly prefix: string },
  { readonly count: number },
  StatsUnavailable
>;
declare const query: QueryRef<{ readonly prefix: string }, { readonly count: number }>;
declare const mutation: MutationRef<{ readonly prefix: string }, { readonly count: number }>;
declare const event: EventRef<{ readonly prefix: string }, { readonly count: number }>;
declare const stream: SseRef<{ readonly prefix: string }, { readonly count: number }>;

function Inference(): string {
  const state = useQueryProcedure(
    stats,
    { prefix: "a" },
    { refreshIntervalMs: 5_000 },
  );
  const exact: AckerDBQueryProcedureState<
    { readonly count: number },
    StatsUnavailable
  > = state;
  const refreshed: void = state.refresh();
  void refreshed;

  if (state.status === "success") return `${state.data.count}:${state.stale}`;
  if (state.status === "application-error") {
    const error: StatsUnavailable = state.error;
    return `${error.code}:${error.body.source}`;
  }
  if (state.status === "rejected" || state.status === "unavailable") {
    const error: AckerDBClientError = state.error;
    return error.code;
  }
  return exact.status;
}

const disabled: AckerDBQueryProcedureState<
  { readonly count: number },
  StatsUnavailable
> = useQueryProcedure(stats, skip);

// @ts-expect-error a query reference is not a procedure
useQueryProcedure(query, { prefix: "a" });
// @ts-expect-error a mutation reference is not a procedure
useQueryProcedure(mutation, { prefix: "a" });
// @ts-expect-error an event reference is not a procedure
useQueryProcedure(event, { prefix: "a" });
// @ts-expect-error an SSE reference is not a procedure
useQueryProcedure(stream, { prefix: "a" });
// @ts-expect-error raw addresses bypass generated typing
useQueryProcedure("stats.read", { prefix: "a" });
// @ts-expect-error arguments are inferred from the generated reference
useQueryProcedure(stats, { prefix: 1 });
// @ts-expect-error only the shared skip sentinel disables demand
useQueryProcedure(stats, "skip");
// @ts-expect-error unknown options are rejected
useQueryProcedure(stats, { prefix: "a" }, { interval: 5_000 });
// @ts-expect-error refreshIntervalMs is measured as a number
useQueryProcedure(stats, { prefix: "a" }, { refreshIntervalMs: "5000" });

export { Inference, disabled };
