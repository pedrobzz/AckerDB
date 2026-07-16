# Expo SDK 57 Runtime Baseline

Sources: Expo — 2026-06-30; Expo Documentation — Unknown; Expo GitHub — 2026-07-16 snapshot; npm Registry — 2026-07-16 snapshot
Raw: [SDK 57 release](../../raw/expo/2026-06-30-expo-sdk-57-release.md); [SDK reference](../../raw/expo/expo-sdk-57-reference.md); [SDK 57 template versions](../../raw/expo/expo-sdk-57-template-versions.md); [Development builds](../../raw/expo/expo-development-builds.md); [Package versions](../../raw/framework-versions/2026-07-16-official-npm-latest-tags.md)
Updated: 2026-07-16

## Decision

Build the customer app on **Expo SDK 57**, the latest stable SDK as of 2026-07-16. Its intended runtime is React Native 0.86.0 with React 19.2.3. Do not start from SDK 55/56, a canary, or an independently selected React Native version.

Use this deterministic baseline:

| Package/runtime | Version |
| --- | --- |
| `expo` | 57.0.6 |
| `react-native` | 0.86.0 |
| `react` / `react-dom` | 19.2.3 |
| `expo-router` | 57.0.6 |
| `@expo/ui` | 57.0.6 |
| `expo-dev-client` | 57.0.6 |
| `react-native-screens` | 4.25.2 (SDK manifest) |
| `react-native-safe-area-context` | 5.7.x (SDK template range) |

The npm latest tags and Expo's `sdk-57` template agree on the 57.0.6 Expo package patch. Install through `npx expo install`, then run `npx expo install --fix`/Expo Doctor so native dependencies remain aligned with the SDK manifest.

## Toolchain floor

- Node 22.13.x is Expo SDK 57's documented minimum and also satisfies TanStack Start's current Node floor.
- Android 7+ with compile/target SDK 36.
- iOS 16.4+ and Xcode 26.4+.

## Development runtime contract

Use a development build, not Expo Go, for the demo's regular workflow:

1. Add `expo-dev-client` with `npx expo install expo-dev-client`.
2. Compile the native binary locally with `npx expo run:ios` / `npx expo run:android`, or create the development profile through EAS Build.
3. Use `npx expo start` for JavaScript iteration against the installed development binary.
4. Rebuild only when native dependencies, native configuration/code, or the Expo SDK changes. JavaScript and asset changes do not require a native rebuild.

Expo UI is available in Expo Go on current SDKs, so it is not itself the technical reason for this requirement. The reason is to test the same customizable native runtime model used by a production app and to remain free to add required native modules/configuration without changing workflows.

## Implementation recommendations for the demo

- Start from the SDK 57 router template shape (`main: "expo-router/entry"`) and remove sample features rather than assembling an older template by hand.
- Keep native projects generated through Continuous Native Generation unless a real native customization requires owning them. On SDK 57, `expo prebuild` is clean by default.
- Avoid importing Reanimated unless a concrete interaction needs it; SDK 57 documents a material memory regression merely from importing it.
- Treat the installed development binary and JavaScript bundle as a versioned contract. A missing native module is a rebuild/configuration problem, not something to catch and mask in JavaScript.

## See also

- [Expo UI and Native Tabs](expo-ui-and-native-tabs.md)
- [TanStack Start admin-panel runtime](../tanstack-start/admin-panel-runtime.md)
