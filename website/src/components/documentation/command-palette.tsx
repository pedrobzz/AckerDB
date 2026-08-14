"use client";

import { useNavigate } from "@tanstack/react-router";
import type { TableOfContents } from "fumadocs-core/toc";
import { useDocsSearch } from "fumadocs-core/search/client";
import { staticClient } from "fumadocs-core/search/client/orama-static";
import { useTheme } from "fumadocs-ui/provider/base";
import {
  BookOpen,
  Check,
  Clipboard,
  ExternalLink,
  FileText,
  GitBranch,
  LoaderCircle,
  MoonStar,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import type {
  DocumentationIdentity,
  DocumentationVersionCatalog,
} from "@/lib/documentation/identity";
import { useVersionNavigation } from "./version-navigation";

const searchCandidateLimit = 200;

interface DocumentationCommandPaletteProps {
  catalog: DocumentationVersionCatalog;
  currentAncestry: string[];
  currentIdentity: DocumentationIdentity;
  currentUrl: string;
  githubUrl: string;
  markdownUrl: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  toc: TableOfContents;
}

function versionId(identity: DocumentationIdentity): string {
  return identity.kind === "stable" ? identity.version : identity.kind;
}

function plainSearchText(value: string): string {
  return value.replaceAll(/<\/?mark>/g, "");
}

interface SearchResult {
  breadcrumbs?: string[];
  content: string;
  id: string;
  type: "heading" | "page" | "text";
  url: string;
}

function searchResultValue(result: SearchResult): string {
  return result.id;
}

function titleCase(value: string): string {
  return decodeURIComponent(value)
    .replaceAll(/[-_]+/g, " ")
    .replace(/\b[a-z]/g, (character) => character.toUpperCase());
}

function searchResultLocation(result: SearchResult): string {
  if (result.breadcrumbs && result.breadcrumbs.length > 0) {
    return result.breadcrumbs.join(" · ");
  }

  const [pathname, fragment] = result.url.split("#", 2);
  const page = pathname.split("/").filter(Boolean).at(-1);
  const location = page ? titleCase(page) : "Documentation";

  return fragment ? `${location} · ${titleCase(fragment)}` : location;
}

function uniqueResults(results: SearchResult[]): SearchResult[] {
  const urls = new Set<string>();

  return results.filter((result) => {
    if (urls.has(result.url)) return false;
    urls.add(result.url);
    return true;
  });
}

function normalizedSearchText(value: string): string {
  return plainSearchText(value).toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function searchMatchScore(result: SearchResult, search: string): number {
  const content = normalizedSearchText(result.content);
  const query = normalizedSearchText(search);
  if (!query) return 0;
  if (content === query) return 4;
  if (content.includes(query)) return 3;

  const terms = new Set(query.split(" ").filter(Boolean));
  return Array.from(terms).filter((term) => content.includes(term)).length / terms.size;
}

function orderResults(results: SearchResult[], search: string): SearchResult[] {
  return [...results].sort(
    (left, right) => searchMatchScore(right, search) - searchMatchScore(left, search),
  );
}

export function DocumentationCommandPalette({
  catalog,
  currentAncestry,
  currentIdentity,
  currentUrl,
  githubUrl,
  markdownUrl,
  onOpenChange,
  open,
  toc,
}: DocumentationCommandPaletteProps) {
  const navigate = useNavigate();
  const { resolvedTheme, setTheme } = useTheme();
  const navigation = useVersionNavigation(currentIdentity, catalog, currentAncestry);
  const client = useMemo(
    () =>
      staticClient({
        from: `/api/search/${versionId(currentIdentity)}`,
        search: { limit: searchCandidateLimit },
      }),
    [currentIdentity],
  );
  const { query, search, setSearch } = useDocsSearch({ client, delayMs: 60 });
  const results = query.data === "empty" || query.data === undefined ? [] : query.data;
  const displayedResults = useMemo(
    () => uniqueResults(orderResults(results, search)),
    [results, search],
  );
  const [selectedSearchResult, setSelectedSearchResult] = useState("");

  useEffect(() => {
    if (!open) setSearch("");
  }, [open, setSearch]);

  useEffect(() => {
    if (!search || displayedResults.length === 0) return;
    setSelectedSearchResult(searchResultValue(displayedResults[0]));
  }, [displayedResults, search]);

  const go = (url: string) => {
    onOpenChange(false);
    void navigate({ href: url });
  };

  const copyMarkdown = async () => {
    const response = await fetch(markdownUrl);
    if (!response.ok) throw new Error(`Markdown returned ${response.status}`);
    await navigator.clipboard.writeText(await response.text());
    onOpenChange(false);
  };

  return (
    <CommandDialog
      description="Search AckerDB documentation and run site commands."
      onOpenChange={onOpenChange}
      open={open}
      title="Command Palette"
    >
      <Command
        onValueChange={setSelectedSearchResult}
        shouldFilter={false}
        value={search ? selectedSearchResult : undefined}
      >
        <CommandInput
          aria-label="Search documentation and commands"
          onValueChange={setSearch}
          placeholder="Search documentation or run a command…"
          value={search}
        />
        <CommandList>
          {query.isLoading && (
            <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
              <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
              Searching documentation
            </div>
          )}

          {search && !query.isLoading && results.length === 0 && (
            <CommandEmpty>No documentation found.</CommandEmpty>
          )}

          {displayedResults.length > 0 && (
            <CommandGroup heading="Documentation">
              {displayedResults.slice(0, 12).map((result) => {
                const content = plainSearchText(result.content);
                const location = searchResultLocation(result);

                return (
                  <CommandItem
                    key={result.id}
                    onSelect={() => go(result.url)}
                    value={searchResultValue(result)}
                  >
                    <Search aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{content}</span>
                      {location !== content && (
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {location}
                        </span>
                      )}
                    </span>
                    <span className="text-[10px] uppercase text-muted-foreground">{result.type}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}

          {!search && toc.length > 0 && (
            <CommandGroup heading="On this page">
              {toc.map((item) => (
                <CommandItem
                  key={item.url}
                  onSelect={() => go(`${currentUrl}${item.url}`)}
                  value={`heading:${String(item.title)}`}
                >
                  <BookOpen aria-hidden="true" />
                  <span>{item.title}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          <CommandSeparator />
          <CommandGroup heading="Commands">
            <CommandItem
              onSelect={() => {
                setTheme(resolvedTheme === "dark" ? "light" : "dark");
                onOpenChange(false);
              }}
              value="toggle site theme light dark appearance"
            >
              <MoonStar aria-hidden="true" />
              <span>Toggle site theme</span>
              <CommandShortcut>Theme</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={() => void copyMarkdown()} value="copy page markdown">
              <Clipboard aria-hidden="true" />
              <span>Copy page Markdown</span>
              <CommandShortcut>MD</CommandShortcut>
            </CommandItem>
            <CommandItem
              onSelect={() => {
                onOpenChange(false);
                window.open(githubUrl, "_blank", "noopener,noreferrer");
              }}
              value="edit open github"
            >
              <ExternalLink aria-hidden="true" />
              <span>Edit on GitHub</span>
            </CommandItem>
            {navigation.versions.map((identity) => {
              const key = identity.kind === "stable" ? identity.version : identity.kind;
              const current = key === navigation.currentKey;
              return (
                <CommandItem
                  disabled={current || navigation.switchingTo !== undefined}
                  key={key}
                  onSelect={() => {
                    onOpenChange(false);
                    void navigation.switchVersion(identity);
                  }}
                  value={`documentation version ${identity.label}`}
                >
                  <GitBranch aria-hidden="true" />
                  <span>Open {identity.label}</span>
                  {current && <Check aria-hidden="true" className="ml-auto" />}
                </CommandItem>
              );
            })}
            <CommandItem
              onSelect={() => {
                onOpenChange(false);
                window.location.assign(markdownUrl);
              }}
              value="view page markdown raw"
            >
              <FileText aria-hidden="true" />
              <span>View page as Markdown</span>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
