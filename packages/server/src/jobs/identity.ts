/**
 * Job identity: equal args always produce equal canonical encodings
 * (stableEncode sorts keys and fixes number/bigint representation), so this
 * hash of the encoding is the dedup identity for (job, args).
 */
import { sha256Base64Url } from "../shared/digest.ts";

export function hashJobArgs(encodedArgs: string): string {
  return sha256Base64Url(encodedArgs);
}
