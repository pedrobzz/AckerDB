# expo-app fixture

Minimal custom Expo consumer for `@ackerdb/client-react`: `App.tsx` mounts
`AckerDBProvider`, `useConnectionState`, and one `useQuery` against an AckerDB
server. Metro selects the package's `react-native` conditional entry, which
composes the shared hooks with the named `expo/fetch` implementation and Expo
Crypto randomness.

## Automated packaging proof (no device required)

```sh
bun fixtures/expo-app/verify-packaging.ts
```

Packs the real `@ackerdb/core`/`@ackerdb/client`/`@ackerdb/client-react` tarballs,
installs them into a throwaway copy of this app, and asserts: headless
`expo export` bundles the native entry and Expo capability modules for iOS
and Android; TypeScript resolves the native entry under
`customConditions: ["react-native"]` and the browser entry without it; a
`bun build --target=browser` bundle of the packed package contains no
Expo/React Native code; and deleting the mandatory `expo-crypto` peer fails
the next bundle with a clear resolution error.

## Manual on-device run (ISSUE-14 scope)

On-device acceptance (custom development build on physical hardware, no Expo
Go) is deliberately deferred to ISSUE-14. To try it anyway:

1. `bun fixtures/react-web/server.ts` — serves the matching `notes.list`
   query on port 3211.
2. Change `SERVER_URL` in `App.tsx` to this machine's LAN address.
3. Build and install a custom development build (`npx expo run:ios` /
   `npx expo run:android`), then watch the connection line reach `ready`.
