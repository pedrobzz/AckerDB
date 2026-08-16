import { encode } from "@ackerdb/core";

/** How many bytes a string occupies as UTF-8, without allocating the encoding. */
export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value);
}

/** How many bytes a value occupies once encoded for the wire. */
export function wireByteLength(value: unknown): number {
  return utf8ByteLength(encode(value));
}
