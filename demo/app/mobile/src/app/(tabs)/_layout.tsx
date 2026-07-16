import { NativeTabs } from "expo-router/unstable-native-tabs";
import { colors } from "../../theme";

export default function TabLayout() {
  return (
    <NativeTabs
      backgroundColor={colors.warmWhite}
      tintColor={colors.forest900}
      iconColor={{ default: colors.ink500, selected: colors.forest900 }}
      labelStyle={{
        default: { color: colors.ink500, fontSize: 11 },
        selected: { color: colors.forest900, fontSize: 11, fontWeight: "700" },
      }}
      disableTransparentOnScrollEdge
    >
      <NativeTabs.Trigger name="tables" accessibilityLabel="Tables">
        <NativeTabs.Trigger.Icon
          sf={{ default: "tablecells", selected: "tablecells.fill" }}
          md="table_restaurant"
        />
        <NativeTabs.Trigger.Label>Tables</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="order" accessibilityLabel="Active order">
        <NativeTabs.Trigger.Icon
          sf={{
            default: "list.bullet.clipboard",
            selected: "list.bullet.clipboard.fill",
          }}
          md="receipt_long"
        />
        <NativeTabs.Trigger.Label>Order</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="history" accessibilityLabel="Order history">
        <NativeTabs.Trigger.Icon sf="clock.arrow.circlepath" md="history" />
        <NativeTabs.Trigger.Label>History</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="profile" accessibilityLabel="Guest profile">
        <NativeTabs.Trigger.Icon
          sf={{ default: "person", selected: "person.fill" }}
          md="person"
        />
        <NativeTabs.Trigger.Label>Profile</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
