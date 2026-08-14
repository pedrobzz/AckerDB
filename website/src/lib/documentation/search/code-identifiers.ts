interface SearchContent {
  content: string;
  heading: string | undefined;
}

const ackerdbPathRoots = new Set(["api", "client", "ctx", "events", "tx", "v"]);

function localImportName(specifier: string): string | undefined {
  const normalized = specifier.trim().replace(/^type\s+/, "");
  if (!normalized) return undefined;

  const alias = /\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(normalized);
  return alias?.[1] ?? /^[A-Za-z_$][A-Za-z0-9_$]*$/.exec(normalized)?.[0];
}

function importedIdentifiers(code: string): string[] {
  const identifiers: string[] = [];
  const imports = code.matchAll(
    /^\s*import\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["'];?/gm,
  );

  for (const [, clause, source] of imports) {
    if (source.startsWith(".")) continue;

    const named = /\{([\s\S]*?)\}/.exec(clause)?.[1];
    if (named) {
      for (const specifier of named.split(",")) {
        const identifier = localImportName(specifier);
        if (identifier && identifier.length > 1) identifiers.push(identifier);
      }
    }

    const withoutNamed = clause.replace(/\{[\s\S]*?\}/, "").replace(/,$/, "").trim();
    const namespace = /^\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(withoutNamed)?.[1];
    const defaultImport = localImportName(withoutNamed);
    if (namespace) identifiers.push(namespace);
    else if (defaultImport && defaultImport.length > 1) identifiers.push(defaultImport);
  }

  return identifiers;
}

function ackerdbCapabilityPaths(code: string): string[] {
  return (
    code.match(/[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+/g) ?? []
  ).filter((path) => ackerdbPathRoots.has(path.split(".", 1)[0]));
}

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
      const identifiers = new Set([
        ...importedIdentifiers(code.join("\n")),
        ...ackerdbCapabilityPaths(code.join("\n")),
      ]);
      contents.push(...Array.from(identifiers, (content) => ({ content, heading })));
      code = undefined;
      continue;
    }

    code.push(line);
  }

  return contents;
}
