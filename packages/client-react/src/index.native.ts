/**
 * React Native (Expo) entry, selected by the `react-native` package-export
 * condition (Expo Metro asserts it for native bundles; browsers, Bun, and
 * plain TypeScript fall through to `default`).
 *
 * It re-exports the entire shared surface unchanged and shadows only
 * `DbzzProvider` with a wrapper that defaults the client's injectable
 * capabilities to the Expo implementations. Shared hook modules never import
 * Expo; `./native/` is the only place Expo modules are referenced. The
 * star-re-export keeps this entry's API mechanically identical to the browser
 * entry as new hooks are added (an explicit export always wins over a name
 * from a star re-export).
 */
export * from "./index.ts";
export { DbzzProvider } from "./native/provider.tsx";
