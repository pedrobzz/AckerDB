# Expo UI and Native Tabs

Sources: Expo — 2026-05-21; Expo Documentation — Unknown
Raw: [Expo UI production readiness](../../raw/expo/2026-05-21-expo-ui-production-readiness.md); [Universal Expo UI](../../raw/expo/expo-ui-universal-components.md); [Native Tabs](../../raw/expo/expo-router-native-tabs.md); [Expo Router installation](../../raw/expo/expo-router-installation.md); [SDK 57 template versions](../../raw/expo/expo-sdk-57-template-versions.md)
Updated: 2026-07-16

## Stability boundary

These two native surfaces have different maturity levels in SDK 57:

| Surface | SDK 57 status | Consequence |
| --- | --- | --- |
| Expo UI Jetpack Compose/SwiftUI APIs | Stable and production-ready since SDK 56 | Suitable for shipped controls and native surfaces |
| Expo UI universal native API | Stable on Android/iOS; web was described as experimental at SDK 56 release | Use for the mobile app; do not make the admin panel depend on it |
| Expo Router Native Tabs | Alpha; imported from `expo-router/unstable-native-tabs` | Use because the product explicitly wants system tabs, but isolate the layout and expect future API migration |

Native Tabs being alpha is not a reason to recreate a custom tab bar. It is a reason to keep all unstable API usage in the tab layout, use only documented primitives, and avoid wrapper abstractions that mirror the whole API.

## Expo UI usage rule

Use React Native primitives for the restaurant app's branded content, cards, images, and custom page layout. Use universal Expo UI where the operating system should own interaction and semantics, such as buttons, switches, text inputs, pickers, lists/forms, and bottom sheets.

Import universal controls from `@expo/ui` and wrap each native subtree in `Host`. Use `@expo/ui/swift-ui` or `@expo/ui/jetpack-compose` only for a specific platform behavior that the universal surface cannot express. Size hosts deliberately: intrinsic controls may use `matchContents`; scrolling or expanding content needs finite/flex constraints.

This hybrid keeps the design faithful without rebuilding native controls in JavaScript or forcing the entire screen into a second layout system.

## Native Tabs shape for the customer app

- Put the stable top-level destinations in a `(tabs)` route group and declare every one with a static `NativeTabs.Trigger`.
- Keep the number of destinations at five or fewer because Android's native component has a hard five-tab limit.
- Use `NativeTabs.Trigger.Icon` with `sf` and `md`, plus `.Label`; do not introduce an icon-font native module merely to reproduce a design mockup.
- Put pushed detail screens behind a nested `Stack` inside the relevant tab. Native Tabs itself does not provide the JavaScript Tabs mock header.
- Keep login/onboarding and transient order/payment flows outside the tab navigator when they are not durable top-level destinations.
- Never dynamically add/remove tabs based on authentication or order state; that remounts the navigator and loses state. Gate screen content or route access instead.
- Do not nest Native Tabs.

## Layout and interaction constraints

- Let Native Tabs perform its automatic bottom inset behavior. On Android, handle top/side safe areas separately; on iOS, keep the first scroll view structurally visible to automatic inset handling.
- If a screen uses `FlatList` or the tab bar becomes incorrectly transparent, set `disableTransparentOnScrollEdge` rather than measuring or padding against an assumed tab-bar height.
- The tab-bar height is intentionally not measurable because its placement can change by device class. Layout content against safe areas, never a hard-coded tab height.
- Set `tabBarRespectsIMEInsets` only for a tab that needs the Android bar to move with the keyboard; it requires Android 11+ and resize-mode keyboard configuration.
- Native tab screens mount eagerly. Defer expensive data/render work on first focus while retaining the mounted screen if local state must survive tab changes.

## Router setup

- Use `expo-router/entry` and `src/app/_layout.tsx`.
- Install Router and its native dependencies through `npx expo install`.
- Configure a deep-link scheme and typed routes.
- Import navigation APIs from Expo Router on SDK 57, not directly from `@react-navigation/*` packages.

## See also

- [Expo SDK 57 runtime baseline](expo-sdk-57-runtime-baseline.md)
- [TanStack Start admin-panel runtime](../tanstack-start/admin-panel-runtime.md)
