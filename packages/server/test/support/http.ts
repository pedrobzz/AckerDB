import { compileExposedHttpCodec, type ExposedHttpCodec } from "../../src/transport/http-codec.ts";
import { exposedFunction } from "../../src/transport/http-surface.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";

/** Compile the HTTP contract a direct Runtime test would otherwise receive from its route. */
export function exposedHttpCodec(runtime: Runtime, address: string): ExposedHttpCodec {
  const fn = runtime.registry.get(address);
  if (fn === undefined || exposedFunction(address, fn) === null) {
    throw new Error(`test function "${address}" is not exposed over HTTP`);
  }
  return compileExposedHttpCodec(address, fn);
}
