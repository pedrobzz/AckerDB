import { skip, useQuery } from "@dbzz/client-react";
import { api } from "@demo/dbzz-codegen/api";
import { Redirect, router } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { AppScreen } from "../../components/screen";
import { EmptyState, ErrorState, LoadingState } from "../../components/states";
import { StatusPill } from "../../components/status-pill";
import { formatDate, formatMoney, formatOrder } from "../../lib/format";
import { useSession } from "../../providers/session";
import { colors, displayFont } from "../../theme";

export default function HistoryScreen() {
  const { session } = useSession();
  const historyQuery = useQuery(
    api.orders.history,
    session === null ? skip : {},
  );
  if (session === null) return <Redirect href="/login" />;
  const history =
    historyQuery.status === "success"
      ? historyQuery.data
      : historyQuery.status === "error"
        ? historyQuery.staleData
        : undefined;
  if (history === undefined && historyQuery.status === "pending")
    return <LoadingState label="Gathering your visits…" />;
  if (history === undefined && historyQuery.status === "error")
    return <ErrorState message={historyQuery.error.message} />;

  return (
    <AppScreen title="Your visits" eyebrow={session.name} name={session.name}>
      {history?.active ? (
        <>
          <Text style={styles.label}>ACTIVE NOW</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Return to active order ${formatOrder(history.active.id)}`}
            onPress={() => router.navigate("/(tabs)/order")}
            style={({ pressed }) => [styles.active, pressed && styles.pressed]}
          >
            <View style={styles.activeHeader}>
              <View>
                <Text style={styles.activeTable}>
                  Table {history.active.table.number}
                </Text>
                <Text style={styles.activeOrder}>
                  {formatOrder(history.active.id)}
                </Text>
              </View>
              <View style={styles.open}>
                <Text style={styles.openText}>● OPEN</Text>
              </View>
            </View>
            <View style={styles.activeFooter}>
              <Text style={styles.activeMeta}>
                {history.active.items.length} items · opened{" "}
                {formatDate(history.active.openedAt)}
              </Text>
              <Text style={styles.activeTotal}>
                {formatMoney(history.active.totalCents)}
              </Text>
            </View>
            <View style={styles.return}>
              <Text style={styles.returnText}>Return to active order →</Text>
            </View>
          </Pressable>
        </>
      ) : null}
      <View style={styles.closedHeader}>
        <Text style={styles.label}>PAST ORDERS</Text>
        <Text style={styles.closedCount}>
          {history?.closed.length ?? 0} total
        </Text>
      </View>
      {history?.closed.length === 0 ? (
        <EmptyState
          title="No past visits yet"
          message="Paid and cancelled orders will be saved here."
        />
      ) : (
        history?.closed.map((order) => (
          <View key={order.id.toString()} style={styles.orderRow}>
            <View
              style={[
                styles.orderMark,
                order.status === "CANCELLED"
                  ? styles.cancelMark
                  : styles.paidMark,
              ]}
            >
              <Text
                style={[
                  styles.orderMarkText,
                  order.status === "CANCELLED"
                    ? styles.cancelText
                    : styles.paidText,
                ]}
              >
                {order.status === "CANCELLED" ? "×" : "✓"}
              </Text>
            </View>
            <View style={styles.orderCopy}>
              <Text style={styles.orderTitle}>
                {formatOrder(order.id)} · Table {order.table.number}
              </Text>
              <Text style={styles.orderDate}>
                {formatDate(order.openedAt)} · {order.items.length} items
              </Text>
            </View>
            <View style={styles.orderEnd}>
              <StatusPill status={order.status} />
              <Text style={styles.orderTotal}>
                {formatMoney(order.totalCents)}
              </Text>
            </View>
          </View>
        ))
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  label: {
    color: colors.ink500,
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 1.1,
  },
  active: {
    marginTop: 8,
    padding: 16,
    borderRadius: 17,
    backgroundColor: colors.forest950,
  },
  activeHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  activeTable: { color: "#9FB8AE", fontSize: 10 },
  activeOrder: {
    marginTop: 4,
    color: colors.warmWhite,
    fontFamily: displayFont,
    fontSize: 23,
    fontWeight: "600",
  },
  open: {
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "#2A5147",
  },
  openText: { color: colors.warmWhite, fontSize: 9, fontWeight: "800" },
  activeFooter: {
    marginTop: 15,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  activeMeta: { flex: 1, color: "#9FB8AE", fontSize: 9 },
  activeTotal: {
    color: colors.warmWhite,
    fontFamily: displayFont,
    fontSize: 21,
    fontWeight: "600",
  },
  return: {
    marginTop: 13,
    minHeight: 40,
    borderRadius: 11,
    backgroundColor: colors.clay500,
    alignItems: "center",
    justifyContent: "center",
  },
  returnText: { color: colors.warmWhite, fontSize: 10, fontWeight: "800" },
  closedHeader: {
    marginTop: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  closedCount: { color: colors.ink500, fontSize: 10 },
  orderRow: {
    minHeight: 72,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  orderMark: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelMark: { backgroundColor: colors.rose100 },
  paidMark: { backgroundColor: colors.sky100 },
  orderMarkText: { fontSize: 18, fontWeight: "800" },
  cancelText: { color: colors.rose500 },
  paidText: { color: colors.sky500 },
  orderCopy: { flex: 1 },
  orderTitle: { color: colors.ink900, fontSize: 11, fontWeight: "800" },
  orderDate: { marginTop: 4, color: colors.ink500, fontSize: 9 },
  orderEnd: { alignItems: "flex-end", gap: 5 },
  orderTotal: { color: colors.ink900, fontSize: 10, fontWeight: "800" },
  pressed: { opacity: 0.7 },
});
