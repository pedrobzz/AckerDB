/**
 * From the shadcn/ui registry (`new-york-v4/ui/badge`).
 *
 * `asChild` and the `[a&]:` anchor variants are dropped with the `radix-ui`
 * `Slot` they served; nothing in Studio renders a badge as a link. The `signal`
 * variant is added: it takes its colour from the caller so the dither palette
 * decides a level's hue in one place rather than growing a variant per level.
 */
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./cn.ts";

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full" +
    " border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap" +
    " [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        secondary: "bg-secondary text-secondary-foreground",
        destructive: "bg-destructive text-destructive-foreground",
        outline: "border-border text-foreground",
        /** Colour comes from the caller's `text-signal-*` and its own tint. */
        signal: "border-current/30 bg-current/10",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export type BadgeProps = ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
