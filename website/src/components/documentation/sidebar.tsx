"use client";

import { Link } from "@tanstack/react-router";
import type * as PageTree from "fumadocs-core/page-tree";
import { useTheme } from "fumadocs-ui/provider/base";
import {
  Folder,
  Moon,
  Search,
  Sun,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import type {
  DocumentationIdentity,
  DocumentationVersionCatalog,
} from "@/lib/documentation/identity";
import { cn } from "@/lib/utils";
import { VersionSelector } from "./version-selector";

export type SidebarExpansionMode = "single" | "multiple";

interface DocumentationSidebarProps {
  catalog: DocumentationVersionCatalog;
  currentAncestry: string[];
  currentIdentity: DocumentationIdentity;
  currentUrl: string;
  expansionMode?: SidebarExpansionMode;
  onNavigate?: () => void;
  onOpenSearch: () => void;
  tree: PageTree.Root;
}

function nodeContainsUrl(node: PageTree.Node, currentUrl: string): boolean {
  if (node.type === "page") return node.url === currentUrl;
  if (node.type !== "folder") return false;
  return (
    node.index?.url === currentUrl ||
    node.children.some((child) => nodeContainsUrl(child, currentUrl))
  );
}

function folderValue(folder: PageTree.Folder, index: number): string {
  if (folder.$id) return folder.$id;
  return `${index}:${String(folder.name)}`;
}

function folderPages(folder: PageTree.Folder): PageTree.Node[] {
  if (!folder.index || folder.children.some((node) => node.type === "page" && node.url === folder.index?.url)) {
    return folder.children;
  }
  return [folder.index, ...folder.children];
}

function SidebarNode({
  currentUrl,
  node,
  onNavigate,
}: {
  currentUrl: string;
  node: PageTree.Node;
  onNavigate?: () => void;
}) {
  if (node.type === "separator") {
    return (
      <div className="mt-3 flex items-center gap-3 px-4 pb-1 first:mt-1">
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/75">
          {node.name}
        </span>
        <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
      </div>
    );
  }

  if (node.type === "folder") {
    if (node.index) {
      const active = nodeContainsUrl(node, currentUrl);
      return (
        <div className="mt-1">
          <SidebarNode
            currentUrl={currentUrl}
            node={node.index}
            onNavigate={onNavigate}
          />
          {active && node.children.length > 0 && (
            <div className="ml-5 border-l border-border/70">
              {node.children.map((child, index) => (
                <SidebarNode
                  key={child.$id ?? `${child.type}:${index}`}
                  currentUrl={currentUrl}
                  node={child}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="mt-3">
        <div className="px-4 pb-1 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/75">
          {node.name}
        </div>
        {folderPages(node).map((child, index) => (
          <SidebarNode
            key={child.$id ?? `${child.type}:${index}`}
            currentUrl={currentUrl}
            node={child}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    );
  }

  const active = node.url === currentUrl;
  return (
    <Link
      activeOptions={{ exact: true }}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group mx-2 flex min-h-8 items-center gap-2 border-l-2 px-3 py-1.5 text-[13px] leading-5 text-muted-foreground outline-none transition-colors duration-150 hover:border-border hover:bg-muted/35 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50",
        active && "border-foreground bg-muted/55 font-medium text-foreground",
      )}
      onClick={onNavigate}
      preload="intent"
      to={node.url}
    >
      {node.icon ?? <span aria-hidden="true" className="size-3.5" />}
      <span>{node.name}</span>
    </Link>
  );
}

export function DocumentationSidebar({
  catalog,
  currentAncestry,
  currentIdentity,
  currentUrl,
  expansionMode = "single",
  onNavigate,
  onOpenSearch,
  tree,
}: DocumentationSidebarProps) {
  const folders = useMemo(
    () => tree.children.filter((node): node is PageTree.Folder => node.type === "folder"),
    [tree],
  );
  const activeFolder = useMemo(() => {
    const index = folders.findIndex((folder) => nodeContainsUrl(folder, currentUrl));
    return index === -1 ? undefined : folderValue(folders[index], index);
  }, [currentUrl, folders]);
  const [expanded, setExpanded] = useState<string[]>(activeFolder ? [activeFolder] : []);
  const { resolvedTheme, setTheme } = useTheme();

  useEffect(() => {
    if (!activeFolder) return;
    setExpanded((current) =>
      expansionMode === "multiple"
        ? current.includes(activeFolder)
          ? current
          : [...current, activeFolder]
        : [activeFolder],
    );
  }, [activeFolder, expansionMode]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="docs-sidebar">
      <Link
        className="flex h-16 shrink-0 items-center gap-2 border-b border-border px-5 text-[15px] font-semibold tracking-[0.16em] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
        onClick={onNavigate}
        to="/"
      >
        ACKERDB
      </Link>

      <VersionSelector
        catalog={catalog}
        current={currentIdentity}
        currentAncestry={currentAncestry}
      />

      <button
        aria-label="Search documentation"
        className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4 text-sm text-muted-foreground outline-none transition-colors duration-150 hover:bg-muted/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
        onClick={onOpenSearch}
        type="button"
      >
        <Search aria-hidden="true" className="size-4" />
        <span className="flex-1 text-left">Search documentation</span>
        <kbd className="border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">⌘K</kbd>
      </button>

      <nav aria-label="Documentation" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <Accordion
          hiddenUntilFound
          multiple={expansionMode === "multiple"}
          onValueChange={(next) => {
            if (expansionMode === "single" && next.length === 0) return;
            setExpanded(next);
          }}
          value={expanded}
        >
          {folders.map((folder, index) => {
            const value = folderValue(folder, index);
            return (
              <AccordionItem key={value} value={value}>
                <AccordionTrigger className="min-h-12 items-center px-4 py-3 text-[13px] text-muted-foreground data-[panel-open]:bg-muted/20 data-[panel-open]:text-foreground">
                  <span className="flex min-w-0 items-center gap-3">
                    <span
                      aria-hidden="true"
                      className="flex size-4 shrink-0 items-center justify-center [&>svg]:size-4"
                    >
                      {folder.icon ?? <Folder strokeWidth={1.75} />}
                    </span>
                    <span className="truncate">{folder.name}</span>
                  </span>
                </AccordionTrigger>
                <AccordionContent className="pb-2">
                  {folderPages(folder).map((node, childIndex) => (
                    <SidebarNode
                      key={node.$id ?? `${node.type}:${childIndex}`}
                      currentUrl={currentUrl}
                      node={node}
                      onNavigate={onNavigate}
                    />
                  ))}
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
      </nav>

      <div className="flex shrink-0 items-center border-t border-border p-2">
        <Button
          aria-label="Toggle site theme"
          className="w-full justify-start gap-3 text-muted-foreground"
          onClick={() => setTheme(resolvedTheme === "light" ? "dark" : "light")}
          variant="ghost"
        >
          <Sun aria-hidden="true" className="size-4 dark:hidden" />
          <Moon aria-hidden="true" className="hidden size-4 dark:block" />
          <span className="dark:hidden">Light theme</span>
          <span className="hidden dark:inline">Dark theme</span>
        </Button>
      </div>
    </div>
  );
}
