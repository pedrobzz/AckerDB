interface SearchContent {
  content: string;
  heading: string | undefined;
}

const codeKeywords = new Set([
  "as",
  "async",
  "await",
  "const",
  "code",
  "default",
  "else",
  "export",
  "false",
  "from",
  "function",
  "if",
  "highlight",
  "import",
  "let",
  "null",
  "return",
  "true",
  "type",
  "undefined",
]);

export function codeIdentifiersFromMarkdown(markdown: string): SearchContent[] {
  const contents: SearchContent[] = [];
  let code: string[] | undefined;
  let heading: string | undefined;

  for (const line of markdown.split("\n")) {
    if (!code) {
      const nextHeading = /^#{2,6}\s+.*\[#([^\]]+)\]\s*$/.exec(line);
      if (nextHeading) heading = nextHeading[1];
      if (/^(?:`{3,}|~{3,})/.test(line)) code = [];
      continue;
    }

    if (/^(?:`{3,}|~{3,})\s*$/.test(line)) {
      const identifiers = new Set(
        code
          .join("\n")
          .match(/[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*/g)
          ?.filter((identifier) => !codeKeywords.has(identifier)) ?? [],
      );
      contents.push(...Array.from(identifiers, (content) => ({ content, heading })));
      code = undefined;
      continue;
    }

    code.push(line);
  }

  return contents;
}
