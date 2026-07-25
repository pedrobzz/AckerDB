import { skip, useQuery } from "@dbzz/client-react";
import { api } from "@demo/dbzz-codegen/api";
import type { MenuItem } from "@demo/dbzz-codegen/types";
import { Redirect, router } from "expo-router";
import { useMemo, useState } from "react";
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { AppScreen } from "../components/screen";
import { ErrorState, LoadingState } from "../components/states";
import { errorMessage, formatMoney } from "../lib/format";
import { menuImage } from "../lib/menu-images";
import { useCart } from "../providers/cart";
import { useSession } from "../providers/session";
import { colors, displayFont, shadow } from "../theme";

export default function MenuScreen() {
  const { session } = useSession();
  const catalogQuery = useQuery(api.menu.catalog, session === null ? skip : {});
  const cart = useCart();
  const [categoryId, setCategoryId] = useState<bigint | null>(null);

  const catalog =
    catalogQuery.status === "success"
      ? catalogQuery.data
      : catalogQuery.status === "unavailable"
        ? catalogQuery.data
        : undefined;
  const selected = categoryId ?? catalog?.[0]?.id ?? null;
  const items = useMemo(
    () => catalog?.find((category) => category.id === selected)?.items ?? [],
    [catalog, selected],
  );

  if (session === null) return <Redirect href="/login" />;
  if (catalog === undefined && catalogQuery.status === "pending")
    return <LoadingState label="Reading tonight’s menu…" />;
  if (
    catalog === undefined &&
    (catalogQuery.status === "rejected" ||
      catalogQuery.status === "unavailable")
  ) {
    return <ErrorState message={errorMessage(catalogQuery.error)} />;
  }

  const cartAction =
    cart.count > 0 ? (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`View cart, ${cart.count} items, ${formatMoney(cart.totalCents)}`}
        onPress={() => router.navigate("/cart")}
        style={({ pressed }) => [
          styles.cart,
          shadow,
          pressed && styles.pressed,
        ]}
      >
        <View style={styles.cartMark}>
          <Text style={styles.cartMarkText}>◇</Text>
        </View>
        <View style={styles.cartCopy}>
          <Text style={styles.cartTitle}>View your cart</Text>
          <Text style={styles.cartCount}>
            {cart.count} {cart.count === 1 ? "item" : "items"}
          </Text>
        </View>
        <Text style={styles.cartTotal}>{formatMoney(cart.totalCents)}</Text>
        <Text style={styles.cartArrow}>›</Text>
      </Pressable>
    ) : null;

  return (
    <AppScreen
      title="Order something delicious"
      eyebrow="Your table · Menu"
      back
      bottomSafeArea
      contentStyle={styles.content}
      overlay={cartAction}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.categories}
      >
        {catalog?.map((category) => {
          const active = category.id === selected;
          return (
            <Pressable
              key={category.id.toString()}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => setCategoryId(category.id)}
              style={({ pressed }) => [
                styles.category,
                active && styles.categoryActive,
                pressed && styles.pressed,
              ]}
            >
              <Text
                style={[
                  styles.categoryText,
                  active && styles.categoryTextActive,
                ]}
              >
                {category.name}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <View style={styles.items}>
        {items.map((item) => (
          <MenuCard
            key={item.id.toString()}
            item={item}
            onAdd={() => cart.add(item)}
          />
        ))}
      </View>
    </AppScreen>
  );
}

function MenuCard({
  item,
  onAdd,
}: {
  readonly item: MenuItem;
  readonly onAdd: () => void;
}) {
  const source = menuImage(item.image);
  return (
    <View style={styles.card}>
      {source ? (
        <Image
          accessibilityLabel={item.name}
          source={source}
          resizeMode="cover"
          style={styles.image}
        />
      ) : (
        <View style={[styles.image, styles.imageFallback]}>
          <Text style={styles.imageFallbackText}>Savoria</Text>
        </View>
      )}
      <View style={styles.cardBody}>
        <View style={styles.cardHeader}>
          <Text style={styles.itemName}>{item.name}</Text>
          <Text style={styles.price}>{formatMoney(item.priceCents)}</Text>
        </View>
        <Text numberOfLines={3} style={styles.description}>
          {item.description}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Add ${item.name} to cart`}
          hitSlop={6}
          onPress={onAdd}
          style={({ pressed }) => [styles.add, pressed && styles.pressed]}
        >
          <Text style={styles.addText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 110 },
  categories: { gap: 7, paddingBottom: 12 },
  category: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.warmWhite,
    alignItems: "center",
    justifyContent: "center",
  },
  categoryActive: {
    borderColor: colors.forest900,
    backgroundColor: colors.forest900,
  },
  categoryText: { color: colors.ink500, fontSize: 11, fontWeight: "600" },
  categoryTextActive: { color: colors.warmWhite, fontWeight: "800" },
  items: { gap: 10 },
  card: {
    minHeight: 112,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 15,
    backgroundColor: colors.warmWhite,
    overflow: "hidden",
    flexDirection: "row",
  },
  image: { width: 112, minHeight: 112, backgroundColor: colors.cream100 },
  imageFallback: { alignItems: "center", justifyContent: "center" },
  imageFallbackText: { color: colors.ink500, fontFamily: displayFont },
  cardBody: { flex: 1, padding: 13 },
  cardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 8,
  },
  itemName: {
    flex: 1,
    color: colors.ink900,
    fontSize: 13,
    lineHeight: 17,
    fontWeight: "800",
  },
  price: { color: colors.forest900, fontSize: 12, fontWeight: "800" },
  description: {
    marginTop: 6,
    paddingRight: 30,
    color: colors.ink500,
    fontSize: 10,
    lineHeight: 15,
  },
  add: {
    position: "absolute",
    right: 10,
    bottom: 10,
    width: 36,
    height: 36,
    borderRadius: 11,
    backgroundColor: colors.forest900,
    alignItems: "center",
    justifyContent: "center",
  },
  addText: { color: colors.warmWhite, fontSize: 22, lineHeight: 24 },
  cart: {
    position: "absolute",
    left: 20,
    right: 20,
    bottom: 18,
    minHeight: 60,
    paddingHorizontal: 13,
    borderRadius: 16,
    backgroundColor: colors.clay500,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  cartMark: {
    width: 34,
    height: 34,
    borderRadius: 11,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  cartMarkText: { color: colors.warmWhite, fontSize: 18 },
  cartCopy: { flex: 1 },
  cartTitle: { color: colors.warmWhite, fontSize: 12, fontWeight: "800" },
  cartCount: { marginTop: 2, color: "rgba(255,255,255,0.88)", fontSize: 10 },
  cartTotal: {
    color: colors.warmWhite,
    fontFamily: displayFont,
    fontSize: 20,
    fontWeight: "600",
  },
  cartArrow: { color: colors.warmWhite, fontSize: 26 },
  pressed: { opacity: 0.7 },
});
