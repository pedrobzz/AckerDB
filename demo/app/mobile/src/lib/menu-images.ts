import type { ImageSourcePropType } from "react-native";

const menuImages: Readonly<Record<string, ImageSourcePropType>> = {
  "menu/charred-tomatoes.png": require("../../assets/menu/charred-tomatoes.png"),
  "menu/rosemary-focaccia.png": require("../../assets/menu/rosemary-focaccia.png"),
  "menu/grilled-sea-bass.png": require("../../assets/menu/grilled-sea-bass.png"),
  "menu/truffle-rigatoni.png": require("../../assets/menu/truffle-rigatoni.png"),
  "menu/pistachio-citrus.png": require("../../assets/menu/pistachio-citrus.png"),
  "menu/blood-orange-spritz.png": require("../../assets/menu/blood-orange-spritz.png"),
};

export function menuImage(path: string): ImageSourcePropType | undefined {
  return menuImages[path];
}
