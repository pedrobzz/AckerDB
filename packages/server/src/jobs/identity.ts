/**
 * Job identity: the canonical args encoding and its hash. Equal args always
 * produce equal encodings (stableEncode sorts keys and fixes number/bigint
 * representation), so the hash is the dedup identity for (job, args).
 */
import { createHash } from "node:crypto";
import { stableEncode } from "@ackerdb/core";

/** Canonical wire encoding of a job's validated args. */
export function encodeJobArgs(args: unknown): string {
  return stableEncode(args);
}

export function hashJobArgs(encodedArgs: string): string {
  return createHash("sha256").update(encodedArgs).digest("base64url");
}
