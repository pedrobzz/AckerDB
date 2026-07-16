import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AppProvider } from "../providers/app-provider";
import { colors } from "../theme";

export default function RootLayout() {
  return (
    <AppProvider>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.cream50 },
          animation: "slide_from_right",
        }}
      >
        <Stack.Screen name="index" options={{ animation: "none" }} />
        <Stack.Screen name="login" options={{ animation: "fade" }} />
        <Stack.Screen name="(tabs)" options={{ animation: "fade" }} />
        <Stack.Screen name="menu" />
        <Stack.Screen name="cart" />
        <Stack.Screen name="bill" />
        <Stack.Screen name="success" options={{ animation: "fade" }} />
      </Stack>
    </AppProvider>
  );
}
