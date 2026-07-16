# Expo development builds

Source: [Introduction to development builds](https://docs.expo.dev/develop/development-builds/introduction/); [Switch from Expo Go to a development build](https://docs.expo.dev/develop/development-builds/expo-go-to-dev-build/); [Create a debug build locally](https://docs.expo.dev/guides/local-app-development/)
Collected: 2026-07-16
Published: Unknown

## Focused source notes

- A development build is the app's own debug native binary, normally including `expo-dev-client`. Unlike Expo Go, it contains the native libraries and native configuration selected by the app.
- Expo describes Expo Go as a learning playground with a fixed native runtime and recommends development builds for production-grade apps.
- Install the client with `npx expo install expo-dev-client`.
- Local native compilation uses `npx expo run:android` or `npx expo run:ios`; EAS Build is the alternative when local native tooling or signing is not available.
- `npx expo start` serves the JavaScript bundle. When `expo-dev-client` is installed, it targets the development build by default.
- Rebuilding is not needed for ordinary JavaScript or asset edits. Rebuild when installing or updating native code, changing native app configuration, changing native code, or upgrading the Expo SDK.
- For local Continuous Native Generation after a native dependency/config change, regenerate native projects and compile the app. In SDK 57, `expo prebuild` is clean by default.
- A JavaScript module can call a native API only when the corresponding native module was compiled into the installed app. This native/JavaScript contract is the reason a development binary must be rebuilt after native changes.
