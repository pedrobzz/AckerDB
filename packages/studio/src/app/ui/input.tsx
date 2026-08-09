/**
 * Vendored from the shadcn/ui registry (MIT, `new-york-v4/ui/input`).
 *
 * The registry's `dark:` variants and its `file:` affordances are dropped —
 * Studio sets no `.dark` class and uploads nothing through a bare input — and
 * the surface is `bg-card` rather than transparent, so a field reads as a
 * field on a page whose background is nearly black.
 */
import type { ComponentProps } from "react";
import { cn } from "./cn.ts";

export function Input({ className, type, ...props }: ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-input bg-card px-3 py-1 text-sm" +
          " transition-[color,box-shadow] outline-none selection:bg-primary" +
          " selection:text-primary-foreground placeholder:text-muted-foreground" +
          " disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50" +
          " focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        className,
      )}
      {...props}
    />
  );
}
