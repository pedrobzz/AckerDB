import {
  anyApi,
  type ApplicationError,
} from "@dbzz/core";
import {
  DbzzClient,
  type ClientResult,
} from "@dbzz/client";
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
} from "./benchmark.ts";
import { waitForBenchmarkStart } from "./process-lifecycle.ts";
import { runWorkload } from "./workload.ts";

const url = process.env.DBZZ_URL ?? "http://127.0.0.1:3311";

async function expectSuccess<
  Data,
  Error extends ApplicationError = never,
>(
  pending: Promise<ClientResult<Data, Error>>,
): Promise<Data> {
  const result = await pending;
  if (!result.ok) throw result.error;
  return result.data;
}

function connection(client: DbzzClient): BenchConnection {
  return {
    search: (partition, nonce) =>
      expectSuccess(
        client.query<{ partition: number; nonce: number }, SearchResult>(
          anyApi.bench.search,
          { partition, nonce },
        ),
      ),
    transfer: async (pair, direction, amount, nonce) => {
      await expectSuccess(
        client.mutation<
          { pair: number; direction: number; amount: number; nonce: number },
          null
        >(
          anyApi.bench.transfer,
          { pair, direction, amount, nonce },
        ),
      );
    },
    accountState: (nonce) =>
      expectSuccess(
        client.query<{ nonce: number }, AccountState>(
          anyApi.bench.accountState,
          { nonce },
        ),
      ),
    compute: (nonce, seed, payload, rounds) =>
      expectSuccess(
        client.procedure<
          { nonce: number; seed: number; payload: string; rounds: number },
          ComputeResult
        >(
          anyApi.bench.compute,
          { nonce, seed, payload, rounds },
        ),
      ),
    updateChannel: async (channel, nonce) => {
      await expectSuccess(
        client.mutation<{ channel: number; nonce: number }, null>(
          anyApi.bench.updateChannel,
          { channel, nonce },
        ),
      );
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
          client.subscribe<{ channel: number }, ChannelRow | null>(
            anyApi.bench.channel,
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
      await expectSuccess(
        client.mutation(anyApi.bench.seedDocuments, { start, count }),
      );
    },
    seedAccounts: async (start, count) => {
      await expectSuccess(
        client.mutation(anyApi.bench.seedAccounts, { start, count }),
      );
    },
    seedChannels: async (start, count) => {
      await expectSuccess(
        client.mutation(anyApi.bench.seedChannels, { start, count }),
      );
    },
    close: async () => client.close(),
  };
}

const adapter: BenchAdapter = {
  system: "dbzz",
  connect: async (nonce, seeded) => {
    const client = new DbzzClient({ url, credential: { kind: "anonymous" } });
    const connected = connection(client);
    try {
      if (seeded) {
        const probe = await expectSuccess(
          client.query<{ nonce: number }, ProbeResult>(
            anyApi.bench.probe,
            { nonce },
          ),
        );
        const expectedAccount = nonce % ACCOUNT_COUNT;
        const expectedChecksum = probeChecksum(nonce, expectedAccount, probe.balance, probe.version);
        if (
          probe.nonce !== nonce ||
          probe.account !== expectedAccount ||
          probe.balance <= 0 ||
          probe.balance > ACCOUNT_BALANCE * 2 ||
          probe.checksum !== expectedChecksum
        ) {
          throw new Error(`invalid dbzz connection probe`);
        }
      } else {
        const state = await connected.accountState(nonce);
        if (state.nonce !== nonce || state.count !== 0) throw new Error(`dbzz seed connection was not empty`);
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
