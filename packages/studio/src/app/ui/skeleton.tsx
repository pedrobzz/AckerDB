/**
 * Vendored from the shadcn/ui registry (MIT, `new-york-v4/ui/skeleton`).
 *
 * Unchanged but for the surface token: the registry pulses `bg-accent`, which
 * against Studio's near-black page reads as a filled block rather than an
 * absence. `bg-muted` is the step that says "something belongs here and has not
 * arrived", which is the only thing a skeleton is for.
 */
import type { ComponentProps } from "react";
import { cn } from "./cn.ts";

export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}
