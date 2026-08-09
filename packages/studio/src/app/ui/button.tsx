/**
 * From the shadcn/ui registry (`new-york-v4/ui/button`).
 *
 * Two edits, both consequences of decisions this package already made:
 *
 * - **`asChild` and its `radix-ui` `Slot` are gone.** The one place a button
 *   and a link want the same shape is the navigation, which styles its router
 *   links directly. Keeping the prop would mean shipping a dependency for a
 *   polymorphism nothing asks for.
 * - **Every `dark:` variant is gone**, folded into the base where it said
 *   anything. Studio's tokens *are* the dark values and no `.dark` class is
 *   ever set, so those utilities could only ever be dead weight in the
 *   stylesheet and a lie to whoever reads the file next.
 */
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./cn.ts";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium" +
    " whitespace-nowrap transition-all outline-none focus-visible:border-ring" +
    " focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none" +
    " disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0" +
    " [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/40",
        outline: "border border-input bg-card hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export type ButtonProps = ComponentProps<"button"> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <button
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
