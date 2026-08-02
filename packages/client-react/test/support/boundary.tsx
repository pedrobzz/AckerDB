import { Component, type ReactNode } from "react";

export interface CaughtBoundary {
  /** Renders `failed` once its subtree throws. */
  readonly Boundary: React.ComponentType<{ children: ReactNode }>;
  /** The error React handed the boundary, or `undefined` while none was thrown. */
  caught(): unknown;
}

/**
 * A hook used outside `<AckerDBProvider>` must fail loudly rather than render a
 * degraded state, and React only surfaces that throw to an error boundary.
 * Each caller owns its own render and settlement convention; this owns the
 * boundary itself so the same class is not restated per hook.
 */
export function createBoundary(): CaughtBoundary {
  let caught: unknown;
  class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
    override state = { failed: false };
    static getDerivedStateFromError(): { failed: boolean } {
      return { failed: true };
    }
    override componentDidCatch(error: unknown): void {
      caught = error;
    }
    override render(): ReactNode {
      return this.state.failed ? "failed" : this.props.children;
    }
  }
  return { Boundary, caught: () => caught };
}
