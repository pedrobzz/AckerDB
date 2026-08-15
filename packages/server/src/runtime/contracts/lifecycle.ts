import type {
  CommitHookContext,
  CommitHookStage,
  CommitWaitHook,
} from "../coordinator.ts";

/**
 * `created` is a constructed Runtime that admits nothing and arms nothing;
 * `start()` is the one transition to `ready`. Every later state is reachable
 * from either through `drain()`.
 */
export type RuntimeLifecycleState = "created" | "ready" | "draining" | "stopped" | "failed";

export type RuntimeHookStage = CommitHookStage;
export type RuntimeHookContext = CommitHookContext;

/** Optional semantic gates for deterministic fault tests; failures are fail-open. */
export interface RuntimeHooks {
  /** Runs after the named stage completes while its owning state machine is still paused. */
  readonly wait?: CommitWaitHook;
}
