import {
  AckerDBClientError,
  type ClientResult,
  type AckerDBClient,
} from "@ackerdb/client";
import {
  Failure,
  decode,
  encode,
  type ApplicationError,
} from "@ackerdb/core";
import { useEffect, useInsertionEffect, useState } from "react";
import { useProviderClient } from "./provider.tsx";

// The cell must reflect the committed provider client before any caller in the
// same commit can run: a layout-effect caller during a provider
// reconfiguration must not dispatch through the retired client, and because
// descendant layout effects run before their ancestors', only the insertion
// phase (which the whole tree completes before any layout effect) closes that
// window for callables passed down to children. Server rendering runs no
// effects; the fallback only silences React's server-side warning.
const useCommitEffect = typeof document === "undefined" ? useEffect : useInsertionEffect;

// A call issued before the provider's commit-phase effect has constructed the
// client waits here. Every waiter settles through exactly one explicit path:
// dispatch when the client arrives, discard when the hook's lifetime ends, or
// rejection when its abort owner (see QueueAbort) claims it first. Once
// dispatched, the caller's signal and provider shutdown both settle the call
// through the client's own fetch abort path, so the hook never wraps or
// reinterprets the typed outcome.
interface Waiter {
  dispatch(client: AckerDBClient): void;
  discard(error: AckerDBClientError): void;
}

// Per-hook-instance mutable state shared between renders and the stable
// callable. The callable reads the provider's current client through it, so
// its identity never changes across renders, client arrival, or provider
// reconfiguration.
export interface LifetimeCell<Ref> {
  ref: Ref;
  client: AckerDBClient | null;
  ended: boolean;
  readonly waiters: Set<Waiter>;
}

// Typed outcomes for the settlements the hook itself owns: calls that end
// before ever reaching a client. Shapes mirror the client's local errors.
function hookError(message: string): AckerDBClientError {
  return new AckerDBClientError({
    code: "unavailable",
    message,
    retryable: false,
    resource: "operation",
  });
}

function drain(waiters: Set<Waiter>): Waiter[] {
  const drained = [...waiters];
  waiters.clear();
  return drained;
}

// The base client encodes arguments synchronously at call time; a queued call
// defers that encoding to dispatch, so the wire value is frozen here instead —
// a caller that mutates its argument object while the call waits must not
// change what it asked for. Unencodable values pass through untouched: the
// client sees them at dispatch and reports its own typed validation outcome.
export function snapshotWireValue<A>(args: A): A {
  try {
    return decode(encode(args)) as A;
  } catch {
    return args;
  }
}

/**
 * The one optional third settlement owner of a queued call: the caller's
 * abort signal. Procedures have one — `client.procedure` takes a signal, so a
 * queued procedure call must honor it before dispatch too. Mutations have
 * none: the base `client.mutation` has no abort surface, so a queued mutation
 * settles only by arrival dispatch or lifetime discard.
 */
export interface QueueAbort {
  readonly signal: AbortSignal;
  /** Message for the typed local rejection when the signal claims the call. */
  readonly canceled: string;
}

/**
 * One call against the cell: straight through the committed client when it
 * exists (the returned promise is the client's own, unwrapped, and `args` the
 * caller's own object), queued until arrival otherwise. `dispatch` must
 * capture its reference at call time so a queued call still names what the
 * caller asked for; it runs at most once, with the call-time wire value of
 * `args`.
 */
