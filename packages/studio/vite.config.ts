// The Studio SPA build: a prebuilt static bundle, no SSR. `dist/` is
// git-ignored and produced at release time (scripts/release/studio-dist.ts);
// the Vite dev server exists only for developing Studio inside the monorepo.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "app",
  plugins: [react()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
