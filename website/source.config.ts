import { defineConfig } from "fumadocs-mdx/config";
import { readFileSync } from "node:fs";
import corePackage from "../packages/core/package.json";
import {
  documentationPackageVersion,
  parseDocumentationPublicationPlan,
} from "./src/lib/documentation/plan";

interface SyntaxNode {
  children?: SyntaxNode[];
  value?: unknown;
}

const publicationPlan = parseDocumentationPublicationPlan(
  process.env,
  corePackage.version,
);
const releaseValues: Record<string, string> = {
  "%ACKERDB_PACKAGE_VERSION%": documentationPackageVersion(publicationPlan),
  "%BUN_VERSION%": readFileSync(new URL("../.bun-version", import.meta.url), "utf8").trim(),
};

function replaceReleaseValues() {
  return (tree: SyntaxNode) => {
    const visit = (node: SyntaxNode) => {
      if (typeof node.value === "string") {
        let value = node.value;
        for (const [token, replacement] of Object.entries(releaseValues)) {
          value = value.replaceAll(token, replacement);
        }
        node.value = value;
      }
      node.children?.forEach(visit);
    };

    visit(tree);
  };
}

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [replaceReleaseValues],
    rehypeCodeOptions: {
      addLanguageClass: true,
      themes: {
        light: "github-light",
        dark: "github-dark",
      },
    },
  },
});
