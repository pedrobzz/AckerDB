/**
 * Job identity: equal args always produce equal canonical encodings
 * (stableEncode sorts keys and fixes number/bigint representation), so this
 * hash of the encoding is the dedup identity for (job, args).
 */
import { createHash } from "node:crypto";

export function hashJobArgs(encodedArgs: string): string {
  return createHash("sha256").update(encodedArgs).digest("base64url");
}
