# Expo UI production readiness

Source: [Expo SDK 56 changelog](https://expo.dev/changelog/sdk-56)
Collected: 2026-07-16
Published: 2026-05-21

## Focused source notes

- Expo declared the Jetpack Compose (Android) and SwiftUI (iOS) Expo UI APIs stable and production-ready in SDK 56.
- The universal `@expo/ui` layer dispatches to Jetpack Compose on Android and SwiftUI on iOS. Its web implementations were still described as experimental at release.
- Universal primitives include `Host`, `Row`, `Column`, `ScrollView`, `Text`, `TextInput`, `Button`, `Switch`, `Slider`, `Checkbox`, and `BottomSheet`.
- Expo UI was added to the default `create-expo-app` template and became available in Expo Go in SDK 56.
- Therefore, Expo UI by itself no longer forces a development build. A development build is still the recommended production workflow and becomes mandatory when the app adds native code/configuration absent from Expo Go.
