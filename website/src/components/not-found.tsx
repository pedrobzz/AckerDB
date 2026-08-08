import { Link } from "@tanstack/react-router";

export function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center bg-background px-6 text-foreground">
      <div className="max-w-xl border-l border-border pl-6">
        <p className="mb-3 text-xs uppercase tracking-[0.18em] text-muted-foreground">404</p>
        <h1 className="text-3xl font-semibold tracking-[-0.04em]">This page does not exist.</h1>
        <p className="mt-4 text-sm leading-6 text-muted-foreground">
          The address may have moved to another Documentation version.
        </p>
        <Link
          className="mt-6 inline-flex border-b border-foreground pb-1 text-sm"
          params={{ _splat: "" }}
          to="/docs/$"
        >
          Read the docs
        </Link>
      </div>
    </main>
  );
}
