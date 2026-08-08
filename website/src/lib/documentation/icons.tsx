import type * as PageTree from "fumadocs-core/page-tree";
import type { LoaderPlugin } from "fumadocs-core/source";
import {
  Blocks,
  BookOpen,
  Braces,
  Cable,
  CloudCog,
  Database,
  FileStack,
  Fingerprint,
  Lightbulb,
  ListTree,
  Plug,
  Radio,
  ServerCog,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import { createElement } from "react";

const documentationIcons: Record<string, LucideIcon> = {
  Blocks,
  BookOpen,
  Braces,
  Cable,
  CloudCog,
  Database,
  FileStack,
  Fingerprint,
  Lightbulb,
  ListTree,
  Plug,
  Radio,
  ServerCog,
  TerminalSquare: SquareTerminal,
};

function resolveIcon<T extends PageTree.Item | PageTree.Folder | PageTree.Separator>(
  node: T,
): T {
  if (typeof node.icon !== "string") return node;
  const Icon = documentationIcons[node.icon];
  if (!Icon) throw new Error(`Unknown Product documentation icon: ${node.icon}`);
  return { ...node, icon: createElement(Icon, { "aria-hidden": true }) };
}

export const documentationIconsPlugin: LoaderPlugin = {
  name: "ackerdb:documentation-icons",
  transformPageTree: {
    file: resolveIcon,
    folder: resolveIcon,
    separator: resolveIcon,
  },
};
