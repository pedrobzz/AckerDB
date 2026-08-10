import defaultMdxComponents from "fumadocs-ui/mdx";
import { CodeBlock, Pre } from "fumadocs-ui/components/codeblock";
import { TriangleAlert } from "lucide-react";
import type { MDXComponents } from "mdx/types";
import {
  Children,
  isValidElement,
  type AnchorHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import type { DocumentationIdentity } from "@/lib/documentation/identity";
import { versionedDocumentationHref } from "@/lib/documentation/identity";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

const languageLabels: Record<string, string> = {
  bash: "Shell",
  json: "JSON",
  shell: "Shell",
  sh: "Shell",
  text: "Text",
  ts: "TypeScript",
  tsx: "TSX",
  typescript: "TypeScript",
};

function codeLanguage(children: ReactNode): string {
  for (const child of Children.toArray(children)) {
    if (!isValidElement<{ className?: string }>(child)) continue;
    const language = child.props.className?.match(/(?:^|\s)language-([^\s]+)/)?.[1];
    if (language) return language;
  }
  return "text";
}

function DocumentationCodeBlock({
  children,
  title,
  ...props
}: HTMLAttributes<HTMLPreElement>) {
  const language = codeLanguage(children);
  const languageLabel = languageLabels[language] ?? language.toUpperCase();
  const regionLabel = title ? `${title} — ${languageLabel} code` : `${languageLabel} code`;

  return (
    <CodeBlock
      {...props}
      Actions={({ children: actions, className }) => (
        <div
          className={cn(
            "flex items-center gap-2 text-[10px] uppercase tracking-[0.1em]",
            className,
          )}
        >
          <span>{languageLabel}</span>
          {actions}
        </div>
      )}
      title={title}
      viewportProps={{ "aria-label": regionLabel }}
    >
      <Pre>{children}</Pre>
    </CodeBlock>
  );
}

function DocumentationWarning({
  children,
  title = "Warning",
  ...props
}: HTMLAttributes<HTMLDivElement> & { title?: ReactNode }) {
  return (
    <Alert
      {...props}
      className={cn(
        "border-l-amber-500 bg-amber-500/10 text-amber-950 dark:text-amber-100",
        props.className,
      )}
    >
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="text-amber-900/80 dark:text-amber-100/80">
        {children}
      </AlertDescription>
    </Alert>
  );
}

function versionedLink(identity: DocumentationIdentity) {
  const Link = defaultMdxComponents.a;

  return function VersionedDocumentationLink({
    href = "",
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement>) {
    return <Link href={versionedDocumentationHref(href, identity)} {...props} />;
  };
}

export function getMdxComponents(
  components?: MDXComponents,
  identity?: DocumentationIdentity,
): MDXComponents {
  return {
    ...defaultMdxComponents,
    pre: DocumentationCodeBlock,
    Warning: DocumentationWarning,
    ...(identity ? { a: versionedLink(identity) } : {}),
    ...components,
  };
}

export const useMDXComponents = getMdxComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMdxComponents>;
}
