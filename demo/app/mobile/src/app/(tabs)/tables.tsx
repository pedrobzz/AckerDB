import { skip, useMutation, useQuery } from "@dbzz/client-react";
import { api } from "@demo/dbzz-codegen/api";
import { Redirect, router } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { AppScreen } from "../../components/screen";
import { InfoBanner } from "../../components/controls";
import { EmptyState, ErrorState, LoadingState } from "../../components/states";
import { errorMessage } from "../../lib/format";
import { useSession } from "../../providers/session";
import { colors, displayFont } from "../../theme";

export default function TablesScreen() {
  const { session } = useSession();
  const tablesQuery = useQuery(
    api.tables.available,
    session === null ? skip : {},
  );
  const sit = useMutation(api.orders.sit);
  const [selecting, setSelecting] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (session === null) return <Redirect href="/login" />;
  const tables =
    tablesQuery.status === "success"
      ? tablesQuery.data
      : tablesQuery.status === "unavailable"
        ? tablesQuery.data
        : undefined;
  if (tables === undefined && tablesQuery.status === "pending")
    return <LoadingState label="Finding open tables…" />;
  if (
    tables === undefined &&
    (tablesQuery.status === "application-error" ||
      tablesQuery.status === "rejected" ||
      tablesQuery.status === "unavailable")
  ) {
    return <ErrorState message={errorMessage(tablesQuery.error)} />;
  }

  const select = async (tableId: bigint) => {
    setSelecting(tableId);
    setError(null);
    try {
      const result = await sit({ tableId });
      if (!result.ok) throw result.error;
      router.replace("/(tabs)/order");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSelecting(null);
    }
  };

  const available = tables?.filter((table) => table.available).length ?? 0;
  return (
    <AppScreen
      title="Choose your table"
      eyebrow={`Good evening, ${session.name.split(" ")[0]}`}
      name={session.name}
    >
      <InfoBanner>
        {available} {available === 1 ? "table is" : "tables are"} ready. Tap an
        available table to open your order.
      </InfoBanner>
      <View style={styles.legend}>
        <Legend color={colors.sage500} label="Available" />
        <Legend color={colors.clay500} label="In use" />
      </View>
      {error === null ? null : (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      {tables?.length === 0 ? (
        <EmptyState
          title="No dining room yet"
          message="Restaurant staff haven’t configured any active tables."
        />
      ) : (
        <View style={styles.grid}>
          {tables?.map((table) => (
            <Pressable
              key={table.id.toString()}
              accessibilityLabel={`Table ${table.number}, ${table.seats} seats, ${table.available ? "available" : "in use"}`}
              accessibilityRole="button"
              accessibilityState={{
                disabled: !table.available || selecting !== null,
                busy: selecting === table.id,
              }}
              disabled={!table.available || selecting !== null}
              onPress={() => void select(table.id)}
              style={({ pressed }) => [
                styles.table,
                table.available ? styles.tableAvailable : styles.tableOccupied,
                pressed && styles.pressed,
              ]}
            >
              <View style={styles.tableTop}>
                <Text
                  style={[styles.tableNumber, !table.available && styles.muted]}
                >
                  T{String(table.number).padStart(2, "0")}
                </Text>
                {!table.available ? <Text style={styles.lock}>●</Text> : null}
              </View>
              <View>
                <Text style={styles.seats}>{table.seats} seats</Text>
                <Text style={[styles.select, !table.available && styles.muted]}>
                  {selecting === table.id
                    ? "Opening…"
                    : table.available
                      ? "Select"
                      : "In use"}
                </Text>
              </View>
            </Pressable>
          ))}
        </View>
      )}
      <InfoBanner tone="cream">
        A table locks when its order opens and becomes available again after
        payment or cancellation.
      </InfoBanner>
    </AppScreen>
  );
}

function Legend({
  color,
  label,
}: {
  readonly color: string;
  readonly label: string;
}) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={styles.legendText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  legend: { marginTop: 14, flexDirection: "row", gap: 18 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { color: colors.ink500, fontSize: 11 },
  error: { marginTop: 12, color: colors.rose500, fontSize: 12 },
  grid: { marginVertical: 12, flexDirection: "row", flexWrap: "wrap", gap: 9 },
  table: {
    width: "31%",
    minWidth: 100,
    flexGrow: 1,
    minHeight: 104,
    padding: 11,
    borderRadius: 15,
    justifyContent: "space-between",
  },
  tableAvailable: {
    borderWidth: 1,
    borderColor: colors.sage500,
    backgroundColor: colors.warmWhite,
  },
  tableOccupied: {
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.cream100,
  },
  tableTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  tableNumber: {
    color: colors.forest900,
    fontFamily: displayFont,
    fontSize: 21,
    fontWeight: "600",
  },
  lock: { color: colors.clay500, fontSize: 9 },
  seats: { color: colors.ink500, fontSize: 10 },
  select: {
    marginTop: 3,
    color: colors.forest800,
    fontSize: 10,
    fontWeight: "800",
  },
  muted: { color: colors.ink500 },
  pressed: { opacity: 0.65, transform: [{ scale: 0.98 }] },
});
