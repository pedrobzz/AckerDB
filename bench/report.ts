import type {
  ConnectionLevelResult,
  DriverResult,
  OperationCaseResult,
  SubscriptionCapacityResult,
} from "./benchmark.ts";
import type { AckerDBBenchmarkProfile } from "./ackerdb-profile.ts";

interface MeasuredProfile {
  readonly workload: DriverResult;
  readonly startupIdle: {
    readonly snapshot: { readonly rssMb: number };
    readonly window: { readonly cpuCores: number };
  };
  readonly observations?: readonly string[];
}

interface Sample {
  readonly schemaVersion: number;
  readonly source: { readonly label: string; readonly commit: string; readonly version: string };
  readonly harnessCommit: string;
  readonly profiles: Partial<Record<AckerDBBenchmarkProfile, MeasuredProfile>>;
  readonly observations: {
    readonly failures?: readonly unknown[];
    readonly integrityAnomalies?: readonly unknown[];
  };
}

function percent(base: number, head: number): string {
  if (!Number.isFinite(base) || !Number.isFinite(head) || base === 0) return "—";
  const delta = ((head - base) / Math.abs(base)) * 100;
  return `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`;
}

function value(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2);
}

function row(
  label: string,
  metric: string,
  base: number,
  head: number,
): string {
  return `| ${label} | ${metric} | ${value(base)} | ${value(head)} | ${percent(base, head)} |`;
}

function operationRows(
  base: readonly OperationCaseResult[],
  head: readonly OperationCaseResult[],
): string[] {
  return head.flatMap((current) => {
    const previous = base.find((candidate) =>
      candidate.operation === current.operation &&
      candidate.profile.name === current.profile.name
    );
    if (!previous) return [];
    const label = `${current.operation}/${current.profile.name}`;
    return [
      row(label, "throughput/s", previous.medianThroughputPerSec, current.medianThroughputPerSec),
      row(label, "p95 ms", previous.medianLatencyP95Ms, current.medianLatencyP95Ms),
      row(label, "p99 ms", previous.medianLatencyP99Ms, current.medianLatencyP99Ms),
    ];
  });
}

function connectionRows(
  base: readonly ConnectionLevelResult[],
  head: readonly ConnectionLevelResult[],
): string[] {
  return head.flatMap((current) => {
    const previous = base.find((candidate) =>
      candidate.targetConnections === current.targetConnections
    );
    if (!previous || !previous.work || !current.work) return [];
    const label = `${current.targetConnections} connections`;
    return [
      row(label, "throughput/s", previous.work.throughputPerSec, current.work.throughputPerSec),
      row(label, "p95 ms", previous.work.latency.p95Ms, current.work.latency.p95Ms),
    ];
  });
}

function capacityRows(
  base: DriverResult,
  head: DriverResult,
): string[] {
  return head.subscriptions.flatMap((subscription) => {
    const previousSubscription = base.subscriptions.find(
      (candidate) => candidate.pattern === subscription.pattern,
    );
    if (!previousSubscription) return [];
    return subscription.capacity.flatMap((current: SubscriptionCapacityResult) => {
      const previous = previousSubscription.capacity.find(
        (candidate) => candidate.slots === current.slots,
      );
      if (!previous) return [];
      const label = `${subscription.pattern}/${current.slots} writers`;
      return [
        row(label, "updates/s", previous.throughputPerSec, current.throughputPerSec),
        row(label, "deliveries/s", previous.deliveryThroughputPerSec, current.deliveryThroughputPerSec),
        row(label, "delivery p95 ms", previous.deliveryLatency.p95Ms, current.deliveryLatency.p95Ms),
      ];
    });
  });
}

const [basePath, headPath] = process.argv.slice(2);
if (!basePath || !headPath) {
  throw new Error("usage: bun bench/report.ts <base.json> <head.json>");
}
const base = JSON.parse(await Bun.file(basePath).text()) as Sample;
const head = JSON.parse(await Bun.file(headPath).text()) as Sample;
if (base.schemaVersion !== 1 || head.schemaVersion !== 1) {
  throw new Error("unsupported AckerDB benchmark sample schema");
}
if (base.source.label !== "base" || head.source.label !== "head") {
  throw new Error("paired benchmark files are not labeled base and head");
}
if (!base.harnessCommit || base.harnessCommit !== head.harnessCommit) {
  throw new Error("base and head samples were not measured by the same harness commit");
}
const baseProfiles = Object.keys(base.profiles).sort().join(",");
const headProfiles = Object.keys(head.profiles).sort().join(",");
if (baseProfiles !== headProfiles) {
  throw new Error("base and head samples do not contain the same telemetry profiles");
}

console.log(`# AckerDB benchmark: v${base.source.version} → v${head.source.version}`);
console.log("");
console.log(`Base: \`${base.source.commit}\`  `);
console.log(`Head: \`${head.source.commit}\``);
console.log("");
console.log("These are observations, not an automated verdict. Pedro and an agent must interpret the complete vector before merge.");

for (const profile of ["disabled", "enabled", "exporter"] as const) {
  const previous = base.profiles[profile];
  const current = head.profiles[profile];
  if (!previous || !current) continue;
  console.log("");
  console.log(`## Telemetry: ${profile}`);
  console.log("");
  console.log("| Work | Metric | Base | Head | Change |");
  console.log("| --- | --- | ---: | ---: | ---: |");
  console.log(row("startup idle", "RSS MB", previous.startupIdle.snapshot.rssMb, current.startupIdle.snapshot.rssMb));
  console.log(row("startup idle", "CPU cores", previous.startupIdle.window.cpuCores, current.startupIdle.window.cpuCores));
  for (const line of operationRows(previous.workload.operations, current.workload.operations)) console.log(line);
  for (const line of connectionRows(previous.workload.connections, current.workload.connections)) console.log(line);
  for (const line of capacityRows(previous.workload, current.workload)) console.log(line);
}

const observations = [
  ...(base.observations.failures ?? []),
  ...(base.observations.integrityAnomalies ?? []),
  ...(head.observations.failures ?? []),
  ...(head.observations.integrityAnomalies ?? []),
  ...Object.values(base.profiles).flatMap((profile) => profile?.observations ?? []),
  ...Object.values(head.profiles).flatMap((profile) => profile?.observations ?? []),
];
console.log("");
console.log("## Recorded anomalies and observations");
console.log("");
if (observations.length === 0) {
  console.log("None recorded by the harness. This is not an approval.");
} else {
  for (const observation of observations) {
    console.log(`- ${typeof observation === "string" ? observation : `\`${JSON.stringify(observation)}\``}`);
  }
}
