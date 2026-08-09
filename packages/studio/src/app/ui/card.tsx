/**
 * Vendored from the shadcn/ui registry (MIT, `new-york-v4/ui/card`).
 *
 * Trimmed to the five parts Studio renders. The registry's `CardAction` and
 * `CardFooter` are dropped rather than kept against a future need — an unused
 * export is a thing the next reader has to check for callers before touching.
 * The header's `@container` grid goes with `CardAction`, which was the only
 * thing that needed a second column.
 */
import type { ComponentProps } from "react";
import { cn } from "./cn.ts";

export function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex flex-col gap-6 rounded-xl border border-border bg-card py-6 text-card-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div data-slot="card-header" className={cn("flex flex-col gap-1.5 px-6", className)} {...props} />
  );
}

export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return (
    <h2 data-slot="card-title" className={cn("leading-none font-semibold", className)} {...props} />
  );
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-6", className)} {...props} />;
}
