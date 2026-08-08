"use client";

import { ChevronDown } from "lucide-react";
import { TOCItem, TOCItems } from "fumadocs-ui/components/toc/default";
import { useTOCItems } from "fumadocs-ui/components/toc";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

function TableOfContentsLinks() {
  const items = useTOCItems();

  if (items.length === 0) {
    return <p className="text-xs text-muted-foreground">No sections on this page.</p>;
  }

  return (
    <TOCItems className="flex flex-col" thumbBox={false}>
      {items.map((item) => (
        <TOCItem
          key={item.url}
          className="py-1 text-xs leading-5 data-[active=true]:font-medium"
          item={item}
        />
      ))}
    </TOCItems>
  );
}

export function DesktopTableOfContents() {
  return (
    <aside aria-label="On this page" className="sticky top-0 hidden h-dvh overflow-y-auto px-5 py-24 lg:block">
      <p className="mb-4 text-[10px] font-semibold uppercase tracking-[0.14em] text-foreground">
        On this page
      </p>
      <TableOfContentsLinks />
    </aside>
  );
}

export function MobileTableOfContents() {
  return (
    <Collapsible>
      <div className="border-y border-border lg:hidden" data-testid="mobile-on-this-page">
        <CollapsibleTrigger className="group flex w-full items-center justify-between px-0 py-3 text-xs font-medium uppercase tracking-[0.1em]">
          On this page
          <ChevronDown
            aria-hidden="true"
            className="size-4 text-muted-foreground transition-transform duration-150 group-data-[panel-open]:rotate-180"
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="pb-4">
            <TableOfContentsLinks />
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
