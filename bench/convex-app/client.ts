import { ConvexClient } from "convex/browser";
import { api } from "./convex/_generated/api.js";
import {
  ACCOUNT_BALANCE,
  ACCOUNT_COUNT,
  probeChecksum,
  type AccountState,
  type BenchAdapter,
  type BenchConnection,
  type ChannelRow,
  type ComputeResult,
  type ProbeResult,
  type SearchResult,
} from "../benchmark.ts";
import { waitForBenchmarkStart } from "../process-lifecycle.ts";
import { runWorkload } from "../workload.ts";

const url = process.env.CONVEX_URL ?? "http://127.0.0.1:3210";

function connection(client: ConvexClient): BenchConnection {
  return {
    search: (partition, nonce) => client.query(api.bench.search, { partition, nonce }) as Promise<SearchResult>,
    transfer: async (pair, direction, amount, nonce) => {
      await client.mutation(api.bench.transfer, { pair, direction, amount, nonce });
    },
    accountState: (nonce) => client.query(api.bench.accountState, { nonce }) as Promise<AccountState>,
    compute: (nonce, seed, payload, rounds) =>
      client.action(api.bench.compute, { nonce, seed, payload, rounds }) as Promise<ComputeResult>,
    updateChannel: async (channel, nonce) => {
      await client.mutation(api.bench.updateChannel, { channel, nonce });
    },
    subscribeChannels: async (channels, onUpdate) => {
      const pending = new Set(channels);
      const unsubscribes: Array<() => void> = [];
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const ready = new Promise<void>((readyResolve, readyReject) => {
        resolve = readyResolve;
        reject = readyReject;
      });
      for (const channel of channels) {
        unsubscribes.push(
          client.onUpdate(
            api.bench.channel,
            { channel },
            (row) => {
              if (row === null) {
                reject(new Error(`channel ${channel} was not seeded`));
                return;
              }
              if (pending.delete(channel) && pending.size === 0) resolve();
              onUpdate(row);
            },
            (error) => reject(error),
          ),
        );
      }
      await ready;
      return async () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
    seedDocuments: async (start, count) => {
      await client.mutation(api.bench.seedDocuments, { start, count });
    },
    seedAccounts: async (start, count) => {
      await client.mutation(api.bench.seedAccounts, { start, count });
    },
    seedChannels: async (start, count) => {
      await client.mutation(api.bench.seedChannels, { start, count });
    },
    close: () => client.close(),
  };
}

const adapter: BenchAdapter = {
  system: "convex",
  connect: async (nonce, seeded) => {
    const client = new ConvexClient(url, { logger: false });
    const connected = connection(client);
    try {
      if (seeded) {
        const probe = (await client.query(api.bench.probe, { nonce })) as ProbeResult;
        const expectedAccount = nonce % ACCOUNT_COUNT;
        const expectedChecksum = probeChecksum(nonce, expectedAccount, probe.balance, probe.version);
        if (
          probe.nonce !== nonce ||
          probe.account !== expectedAccount ||
          probe.balance <= 0 ||
          probe.balance > ACCOUNT_BALANCE * 2 ||
          probe.checksum !== expectedChecksum
        ) {
          throw new Error(`invalid Convex connection probe`);
        }
      } else {
        const state = (await client.query(api.bench.accountState, { nonce })) as AccountState;
        if (state.nonce !== nonce || state.count !== 0) throw new Error(`Convex seed connection was not empty`);
      }
      return connected;
    } catch (error) {
      await connected.close();
      throw error;
    }
  },
};

await waitForBenchmarkStart();
const result = await runWorkload(adapter);
console.log(`@@result ${JSON.stringify(result)}`);