export function callThroughCell<Ref, A, R>(
  cell: LifetimeCell<Ref>,
  args: A,
  dispatch: (client: AckerDBClient, args: A) => Promise<R>,
  abort?: QueueAbort,
): Promise<R> {
  // Ownership ends with the hook: a callable retained past unmount (by a
  // timer or external listener) settles locally and never dispatches.
  if (cell.ended) return Promise.reject(hookError("client closed"));
  if (cell.client !== null) return dispatch(cell.client, args);
  // Snapshot before consulting the remaining owners: encoding runs caller
  // getters, which may synchronously end the lifetime or deliver a client
  // (both re-read below), or abort — and an AbortSignal never replays its
  // event for a listener attached afterwards.
  const snapshot = snapshotWireValue(args);
  if (cell.ended) return Promise.reject(hookError("client closed"));
  // A client delivered mid-snapshot dispatches now: the arrival drain already
  // ran and will never come back for a late waiter. Synchronous throws
  // propagate like the entry fast path's — the caller's stack is still here.
  if (cell.client !== null) return dispatch(cell.client, snapshot);
  if (abort?.signal.aborted) return Promise.reject(hookError(abort.canceled));
  return new Promise<R>((resolve, reject) => {
    let detach: (() => void) | undefined;
    const waiter: Waiter = {
      dispatch(readyClient) {
        detach?.();
        // A synchronous dispatch throw (a runtime-malformed reference) must
        // fail only its own call: the arrival drain runs inside a commit-phase
        // effect, and later waiters still need their dispatch.
        try {
          dispatch(readyClient, snapshot).then(resolve, reject);
        } catch (error) {
          reject(error);
        }
      },
      discard(error) {
        detach?.();
        reject(error);
      },
    };
    if (abort !== undefined) {
      const { signal, canceled } = abort;
      const onAbort = (): void => {
        // Settle only a waiter still in the queue: once another owner has
        // drained it, its settlement is already decided — an imminent
        // dispatch hands the aborted signal to the client, whose own
        // pre-dispatch check reports the same typed cancellation.
        if (!cell.waiters.delete(waiter)) return;
        reject(hookError(canceled));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      detach = (): void => signal.removeEventListener("abort", onAbort);
    }
    cell.waiters.add(waiter);
  });
}

function asHookClientError(error: unknown): AckerDBClientError {
  return error instanceof AckerDBClientError
    ? error
    : new AckerDBClientError({
        code: "internal",
        message: error instanceof Error ? error.message : "hook call failed unexpectedly",
        retryable: false,
        resource: "operation",
      });
}

/**
 * Result-preserving call ownership for mutations and procedures. Base-client
 * calls already resolve to Results; this also converts hook-owned queued-call,
 * abort, and lifetime settlements into the same non-rejecting shape.
 */
export function callResultThroughCell<
  Ref,
  A,
  Data,
  Error extends ApplicationError = never,
>(
  cell: LifetimeCell<Ref>,
  args: A,
  dispatch: (client: AckerDBClient, args: A) => Promise<ClientResult<Data, Error>>,
  abort?: QueueAbort,
): Promise<ClientResult<Data, Error>> {
  try {
    return callThroughCell(cell, args, dispatch, abort).catch(
      (error) => Failure(asHookClientError(error)),
    ) as Promise<ClientResult<Data, Error>>;
  } catch (error) {
    return Promise.resolve(Failure(asHookClientError(error))) as Promise<ClientResult<Data, Error>>;
  }
}

/**
 * The per-hook-instance plumbing shared by useProcedure and useMutation: one
 * cell and one callable created per hook instance (`createCall` runs once and
 * must route every call through the cell), cell state synced in the commit's
 * insertion phase, queued calls dispatched when the provider's client arrives
 * and discarded when the hook's lifetime ends.
 */
export function useLifetimeCall<Ref, Call>(
  hook: string,
  ref: Ref,
  createCall: (cell: LifetimeCell<Ref>) => Call,
): Call {
  const client = useProviderClient(hook);
  const [{ cell, call }] = useState(() => {
    const created: LifetimeCell<Ref> = { ref, client: null, ended: false, waiters: new Set() };
    return { cell: created, call: createCall(created) };
  });

  // Generated references are proxies with fresh identity per render; track the
  // latest one each commit so the stable callable always names the operation
  // the caller most recently rendered with.
  useCommitEffect(() => {
    cell.ref = ref;
  });

  useCommitEffect(() => {
    cell.ended = false;
    cell.client = client;
    if (client === null) return;
    for (const waiter of drain(cell.waiters)) waiter.dispatch(client);
  }, [cell, client]);

  // The hook's lifetime ends with its component (provider shutdown unmounts
  // consumers too): settle queued calls instead of leaving them pending, and
  // drop the client so nothing dispatches through the ended cell.
  useCommitEffect(
    () => () => {
      cell.ended = true;
      cell.client = null;
      const error = hookError("client closed");
      for (const waiter of drain(cell.waiters)) waiter.discard(error);
    },
    [cell],
  );

  return call;
}
