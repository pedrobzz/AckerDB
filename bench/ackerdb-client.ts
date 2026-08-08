import {
  anyApi,
  type ApplicationError,
} from "@ackerdb/core";
import {
  AckerDBClient,
  type ClientResult,
} from "@ackerdb/client";
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
import { parentCommands } from "./process-lifecycle.ts";
import { openWorkloadSession, type WorkloadSession } from "./workload.ts";
import type { BenchUnit } from "./units.ts";

const url = process.env.ACKERDB_URL ?? "http://127.0.0.1:3311";

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

function connection(client: AckerDBClient): BenchConnection {
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
  system: "ackerdb",
  connect: async (nonce, seeded) => {
    const client = new AckerDBClient({ url, credential: { kind: "anonymous" } });
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
          throw new Error(`invalid ackerdb connection probe`);
        }
      } else {
        const state = await connected.accountState(nonce);
        if (state.nonce !== nonce || state.count !== 0) throw new Error(`ackerdb seed connection was not empty`);
      }
      return connected;
    } catch (error) {
      await connected.close();
      throw error;
    }
  },
};

/**
 * The load generator outlives one instruction. It seeds once, then answers unit
 * requests until the side driver stops it, so the pair driver can hand the
 * machine back and forth between base and head without paying to seed, connect,
 * and warm a fresh process for every window it measures.
 */
type ClientCommand =
  | { readonly type: "open" }
  | { readonly type: "unit"; readonly unit: BenchUnit; readonly measureIdle: boolean }
  | { readonly type: "close" };

let session: WorkloadSession | undefined;
for await (const line of parentCommands()) {
  const command = JSON.parse(line) as ClientCommand;
  if (command.type === "close") break;
  if (command.type === "open") {
    if (session !== undefined) throw new Error("benchmark client was opened twice");
    session = await openWorkloadSession(adapter);
    console.log(`@@session ${JSON.stringify({ seededIdle: session.seededIdle })}`);
    continue;
  }
  if (session === undefined) throw new Error("benchmark client received a unit before it was opened");
  const result = await session.runUnit(command.unit, { measureIdle: command.measureIdle });
  console.log(`@@unit ${JSON.stringify({ unitId: command.unit.id, ...result })}`);
}
