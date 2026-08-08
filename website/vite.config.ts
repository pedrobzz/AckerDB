import react from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import { fumadocsMdx } from "fumadocs-mdx/vite";
import { nitro } from "nitro/vite";
import { defineConfig, loadEnv } from "vite";
import corePackage from "../packages/core/package.json";
import {
  parseDocumentationPublicationPlan,
  publicationEntryPaths,
  publicationOwnsPath,
} from "./src/lib/documentation/plan";

export default defineConfig(({ mode }) => {
  const plan = parseDocumentationPublicationPlan(
    loadEnv(mode, process.cwd(), ""),
    corePackage.version,
  );

  return {
    plugins: [
      fumadocsMdx(),
      tailwindcss(),
      tanstackStart({
        prerender: {
          enabled: true,
          filter: (page) => publicationOwnsPath(plan, page.path),
        },
        spa: {
          enabled: true,
          maskPath: "/404",
          prerender: {
            enabled: true,
            crawlLinks: true,
            outputPath: "/404",
          },
        },
        pages: publicationEntryPaths(plan).map((path) => ({ path })),
      }),
      react(),
      nitro({
        noExternals: ["tslib"],
        output: process.env.DOCS_BUILD_OUTPUT_DIR
          ? { dir: process.env.DOCS_BUILD_OUTPUT_DIR }
          : undefined,
      }),
    ],
    resolve: {
      tsconfigPaths: true,
      alias: {
        tslib: "tslib/tslib.es6.js",
        "tslib/modules/index.js": "tslib/tslib.es6.js",
      },
    },
  };
});
