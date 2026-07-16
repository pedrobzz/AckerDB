/**
 * Shared fake `react-native` AppState for the native suites. `bun test` runs
 * every file in one process and `mock.module` registrations are process-wide,
 * so every file that needs the react-native module must register this same
 * instance — whichever file runs first then defines the module identity, and
 * with one shared object that identity is always this fake.
 */
export type FakeAppStateStatus = "active" | "background" | "inactive" | "unknown" | "extension";

type Listener = (state: FakeAppStateStatus) => void;

const listeners = new Set<Listener>();
let currentState: FakeAppStateStatus = "active";

/** Chronological observer events; tests reset it with `appStateLog.length = 0`. */
export const appStateLog: string[] = [];

export const FakeAppState = {
  get currentState(): FakeAppStateStatus {
    return currentState;
  },
  addEventListener(type: "change", listener: Listener): { remove(): void } {
    if (type !== "change") throw new Error(`unexpected AppState event type: ${type}`);
    listeners.add(listener);
    appStateLog.push("listener-added");
    return {
      remove() {
        listeners.delete(listener);
        appStateLog.push("listener-removed");
      },
    };
  },
};

/** Sets the platform state and notifies listeners, like a real transition. */
export function setAppState(state: FakeAppStateStatus): void {
  currentState = state;
  for (const listener of [...listeners]) listener(state);
}

export function appStateListenerCount(): number {
  return listeners.size;
}
