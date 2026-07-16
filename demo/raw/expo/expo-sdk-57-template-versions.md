# Expo SDK 57 official template versions

Source: [Expo SDK 57 default template package](https://raw.githubusercontent.com/expo/expo/sdk-57/templates/expo-template-default/package.json); [Expo SDK 57 bundled native modules](https://raw.githubusercontent.com/expo/expo/sdk-57/packages/expo/bundledNativeModules.json)
Collected: 2026-07-16
Published: Unknown

## Focused source notes

The `sdk-57` branch's official default template and bundled-module manifest provide the compatible package baseline:

| Package | SDK 57 template/manifest value |
| --- | --- |
| `expo` | `~57.0.6` |
| `expo-router` | `~57.0.6` |
| `@expo/ui` | `~57.0.6` |
| `expo-dev-client` | `~57.0.6` (bundled-module manifest) |
| `react` / `react-dom` | `19.2.3` |
| `react-native` | `0.86.0` |
| `react-native-web` | `~0.21.0` |
| `react-native-screens` | `4.25.2` |
| `react-native-safe-area-context` | `~5.7.0` |
| `react-native-reanimated` | `4.5.0` |
| `react-native-worklets` | `0.10.0` |
| TypeScript | `~6.0.3` |

The template uses `expo-router/entry` as `main`. The compatibility ranges are Expo's source of truth; use `npx expo install --fix` after adding packages rather than independently upgrading native dependencies.
