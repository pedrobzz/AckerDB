// Process-level resource tests sample the fixture and every child it owns.
const PS_COMMAND = ["ps", "-ww", "-axo", "pid=,ppid=,rss=,time=,etime="];

export const PROCESS_TREE_RSS_KIND = "sumProcessRss" as const;

export interface ProcessStats {
  pid: number;
  ppid: number;
  rssMb: number;
  cpuSeconds: number;
  elapsedSeconds: number;
}

export interface ProcessTreeSnapshot {
  timestampMs: number;
  rootPid: number;
  rssKind: typeof PROCESS_TREE_RSS_KIND;
  rssMb: number;
  cumulativeCpuSeconds: number;
  processCount: number;
}

export interface ProcessTreeWindowSummary {
  wallMs: number;
  cpuSeconds: number;
  cpuCores: number;
  rssKind: typeof PROCESS_TREE_RSS_KIND;
  rssMb: { p50: number; peak: number };
  sampleCount: number;
  processCountPeak: number;
}

export interface ProcessTableSnapshot {
  timestampMs: number;
  processes: Map<number, ProcessStats>;
}

interface TrackedProcess {
  startedAtMs: number;
  lastCpuSeconds: number;
}

/** Parse the [[days-]hours:]minutes:seconds format emitted by macOS ps. */
export function parsePsDuration(value: string): number {
  const dayParts = value.split("-");
  if (dayParts.length > 2) throw new Error(`invalid ps duration ${JSON.stringify(value)}`);

  const days = dayParts.length === 2 ? Number(dayParts[0]) : 0;
  const clock = dayParts[dayParts.length - 1]!.split(":").map(Number);
  if (
    !Number.isFinite(days) ||
    (clock.length !== 2 && clock.length !== 3) ||
    clock.some((part) => !Number.isFinite(part))
  ) {
    throw new Error(`invalid ps duration ${JSON.stringify(value)}`);
  }

  const [hours, minutes, seconds] = clock.length === 3 ? clock : [0, clock[0]!, clock[1]!];
  return days * 86_400 + hours! * 3_600 + minutes! * 60 + seconds!;
}

/** Parse `ps -ww -axo pid=,ppid=,rss=,time=,etime=` output. */
export function parseProcessTable(output: string): Map<number, ProcessStats> {
  const processes = new Map<number, ProcessStats>();
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 5) throw new Error(`invalid ps row ${JSON.stringify(line)}`);

    const [pidText, ppidText, rssText, cpuText, elapsedText] = fields as [string, string, string, string, string];
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    const rssKb = Number(rssText);
    if (![pid, ppid, rssKb].every(Number.isFinite)) throw new Error(`invalid ps row ${JSON.stringify(line)}`);

    processes.set(pid, {
      pid,
      ppid,
      rssMb: rssKb / 1024,
      cpuSeconds: parsePsDuration(cpuText),
      elapsedSeconds: parsePsDuration(elapsedText),
    });
  }
  return processes;
}

export function readProcessTable(): ProcessTableSnapshot {
  const startedAtMs = performance.now();
  const result = Bun.spawnSync(PS_COMMAND, { stdout: "pipe", stderr: "pipe", timeout: 5_000 });
  const finishedAtMs = performance.now();
  if (result.exitCode !== 0) {
    throw new Error(`ps failed (${result.exitCode}): ${result.stderr.toString().trim()}`);
  }
  return {
    timestampMs: performance.timeOrigin + (startedAtMs + finishedAtMs) / 2,
    processes: parseProcessTable(result.stdout.toString()),
  };
}

