// Compile-time contract for useQuery: reference-driven inference, the typed
// skip sentinel, and exhaustive state handling. This file is typechecked (see
// the package tsconfig) and never executed.
import {
  skip,
  useQuery,
  type DbzzClientError,
  type DbzzQueryState,
  type QueryRef,
} from "@dbzz/client-react";
import type { EventRef, MutationRef } from "@dbzz/client";

interface Todo {
  readonly id: bigint;
  readonly text: string;
}
type TodoArgs = { readonly list: bigint };

declare const todos: QueryRef<TodoArgs, Todo[]>;
declare const addTodo: MutationRef<TodoArgs, bigint>;
declare const todoEvents: EventRef<TodoArgs, Todo>;

// --- reference-driven inference ----------------------------------------------

function Inferred(): string {
  // Arguments, rows, and the error type all come from the reference alone.
  const state = useQuery(todos, { list: 1n });
  if (state.status === "success") {
    const rows: Todo[] = state.data;
    const marker: boolean = state.stale;
    return `${rows.length}:${marker}`;
  }
  if (state.status === "error") {
    // The error is the exact DbzzClientError value, not a widened Error.
    const exact: DbzzClientError = state.error;
    const retained: Todo[] | undefined = state.staleData;
    return `${exact.code}:${exact.outcome.retryable}:${retained?.length ?? 0}`;
  }
  return state.status;
}

const skipped: DbzzQueryState<Todo[]> = useQuery(todos, skip);

// --- rejected references and arguments ---------------------------------------

// @ts-expect-error a mutation reference is not a query reference
useQuery(addTodo, { list: 1n });

// @ts-expect-error an event reference is not a query reference
useQuery(todoEvents, { list: 1n });

// @ts-expect-error arguments must match the reference's argument type
useQuery(todos, { list: 1 });

// @ts-expect-error missing arguments are not a skip
useQuery(todos, {});

// @ts-expect-error only the exported sentinel skips; strings do not
useQuery(todos, "skip");

// @ts-expect-error only the exported sentinel skips; arbitrary symbols do not
useQuery(todos, Symbol("skip"));

// --- state narrowing and exhaustiveness --------------------------------------

declare const state: DbzzQueryState<Todo[]>;

// @ts-expect-error data exists only after narrowing to success
state.data;

// @ts-expect-error the pending state carries no data
declare const pending: Extract<DbzzQueryState<Todo[]>, { status: "pending" }>["data"];

// @ts-expect-error rows keep their reference type; they are not strings
const wrongRows: string[] = useQuery(todos, skip).status === "success" && state.data;

function assertNever(value: never): never {
  throw new Error(String(value));
}

function describeState(value: DbzzQueryState<Todo[]>): string {
  switch (value.status) {
    case "disabled":
      return "disabled";
    case "pending":
      return "pending";
    case "success":
      return `${value.stale}:${value.data.length}`;
    case "error":
      return `${value.error.code}:${value.staleData?.length ?? 0}`;
    default:
      return assertNever(value);
  }
}

function missesErrorState(value: DbzzQueryState<Todo[]>): string {
  switch (value.status) {
    case "disabled":
    case "pending":
    case "success":
      return value.status;
    default:
      // @ts-expect-error the error state makes this handling non-exhaustive
      return assertNever(value);
  }
}

export { Inferred, describeState, missesErrorState, skipped, wrongRows };
