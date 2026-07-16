import { skip, useQuery } from "@dbzz/client-react";
import { api } from "@demo/dbzz-codegen/api";
import { Redirect, router } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { ActionButton, InfoBanner } from "../../components/controls";
import { AppScreen } from "../../components/screen";
import { ErrorState, LoadingState } from "../../components/states";
import { errorMessage, formatOrder, initials } from "../../lib/format";
import { useSession } from "../../providers/session";
import { colors, displayFont } from "../../theme";

export default function ProfileScreen() {
  const sessionState = useSession();
  const profileQuery = useQuery(
    api.users.current,
    sessionState.session === null ? skip : {},
  );
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (sessionState.session === null) return <Redirect href="/login" />;
  const profile =
    profileQuery.status === "success"
      ? profileQuery.data
      : profileQuery.status === "error"
        ? profileQuery.staleData
        : undefined;
  if (profile === undefined && profileQuery.status === "pending")
    return <LoadingState label="Loading your profile…" />;
  if (profile === undefined && profileQuery.status === "error")
    return <ErrorState message={profileQuery.error.message} />;
  if (profile === undefined)
    return <LoadingState label="Loading your profile…" />;
  if (profile === null)
    return <ErrorState message="Your guest profile is not available." />;

  const logout = async () => {
    setLoggingOut(true);
    setError(null);
    try {
      await sessionState.clear();
      router.replace("/login");
    } catch (caught) {
      setError(errorMessage(caught));
      setLoggingOut(false);
    }
  };

  return (
    <AppScreen title="Your profile" eyebrow="Savoria guest" name={profile.name}>
      <View style={styles.profileCard}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials(profile.name)}</Text>
        </View>
        <Text style={styles.name}>{profile.name}</Text>
        <Text style={styles.email}>{profile.email}</Text>
      </View>
      {profile.activeOrder ? (
        <InfoBanner>
          Your live order {formatOrder(profile.activeOrder.id)} remains attached
          to Table {profile.activeOrder.table.number} if you log out.
        </InfoBanner>
      ) : (
        <InfoBanner tone="cream">
          You don’t have an active table right now.
        </InfoBanner>
      )}
      <View style={styles.about}>
        <Text style={styles.aboutTitle}>Passwordless demo account</Text>
        <Text style={styles.aboutText}>
          Your bearer credential is stored in the device’s secure native
          storage. Order history stays linked to this email.
        </Text>
      </View>
      {error === null ? null : (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      <ActionButton
        label="Leave and log out"
        variant="secondary"
        loading={loggingOut}
        onPress={() => void logout()}
        style={styles.logout}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  profileCard: {
    marginBottom: 14,
    padding: 22,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 18,
    backgroundColor: colors.warmWhite,
    alignItems: "center",
  },
  avatar: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: colors.sage200,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    color: colors.forest900,
    fontFamily: displayFont,
    fontSize: 25,
    fontWeight: "600",
  },
  name: {
    marginTop: 13,
    color: colors.ink900,
    fontFamily: displayFont,
    fontSize: 27,
    fontWeight: "600",
  },
  email: { marginTop: 4, color: colors.ink500, fontSize: 12 },
  about: {
    marginTop: 14,
    padding: 16,
    borderRadius: 15,
    backgroundColor: colors.cream100,
  },
  aboutTitle: { color: colors.ink900, fontSize: 13, fontWeight: "800" },
  aboutText: {
    marginTop: 6,
    color: colors.ink500,
    fontSize: 12,
    lineHeight: 18,
  },
  error: { marginTop: 12, color: colors.rose500, fontSize: 12 },
  logout: { marginTop: 18 },
});
