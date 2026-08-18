import { toStandardJson } from "@ackerdb/core";
import type { ExposedHttpCodec } from "../../src/transport/http-codec.ts";

/** Direct Runtime tests exercise execution, not the listener's compiled contract. */
export const testHttpCodec: ExposedHttpCodec = Object.freeze({
  decodeArgs: (value: unknown) => value,
  encodeValue: toStandardJson,
  encodeError: toStandardJson,
});
