import { Bash, type InitialFiles } from "just-bash";
import { v } from "@dbzz/server";
import type { DatabaseReader } from "@demo/dbzz-codegen/server";
import { isFinal } from "../../../lib/domain.ts";
import { admin } from "../mcp.ts";

/**
 * Sane demo caps for the sandboxed shell. Runaway scripts (infinite loops,
 * fork bombs, deep recursion) trip one of these and terminate in milliseconds
 * with a non-zero exit code and an explanatory stderr line, rather than hanging
 * the request. Legitimate analytics over the restaurant's few dozen rows never
 * approach them. Network, Python and JS execution are left off (the defaults).
 */
const EXECUTION_LIMITS = {
  maxCommandCount: 10_000,
  maxLoopIterations: 10_000,
  maxCallDepth: 64,
} as const;

/** Each of stdout and stderr is capped at this many bytes before returning. */
const OUTPUT_LIMIT_BYTES = 32 * 1024;
const TRUNCATION_MARKER = "\n[output truncated at 32 KiB]\n";

const encoder = new TextEncoder();
// Lenient decoder: a multi-byte character split by the byte cut becomes U+FFFD
// rather than throwing — harmless for the human-readable, mostly-ASCII output.
const decoder = new TextDecoder();

/** Bound one stream to {@link OUTPUT_LIMIT_BYTES}, flagging when it was cut. */
function boundOutput(text: string): { text: string; truncated: boolean } {
  const bytes = encoder.encode(text);
  if (bytes.length <= OUTPUT_LIMIT_BYTES) return { text, truncated: false };
  const head = decoder.decode(bytes.subarray(0, OUTPUT_LIMIT_BYTES));
  return { text: head + TRUNCATION_MARKER, truncated: true };
}

/**
 * Render rows as JSON Lines. BigInt identifiers serialize losslessly as decimal
 * strings (the same lossless-id contract the typed tools honor), so `jq` reads
 * them as strings and no precision is lost.
 */
