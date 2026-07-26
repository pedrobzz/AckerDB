import { useProcedure } from "@ackerdb/client-react";
import { api } from "@demo/ackerdb-codegen/api";
import { router } from "expo-router";
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ActionButton, NativeField } from "../components/controls";
import { errorMessage } from "../lib/format";
import { useSession } from "../providers/session";
import { colors, displayFont } from "../theme";

export default function LoginScreen() {
  const login = useProcedure(api.auth.login);
  const { establish } = useSession();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (name.trim().length < 2 || !email.includes("@")) {
      setError("Enter your name and a valid email address.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await login({ name, email });
      if (!result.ok) {
        setError(errorMessage(result.error));
        return;
      }
      await establish(result.data);
      router.replace("/");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.hero}>
            <View style={styles.orbitLarge} />
            <View style={styles.orbitSmall} />
            <View style={styles.brand}>
              <View style={styles.brandMark}>
                <Text style={styles.brandMarkText}>✦</Text>
              </View>
              <Text style={styles.brandText}>Savoria</Text>
            </View>
            <View style={styles.heroCopy}>
              <Text style={styles.eyebrow}>Welcome to your table</Text>
              <Text style={styles.headline}>
                A memorable evening starts here.
              </Text>
              <Text style={styles.description}>
                Sign in with your name and email to choose a table, order, and
                follow every plate to your seat.
              </Text>
            </View>
          </View>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Let’s get you seated</Text>
            <Text style={styles.sheetCopy}>
              No password needed. We’ll remember your order history.
            </Text>
            <View style={styles.fields}>
              <NativeField
                label="Your name"
                value={name}
                onChangeText={setName}
                placeholder="Enter your name"
                autoCapitalize="words"
                autoComplete="name"
                returnKeyType="next"
              />
              <NativeField
                label="Email address"
                value={email}
                onChangeText={setEmail}
                placeholder="Enter your email address"
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                returnKeyType="done"
                onSubmitEditing={() => void submit()}
              />
            </View>
            {error === null ? null : (
              <Text accessibilityRole="alert" style={styles.error}>
                {error}
              </Text>
            )}
            <ActionButton
              label="Find a table  →"
              onPress={() => void submit()}
              loading={submitting}
              style={styles.submit}
            />
            <Text style={styles.terms}>
              By continuing, you agree to receive live updates about your order.
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.forest950 },
  flex: { flex: 1 },
  scroll: { flexGrow: 1, justifyContent: "space-between" },
  hero: {
    minHeight: 410,
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 36,
    overflow: "hidden",
  },
  orbitLarge: {
    position: "absolute",
    width: 320,
    height: 320,
    borderRadius: 160,
    top: -170,
    right: -120,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  orbitSmall: {
    position: "absolute",
    width: 210,
    height: 210,
    borderRadius: 105,
    top: -110,
    right: -58,
    backgroundColor: "rgba(134,167,137,0.10)",
  },
  brand: { flexDirection: "row", alignItems: "center", gap: 11 },
  brandMark: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.warmWhite,
    alignItems: "center",
    justifyContent: "center",
  },
  brandMarkText: { color: colors.forest900, fontSize: 19, fontWeight: "800" },
  brandText: {
    color: colors.warmWhite,
    fontFamily: displayFont,
    fontSize: 28,
    fontWeight: "600",
  },
  heroCopy: { marginTop: 64, maxWidth: 340 },
  eyebrow: {
    color: "#AFC6BC",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.6,
    textTransform: "uppercase",
  },
  headline: {
    marginTop: 12,
    color: colors.warmWhite,
    fontFamily: displayFont,
    fontSize: 43,
    lineHeight: 45,
    fontWeight: "600",
    letterSpacing: -1.7,
  },
  description: {
    marginTop: 16,
    maxWidth: 320,
    color: "#AFC6BC",
    fontSize: 13,
    lineHeight: 20,
  },
  sheet: {
    width: "100%",
    maxWidth: 560,
    alignSelf: "center",
    paddingHorizontal: 22,
    paddingTop: 24,
    paddingBottom: 20,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: colors.cream50,
  },
  sheetTitle: {
    color: colors.ink900,
    fontFamily: displayFont,
    fontSize: 27,
    fontWeight: "600",
  },
  sheetCopy: { marginTop: 5, color: colors.ink500, fontSize: 11 },
  fields: { marginTop: 18, gap: 13 },
  error: { marginTop: 12, color: colors.rose500, fontSize: 12, lineHeight: 17 },
  submit: { marginTop: 18 },
  terms: {
    marginTop: 12,
    color: colors.ink500,
    fontSize: 10,
    lineHeight: 15,
    textAlign: "center",
  },
});
