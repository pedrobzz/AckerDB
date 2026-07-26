import { useConnectionState } from "@ackerdb/client-react";
import { router } from "expo-router";
import type { ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, displayFont } from "../theme";
import { initials } from "../lib/format";

export function AppScreen({
  title,
  eyebrow,
  name,
  back = false,
  children,
  contentStyle,
  keyboard = false,
  bottomSafeArea = false,
  overlay,
}: {
  readonly title: string;
  readonly eyebrow: string;
  readonly name?: string;
  readonly back?: boolean;
  readonly children: ReactNode;
  readonly contentStyle?: StyleProp<ViewStyle>;
  readonly keyboard?: boolean;
  readonly bottomSafeArea?: boolean;
  readonly overlay?: ReactNode;
}) {
  const connection = useConnectionState();
  const body = (
    <ScrollView
      automaticallyAdjustContentInsets
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[styles.content, contentStyle]}
    >
      {connection.phase !== "ready" && connection.phase !== "connecting" ? (
        <View accessibilityLiveRegion="polite" style={styles.connection}>
          <Text style={styles.connectionText}>
            {connection.phase === "suspended"
              ? "Live updates pause while Savoria is in the background."
              : connection.phase === "authentication-blocked"
                ? connection.error.message
                : connection.phase === "terminal-error"
                  ? connection.error.message
                  : "Reconnecting to live service…"}
          </Text>
        </View>
      ) : null}
      {children}
    </ScrollView>
  );

  return (
    <SafeAreaView
      edges={
        bottomSafeArea
          ? ["top", "bottom", "left", "right"]
          : ["top", "left", "right"]
      }
      style={styles.safe}
    >
      <View style={styles.header}>
        {back ? (
          <Pressable
            accessibilityLabel="Go back"
            accessibilityRole="button"
            hitSlop={6}
            onPress={() => router.back()}
            style={({ pressed }) => [styles.back, pressed && styles.pressed]}
          >
            <Text style={styles.backText}>‹</Text>
          </Pressable>
        ) : null}
        <View style={styles.heading}>
          <Text style={styles.eyebrow}>{eyebrow}</Text>
          <Text style={styles.title}>{title}</Text>
        </View>
        {!back && name ? (
          <View
            accessibilityLabel={`Signed in as ${name}`}
            style={styles.avatar}
          >
            <Text style={styles.avatarText}>{initials(name)}</Text>
          </View>
        ) : null}
      </View>
      {keyboard ? (
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.flex}
        >
          {body}
        </KeyboardAvoidingView>
      ) : (
        body
      )}
      {overlay}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.cream50 },
  flex: { flex: 1 },
  header: {
    width: "100%",
    maxWidth: 560,
    alignSelf: "center",
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  heading: { flex: 1 },
  eyebrow: {
    color: colors.clay500,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.3,
    textTransform: "uppercase",
  },
  title: {
    marginTop: 4,
    color: colors.ink900,
    fontFamily: displayFont,
    fontSize: 27,
    lineHeight: 30,
    fontWeight: "600",
    letterSpacing: -0.8,
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.sage200,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: colors.forest900, fontSize: 12, fontWeight: "800" },
  back: {
    width: 44,
    height: 44,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.warmWhite,
    alignItems: "center",
    justifyContent: "center",
  },
  backText: { color: colors.ink900, fontSize: 32, lineHeight: 34 },
  content: {
    width: "100%",
    maxWidth: 560,
    alignSelf: "center",
    flexGrow: 1,
    paddingHorizontal: 20,
    paddingBottom: 28,
  },
  connection: {
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 12,
    backgroundColor: colors.amber100,
  },
  connectionText: {
    color: colors.amber500,
    fontSize: 11,
    lineHeight: 16,
    fontWeight: "700",
  },
  pressed: { opacity: 0.65 },
});
