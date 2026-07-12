/** Convex side of the benchmark; prints one JSON result line. */
import { ConvexClient } from "convex/browser";
import { api } from "./convex/_generated/api.js";
import { runWorkload, type BenchAdapter } from "../workload.ts";

const client = new ConvexClient(process.env["CONVEX_URL"] ?? "http://127.0.0.1:3210");

const adapter: BenchAdapter = {
  mutate: (seq) => client.mutation(api.bench.add, { seq, body: `item-${seq}` }),
  subscribeTop: (onRows) =>
    client.onUpdate(api.bench.top, {}, (rows) => {
      if (rows.length > 0) onRows(Math.max(...rows.map((r) => r.seq)));
    }),
  close: () => void client.close(),
};

const result = await runWorkload(adapter);
adapter.close();
console.log(JSON.stringify(result));
