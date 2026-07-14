import type { Subprocess } from "bun";

export const DIAGNOSTIC_TAIL_CHARS = 64 * 1_024;
export const BENCHMARK_START_SIGNAL = "start\n";

type StoppableProcess = Pick<Subprocess, "exitCode" | "exited" | "kill">;

export interface BenchmarkFailurePart {
  readonly stage: string;
  readonly error: unknown;
}

export interface BenchmarkDiagnostics {
  readonly summary?: readonly string[];
  readonly tail?: string;
}

/** Blocks a benchmark client until the parent has established resource baselines. */
export async function waitForBenchmarkStart(): Promise<void> {
  const signal = await Bun.stdin.text();
  if (signal !== BENCHMARK_START_SIGNAL) {
    throw new Error(`invalid benchmark start signal ${JSON.stringify(signal)}`);
  }
}

export class BenchmarkError extends Error {
  declare readonly errors: readonly unknown[];

  constructor(message: string, errors: readonly unknown[]) {
    const cause = errors.length === 1 && !(errors[0] instanceof BenchmarkError)
      ? errors[0]
      : undefined;
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BenchmarkError";
    Object.defineProperty(this, "errors", {
      value: Object.freeze([...errors]),
      enumerable: false,
    });
  }
}

/** Retains the final decoded characters from a process stream within one fixed bound. */
export class BoundedTextTail {
  private readonly decoder = new TextDecoder();
  private text = "";

  constructor(private readonly maxChars = DIAGNOSTIC_TAIL_CHARS) {
    if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
      throw new RangeError("diagnostic tail maxChars must be a positive safe integer");
    }
  }

  write(chunk: Uint8Array): void {
    this.append(this.decoder.decode(chunk, { stream: true }));
  }

  finish(): void {
    this.append(this.decoder.decode());
  }

  output(): string {
    return this.text;
  }

  private append(next: string): void {
    this.text = `${this.text}${next}`;
    if (this.text.length > this.maxChars) this.text = this.text.slice(-this.maxChars);
  }
}

export function activePhaseIds(
  starts: ReadonlyMap<string, number>,
  completed: ReadonlyMap<string, unknown>,
): string[] {
  return [...starts.keys()].filter((id) => !completed.has(id));
}

export function benchmarkFailure(
  scope: string,
  failures: readonly BenchmarkFailurePart[],
  diagnostics: BenchmarkDiagnostics = {},
): BenchmarkError {
  if (failures.length === 0) throw new RangeError("benchmark failure requires at least one cause");
  const summaries = failures.map(({ stage, error }) =>
    `${stage}: ${error instanceof Error ? error.message : String(error)}`
  );
  const boundedTail = diagnostics.tail?.slice(-DIAGNOSTIC_TAIL_CHARS);
  return new BenchmarkError(
    [`${scope} failed`, ...summaries, ...diagnostics.summary ?? [], boundedTail]
      .filter((line): line is string => line !== undefined && line !== "")
      .join("\n"),
    failures.map(({ error }) => error),
  );
}

export async function stopSubprocess(
  child: StoppableProcess,
  timeoutMs: number,
): Promise<{ exitCode: number; timedOut: boolean }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("process stop timeout must be finite and non-negative");
  }
  if (child.exitCode === null) child.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = await Promise.race([
    child.exited.then((exitCode) => ({ exitCode, timedOut: false as const })),
    new Promise<{ exitCode: -1; timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ exitCode: -1, timedOut: true }), timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (!stopped.timedOut) return stopped;
  if (child.exitCode === null) child.kill("SIGKILL");
  return { exitCode: await child.exited, timedOut: true };
}
