import type { Runtime, TelemetryJournalEntry } from "@ackerdb/server";

/**
 * Read the durable journal the way anything else does: through the sidecar's
 * export port, which commits whatever the ring is holding before it reads. The
 * connection is on another thread, so there is no synchronous read to reach for.
 *
 * Reading does not advance the consumer, so repeated calls see the same rows.
 */
export async function journalRecords(
  runtime: Runtime,
  limit: number,
): Promise<readonly TelemetryJournalEntry[]> {
  const { records } = await runtime.telemetrySidecar.exports.batch("test-reader", limit);
  return records;
}
