import { resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? ".output/public");
const port = Number.parseInt(process.argv[3] ?? "4173", 10);

if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid port: ${process.argv[3] ?? ""}`);
}

function insideRoot(path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function candidates(pathname: string): string[] {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return [];
  }

  const exact = resolve(root, `.${decoded}`);
  if (!insideRoot(exact)) return [];

  if (decoded.endsWith("/")) return [resolve(exact, "index.html")];
  return [exact, resolve(exact, "index.html")];
}

async function staticResponse(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);

  for (const candidate of candidates(pathname)) {
    const file = Bun.file(candidate);
    if (!(await file.exists())) continue;

    return new Response(request.method === "HEAD" ? null : file, {
      headers: {
        "Content-Length": String(file.size),
        "Content-Type": file.type || "application/octet-stream",
      },
    });
  }

  const notFound = Bun.file(resolve(root, "404.html"));
  return new Response(request.method === "HEAD" ? null : notFound, {
    status: 404,
    headers: {
      "Content-Length": String(notFound.size),
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: staticResponse,
});

console.log(`Static website preview: http://127.0.0.1:${port}`);
