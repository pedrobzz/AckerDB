# Expo SDK 57 release

Source: [Expo SDK 57 changelog](https://expo.dev/changelog/sdk-57)
Collected: 2026-07-16
Published: 2026-06-30

## Focused source notes

- Expo announced SDK 57 as a stable, intentionally small release centered on the move from React Native 0.85 to 0.86.
- SDK 57 uses React Native 0.86. React remains on the same 19.2 line used by SDK 56.
- The documented upgrade command is `npx expo install expo@^57.0.0 --fix`, followed by `npx expo-doctor@latest`.
- A development client must be rebuilt after an SDK upgrade because the native runtime changed.
- With Continuous Native Generation, SDK 57's `expo prebuild` clears and regenerates `android` and `ios` by default. `--no-clean` opts into applying changes to existing native folders.
- Known regression: importing `react-native-reanimated` on SDK 56/57 can raise memory use by roughly 25–30% because of a Hermes V1 interaction. Expo points to worklets bundle mode as the current mitigation. Avoid importing Reanimated when the app does not need it.
