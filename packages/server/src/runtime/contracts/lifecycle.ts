import type {
  CommitHookContext,
  CommitHookStage,
  CommitWaitHook,
} from "../coordinator.ts";

export type RuntimeLifecycleState = "ready" | "draining" | "stopped" | "failed";

export type RuntimeHookStage = CommitHookStage;
export type RuntimeHookContext = CommitHookContext;

/** Optional semantic gates for deterministic fault tests; failures are fail-open. */
export interface RuntimeHooks {
  /** Runs after the named stage completes while its owning state machine is still paused. */
  readonly wait?: CommitWaitHook;
}
