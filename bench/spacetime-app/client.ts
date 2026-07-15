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
import { DbConnection, tables, type EventContext } from "./module_bindings/index.ts";
import { setGlobalLogLevel } from "spacetimedb";

setGlobalLogLevel("error");

const uri = process.env.SPACETIMEDB_URL ?? "ws://127.0.0.1:5321";
const dbName = process.env.SPACETIMEDB_DB ?? "dbzz-bench";

interface OpenConnection {
  connection: DbConnection;
  disconnected: Promise<void>;
}

function openConnection(): Promise<OpenConnection> {
  return new Promise((resolve, reject) => {
    let connection!: DbConnection;
    let disconnectResolve!: () => void;
    const disconnected = new Promise<void>((done) => {
      disconnectResolve = done;
    });
    connection = DbConnection.builder()
      .withUri(uri)
      .withDatabaseName(dbName)
      .withConfirmedReads(true)
      .onConnect(() => resolve({ connection, disconnected }))
      .onConnectError((_ctx, error) => reject(error))
      .onDisconnect(() => disconnectResolve())
      .build();
  });
}

function benchConnection(opened: OpenConnection): BenchConnection {
  const conn = opened.connection;
  return {
    search: (partition, nonce) => conn.procedures.search({ partition, nonce }) as Promise<SearchResult>,
    transfer: async (pair, direction, amount, nonce) => {
      await conn.reducers.transfer({ pair, direction, amount, nonce });
    },
    accountState: (nonce) => conn.procedures.accountState({ nonce }) as Promise<AccountState>,
    compute: (nonce, seed, payload, rounds) =>
      conn.procedures.compute({ nonce, seed, payload, rounds }) as Promise<ComputeResult>,
    updateChannel: async (channel, nonce) => {
      await conn.reducers.updateChannel({ channel, nonce });
    },
    subscribeChannels: async (channels, onUpdate) => {
      const callback = (_ctx: EventContext, _oldRow: ChannelRow, row: ChannelRow) => onUpdate(row);
      conn.db.channels.onUpdate(callback);
      let handle!: ReturnType<ReturnType<DbConnection["subscriptionBuilder"]>["subscribe"]>;
      await new Promise<void>((resolve, reject) => {
        handle = conn
          .subscriptionBuilder()
          .onApplied(() => resolve())
          .onError((ctx) => reject(new Error(`subscription failed: ${String(ctx.event)}`)))
          .subscribe(channels.map((channel) => tables.channels.where((row) => row.channel.eq(channel))));
      });
      return async () => {
        conn.db.channels.removeOnUpdate(callback);
        if (!handle.isActive()) return;
        await new Promise<void>((resolve) => handle.unsubscribeThen(() => resolve()));
      };
    },
    seedDocuments: async (start, count) => {
      await conn.reducers.seedDocuments({ start, count });
    },
    seedAccounts: async (start, count) => {
      await conn.reducers.seedAccounts({ start, count });
    },
    seedChannels: async (start, count) => {
      await conn.reducers.seedChannels({ start, count });
    },
    close: async () => {
      conn.disconnect();
      await opened.disconnected;
    },
  };
}

const adapter: BenchAdapter = {
  system: "spacetimedb",
  connect: async (nonce, seeded) => {
    const opened = await openConnection();
    const connected = benchConnection(opened);
    try {
      if (seeded) {
        const probe = (await opened.connection.procedures.probe({ nonce })) as ProbeResult;
        const expectedAccount = nonce % ACCOUNT_COUNT;
        const expectedChecksum = probeChecksum(nonce, expectedAccount, probe.balance, probe.version);
        if (
          probe.nonce !== nonce ||
          probe.account !== expectedAccount ||
          probe.balance <= 0 ||
          probe.balance > ACCOUNT_BALANCE * 2 ||
          probe.checksum !== expectedChecksum
        ) {
          throw new Error(`invalid SpacetimeDB connection probe`);
        }
      } else {
        const state = (await opened.connection.procedures.accountState({ nonce })) as AccountState;
        if (state.nonce !== nonce || state.count !== 0) throw new Error(`SpacetimeDB seed connection was not empty`);
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
