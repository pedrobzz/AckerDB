import { Host, TextInput as ExpoTextInput, useNativeState } from "@expo/ui";
import { useEffect, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type KeyboardTypeOptions,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { colors } from "../theme";

export function ActionButton({
  label,
  onPress,
  disabled = false,
  loading = false,
  variant = "primary",
  style,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly variant?: "primary" | "dark" | "danger" | "secondary";
  readonly style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        styles[variant],
        (disabled || loading) && styles.disabled,
        pressed && styles.pressed,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator
          color={variant === "danger" ? colors.rose500 : "white"}
        />
      ) : null}
      <Text
        style={[
          styles.buttonText,
          variant === "danger" && styles.dangerText,
          variant === "secondary" && styles.secondaryText,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function NativeField({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  autoCapitalize = "sentences",
  autoComplete,
  returnKeyType,
  onSubmitEditing,
  multiline = false,
  maxLength,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly placeholder: string;
  readonly keyboardType?: KeyboardTypeOptions;
  readonly autoCapitalize?: "none" | "sentences" | "words" | "characters";
  readonly autoComplete?: "email" | "name" | "off";
  readonly returnKeyType?: "next" | "done";
  readonly onSubmitEditing?: () => void;
  readonly multiline?: boolean;
  readonly maxLength?: number;
}) {
  const height = multiline ? 72 : 48;
  const nativeValue = useNativeState(value);

  useEffect(() => {
    if (nativeValue.value !== value) nativeValue.value = value;
  }, [nativeValue, value]);

  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Host
        style={{ height, width: "100%" }}
        seedColor={colors.forest900}
        colorScheme="light"
      >
        <ExpoTextInput
          value={nativeValue}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.ink300}
          keyboardType={keyboardType}
          autoCapitalize={autoCapitalize}
          autoComplete={autoComplete}
          autoCorrect={keyboardType !== "email-address"}
          returnKeyType={returnKeyType}
          onSubmitEditing={
            onSubmitEditing === undefined ? undefined : onSubmitEditing
          }
          multiline={multiline}
          numberOfLines={multiline ? 3 : undefined}
          maxLength={maxLength}
          style={{
            height,
            width: "100%",
            borderWidth: 1,
            borderColor: colors.line,
            borderRadius: 13,
            backgroundColor: colors.warmWhite,
            paddingHorizontal: 13,
            paddingVertical: multiline ? 10 : 0,
          }}
          textStyle={{ color: colors.ink900, fontSize: 14 }}
        />
      </Host>
    </View>
  );
}

export function InfoBanner({
  children,
  tone = "sage",
}: {
  readonly children: ReactNode;
  readonly tone?: "sage" | "rose" | "cream";
}) {
  return (
    <View
      style={[
        styles.banner,
        tone === "rose"
          ? styles.roseBanner
          : tone === "cream"
            ? styles.creamBanner
            : styles.sageBanner,
      ]}
    >
      <Text style={[styles.bannerMark, tone === "rose" && styles.roseText]}>
        {tone === "rose" ? "×" : "✦"}
      </Text>
      <Text style={[styles.bannerText, tone === "rose" && styles.roseText]}>
        {children}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 48,
    borderRadius: 14,
    paddingHorizontal: 18,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
  },
  primary: { backgroundColor: colors.clay500 },
  dark: { backgroundColor: colors.forest900 },
  danger: { backgroundColor: colors.rose100 },
  secondary: {
    backgroundColor: colors.warmWhite,
    borderWidth: 1,
    borderColor: colors.line,
  },
  buttonText: { color: colors.warmWhite, fontSize: 14, fontWeight: "800" },
  dangerText: { color: colors.rose500 },
  secondaryText: { color: colors.ink700 },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.75, transform: [{ scale: 0.99 }] },
  fieldGroup: { gap: 7 },
  fieldLabel: { color: colors.ink700, fontSize: 12, fontWeight: "700" },
  banner: {
    minHeight: 48,
    padding: 12,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  sageBanner: { backgroundColor: colors.sage100 },
  roseBanner: { backgroundColor: colors.rose100 },
  creamBanner: { backgroundColor: colors.cream100 },
  bannerMark: { color: colors.forest800, fontSize: 16, fontWeight: "800" },
  bannerText: {
    flex: 1,
    color: colors.forest800,
    fontSize: 12,
    lineHeight: 17,
  },
  roseText: { color: colors.rose500 },
});
