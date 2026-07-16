import { skip, useMutation, useQuery } from "@dbzz/client-react";
import { api } from "@demo/dbzz-codegen/api";
import type { ItemStatus } from "@demo/dbzz-codegen/types";
import { Redirect, router } from "expo-router";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useState } from "react";
import { ActionButton, InfoBanner } from "../../components/controls";
import { AppScreen } from "../../components/screen";
import { EmptyState, ErrorState, LoadingState } from "../../components/states";
import { StatusPill } from "../../components/status-pill";
import { errorMessage, formatMoney, formatOrder } from "../../lib/format";
import { useSession } from "../../providers/session";
import { colors, displayFont } from "../../theme";

const stages: readonly ItemStatus[] = [
  "ORDERED",
  "PREPARING",
  "PREPARED",
  "SERVED",
];

export default function OrderScreen() {
  const { session } = useSession();
  const orderQuery = useQuery(api.orders.current, session === null ? skip : {});
  const cancelItem = useMutation(api.orders.cancelItem);
  const closeCancelled = useMutation(api.orders.closeCancelled);
  const [pendingId, setPendingId] = useState<bigint | null>(null);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session === null) return <Redirect href="/login" />;
  const order =
    orderQuery.status === "success"
      ? orderQuery.data
      : orderQuery.status === "error"
        ? orderQuery.staleData
        : undefined;
  if (order === undefined && orderQuery.status === "pending")
    return <LoadingState label="Loading your live order…" />;
  if (order === undefined && orderQuery.status === "error")
    return <ErrorState message={orderQuery.error.message} />;
  if (order === undefined)
    return <LoadingState label="Loading your live order…" />;
  if (order === null) {
    return (
      <AppScreen
        title="Your order"
        eyebrow="No active table"
        name={session.name}
      >
        <EmptyState
          title="Choose a table first"
          message="Once you sit, your live order and every kitchen update will appear here."
          actionLabel="Find a table"
          onAction={() => router.navigate("/(tabs)/tables")}
        />
      </AppScreen>
    );
  }

  const cancel = (orderItemId: bigint, itemName: string) => {
    Alert.alert(
      "Cancel this item?",
      `${itemName} can only be cancelled before preparation starts.`,
      [
        { text: "Keep item", style: "cancel" },
        {
          text: "Cancel item",
          style: "destructive",
          onPress: () => {
            setPendingId(orderItemId);
            setError(null);
            void cancelItem({ orderId: order.id, orderItemId })
              .catch((caught: unknown) => setError(errorMessage(caught)))
              .finally(() => setPendingId(null));
          },
        },
      ],
    );
  };

  const close = () => {
    setClosing(true);
    setError(null);
    void closeCancelled({ orderId: order.id })
      .then(() => router.replace("/(tabs)/history"))
      .catch((caught: unknown) => setError(errorMessage(caught)))
      .finally(() => setClosing(false));
  };

  const canClose = order.items.length === 0 || order.allCancelled;
  const moving = order.items.filter(
    (item) => item.status === "PREPARING" || item.status === "PREPARED",
  ).length;
  return (
    <AppScreen
      title={`Table ${String(order.table.number).padStart(2, "0")}`}
      eyebrow={`${formatOrder(order.id)} · Live order`}
      name={session.name}
    >
      <View style={styles.progressCard}>
        <Text style={styles.progressEyebrow}>Order progress</Text>
        <Text style={styles.progressTitle}>
          {moving > 0
            ? `${moving} ${moving === 1 ? "plate is" : "plates are"} moving`
            : order.items.length === 0
              ? "Ready for your first order"
              : "Dinner is underway"}
        </Text>
        <View style={styles.stages}>
          {stages.map((stage) => {
            const active = order.items.some((item) => item.status === stage);
            return (
              <View key={stage} style={styles.stage}>
                <View style={[styles.stageBar, active && styles.stageActive]} />
                <Text
                  style={[styles.stageLabel, active && styles.stageLabelActive]}
                >
                  {stage[0]}
                  {stage.slice(1).toLowerCase()}
                </Text>
              </View>
            );
          })}
        </View>
      </View>
      {canClose && order.items.length > 0 ? (
        <InfoBanner tone="rose">
          Every item was cancelled. You can close this order without payment.
        </InfoBanner>
      ) : null}
      {order.readyToPay ? (
        <InfoBanner>
          Everything is served or cancelled. Your bill is ready.
        </InfoBanner>
      ) : null}
      {error === null ? null : (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Your items</Text>
        <Text style={styles.count}>{order.items.length} total</Text>
      </View>
      {order.items.length === 0 ? (
        <View style={styles.emptyItems}>
          <Text style={styles.emptyText}>
            Your table is open. Add something delicious when you’re ready.
          </Text>
        </View>
      ) : (
        order.items.map((item) => (
          <View key={item.id.toString()} style={styles.line}>
            <View style={styles.quantity}>
              <Text style={styles.quantityText}>{item.quantity}×</Text>
            </View>
            <View style={styles.lineBody}>
              <Text
                style={[
                  styles.itemName,
                  item.status === "CANCELLED" && styles.cancelled,
                ]}
              >
                {item.name}
              </Text>
              <Text style={styles.itemMeta}>
                {formatMoney(item.unitPriceCents * item.quantity)}
                {item.note ? ` · ${item.note}` : ""}
              </Text>
              {item.status === "ORDERED" ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Cancel ${item.name}`}
                  disabled={pendingId !== null}
                  hitSlop={8}
                  onPress={() => cancel(item.id, item.name)}
                >
                  <Text style={styles.cancelAction}>
                    {pendingId === item.id ? "Cancelling…" : "Cancel item"}
                  </Text>
                </Pressable>
              ) : null}
            </View>
            <StatusPill status={item.status} />
          </View>
        ))
      )}
      <View style={styles.totalRow}>
        <View>
          <Text style={styles.totalLabel}>Running total</Text>
          <Text style={styles.total}>{formatMoney(order.totalCents)}</Text>
        </View>
        <Text style={styles.tax}>Taxes included</Text>
      </View>
      <ActionButton
        label={
          order.items.length === 0 ? "Browse menu  +" : "Order more items  +"
        }
        variant="dark"
        onPress={() => router.navigate("/menu")}
      />
      {canClose ? (
        <ActionButton
          label={
            order.items.length === 0
              ? "Close empty order"
              : "Close cancelled order"
          }
          variant="danger"
          loading={closing}
          onPress={close}
          style={styles.secondaryAction}
        />
      ) : (
        <ActionButton
          label={
            order.readyToPay
              ? "Request bill"
              : "Pay when every item is served"
          }
          variant={order.readyToPay ? "primary" : "secondary"}
          disabled={!order.readyToPay}
          onPress={() => router.navigate("/bill")}
          style={styles.secondaryAction}
        />
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  progressCard: {
    marginBottom: 14,
    padding: 16,
    borderRadius: 17,
    backgroundColor: colors.forest950,
  },
  progressEyebrow: {
    color: "#9FB8AE",
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 1.1,
    textTransform: "uppercase",
  },
  progressTitle: {
    marginTop: 5,
    color: colors.warmWhite,
    fontFamily: displayFont,
    fontSize: 22,
    fontWeight: "600",
  },
  stages: { marginTop: 16, flexDirection: "row", gap: 5 },
  stage: { flex: 1 },
  stageBar: { height: 4, borderRadius: 2, backgroundColor: "#35564E" },
  stageActive: { backgroundColor: colors.clay500 },
  stageLabel: { marginTop: 5, color: "#78958B", fontSize: 8 },
  stageLabelActive: { color: colors.warmWhite },
  error: { marginTop: 12, color: colors.rose500, fontSize: 12 },
  sectionHeader: {
    marginTop: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionTitle: { color: colors.ink900, fontSize: 15, fontWeight: "800" },
  count: { color: colors.ink500, fontSize: 11 },
  emptyItems: {
    marginTop: 8,
    padding: 20,
    borderRadius: 14,
    backgroundColor: colors.cream100,
  },
  emptyText: {
    color: colors.ink500,
    fontSize: 12,
    lineHeight: 18,
    textAlign: "center",
  },
  line: {
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  quantity: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: colors.cream100,
    alignItems: "center",
    justifyContent: "center",
  },
  quantityText: { color: colors.forest900, fontSize: 11, fontWeight: "800" },
  lineBody: { flex: 1, minWidth: 0 },
  itemName: { color: colors.ink900, fontSize: 12, fontWeight: "700" },
  cancelled: { color: colors.ink500, textDecorationLine: "line-through" },
  itemMeta: { marginTop: 3, color: colors.ink500, fontSize: 10 },
  cancelAction: {
    marginTop: 7,
    color: colors.rose500,
    fontSize: 11,
    fontWeight: "700",
  },
  totalRow: {
    marginTop: 14,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
  },
  totalLabel: { color: colors.ink500, fontSize: 10 },
  total: {
    marginTop: 2,
    color: colors.ink900,
    fontFamily: displayFont,
    fontSize: 29,
    fontWeight: "600",
  },
  tax: { color: colors.ink500, fontSize: 10 },
  secondaryAction: { marginTop: 9 },
});
