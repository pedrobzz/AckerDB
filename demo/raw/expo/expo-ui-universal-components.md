# Expo UI universal components

Source: [Expo UI universal components](https://docs.expo.dev/versions/latest/sdk/ui/universal/); [Universal Host](https://docs.expo.dev/versions/latest/sdk/ui/universal/host/)
Collected: 2026-07-16
Published: Unknown

## Focused source notes

- Install with `npx expo install @expo/ui`.
- Import universal primitives from `@expo/ui`. Use `@expo/ui/swift-ui` or `@expo/ui/jetpack-compose` only when a platform-specific control or modifier is actually required.
- Every universal Expo UI subtree must be rooted in `Host`. On native platforms, the host bridges the React Native view tree to SwiftUI or Jetpack Compose; on web it falls back to a React Native view.
- `Host` sizing is part of the layout contract. Use an explicit size/flex layout for expanding content and `matchContents` only for intrinsically sized content. Do not combine an unbounded `matchContents` axis with a scrollable child.
- The universal surface covers platform controls, layouts, sheets, lists, and forms. React Native views can remain outside those subtrees, so an app can adopt Expo UI only where native behavior provides value.
