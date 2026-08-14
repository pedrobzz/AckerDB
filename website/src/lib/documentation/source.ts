import { loader } from "fumadocs-core/source";
import { defineDocs } from "fumadocs-mdx/macro";
import type { DocumentationIdentity } from "./identity";
import {
  documentationUrl,
  versionedDocumentationMarkdown,
} from "./identity";
import { documentationIconsPlugin } from "./icons";

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    async: true,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

export const source = loader({
  source: docs.toFumadocsSource(),
  baseUrl: "/docs",
  plugins: [documentationIconsPlugin],
});

export async function getMarkdown(
  page: (typeof source)["$inferPage"],
  identity: DocumentationIdentity,
): Promise<string> {
  const processed = await page.data.getText("processed");
  const url = documentationUrl(identity, page.slugs);

  return versionedDocumentationMarkdown(`# ${page.data.title}

Source: ${url}

${processed}`, identity);
}
