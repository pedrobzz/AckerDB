import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ActionButton } from "../components/controls";
import { errorMessage, formatMoney, formatOrder } from "../lib/format";
import { useSession } from "../providers/session";
import { colors, displayFont } from "../theme";

export default function SuccessScreen() {
  const { session, clear } = useSession();
  const params = useLocalSearchParams<{
    orderId?: string;
    totalCents?: string;
  }>();
  const [exiting, setExiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (session === null) return <Redirect href="/login" />;
  const orderId = params.orderId ? BigInt(params.orderId) : null;
  const totalCents = Number(params.totalCents ?? 0);

  const exit = async () => {
    setExiting(true);
    setError(null);
    try {
      await clear();
      router.replace("/login");
    } catch (caught) {
      setError(errorMessage(caught));
      setExiting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.brand}>
        <View style={styles.brandMark}>
          <Text style={styles.brandMarkText}>✦</Text>
        </View>
        <Text style={styles.brandText}>Savoria</Text>
      </View>
      <View style={styles.main}>
        <View style={styles.successOuter}>
          <View style={styles.successInner}>
            <Text style={styles.check}>✓</Text>
          </View>
          <Text style={styles.spark}>✦</Text>
        </View>
        <Text style={styles.eyebrow}>Payment successful</Text>
        <Text style={styles.title}>Thank you for dining with us.</Text>
        <Text style={styles.copy}>
          {orderId === null
            ? "Your order is paid"
            : `Order ${formatOrder(orderId)} is paid`}
          . Your table is available again, and this visit is saved in your
          history.
        </Text>
        <View style={styles.receipt}>
          <View>
            <Text style={styles.amountLabel}>Amount paid</Text>
            <Text style={styles.amount}>{formatMoney(totalCents)}</Text>
          </View>
          <View style={styles.paid}>
            <Text style={styles.paidText}>● PAID</Text>
          </View>
        </View>
      </View>
      <ActionButton
        label="View all orders"
        variant="dark"
        onPress={() => router.replace("/(tabs)/history")}
      />
      {error === null ? null : (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      <ActionButton
        label="Leave and log out"
        variant="secondary"
        loading={exiting}
        onPress={() => void exit()}
        style={styles.exit}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    paddingHorizontal: 22,
    paddingTop: 18,
    paddingBottom: 20,
    backgroundColor: colors.cream50,
  },
  brand: { flexDirection: "row", alignItems: "center", gap: 10 },
  brandMark: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.forest900,
    alignItems: "center",
    justifyContent: "center",
  },
  brandMarkText: { color: colors.warmWhite, fontSize: 16 },
  brandText: {
    color: colors.forest950,
    fontFamily: displayFont,
    fontSize: 24,
    fontWeight: "600",
  },
  main: { flex: 1, alignItems: "center", justifyContent: "center" },
  successOuter: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: colors.sage100,
    alignItems: "center",
    justifyContent: "center",
  },
  successInner: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.forest900,
    alignItems: "center",
    justifyContent: "center",
  },
  check: { color: colors.warmWhite, fontSize: 30, fontWeight: "700" },
  spark: {
    position: "absolute",
    top: 0,
    right: 4,
    color: colors.clay500,
    fontSize: 18,
  },
  eyebrow: {
    marginTop: 26,
    color: colors.clay500,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  title: {
    marginTop: 10,
    maxWidth: 340,
    color: colors.ink900,
    fontFamily: displayFont,
    fontSize: 38,
    lineHeight: 41,
    fontWeight: "600",
    letterSpacing: -1.3,
    textAlign: "center",
  },
  copy: {
    marginTop: 14,
    maxWidth: 320,
    color: colors.ink500,
    fontSize: 13,
    lineHeight: 20,
    textAlign: "center",
  },
  receipt: {
    marginTop: 22,
    width: "100%",
    maxWidth: 420,
    padding: 15,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 16,
    backgroundColor: colors.warmWhite,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  amountLabel: { color: colors.ink500, fontSize: 10 },
  amount: {
    marginTop: 3,
    color: colors.ink900,
    fontFamily: displayFont,
    fontSize: 24,
    fontWeight: "600",
  },
  paid: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: colors.sky100,
  },
  paidText: { color: colors.sky500, fontSize: 10, fontWeight: "800" },
  error: {
    marginTop: 8,
    color: colors.rose500,
    fontSize: 11,
    textAlign: "center",
  },
  exit: { marginTop: 8 },
});
