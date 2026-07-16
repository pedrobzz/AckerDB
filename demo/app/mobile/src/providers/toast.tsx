import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  AccessibilityInfo,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, shadow } from "../theme";

interface ToastContextValue {
  readonly show: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const [message, setMessage] = useState<string | null>(null);
  const show = useCallback((next: string) => {
    setMessage(next);
    AccessibilityInfo.announceForAccessibility(next);
  }, []);
  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {message === null ? null : (
        <View
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          style={[styles.toast, shadow, { top: insets.top + 8 }]}
        >
          <View style={styles.toastMark}>
            <Text style={styles.toastMarkText}>↗</Text>
          </View>
          <Text style={styles.toastText}>{message}</Text>
          <Pressable
            accessibilityLabel="Dismiss order update"
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => setMessage(null)}
            style={({ pressed }) => [styles.dismiss, pressed && styles.pressed]}
          >
            <Text style={styles.dismissText}>×</Text>
          </Pressable>
        </View>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (value === null) throw new Error("useToast requires ToastProvider");
  return value;
}

const styles = StyleSheet.create({
  toast: {
    position: "absolute",
    zIndex: 100,
    left: 16,
    right: 16,
    minHeight: 64,
    padding: 12,
    borderRadius: 16,
    backgroundColor: colors.forest950,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  toastMark: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: colors.amber500,
    alignItems: "center",
    justifyContent: "center",
  },
  toastMarkText: { color: colors.warmWhite, fontSize: 18, fontWeight: "800" },
  toastText: {
    flex: 1,
    color: colors.warmWhite,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "700",
  },
  dismiss: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  dismissText: { color: "#AFC6BC", fontSize: 24 },
  pressed: { opacity: 0.7 },
});
