import { createSearchAPI } from "fumadocs-core/search/server";
import type { DocumentationIdentity } from "../identity";
import { documentationUrl } from "../identity";
import { source } from "../source";
import { codeIdentifiersFromMarkdown } from "./code-identifiers";

export function searchApiFor(identity: DocumentationIdentity) {
  return createSearchAPI("advanced", {
    language: "english",
    indexes: async () =>
      Promise.all(
        source.getPages().map(async (page) => {
          const [structuredData, markdown] = await Promise.all([
            page.data.structuredData(),
            page.data.getText("processed"),
          ]);

          return {
            id: `${identity.kind}:${page.path}`,
            title: page.data.title,
            description: page.data.description,
            url: documentationUrl(identity, page.slugs),
            structuredData: {
              ...structuredData,
              contents: [
                ...structuredData.contents,
                ...codeIdentifiersFromMarkdown(markdown),
              ],
            },
          };
        }),
      ),
  });
}
