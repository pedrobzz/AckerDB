import type { ItemStatus, OrderStatus } from "@demo/dbzz-codegen/types";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";

const tones = {
  ORDERED: [colors.forest800, colors.sage100],
  OPEN: [colors.forest800, colors.sage100],
  PREPARING: [colors.amber500, colors.amber100],
  PREPARED: [colors.sky500, colors.sky100],
  SERVED: [colors.forest800, colors.sage100],
  PAID: [colors.sky500, colors.sky100],
  CANCELLED: [colors.rose500, colors.rose100],
} satisfies Record<ItemStatus | OrderStatus, readonly [string, string]>;

export function StatusPill({
  status,
}: {
  readonly status: ItemStatus | OrderStatus;
}) {
  const [foreground, background] = tones[status];
  return (
    <View
      accessibilityLabel={`Status: ${status.toLowerCase()}`}
      style={[styles.pill, { backgroundColor: background }]}
    >
      <View style={[styles.dot, { backgroundColor: foreground }]} />
      <Text style={[styles.label, { color: foreground }]}>{status}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 999,
  },
  dot: { width: 6, height: 6, borderRadius: 999 },
  label: { fontSize: 9, fontWeight: "800", letterSpacing: 0.5 },
});
