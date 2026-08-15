// Manual demo: one process serving a real AckerDB server plus the React page.
// Run from the repo root with `bun fixtures/react-web/server.ts`, then open
// http://localhost:3210 — the page connects through AckerDBProvider and shows the
// live connection state (stop/restart this process to watch it change).
//
// It is also the smallest programmatic host: values wrapped in loaders, one
// `boot()`, and the returned application's `drain()` on the way out.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalFileStore,
  boot,
  defineApp,
  defineSchema,
  defineTable,
  query,
  v,
} from "@ackerdb/server";
import index from "./index.html";

const schema = defineSchema({
  notes: defineTable({
    id: v.primaryKey(),
    body: v.string(),
  }),
});
const app = defineApp({ schema });
const functions = {
  notes: {
    list: query({
      access: "public",
      args: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: (ctx: any) => ctx.db.notes.query().collect(),
    }),
  },
};

const dir = mkdtempSync(join(tmpdir(), "ackerdb-react-web-"));
const running = await boot({
  listener: { port: 3211 },
  storage: { path: join(dir, "data.db") },
  files: { store: new LocalFileStore({ root: join(dir, "files") }) },
  load: {
    app: async () => ({ app, migrations: [] }),
    runtime: async () => ({ functions, jobs: {} }),
  },
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void running.drain().finally(() => process.exit(0)));
}

Bun.serve({ port: 3210, routes: { "/": index }, development: true });
console.log("AckerDB server:  http://127.0.0.1:3211");
console.log("react fixture: http://localhost:3210");
