// Manual demo: one process serving a real AckerDB server plus the React page.
// Run from the repo root with `bun fixtures/react-web/server.ts`, then open
// http://localhost:3210 — the page connects through AckerDBProvider and shows the
// live connection state (stop/restart this process to watch it change).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Engine,
  PRODUCTION_LIMITS,
  Registry,
  Runtime,
  v,
  defineSchema,
  defineTable,
  query,
  reconcile,
  serve,
} from "@ackerdb/server";
import index from "./index.html";

const schema = defineSchema({
  notes: defineTable({
    id: v.primaryKey(),
    body: v.string(),
  }),
});

const engine = new Engine(schema, join(mkdtempSync(join(tmpdir(), "ackerdb-react-web-")), "data.db"));
reconcile(engine);
const registry = new Registry({
  notes: {
    list: query({
      access: "public",
      args: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: (ctx: any) => ctx.db.notes.query().collect(),
    }),
  },
});
const runtime = new Runtime({ engine, registry, limits: PRODUCTION_LIMITS });
serve({ runtime, port: 3211 });

Bun.serve({ port: 3210, routes: { "/": index }, development: true });
console.log("AckerDB server:  http://127.0.0.1:3211");
console.log("react fixture: http://localhost:3210");
