"use client";

import { Link } from "@tanstack/react-router";
import { findNeighbour } from "fumadocs-core/page-tree";
import type * as PageTree from "fumadocs-core/page-tree";
import type { TableOfContents } from "fumadocs-core/toc";
import { TOCProvider } from "fumadocs-ui/components/toc";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  Copy,
  ExternalLink,
  FileText,
  Menu,
  Search,
} from "lucide-react";
import type { ReactNode } from "react";
import { lazy, Suspense, useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import type {
  DocumentationIdentity,
  DocumentationVersionCatalog,
} from "@/lib/documentation/identity";
import { cn } from "@/lib/utils";
import { DocumentationSidebar } from "./sidebar";
import {
  DesktopTableOfContents,
  MobileTableOfContents,
} from "./table-of-contents";

const DocumentationCommandPalette = lazy(() =>
  import("./command-palette").then((module) => ({
    default: module.DocumentationCommandPalette,
  })),
);

interface DocumentationShellProps {
  catalog: DocumentationVersionCatalog;
  children: ReactNode;
  currentAncestry: string[];
  currentIdentity: DocumentationIdentity;
  currentUrl: string;
  description?: string;
  githubUrl: string;
  markdownUrl: string;
  title: string;
  toc: TableOfContents;
  tree: PageTree.Root;
  unavailableRoute?: string;
}

function CopyMarkdownAction({ markdownUrl }: { markdownUrl: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const response = await fetch(markdownUrl);
    if (!response.ok) throw new Error(`Markdown returned ${response.status}`);
    await navigator.clipboard.writeText(await response.text());
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <Button onClick={() => void copy()} size="sm" variant="outline">
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {copied ? "Copied" : "Copy Markdown"}
    </Button>
  );
}

function PageFooter({ currentUrl, tree }: { currentUrl: string; tree: PageTree.Root }) {
  const neighbours = findNeighbour(tree, currentUrl);

  if (!neighbours.previous && !neighbours.next) return null;

  return (
    <nav aria-label="Documentation pages" className="mt-20 grid gap-px border border-border bg-border sm:grid-cols-2">
      {neighbours.previous ? (
        <Link
          className="group flex min-h-24 flex-col justify-center gap-2 bg-background p-4 outline-none transition-colors duration-150 hover:bg-muted/35 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
          preload="intent"
          to={neighbours.previous.url}
        >
          <span className="flex items-center gap-2 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            <ArrowLeft aria-hidden="true" className="size-3.5 transition-transform duration-150 group-hover:-translate-x-0.5" />
            Previous
          </span>
          <span className="text-sm font-medium">{neighbours.previous.name}</span>
        </Link>
      ) : (
        <span aria-hidden="true" className="hidden bg-background sm:block" />
      )}
      {neighbours.next && (
        <Link
          className="group flex min-h-24 flex-col items-end justify-center gap-2 bg-background p-4 text-right outline-none transition-colors duration-150 hover:bg-muted/35 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
          preload="intent"
          to={neighbours.next.url}
        >
          <span className="flex items-center gap-2 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            Next
            <ArrowRight aria-hidden="true" className="size-3.5 transition-transform duration-150 group-hover:translate-x-0.5" />
          </span>
          <span className="text-sm font-medium">{neighbours.next.name}</span>
        </Link>
      )}
    </nav>
  );
}

export function DocumentationShell({
  catalog,
  children,
  currentAncestry,
  currentIdentity,
  currentUrl,
  description,
  githubUrl,
  markdownUrl,
  title,
  toc,
  tree,
  unavailableRoute,
}: DocumentationShellProps) {
  const [commandOpen, setCommandOpen] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      setCommandOpen((open) => !open);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <TOCProvider single toc={toc}>
      <a
        className="fixed left-3 top-3 z-[100] -translate-y-20 border border-foreground bg-background px-3 py-2 text-xs text-foreground transition-transform duration-150 focus:translate-y-0"
        href="#docs-content"
      >
        Skip to content
      </a>
      <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[minmax(0,1fr)_15rem] xl:grid-cols-[19rem_minmax(0,1fr)_15rem]">
        <aside className="sticky top-0 hidden h-dvh border-r border-border xl:block">
          <DocumentationSidebar
            catalog={catalog}
            currentAncestry={currentAncestry}
            currentIdentity={currentIdentity}
            currentUrl={currentUrl}
            onOpenSearch={() => setCommandOpen(true)}
            tree={tree}
          />
        </aside>

        <div className="min-w-0 lg:col-start-1 xl:col-start-2">
          <header className="sticky top-0 z-30 flex h-14 items-center border-b border-border bg-background/95 px-3 backdrop-blur-sm xl:hidden">
            <Sheet onOpenChange={setMobileNavigationOpen} open={mobileNavigationOpen}>
              <SheetTrigger
                render={
                  <Button
                    aria-label="Open documentation navigation"
                    data-testid="mobile-docs-trigger"
                    size="icon"
                    variant="ghost"
                  />
                }
              >
                <Menu aria-hidden="true" />
              </SheetTrigger>
              <SheetContent className="w-[min(22rem,90vw)] gap-0 p-0" side="left">
                <SheetHeader className="sr-only">
                  <SheetTitle>Documentation navigation</SheetTitle>
                  <SheetDescription>Browse AckerDB documentation.</SheetDescription>
                </SheetHeader>
                <DocumentationSidebar
                  catalog={catalog}
                  currentAncestry={currentAncestry}
                  currentIdentity={currentIdentity}
                  currentUrl={currentUrl}
                  onNavigate={() => setMobileNavigationOpen(false)}
                  onOpenSearch={() => {
                    setMobileNavigationOpen(false);
                    setCommandOpen(true);
                  }}
                  tree={tree}
                />
              </SheetContent>
            </Sheet>

            <Link className="ml-2 text-xs font-semibold tracking-[0.14em]" to="/">
              ACKERDB
            </Link>
            <Button
              aria-label="Search documentation"
              className="ml-auto"
              onClick={() => setCommandOpen(true)}
              size="icon"
              variant="ghost"
            >
              <Search aria-hidden="true" />
            </Button>
          </header>

          <main
            className="mx-auto w-full max-w-[52rem] px-5 py-10 sm:px-8 sm:py-14 lg:px-10 lg:py-20"
            id="docs-content"
            tabIndex={-1}
          >
            {unavailableRoute && (
              <Alert
                className="mb-8 border-l-sky-500 bg-sky-500/8 text-sky-900 dark:text-sky-100"
                role="status"
              >
                <CircleAlert aria-hidden="true" />
                <AlertTitle>
                  This page is unavailable in {currentIdentity.label}.
                </AlertTitle>
                <AlertDescription className="text-sky-800 dark:text-sky-100/80">
                  Showing the nearest documented section for <code>{unavailableRoute}</code>.
                </AlertDescription>
              </Alert>
            )}

            <article>
              <header>
                <h1 className="text-balance text-3xl font-semibold tracking-[-0.045em] text-foreground sm:text-4xl">
                  {title}
                </h1>
                {description && (
                  <p className="mt-4 max-w-3xl text-sm leading-7 text-muted-foreground sm:text-[15px]">
                    {description}
                  </p>
                )}

                <div className="mt-7 flex flex-wrap items-center gap-2 border-b border-border pb-6">
                  <CopyMarkdownAction markdownUrl={markdownUrl} />
                  <Link
                    className={cn(buttonVariants({ size: "sm", variant: "outline" }), "no-underline")}
                    reloadDocument
                    to={markdownUrl}
                  >
                    <FileText aria-hidden="true" />
                    Markdown
                  </Link>
                  <a
                    className={cn(buttonVariants({ size: "sm", variant: "ghost" }), "no-underline")}
                    href={githubUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <ExternalLink aria-hidden="true" />
                    Edit on GitHub
                  </a>
                </div>

                <MobileTableOfContents />
              </header>

              <div className="prose prose-fd mt-10 max-w-none text-[15px] leading-7 [--fd-layout-width:100%]">
                {children}
              </div>

              <PageFooter currentUrl={currentUrl} tree={tree} />
            </article>
          </main>
        </div>

        <div className="hidden lg:col-start-2 lg:block xl:col-start-3">
          <DesktopTableOfContents />
        </div>
      </div>

      {commandOpen && (
        <Suspense fallback={null}>
          <DocumentationCommandPalette
            catalog={catalog}
            currentAncestry={currentAncestry}
            currentIdentity={currentIdentity}
            currentUrl={currentUrl}
            githubUrl={githubUrl}
            markdownUrl={markdownUrl}
            onOpenChange={setCommandOpen}
            open={commandOpen}
            toc={toc}
          />
        </Suspense>
      )}
    </TOCProvider>
  );
}
