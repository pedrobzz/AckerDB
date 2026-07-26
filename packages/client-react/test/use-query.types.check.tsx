// Compile-time contract for useQuery: reference-driven inference, the typed
// skip sentinel, and exhaustive state handling. This file is typechecked (see
// the package tsconfig) and never executed.
import {
  skip,
  useQuery,
  type AckerDBClientError,
  type AckerDBQueryState,
  type QueryRef,
} from "@ackerdb/client-react";
import type { ApplicationError } from "@ackerdb/core";
import type { EventRef, MutationRef } from "@ackerdb/client";

interface Todo {
  readonly id: bigint;
  readonly text: string;
}
type TodoArgs = { readonly list: bigint };

type TodoNotFound = ApplicationError<"todo.not-found", { readonly id: bigint }, 404>;
declare const todos: QueryRef<TodoArgs, Todo[], TodoNotFound>;
declare const addTodo: MutationRef<TodoArgs, bigint>;
declare const todoEvents: EventRef<TodoArgs, Todo>;

// --- reference-driven inference ----------------------------------------------

function Inferred(): string {
  // Arguments, rows, and the error type all come from the reference alone.
  const state = useQuery(todos, { list: 1n });
  if (state.status === "success") {
    const rows: Todo[] = state.data;
    return `${rows.length}`;
  }
  if (state.status === "application-error") {
    const exact: TodoNotFound = state.error;
    const absent: undefined = state.data;
    return `${exact.code}:${exact.body.id}:${String(absent)}`;
  }
  if (state.status === "rejected") {
    const exact: AckerDBClientError = state.error;
    const absent: undefined = state.data;
    return `${exact.code}:${exact.outcome.retryable}:${String(absent)}`;
  }
  if (state.status === "unavailable") {
    const retained: Todo[] | undefined = state.data;
    if (state.stale) {
      const staleRows: Todo[] = state.data;
      void staleRows;
    } else {
      const absent: undefined = state.data;
      void absent;
    }
    return `${state.error.code}:${state.stale}:${retained?.length ?? 0}`;
  }
  return state.status;
}

const skipped: AckerDBQueryState<Todo[], TodoNotFound> = useQuery(todos, skip);

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

declare const state: AckerDBQueryState<Todo[], TodoNotFound>;

const maybeRows: Todo[] | undefined = state.data;
// @ts-expect-error data is not always defined before state narrowing
const alwaysRows: Todo[] = state.data;

declare const pending: Extract<
  AckerDBQueryState<Todo[], TodoNotFound>,
  { status: "pending" }
>;
// @ts-expect-error the pending state carries no rows
const pendingRows: Todo[] = pending.data;

// @ts-expect-error rows keep their reference type; they are not strings
const wrongRows: string[] = useQuery(todos, skip).status === "success" && state.data;

function assertNever(value: never): never {
  throw new Error(String(value));
}

function describeState(value: AckerDBQueryState<Todo[], TodoNotFound>): string {
  switch (value.status) {
    case "disabled":
      return "disabled";
    case "pending":
      return "pending";
    case "success":
      return `${value.data.length}`;
    case "application-error":
      return `${value.error.code}:${value.error.body.id}`;
    case "rejected":
      return value.error.code;
    case "unavailable":
      return `${value.error.code}:${value.data?.length ?? 0}`;
    default:
      return assertNever(value);
  }
}

function missesErrorState(value: AckerDBQueryState<Todo[], TodoNotFound>): string {
  switch (value.status) {
    case "disabled":
    case "pending":
    case "success":
      return value.status;
    default:
      // @ts-expect-error error and unavailable states make this handling non-exhaustive
      return assertNever(value);
  }
}

export {
  Inferred,
  alwaysRows,
  describeState,
  maybeRows,
  missesErrorState,
  pendingRows,
  skipped,
  wrongRows,
};
