import {
  useCallback,
  useInsertionEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type DependencyList,
} from "react";

export interface ObservationSource<State> {
  snapshot(): State;
  listen(listener: () => void): () => void;
}

const noObservation = (): void => {};

/**
 * Reads committed external-store demand without letting a render start work.
 */
export function useObservation<State>(
  source: ObservationSource<State> | null,
  fallback: State,
): State {
  const subscribe = useCallback(
    (listener: () => void) =>
      source === null ? noObservation : source.listen(listener),
    [source],
  );
  const getSnapshot = useCallback(
    () => source === null ? fallback : source.snapshot(),
    [source, fallback],
  );
  const getServerSnapshot = useCallback(
    () => fallback,
    [fallback],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

interface CommittedHandler<Source, Handler> {
  readonly source: Source | null;
  readonly handler: Handler;
  live: boolean;
}

/**
 * Owns source identity and latest-handler routing for observations whose
 * handler must update at commit without restarting their underlying work.
 */
export function useCommittedObservation<
  State,
  Handler,
  Source extends ObservationSource<State>,
>(
  create: (committedHandler: () => Handler | undefined) => Source | null,
  dependencies: DependencyList,
  handler: Handler,
  fallback: State,
): readonly [source: Source | null, state: State] {
  const latest = useRef<CommittedHandler<Source, Handler> | null>(null);

  // The caller's dependencies define source identity. The factory and handler
  // are deliberately excluded: the source reads only the latest committed
  // handler and must not restart for callback-only renders.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const source = useMemo(() => {
    let observation: Source | null = null;
    observation = create(() => {
      const committed = latest.current;
      return committed !== null &&
          committed.live &&
          committed.source === observation
        ? committed.handler
        : undefined;
    });
    return observation;
  }, dependencies);

  useInsertionEffect(() => {
    const committed: CommittedHandler<Source, Handler> = {
      source,
      handler,
      live: true,
    };
    latest.current = committed;
    return () => {
      committed.live = false;
    };
  });

  return [source, useObservation(source, fallback)] as const;
}

/**
 * Shared committed-demand ownership for React external stores. Concrete
 * adapters supply the work started by the first listener and stopped after the
 * last; Strict Mode and same-commit handoffs share the microtask release gap.
 */
export abstract class SharedObservation<State> implements ObservationSource<State> {
  private readonly listeners = new Set<() => void>();
  private started = false;
  private releaseScheduled = false;

  constructor(
    private state: State,
    private readonly onRelease?: () => void,
  ) {}

  snapshot(): State {
    return this.state;
  }

  listen(listener: () => void): () => void {
    this.listeners.add(listener);
    if (!this.started) {
      this.started = true;
      this.startObservation();
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.scheduleRelease();
    };
  }

  protected get hasDemand(): boolean {
    return this.started && this.listeners.size > 0;
  }

  protected replace(state: State): void {
    if (state === this.state) return;
    if (typeof state === "object" && state !== null) Object.freeze(state);
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }

  protected abstract startObservation(): void;
  protected abstract stopObservation(): void;

  private scheduleRelease(): void {
    if (this.releaseScheduled) return;
    this.releaseScheduled = true;
    queueMicrotask(() => {
      this.releaseScheduled = false;
      if (this.listeners.size > 0 || !this.started) return;
      this.started = false;
      this.stopObservation();
      this.onRelease?.();
    });
  }
}
