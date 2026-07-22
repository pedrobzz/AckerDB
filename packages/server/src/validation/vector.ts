import { ValidationError } from "./error.ts";
import { CorruptDatabaseError } from "../shared/errors.ts";

const LITTLE_ENDIAN = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1;

export function vectorDimensions(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ValidationError(`${path}: dimensions must be a positive safe integer`);
  }
  return value as number;
}

/** Normalize an application vector at its single Float32 value boundary. */
export function normalizeVector(
  value: unknown,
  dimensions: number,
  path: string,
): readonly number[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${path}: expected a ${dimensions}-dimensional vector, got ${
      value === null ? "null" : typeof value
    }`);
  }
  if (value.length !== dimensions) {
    throw new ValidationError(
      `${path}: expected a ${dimensions}-dimensional vector, got ${value.length} dimensions`,
    );
  }

  const normalized = new Array<number>(dimensions);
  for (let index = 0; index < dimensions; index++) {
    const coordinate = value[index];
    if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) {
      throw new ValidationError(`${path}[${index}]: expected a finite number`);
    }
    const rounded = Math.fround(coordinate);
    if (!Number.isFinite(rounded)) {
      throw new ValidationError(`${path}[${index}]: value overflows Float32`);
    }
    normalized[index] = Object.is(rounded, -0) ? 0 : rounded;
  }
  return normalized;
}

/** Encode the canonical persisted form: headerless little-endian IEEE-754 Float32. */
export function encodeVectorBlob(value: readonly number[], dimensions: number): Uint8Array {
  const blob = new Uint8Array(dimensions * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(blob.buffer);
  for (let index = 0; index < dimensions; index++) {
    view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, value[index]!, true);
  }
  return blob;
}

function corruptVector(path: string, message: string, rowId?: bigint): never {
  const location = rowId === undefined ? path : `${path} at row ${rowId}`;
  throw new CorruptDatabaseError(`stored vector ${location} is corrupt: ${message}`);
}

/**
 * Validate a persisted vector's storage layout and expose it to a native
 * Float32 kernel. Coordinate validation deliberately remains with the caller:
 * exact ranking can let a finite native result prove the common L2/dot path,
 * while ordinary row decoding still validates every coordinate. The common
 * aligned little-endian path is zero-copy; unusual views are copied.
 */
export function vectorBlobKernelView(
  value: unknown,
  dimensions: number,
  path: string,
  rowId?: bigint,
): Float32Array {
  if (!(value instanceof Uint8Array)) {
    corruptVector(path, "expected a BLOB", rowId);
  }
  const expectedBytes = dimensions * Float32Array.BYTES_PER_ELEMENT;
  if (value.byteLength !== expectedBytes) {
    corruptVector(path, `expected ${expectedBytes} bytes, got ${value.byteLength}`, rowId);
  }

  const canView = LITTLE_ENDIAN && value.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0;
  if (canView) return new Float32Array(value.buffer, value.byteOffset, dimensions);

  const data = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const copied = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index++) {
    copied[index] = data.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
  }
  return copied;
}

/** Validate every coordinate, returning whether the finite vector is zero. */
export function isZeroFiniteVector(
  vector: Float32Array,
  path: string,
  rowId?: bigint,
): boolean {
  let zero = true;
  for (let index = 0; index < vector.length; index++) {
    const coordinate = vector[index]!;
    if (!Number.isFinite(coordinate)) {
      corruptVector(path, `coordinate ${index} is not finite`, rowId);
    }
    if (coordinate !== 0) zero = false;
  }
  return zero;
}

/** Validate coordinates after a native kernel reports a non-finite result. */
export function assertFiniteVector(vector: Float32Array, path: string, rowId?: bigint): void {
  for (let index = 0; index < vector.length; index++) {
    if (!Number.isFinite(vector[index])) {
      corruptVector(path, `coordinate ${index} is not finite`, rowId);
    }
  }
}

/**
 * Fully validate one persisted vector for ordinary row decoding. Negative zero
 * is canonicalized without mutating the SQLite-owned BLOB view.
 */
export function vectorBlobFloat32View(
  value: unknown,
  dimensions: number,
  path: string,
): Float32Array {
  const direct = vectorBlobKernelView(value, dimensions, path);
  let canonical: Float32Array | undefined;
  for (let index = 0; index < dimensions; index++) {
    const coordinate = direct[index]!;
    if (!Number.isFinite(coordinate)) {
      corruptVector(path, `coordinate ${index} is not finite`);
    }
    if (Object.is(coordinate, -0)) {
      canonical ??= direct.slice();
      canonical[index] = 0;
    }
  }
  return canonical ?? direct;
}

/** Decode one stored vector to the fresh plain array exposed on ordinary rows. */
export function decodeVectorBlob(
  value: unknown,
  dimensions: number,
  path: string,
): readonly number[] {
  return Array.from(vectorBlobFloat32View(value, dimensions, path));
}
