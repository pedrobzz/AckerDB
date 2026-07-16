import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { ActionButton } from "./controls";
import { colors, displayFont } from "../theme";

export function LoadingState({
  label = "Setting the table…",
}: {
  readonly label?: string;
}) {
  return (
    <View
      accessibilityLabel={label}
      accessibilityRole="progressbar"
      style={styles.state}
    >
      <ActivityIndicator color={colors.clay500} size="large" />
      <Text style={styles.body}>{label}</Text>
    </View>
  );
}

export function EmptyState({
  title,
  message,
  actionLabel,
  onAction,
}: {
  readonly title: string;
  readonly message: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}) {
  return (
    <View style={styles.state}>
      <Text style={styles.symbol}>◇</Text>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>{message}</Text>
      {actionLabel && onAction ? (
        <ActionButton
          label={actionLabel}
          onPress={onAction}
          style={styles.action}
        />
      ) : null}
    </View>
  );
}

export function ErrorState({
  message,
  actionLabel,
  onAction,
}: {
  readonly message: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}) {
  return (
    <View accessibilityRole="alert" style={styles.state}>
      <Text style={styles.errorSymbol}>!</Text>
      <Text style={styles.title}>We couldn’t load this</Text>
      <Text style={styles.body}>{message}</Text>
      {actionLabel && onAction ? (
        <ActionButton
          label={actionLabel}
          onPress={onAction}
          variant="secondary"
          style={styles.action}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  state: {
    flex: 1,
    minHeight: 280,
    alignItems: "center",
    justifyContent: "center",
    padding: 28,
  },
  symbol: { color: colors.sage500, fontSize: 46 },
  errorSymbol: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.rose100,
    color: colors.rose500,
    fontSize: 30,
    fontWeight: "800",
    textAlign: "center",
    lineHeight: 52,
  },
  title: {
    marginTop: 12,
    color: colors.ink900,
    fontFamily: displayFont,
    fontSize: 24,
    fontWeight: "600",
    textAlign: "center",
  },
  body: {
    marginTop: 8,
    color: colors.ink500,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
  },
  action: { marginTop: 18, alignSelf: "stretch" },
});
