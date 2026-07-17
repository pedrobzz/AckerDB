import { Platform, type TextStyle } from "react-native";

export const colors = {
  forest950: "#102A24",
  forest900: "#15372F",
  forest800: "#1E4A3E",
  sage500: "#3F6C50",
  sage200: "#DDE8DD",
  sage100: "#ECF2EC",
  cream50: "#FBF8F2",
  cream100: "#F5EFE4",
  warmWhite: "#FFFDFC",
  ink900: "#1D2925",
  ink700: "#40514B",
  ink500: "#596661",
  ink300: "#A7B0AC",
  line: "#E5E8E3",
  clay500: "#AC492C",
  clay100: "#F8E4DC",
  amber500: "#8C5A0D",
  amber100: "#F9ECD6",
  sky500: "#376581",
  sky100: "#DFEBF1",
  rose500: "#A43A41",
  rose100: "#F7E2E2",
} as const;

export const displayFont: TextStyle["fontFamily"] = Platform.select({
  ios: "Iowan Old Style",
  android: "serif",
  default: "serif",
});

export const shadow = Platform.select({
  ios: {
    shadowColor: colors.forest950,
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.16,
    shadowRadius: 24,
  },
  android: { elevation: 8 },
  default: {},
});
