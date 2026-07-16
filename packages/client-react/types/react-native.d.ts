/**
 * Minimal ambient typing for the `react-native` optional peer, which is never
 * installed in this repository (it only exists inside a React Native app).
 * Scoped to repo typechecking via this package's tsconfig `include`; it does
 * not ship (`files` covers `src` only), so consumers always typecheck
 * src/native against the real react-native declarations. The shape mirrors
 * the documented AppState API exactly.
 */
declare module "react-native" {
  export type AppStateStatus = "active" | "background" | "inactive" | "unknown" | "extension";

  export interface NativeEventSubscription {
    remove(): void;
  }

  export const AppState: {
    readonly currentState: AppStateStatus;
    addEventListener(
      type: "change",
      listener: (state: AppStateStatus) => void,
    ): NativeEventSubscription;
  };
}