function toJsonl(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const body = rows
    .map((row) =>
      JSON.stringify(row, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    )
    .join("\n");
  return `${body}\n`;
}

const README = `# Savoria workspace

Every file here is the restaurant's LIVE data, rendered fresh from the database
at the moment you called this tool. Files are read-only and vanish when the call
returns — a later call re-materializes them from the current data, so what you
see is never stale. One JSON object per line (JSON Lines). Numeric identifiers
are decimal strings so nothing is truncated; parse them with \`jq\` as strings.
Timestamps are epoch milliseconds. Money is integer cents. Enum columns are
plain strings.

## Raw tables (/data)

- \`tables.jsonl\` — restaurant tables. Fields: id, number, seats, active,
  createdAt, updatedAt.
- \`menu_categories.jsonl\` — menu sections. Fields: id, name, sortOrder, active,
  createdAt, updatedAt.
- \`menu_items.jsonl\` — dishes. Fields: id, categoryId, name, description, image,
  priceCents, sortOrder, active, createdAt, updatedAt.
- \`orders.jsonl\` — one row per check. Fields: id, userId, tableId, openUserId,
  openTableId, status (OPEN | PAID | CANCELLED), totalCents, openedAt, closedAt
  (null while OPEN).
- \`order_items.jsonl\` — one row per line on a check. Fields: id, orderId,
  menuItemId, name, image, unitPriceCents, quantity, note, status (ORDERED |
  PREPARING | PREPARED | SERVED | CANCELLED), orderedAt, statusChangedAt.
- \`users.jsonl\` — guests and staff. Fields: id, email, name, createdAt,
  updatedAt.

## Derived views (/data/views)

- \`wait_times.jsonl\` — one row per order item, joined to its table, with the
  wait already computed. Fields: orderItemId, orderId, menuItemId, tableNumber,
  itemName, status, final (true when SERVED or CANCELLED), orderedAt,
  statusChangedAt, waitMs.
  - \`waitMs\` is how long the guest has waited on this item:
    - final items (SERVED / CANCELLED): the settled wait,
      \`statusChangedAt - orderedAt\`.
    - in-flight items (ORDERED / PREPARING / PREPARED): the wait still accruing,
      \`now - orderedAt\`, measured against this snapshot's clock.
  - Filter on \`.final\` for historical service times; leave it in for live
    queue pressure (how long current guests have been waiting right now).

- \`table_sessions.jsonl\` — one row per closed check (PAID or CANCELLED), i.e. a
  finished seating. Fields: orderId, tableNumber, openedAt, closedAt, durationMs
  (\`closedAt - openedAt\`), totalCents, status. Use durationMs to see which
  tables guests linger on.

## Example pipelines

Median live wait across every item on the board, in minutes:

    jq -s 'map(.waitMs) | sort
      | (if length % 2 == 1 then .[length/2 | floor]
         else (.[length/2 - 1] + .[length/2]) / 2 end) / 60000' \\
      /data/views/wait_times.jsonl

Longest-waiting in-flight items first (the kitchen's priority list):

    jq -c 'select(.final | not)' /data/views/wait_times.jsonl \\
      | jq -s 'sort_by(-.waitMs) | .[0:5]'

Which tables do guests stay longest on (by average finished-session minutes):

    jq -s 'group_by(.tableNumber)
      | map({ table: .[0].tableNumber,
              avgMinutes: (map(.durationMs) | add / length / 60000) })
      | sort_by(-.avgMinutes)' /data/views/table_sessions.jsonl

Revenue by dish across all checks (cents), busiest dish first:

    jq -s 'map(select(.status != "CANCELLED"))
      | group_by(.name)
      | map({ dish: .[0].name,
              cents: (map(.unitPriceCents * .quantity) | add) })
      | sort_by(-.cents)' /data/order_items.jsonl
`;

/**
 * Materialize the workspace's virtual files from one database snapshot.
 *
 * Materialization is EAGER — every file is rendered here, inside the open read
 * transaction, before the shell runs. Lazy per-file providers would query less,
 * but just-bash's sandbox lockdown blocks `globalThis.performance.now` while a
 * script executes, and dbzz's read path times its reads with `performance.now()`
 * whenever telemetry is enabled — so any database read issued from inside
 * `exec()` dies with a SecurityViolationError (surfaced to the script as
 * ENOENT). Host reads happen out here instead, where the sandbox has no say;
 * the shell only ever sees plain strings. Per-call freshness and snapshot
 * consistency are unchanged: files are rebuilt from live data on every call and
 * discarded afterward.
 */
async function buildFiles(db: DatabaseReader, now: number): Promise<InitialFiles> {
  const [tables, categories, menuItems, orders, orderItems, users] =
    await Promise.all([
      db.restaurantTables.scan().collect(),
      db.menuCategories.scan().collect(),
      db.menuItems.scan().collect(),
      db.orders.scan().collect(),
      db.orderItems.scan().collect(),
      db.users.scan().collect(),
    ]);
  const orderById = new Map(orders.map((order) => [order.id, order]));
  const tableById = new Map(tables.map((table) => [table.id, table]));
  const sessions = orders.filter((order) => order.status !== "OPEN");
  return {
    "/data/README.md": README,
    "/data/tables.jsonl": toJsonl(tables),
    "/data/menu_categories.jsonl": toJsonl(categories),
    "/data/menu_items.jsonl": toJsonl(menuItems),
    "/data/orders.jsonl": toJsonl(orders),
    "/data/order_items.jsonl": toJsonl(orderItems),
    // `identity` stays private, matching get_guests: the workspace never
    // exposes more than the typed tools do.
    "/data/users.jsonl": toJsonl(
      users.map(({ identity: _identity, ...user }) => user),
    ),
    "/data/views/wait_times.jsonl": toJsonl(
      orderItems.map((item) => {
        const order = orderById.get(item.orderId);
        const table = order ? tableById.get(order.tableId) : undefined;
        const final = isFinal(item.status);
        const endedAt = final ? item.statusChangedAt : now;
        return {
          orderItemId: item.id,
          orderId: item.orderId,
          menuItemId: item.menuItemId,
          tableNumber: table?.number ?? null,
          itemName: item.name,
          status: item.status,
          final,
          orderedAt: item.orderedAt,
          statusChangedAt: item.statusChangedAt,
          waitMs: endedAt - item.orderedAt,
        };
      }),
    ),
    "/data/views/table_sessions.jsonl": toJsonl(
      sessions.map((order) => {
        const table = tableById.get(order.tableId);
        return {
          orderId: order.id,
          tableNumber: table?.number ?? null,
          openedAt: order.openedAt,
          closedAt: order.closedAt,
          durationMs:
            order.closedAt === null ? null : order.closedAt - order.openedAt,
          totalCents: order.totalCents,
          status: order.status,
        };
      }),
    ),
  };
}

/**
 * `bash` — the Admin MCP's open-ended read tool. A sandboxed just-bash shell,
 * created fresh for each call, whose files are the live restaurant data rendered
 * as JSON Lines (materialized from read queries at call time, discarded after —
 * never stored, therefore never stale). Ships derived
 * views and a `/data/README.md` so flagship analytics collapse into one-line jq
 * pipelines. This is where a capable model answers questions the typed entity
 * tools never anticipated; small models should prefer the typed tools.
 */
export const bashWorkspace = admin.tool({
  name: "bash",
  title: "Bash workspace",
  description:
    "Run a bash script against a sandboxed, read-only workspace of the " +
    "restaurant's LIVE data under /data, rendered fresh each call as JSON " +
    "Lines (files vanish afterward, so results are never stale). Includes jq, " +
    "awk, sed, grep, sort and friends; no network. Raw tables live at " +
    "/data/*.jsonl and precomputed views (per-item wait times, per-table " +
    "sessions) at /data/views/*.jsonl. When unsure of file names or schemas, " +
    "`cat /data/README.md` first — it documents every field and shows example " +
    "pipelines. Returns the script's exitCode, stdout, stderr, and a truncated " +
    "flag (each stream is capped at 32 KiB).",
  access: { anyOf: ["read"] },
  annotations: { readOnlyHint: true },
  args: {
    script: v
      .string()
      .describe(
        "The bash script to run in the workspace. Read files under /data " +
          "(e.g. pipe /data/views/wait_times.jsonl through jq). Start with " +
          "`cat /data/README.md` if you are unsure what is available.",
      ),
  },
  output: v.object({
    exitCode: v.int(),
    stdout: v.string(),
    stderr: v.string(),
    truncated: v.boolean(),
  }),
  handler: (ctx, args) =>
    ctx.tx(async (tx) => {
      const now = Date.now();
      const shell = new Bash({
        files: await buildFiles(tx.db, now),
        executionLimits: EXECUTION_LIMITS,
      });
      const result = await shell.exec(args.script, {
        signal: ctx.abortSignal,
      });
      const stdout = boundOutput(result.stdout);
      const stderr = boundOutput(result.stderr);
      return {
        exitCode: result.exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: stdout.truncated || stderr.truncated,
      };
    }),
});
