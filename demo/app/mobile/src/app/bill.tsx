import { skip, useMutation, useQuery } from "@dbzz/client-react";
import { api } from "@demo/dbzz-codegen/api";
import { Redirect, router } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { ActionButton, InfoBanner } from "../components/controls";
import { AppScreen } from "../components/screen";
import { ErrorState, LoadingState } from "../components/states";
import { StatusPill } from "../components/status-pill";
import { errorMessage, formatMoney, formatOrder } from "../lib/format";
import { useSession } from "../providers/session";
import { colors, displayFont } from "../theme";

export default function BillScreen() {
  const { session } = useSession();
  const orderQuery = useQuery(api.orders.current, session === null ? skip : {});
  const pay = useMutation(api.orders.pay);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session === null) return <Redirect href="/login" />;
  const order =
    orderQuery.status === "success"
      ? orderQuery.data
      : orderQuery.status === "error"
        ? orderQuery.staleData
        : undefined;
  if (order === undefined && orderQuery.status === "pending")
    return <LoadingState label="Preparing your bill…" />;
  if (order === undefined && orderQuery.status === "error")
    return <ErrorState message={orderQuery.error.message} />;
  if (order === undefined) return <LoadingState label="Preparing your bill…" />;
  if (order === null)
    return (
      <AppScreen
        title="Your bill"
        eyebrow="No active order"
        back
        bottomSafeArea
      >
        <ErrorState
          message="This order is no longer open. Find its receipt in your history."
          actionLabel="View order history"
          onAction={() => router.replace("/(tabs)/history")}
        />
      </AppScreen>
    );
  if (!order.readyToPay)
    return (
      <AppScreen
        title="Your bill"
        eyebrow={`${formatOrder(order.id)} · Table ${order.table.number}`}
        back
        bottomSafeArea
      >
        <ErrorState
          message="The bill becomes available after every item is served or cancelled."
          actionLabel="Return to live order"
          onAction={() => router.replace("/(tabs)/order")}
        />
      </AppScreen>
    );

  const served = order.items.filter((item) => item.status === "SERVED").length;
  const cancelled = order.items.filter(
    (item) => item.status === "CANCELLED",
  ).length;
  const submit = async () => {
    setPaying(true);
    setError(null);
    try {
      const result = await pay({ orderId: order.id });
      router.replace({
        pathname: "/success",
        params: {
          orderId: result.orderId.toString(),
          totalCents: String(result.totalCents),
        },
      });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPaying(false);
    }
  };

  return (
    <AppScreen
      title="Your bill is ready"
      eyebrow={`${formatOrder(order.id)} · Table ${String(order.table.number).padStart(2, "0")}`}
      back
      bottomSafeArea
    >
      <InfoBanner>
        {served} served{cancelled > 0 ? ` · ${cancelled} cancelled` : ""} ·
        ready to pay
      </InfoBanner>
      <View style={styles.bill}>
        <View style={styles.billHeader}>
          <Text style={styles.billTitle}>Bill summary</Text>
          <View style={styles.ready}>
            <Text style={styles.readyText}>READY</Text>
          </View>
        </View>
        <View style={styles.lines}>
          {order.items.map((item) => (
            <View key={item.id.toString()} style={styles.line}>
              <Text style={styles.quantity}>{item.quantity}×</Text>
              <View style={styles.itemCopy}>
                <Text
                  style={[
                    styles.itemName,
                    item.status === "CANCELLED" && styles.cancelled,
                  ]}
                >
                  {item.name}
                </Text>
                {item.note ? (
                  <Text style={styles.note}>{item.note}</Text>
                ) : null}
              </View>
              {item.status === "CANCELLED" ? (
                <StatusPill status="CANCELLED" />
              ) : null}
              <Text style={styles.price}>
                {formatMoney(
                  item.status === "CANCELLED"
                    ? 0
                    : item.unitPriceCents * item.quantity,
                )}
              </Text>
            </View>
          ))}
        </View>
        <View style={styles.totalRow}>
          <View>
            <Text style={styles.totalLabel}>Total · taxes included</Text>
            <Text style={styles.total}>{formatMoney(order.totalCents)}</Text>
          </View>
          <Text style={styles.relations}>
            {order.items.length} item{" "}
            {order.items.length === 1 ? "relation" : "relations"}
          </Text>
        </View>
      </View>
      <InfoBanner tone="cream">
        Demo payment · instant confirmation · no card required
      </InfoBanner>
      {error === null ? null : (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      <ActionButton
        label={`Pay ${formatMoney(order.totalCents)}`}
        loading={paying}
        onPress={() => void submit()}
        style={styles.pay}
      />
      <Text style={styles.disclaimer}>
        Payment marks this order PAID and releases Table{" "}
        {String(order.table.number).padStart(2, "0")}.
      </Text>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  bill: {
    marginVertical: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 18,
    backgroundColor: colors.warmWhite,
  },
  billHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  billTitle: {
    color: colors.ink900,
    fontFamily: displayFont,
    fontSize: 23,
    fontWeight: "600",
  },
  ready: {
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.sage100,
  },
  readyText: { color: colors.forest800, fontSize: 9, fontWeight: "800" },
  lines: { marginTop: 12 },
  line: {
    minHeight: 48,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  quantity: { color: colors.ink500, fontSize: 11 },
  itemCopy: { flex: 1 },
  itemName: { color: colors.ink900, fontSize: 11 },
  note: { marginTop: 2, color: colors.ink500, fontSize: 9 },
  cancelled: { color: colors.ink500, textDecorationLine: "line-through" },
  price: {
    minWidth: 42,
    color: colors.ink900,
    fontSize: 11,
    fontWeight: "800",
    textAlign: "right",
  },
  totalRow: {
    marginTop: 15,
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
  },
  totalLabel: { color: colors.ink500, fontSize: 10 },
  total: {
    marginTop: 3,
    color: colors.ink900,
    fontFamily: displayFont,
    fontSize: 32,
    fontWeight: "600",
  },
  relations: { color: colors.ink500, fontSize: 10 },
  error: { marginTop: 12, color: colors.rose500, fontSize: 12 },
  pay: { marginTop: 16 },
  disclaimer: {
    marginTop: 10,
    color: colors.ink500,
    fontSize: 10,
    lineHeight: 15,
    textAlign: "center",
  },
});
