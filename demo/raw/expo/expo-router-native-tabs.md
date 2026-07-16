# Expo Router Native Tabs

Source: [Native tabs guide](https://docs.expo.dev/router/advanced/native-tabs/); [SDK 57 Native Tabs reference](https://docs.expo.dev/versions/v57.0.0/sdk/router/native-tabs/)
Collected: 2026-07-16
Published: Unknown

## Focused source notes

- Native Tabs uses the platform's system tab bar and remains **alpha** in SDK 57. Its public import is still `expo-router/unstable-native-tabs`.
- Routes do not appear automatically. Each tab must be declared statically with `NativeTabs.Trigger` in the layout.
- SDK 55+ uses the compound API: `NativeTabs.Trigger.Icon`, `.Label`, and `.Badge`. `sf` selects SF Symbols on iOS and `md` selects Material Symbols on Android.
- Native Tabs is not a drop-in replacement for JavaScript tabs. It intentionally accepts native platform behavior and less visual customization.
- Use a nested native `Stack` inside a tab when that section needs headers or pushed detail screens.
- Safe areas differ by platform: Android automatically applies the bottom inset but leaves other edges to the app; iOS enables automatic inset adjustment on the first nested `ScrollView`. Disabling automatic insets transfers responsibility to the app.
- Android keyboard avoidance is opt-in with `tabBarRespectsIMEInsets`, requires Android 11+, and expects `android.softwareKeyboardLayoutMode: "resize"`.
- All tab screens render eagerly. Expensive work should be deferred until focus without changing the static tab set.
- Known constraints: at most five tabs on Android, no nested Native Tabs, no reliable tab-bar height measurement, limited `FlatList` scroll integration, and no dynamic addition/removal of tabs without remounting/resetting state.
- `disableTransparentOnScrollEdge` is the documented fix for unwanted transparency with static content, iOS 18-and-earlier scroll edges, and affected `FlatList` layouts.