function descendantPids(processes: Map<number, ProcessStats>, roots: Iterable<number>): Set<number> {
  const children = new Map<number, number[]>();
  for (const process of processes.values()) {
    const siblings = children.get(process.ppid);
    if (siblings) siblings.push(process.pid);
    else children.set(process.ppid, [process.pid]);
  }

  const descendants = new Set<number>();
  const pending = [...roots];
  while (pending.length > 0) {
    const pid = pending.pop()!;
    if (descendants.has(pid) || !processes.has(pid)) continue;
    descendants.add(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return descendants;
}

function currentTreeSnapshot(rootPid: number, table: ProcessTableSnapshot): ProcessTreeSnapshot {
  if (!table.processes.has(rootPid)) throw new Error(`process tree root ${rootPid} is not running`);
  const pids = descendantPids(table.processes, [rootPid]);
  let rssMb = 0;
  let cumulativeCpuSeconds = 0;
  for (const pid of pids) {
    const process = table.processes.get(pid)!;
    rssMb += process.rssMb;
    cumulativeCpuSeconds += process.cpuSeconds;
  }
  return {
    timestampMs: table.timestampMs,
    rootPid,
    rssKind: PROCESS_TREE_RSS_KIND,
    rssMb,
    cumulativeCpuSeconds,
    processCount: pids.size,
  };
}

/** Take one current-process-tree snapshot without retaining exited-child CPU. */
export function snapshotProcessTree(rootPid: number): ProcessTreeSnapshot {
  return currentTreeSnapshot(rootPid, readProcessTable());
}

/**
 * Samples an explicit process tree. RSS is the sum of resident bytes for live
 * tree members; cumulative CPU retains the last observed value of exited tree
 * members so window deltas do not fall when a child terminates.
 */
export class ProcessTreeMonitor {
  readonly rootPid: number;
  readonly intervalMs: number;

  #timer: ReturnType<typeof setInterval> | undefined;
  #failure: Error | undefined;
  #rootStartedAtMs: number | undefined;
  #retiredCpuSeconds = 0;
  #active = new Map<number, TrackedProcess>();
  #samples: ProcessTreeSnapshot[] = [];

  constructor(rootPid: number, intervalMs = 100) {
    if (!Number.isInteger(rootPid) || rootPid <= 0) throw new Error(`invalid root pid ${rootPid}`);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error(`invalid sampling interval ${intervalMs}`);
    this.rootPid = rootPid;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.#timer) throw new Error(`process tree monitor for ${this.rootPid} is already running`);
    if (this.#samples.length > 0) throw new Error(`process tree monitor for ${this.rootPid} cannot be restarted`);
    this.sampleNow();
    this.#timer = setInterval(() => {
      try {
        this.sampleNow();
      } catch (error) {
        this.#failure = error instanceof Error ? error : new Error(String(error));
        this.stop();
      }
    }, this.intervalMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  sampleNow(table = readProcessTable()): ProcessTreeSnapshot {
    if (this.#failure) throw this.#failure;
    const root = table.processes.get(this.rootPid);
    if (this.#rootStartedAtMs === undefined) {
      if (!root) throw new Error(`process tree root ${this.rootPid} is not running`);
      this.#rootStartedAtMs = table.timestampMs - root.elapsedSeconds * 1000;
    }

    for (const [pid, tracked] of this.#active) {
      const process = table.processes.get(pid);
      if (!process || !this.#sameProcess(tracked, process, table.timestampMs)) {
        this.#retiredCpuSeconds += tracked.lastCpuSeconds;
        this.#active.delete(pid);
      }
    }

    const roots: number[] = [];
    if (root && Math.abs(table.timestampMs - root.elapsedSeconds * 1000 - this.#rootStartedAtMs) <= 2_000) {
      roots.push(this.rootPid);
    }
    roots.push(...this.#active.keys());
    const livePids = descendantPids(table.processes, roots);

    let rssMb = 0;
    for (const pid of livePids) {
      const process = table.processes.get(pid)!;
      rssMb += process.rssMb;
      const tracked = this.#active.get(pid);
      if (tracked) tracked.lastCpuSeconds = Math.max(tracked.lastCpuSeconds, process.cpuSeconds);
      else {
        this.#active.set(pid, {
          startedAtMs: table.timestampMs - process.elapsedSeconds * 1000,
          lastCpuSeconds: process.cpuSeconds,
        });
      }
    }

    let cumulativeCpuSeconds = this.#retiredCpuSeconds;
    for (const process of this.#active.values()) cumulativeCpuSeconds += process.lastCpuSeconds;
    const sample: ProcessTreeSnapshot = {
      timestampMs: table.timestampMs,
      rootPid: this.rootPid,
      rssKind: PROCESS_TREE_RSS_KIND,
      rssMb,
      cumulativeCpuSeconds,
      processCount: livePids.size,
    };
    this.#samples.push(sample);
    return sample;
  }

  samples(): readonly ProcessTreeSnapshot[] {
    return this.#samples;
  }

  summarize(startMs: number, endMs: number): ProcessTreeWindowSummary {
    if (this.#failure) throw this.#failure;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      throw new Error(`invalid process-tree window [${startMs}, ${endMs}]`);
    }
    const first = this.#samples[0];
    const last = this.#samples[this.#samples.length - 1];
    if (!first || !last || startMs < first.timestampMs || endMs > last.timestampMs) {
      throw new Error(`process-tree samples do not cover [${startMs}, ${endMs}]`);
    }

    const windowSamples = this.#samples.filter(
      (sample) => sample.timestampMs >= startMs && sample.timestampMs <= endMs,
    );
    if (windowSamples.length === 0) throw new Error(`no process-tree samples inside [${startMs}, ${endMs}]`);

    const rssValues = windowSamples.map((sample) => sample.rssMb).sort((a, b) => a - b);
    const wallMs = endMs - startMs;
    const cpuSeconds = Math.max(0, this.#cpuAt(endMs) - this.#cpuAt(startMs));
    return {
      wallMs,
      cpuSeconds,
      cpuCores: cpuSeconds / (wallMs / 1000),
      rssKind: PROCESS_TREE_RSS_KIND,
      rssMb: {
        p50: rssValues[Math.ceil(rssValues.length * 0.5) - 1]!,
        peak: rssValues[rssValues.length - 1]!,
      },
      sampleCount: windowSamples.length,
      processCountPeak: Math.max(...windowSamples.map((sample) => sample.processCount)),
    };
  }

  #sameProcess(tracked: TrackedProcess, process: ProcessStats, timestampMs: number): boolean {
    const startedAtMs = timestampMs - process.elapsedSeconds * 1000;
    return Math.abs(startedAtMs - tracked.startedAtMs) <= 2_000 && process.cpuSeconds >= tracked.lastCpuSeconds;
  }

  #cpuAt(timestampMs: number): number {
    const upperIndex = this.#samples.findIndex((sample) => sample.timestampMs >= timestampMs);
    if (upperIndex <= 0) return this.#samples[0]!.cumulativeCpuSeconds;
    const upper = this.#samples[upperIndex]!;
    if (upper.timestampMs === timestampMs) return upper.cumulativeCpuSeconds;
    const lower = this.#samples[upperIndex - 1]!;
    const position = (timestampMs - lower.timestampMs) / (upper.timestampMs - lower.timestampMs);
    return lower.cumulativeCpuSeconds + (upper.cumulativeCpuSeconds - lower.cumulativeCpuSeconds) * position;
  }
}
