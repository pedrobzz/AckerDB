import type { ReactElement } from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  AckerDBProvider,
  useConnectionState,
  useQuery,
  type AckerDBProviderConfig,
  type QueryRef,
} from "@ackerdb/client-react";

// Point this at a machine running `bun fixtures/react-web/server.ts` — it
// serves the matching `notes.list` query on port 3211. A physical device
// needs that machine's LAN address instead of localhost; on-device acceptance
// itself is ISSUE-14 scope.
const SERVER_URL = "http://127.0.0.1:3211";

interface Note {
  readonly body: string;
}

// Same untyped-reference pattern as the repo's React integration tests; a real
// application imports its generated api object from its server project.
const notesList = { $ref: "notes.list" } as QueryRef<Record<never, never>, Note[]>;

const config: AckerDBProviderConfig = { url: SERVER_URL, credential: { kind: "anonymous" } };

function Screen(): ReactElement {
  const connection = useConnectionState();
  const notes = useQuery(notesList, {});
  return (
    <View style={styles.container}>
      <Text style={styles.title}>AckerDB Expo fixture</Text>
      <Text>connection: {connection.phase}</Text>
      {connection.phase === "ready" && (
        <Text>principal: {connection.authentication.principal}</Text>
      )}
      <Text>
        notes:{" "}
        {notes.status === "success"
          ? `${notes.data.length} row(s)${notes.stale ? " (stale)" : ""}`
          : notes.status}
      </Text>
      {notes.status === "success" &&
        notes.data.map((note, index) => <Text key={index}>- {note.body}</Text>)}
    </View>
  );
}

export function App(): ReactElement {
  return (
    <AckerDBProvider config={config}>
      <Screen />
    </AckerDBProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", padding: 24, gap: 4 },
  title: { fontSize: 18, fontWeight: "600" },
});
