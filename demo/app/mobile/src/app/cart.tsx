import { skip, useMutation, useQuery } from "@dbzz/client-react";
import { api } from "@demo/dbzz-codegen/api";
import { Redirect, router } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ActionButton, InfoBanner, NativeField } from "../components/controls";
import { AppScreen } from "../components/screen";
import { ErrorState, LoadingState } from "../components/states";
import { errorMessage, formatMoney } from "../lib/format";
import { useCart } from "../providers/cart";
import { useSession } from "../providers/session";
import { colors } from "../theme";

export default function CartScreen() {
  const { session } = useSession();
  const orderQuery = useQuery(api.orders.current, session === null ? skip : {});
  const addItems = useMutation(api.orders.addItems);
  const cart = useCart();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session === null) return <Redirect href="/login" />;
  const order =
    orderQuery.status === "success"
      ? orderQuery.data
      : orderQuery.status === "error"
        ? orderQuery.staleData
        : undefined;
  if (order === undefined && orderQuery.status === "pending")
    return <LoadingState label="Checking your table…" />;
  if (order === undefined && orderQuery.status === "error")
    return <ErrorState message={orderQuery.error.message} />;
  if (order === undefined) return <LoadingState label="Checking your table…" />;
  if (order === null)
    return (
      <AppScreen
        title="Review your cart"
        eyebrow="No active table"
        back
        bottomSafeArea
      >
        <ErrorState
          message="Choose a free table before placing an order."
          actionLabel="Choose a table"
          onAction={() => router.replace("/(tabs)/tables")}
        />
      </AppScreen>
    );

  const confirm = async () => {
    if (cart.lines.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await addItems({
        orderId: order.id,
        items: cart.lines.map((line) => ({
          menuItemId: line.item.id,
          quantity: line.quantity,
          note: line.note.trim() || null,
        })),
      });
      cart.clear();
      router.replace("/(tabs)/order");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppScreen
      title="Review your cart"
      eyebrow={`Table ${String(order.table.number).padStart(2, "0")}`}
      back
      bottomSafeArea
      keyboard
    >
      <InfoBanner>
        Items begin as ORDERED and can be cancelled until preparation starts.
      </InfoBanner>
      {cart.lines.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>Your cart is empty</Text>
          <Text style={styles.emptyText}>
            Browse tonight’s menu and add a dish when you’re ready.
          </Text>
          <ActionButton
            label="Back to menu"
            variant="dark"
            onPress={() => router.replace("/menu")}
            style={styles.emptyAction}
          />
        </View>
      ) : (
        <>
          <View style={styles.lines}>
            {cart.lines.map((line) => (
              <View key={line.item.id.toString()} style={styles.line}>
                <View style={styles.lineHeader}>
                  <View style={styles.lineCopy}>
                    <Text style={styles.itemName}>{line.item.name}</Text>
                    <Text style={styles.itemPrice}>
                      {formatMoney(line.item.priceCents * line.quantity)}
                    </Text>
                  </View>
                  <View style={styles.stepper}>
                    <Step
                      label="−"
                      accessibilityLabel={`Remove one ${line.item.name}`}
                      onPress={() =>
                        cart.setQuantity(line.item.id, line.quantity - 1)
                      }
                    />
                    <Text style={styles.quantity}>{line.quantity}</Text>
                    <Step
                      label="+"
                      accessibilityLabel={`Add one ${line.item.name}`}
                      dark
                      onPress={() =>
                        cart.setQuantity(line.item.id, line.quantity + 1)
                      }
                    />
                  </View>
                </View>
                <NativeField
                  label="Kitchen note (optional)"
                  value={line.note}
                  onChangeText={(note) => cart.setNote(line.item.id, note)}
                  placeholder="e.g. less ice"
                  multiline
                  maxLength={160}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${line.item.name} from cart`}
                  hitSlop={8}
                  onPress={() => cart.remove(line.item.id)}
                >
                  <Text style={styles.remove}>Remove</Text>
                </Pressable>
              </View>
            ))}
          </View>
          <View style={styles.summary}>
            <View>
              <Text style={styles.summaryLabel}>Subtotal</Text>
              <Text style={styles.summaryMeta}>Service and taxes included</Text>
            </View>
            <Text style={styles.summaryTotal}>
              {formatMoney(cart.totalCents)}
            </Text>
          </View>
          {error === null ? null : (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          )}
          <ActionButton
            label={`Confirm ${cart.count} ${cart.count === 1 ? "item" : "items"}`}
            loading={submitting}
            onPress={() => void confirm()}
          />
        </>
      )}
    </AppScreen>
  );
}

function Step({
  label,
  accessibilityLabel,
  dark = false,
  onPress,
}: {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly dark?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [
        styles.step,
        dark && styles.stepDark,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.stepText, dark && styles.stepTextDark]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  empty: {
    flex: 1,
    minHeight: 360,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  emptyTitle: { color: colors.ink900, fontSize: 20, fontWeight: "800" },
  emptyText: {
    marginTop: 8,
    color: colors.ink500,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
  },
  emptyAction: { alignSelf: "stretch", marginTop: 18 },
  lines: { marginTop: 10 },
  line: {
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    gap: 12,
  },
  lineHeader: { flexDirection: "row", alignItems: "center", gap: 12 },
  lineCopy: { flex: 1 },
  itemName: { color: colors.ink900, fontSize: 13, fontWeight: "800" },
  itemPrice: { marginTop: 3, color: colors.ink500, fontSize: 11 },
  stepper: { flexDirection: "row", alignItems: "center", gap: 8 },
  step: {
    width: 44,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.warmWhite,
    alignItems: "center",
    justifyContent: "center",
  },
  stepDark: {
    borderColor: colors.forest900,
    backgroundColor: colors.forest900,
  },
  stepText: { color: colors.ink900, fontSize: 20 },
  stepTextDark: { color: colors.warmWhite },
  quantity: {
    minWidth: 18,
    color: colors.ink900,
    fontSize: 13,
    fontWeight: "800",
    textAlign: "center",
  },
  remove: { color: colors.rose500, fontSize: 11, fontWeight: "700" },
  summary: {
    marginTop: 14,
    paddingVertical: 16,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
  },
  summaryLabel: { color: colors.ink900, fontSize: 13, fontWeight: "800" },
  summaryMeta: { marginTop: 3, color: colors.ink500, fontSize: 10 },
  summaryTotal: { color: colors.ink900, fontSize: 25, fontWeight: "700" },
  error: { marginBottom: 12, color: colors.rose500, fontSize: 12 },
  pressed: { opacity: 0.65 },
});
