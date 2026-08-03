import type { SessionOptions } from "./contract.ts";
import type {
  AuthenticationAttemptInput,
  AuthenticationAttemptObservation,
  AuthenticationAttemptObserver,
} from "../../auth/attempt-observation.ts";

const SESSION_AUTH_OBSERVER: unique symbol = Symbol("ackerdb.sessionAuthObserver");

interface InternalSessionOptions {
  readonly [SESSION_AUTH_OBSERVER]?: AuthenticationAttemptObserver;
}

interface PendingAuthObservation {
  readonly owner: object;
  readonly observation: AuthenticationAttemptObservation;
}

/** Attach package-internal auth observation without expanding Session's public options. */
export function withSessionAuthObserver<T extends SessionOptions>(
  options: T,
  observer: AuthenticationAttemptObserver | undefined,
): T {
  if (observer !== undefined) Object.assign(options, { [SESSION_AUTH_OBSERVER]: observer });
  return options;
}

/**
 * At most one in-flight authentication attempt is observed per session, owned
 * by the AbortController that drives it. A late owner cannot finish a newer
 * attempt's observation, and every observer callback is fail-open: observation
 * must never affect authentication progress.
 */
export class PendingAuthObservations {
  private readonly observe: AuthenticationAttemptObserver | undefined;
  private pending: PendingAuthObservation | null = null;

  constructor(options: SessionOptions) {
    this.observe = (options as SessionOptions & InternalSessionOptions)[SESSION_AUTH_OBSERVER];
  }

  get enabled(): boolean {
    return this.observe !== undefined;
  }

  /** Begins `owner`'s attempt. An absent input records no observation. */
  begin(owner: object, input: AuthenticationAttemptInput | undefined): void {
    let observation: AuthenticationAttemptObservation | undefined;
    try {
      observation = input === undefined ? undefined : this.observe?.(input);
    } catch {
      observation = undefined;
    }
    this.pending = observation === undefined ? null : { owner, observation };
  }

  /** Finishes the pending attempt, unless it belongs to a different owner. */
  finish(owner?: object, error?: unknown): void {
    const pending = this.pending;
    if (pending === null || (owner !== undefined && pending.owner !== owner)) return;
    this.pending = null;
    try {
      pending.observation.finish(error);
    } catch {
      // Authentication owns application progress; observation is fail-open.
    }
  }
}
