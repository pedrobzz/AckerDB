import { createRequire } from "node:module";
import { AckerDBError } from "../../shared/errors.ts";
import type { Schema } from "../../schema/definition.ts";
import { baseValidator } from "../../validation/validator.ts";

type DistanceKernel = (left: Float32Array, right: Float32Array) => number;

export interface VectorRuntime {
  readonly angular: DistanceKernel;
  readonly dot: DistanceKernel;
  readonly euclidean: DistanceKernel;
}

export class VectorRuntimeUnavailableError extends AckerDBError {
  constructor(message: string, cause?: unknown) {
    super("unavailable", message, { resource: "operation", cause });
    this.name = "VectorRuntimeUnavailableError";
  }
}

const require = createRequire(import.meta.url);
const loadNativeModule = (): unknown => require("numkong");
let loadedRuntime: VectorRuntime | undefined;

function kernel(candidate: unknown, name: keyof VectorRuntime): DistanceKernel {
  if (
    candidate === null ||
    (typeof candidate !== "object" && typeof candidate !== "function") ||
    typeof (candidate as Record<string, unknown>)[name] !== "function"
  ) {
    throw new TypeError(`NumKong does not export ${name}()`);
  }
  return (candidate as Record<keyof VectorRuntime, DistanceKernel>)[name].bind(candidate);
}

function closeEnough(actual: number, expected: number): boolean {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-6;
}

function validateRuntime(candidate: unknown): VectorRuntime {
  const runtime: VectorRuntime = Object.freeze({
    angular: kernel(candidate, "angular"),
    dot: kernel(candidate, "dot"),
    euclidean: kernel(candidate, "euclidean"),
  });
  const x = new Float32Array([1, 2]);
  const y = new Float32Array([3, 4]);
  if (!closeEnough(runtime.dot(x, y), 11)) {
    throw new TypeError("NumKong dot() failed its startup self-test");
  }
  if (!closeEnough(runtime.euclidean(new Float32Array([0, 0]), new Float32Array([3, 4])), 5)) {
    throw new TypeError("NumKong euclidean() failed its startup self-test");
  }
  if (
    !closeEnough(runtime.angular(new Float32Array([1, 0]), new Float32Array([0, 1])), 1) ||
    !closeEnough(runtime.angular(new Float32Array([1, 0]), new Float32Array([1, 0])), 0)
  ) {
    throw new TypeError("NumKong angular() failed its startup self-test");
  }
  return runtime;
}

/**
 * Load and self-test the required native kernels. The default loader is cached;
 * an injected loader is an uncached failure seam for process-boundary tests.
 */
export function loadVectorRuntime(
  load: () => unknown = loadNativeModule,
): VectorRuntime {
  if (load === loadNativeModule && loadedRuntime !== undefined) return loadedRuntime;
  try {
    const runtime = validateRuntime(load());
    if (load === loadNativeModule) loadedRuntime = runtime;
    return runtime;
  } catch (cause) {
    throw new VectorRuntimeUnavailableError(
      "stored vector schemas require the native NumKong runtime",
      cause,
    );
  }
}

/** Function validators are inert; only a schema with a stored vector loads native code. */
export function loadVectorRuntimeForSchema(schema: Schema): void {
  for (const table of Object.values(schema.tables)) {
    if (table.kind === "event") continue;
    if (Object.values(table.columns).some((validator) => baseValidator(validator).kind === "vector")) {
      loadVectorRuntime();
      return;
    }
  }
}
