/** dbzz side of the benchmark; prints one JSON result line. */
import { anyApi } from "@dbzz/core";
import { DbzzClient } from "@dbzz/client";
import { runWorkload, type BenchAdapter } from "./workload.ts";

const client = new DbzzClient({ url: process.env["DBZZ_URL"] ?? "http://127.0.0.1:3311" });

const adapter: BenchAdapter = {
  mutate: (seq) => client.mutation(anyApi.bench.add, { seq, body: `item-${seq}` }),
  subscribeTop: (onRows) =>
    client.subscribe(anyApi.bench.top, {}, (rows: { seq: number }[]) => {
      if (rows.length > 0) onRows(Math.max(...rows.map((r) => r.seq)));
    }),
  close: () => client.close(),
};

const result = await runWorkload(adapter);
adapter.close();
console.log(JSON.stringify(result));
