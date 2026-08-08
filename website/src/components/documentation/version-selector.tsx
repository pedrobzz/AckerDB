"use client";

import { GitBranch, LoaderCircle } from "lucide-react";
import type {
  DocumentationIdentity,
  DocumentationVersionCatalog,
} from "@/lib/documentation/identity";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useVersionNavigation } from "./version-navigation";

interface VersionSelectorProps {
  catalog: DocumentationVersionCatalog;
  current: DocumentationIdentity;
  currentAncestry: string[];
  className?: string;
}

export function VersionSelector({
  catalog,
  current,
  currentAncestry,
  className,
}: VersionSelectorProps) {
  const { currentKey, switchingTo, switchVersion, versions } = useVersionNavigation(
    current,
    catalog,
    currentAncestry,
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Select documentation version"
        className={cn(
          "flex h-11 w-full items-center gap-3 border-y border-border px-4 text-left text-sm text-muted-foreground outline-none transition-colors duration-150 hover:bg-muted/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50",
          className,
        )}
      >
        <GitBranch aria-hidden="true" className="size-4" />
        <span className="min-w-0 flex-1 truncate">{current.label}</span>
        {switchingTo ? (
          <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
        ) : (
          <span aria-hidden="true" className="text-[10px] text-muted-foreground">
            ↕
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Documentation version</DropdownMenuLabel>
          {versions.map((version) => {
            const key = version.kind === "stable" ? version.version : version.kind;
            return (
              <DropdownMenuItem
                key={key}
                disabled={key === currentKey || switchingTo !== undefined}
                onClick={() => void switchVersion(version)}
                className="min-h-9"
              >
                <span className="flex-1">{version.label}</span>
                {key === currentKey && (
                  <span className="text-xs text-muted-foreground">Current</span>
                )}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
