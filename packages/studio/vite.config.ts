// The Studio SPA build: one prebuilt static bundle, no SSR. `dist/` is
// git-ignored and produced by the release pipeline's build stage
// (scripts/release/studio-dist.ts); the Vite dev server exists only for
// developing Studio inside the monorepo.
//
// `base` is the prefix the launcher serves the shell under, read from the same
// constant the launcher and the router read: emitted asset URLs must resolve
// on the Studio origin, where every path outside that prefix belongs to the
// application.
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { STUDIO_PATH_PREFIX } from "./src/origin.ts";

export default defineConfig({
  root: "src/app",
  base: STUDIO_PATH_PREFIX,
  // Tailwind v4 is a Vite plugin rather than a PostCSS step: the scan that
  // decides which utilities exist reads the module graph the bundler already
  // built, so a class name reaches the stylesheet exactly when the file using
  // it reaches the bundle.
  plugins: [tailwindcss(), react()],
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
});
