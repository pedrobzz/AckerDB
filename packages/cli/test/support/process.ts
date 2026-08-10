/** Shared mechanics for the CLI suites that drive real child processes. */
import { within } from "ackerdb-test-support/async";

const CLI = new URL("../../src/commands/main.ts", import.meta.url).pathname;

/**
 * Durable writes for suites whose subject is not durability.
 * A suite that asserts on durability must pass its own instead.
 */
export const CLI_ENV = { ACKERDB_DURABILITY: "production" } as const;

/**
 * A settled `Result` yields its data; anything else passes through. Process
 * suites await client calls and raw promises through the same step, and a
 * failed `Result` must surface as the thrown error rather than a value the
 * assertion then has to unwrap by hand.
 */
export type UnwrappedResult<T> = T extends { readonly ok: true; readonly data: infer Data }
  ? Data
  : T extends { readonly ok: false }
    ? never
    : T;

export interface Steps {
  /** Bounds a promise, unwrapping a settled Result and throwing a failed one. */
  withTimeout<T>(promise: Promise<T>, label: string, timeoutMs?: number): Promise<UnwrappedResult<T>>;
  /**
   * Retries an assertion until it holds. Unlike a predicate poll this keeps the
   * last failure as the cause, so a timeout reports what was actually wrong.
   */
  eventually(assertion: () => void | Promise<void>, label: string): Promise<void>;
}

/**
 * Binds one suite's step budget. How long a spawn, a ready line, or a graceful
 * exit may legitimately take is the only thing that differs between the process
 * suites' copies of these two steps, so it is the only thing they pass.
 */
export function steps(stepTimeoutMs: number): Steps {
  return {
    async withTimeout<T>(
      promise: Promise<T>,
      label: string,
      timeoutMs = stepTimeoutMs,
    ): Promise<UnwrappedResult<T>> {
      const value = await within(promise, label, timeoutMs);
      if (typeof value === "object" && value !== null && "ok" in value) {
        if (value.ok === true && "data" in value) return value.data as UnwrappedResult<T>;
        if (value.ok === false && "error" in value) throw value.error;
      }
      return value as UnwrappedResult<T>;
    },
    async eventually(assertion, label) {
      const deadline = Date.now() + stepTimeoutMs;
      let lastError: unknown;
      while (Date.now() < deadline) {
        try {
          await assertion();
          return;
        } catch (error) {
          lastError = error;
          await Bun.sleep(25);
        }
      }
      throw new Error(`timed out waiting for ${label}`, { cause: lastError });
    },
  };
}

export interface RanCli {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs one CLI command to completion with stdin ignored, which is how a
 * non-TTY invocation reaches the command: anything that would prompt must
 * instead refuse.
 */
export async function runCli(
  args: string[],
  env: Readonly<Record<string, string>> = {},
): Promise<RanCli> {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}
