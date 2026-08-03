/** Transport-neutral lifecycle emitted around one authentication attempt. */
export type AuthenticationAttemptKind = "hello" | "refresh" | "sign-out";

export interface AuthenticationAttemptInput {
  readonly kind: AuthenticationAttemptKind;
  readonly clientSessionId: string;
  readonly attemptId?: number;
}

export interface AuthenticationAttemptObservation {
  finish(error?: unknown): void;
}

export type AuthenticationAttemptObserver = (
  input: AuthenticationAttemptInput,
) => AuthenticationAttemptObservation | undefined;
