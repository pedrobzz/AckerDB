/**
 * From the shadcn/ui registry (`@/lib/utils`).
 *
 * The class merger every component composes with. `clsx` resolves the
 * conditional forms; `tailwind-merge` is what makes a `className` prop able to
 * *override* rather than merely append — two conflicting utilities in one
 * string leave the later one standing, which is the whole reason a caller can
 * pass `px-2` to a component whose base says `px-4`.
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
