import type { Result } from "@ackerdb/core";

export function expectOk<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.data;
  throw new Error("Expected a successful AckerDB Result", { cause: result.error });
}

export async function expectErrorCode<
  T,
  E extends { readonly code: string },
>(
  work: Promise<Result<T, E>>,
  code: string,
): Promise<E> {
  const result = await work;
  if (result.ok) throw new Error(`Expected AckerDB error code ${code}`);
  if (result.error.code !== code) {
    throw new Error(
      `Expected AckerDB error code ${code}, received ${result.error.code}`,
      { cause: result.error },
    );
  }
  return result.error;
}

export async function expectRejectedCode(
  work: Promise<unknown>,
  code: string,
): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === code
    ) {
      return error;
    }
    throw error;
  }
  throw new Error(`Expected rejected AckerDB error code ${code}`);
}
