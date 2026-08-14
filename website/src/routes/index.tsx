import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <main className="grid min-h-screen place-items-center bg-black px-6 text-white">
      <section className="w-full max-w-sm border-l border-white/20 pl-7">
        <h1 className="text-lg font-semibold tracking-[0.24em]">ACKERDB</h1>
        <Link
          className="mt-8 inline-flex border-b border-white/35 pb-2 text-sm text-white/70 transition-colors duration-150 hover:border-white hover:text-white"
          params={{ _splat: "" }}
          to="/docs/$"
        >
          Read the docs
        </Link>
      </section>
    </main>
  );
}
