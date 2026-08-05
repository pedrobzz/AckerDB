import type { Telemetry } from "../../telemetry/telemetry.ts";
import type { RuntimeStatus } from "../contracts/status.ts";

type RuntimeSamplerState = Pick<
  RuntimeStatus,
  | "connections"
  | "activeOperations"
  | "activeOperationCallers"
  | "activeSse"
  | "realtime"
  | "reader"
  | "writer"
  | "reactive"
  | "publication"
  | "authCaptureBudget"
  | "sseBudget"
  | "telemetry"
  | "files"
  | "storage"
>;

type SamplerTelemetry = Pick<
  Telemetry,
  "enabled" | "sampleIntervalMs" | "recordMetric"
>;

export interface RuntimeSamplerOptions {
  readonly telemetry: SamplerTelemetry;
  readonly isReady: () => boolean;
  readonly state: () => RuntimeSamplerState;
  readonly sampleRealtime: () => void;
  readonly flushDeliveryFailures: () => void;
}

type RuntimeMetric = readonly [
  name: string,
  value: number,
  unit: "count" | "bytes" | "milliseconds" | "gauge",
];

/** Owns process sampling and the Runtime metric projection; no request state. */
export class RuntimeSampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCpu = process.cpuUsage();
  private lastCpuAt = performance.now();
  private expectedSampleAt = performance.now();

  constructor(private readonly options: RuntimeSamplerOptions) {}

  start(): void {
    if (!this.options.telemetry.enabled) return;
    const interval = this.options.telemetry.sampleIntervalMs;
    this.expectedSampleAt = performance.now() + interval;
    this.timer = setInterval(() => this.sample(), interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private sample(): void {
    if (!this.options.isReady()) return;
    const now = performance.now();
    const elapsedMs = Math.max(1, now - this.lastCpuAt);
    const cpu = process.cpuUsage(this.lastCpu);
    const cores = (cpu.user + cpu.system) / (elapsedMs * 1_000);
    this.lastCpu = process.cpuUsage();
    this.lastCpuAt = now;
    const eventLoopDrift = Math.max(0, now - this.expectedSampleAt);
    this.expectedSampleAt = now + this.options.telemetry.sampleIntervalMs;

    const state = this.options.state();
    const checkpoint = state.storage.lastCheckpoint;
    const realtime = state.realtime;
    const telemetryDrops = Object.values(state.telemetry.dropped).reduce(
      (sum, value) => sum + value,
      0,
    );
    const fileMetrics: RuntimeMetric[] = [
      ["runtime.file_pending_count", state.files.pending.count, "gauge"],
      ["runtime.file_pending_bytes", state.files.pending.bytes, "bytes"],
      ["runtime.file_active_count", state.files.active.count, "gauge"],
      ["runtime.file_active_bytes", state.files.active.bytes, "bytes"],
      ["runtime.file_deleting_count", state.files.deleting.count, "gauge"],
      ["runtime.file_deleting_bytes", state.files.deleting.bytes, "bytes"],
      ["runtime.file_cleanup_backlog", state.files.cleanup.backlog, "gauge"],
      ["runtime.file_cleanup_oldest_age", state.files.cleanup.oldestAgeMs, "milliseconds"],
      ["runtime.file_cleanup_failures", state.files.cleanup.failures, "count"],
      ["runtime.file_upload_operations", state.files.upload.operations, "count"],
      ["runtime.file_upload_bytes", state.files.upload.bytes, "bytes"],
      ["runtime.file_upload_latency", state.files.upload.latencyMs.average, "milliseconds"],
      ["runtime.file_upload_latency_max", state.files.upload.latencyMs.max, "milliseconds"],
      ["runtime.file_download_operations", state.files.download.operations, "count"],
      ["runtime.file_download_bytes", state.files.download.bytes, "bytes"],
      ["runtime.file_download_latency", state.files.download.latencyMs.average, "milliseconds"],
      ["runtime.file_download_latency_max", state.files.download.latencyMs.max, "milliseconds"],
      ["runtime.file_provider_errors", state.files.providerErrors.total, "count"],
      ["runtime.file_provider_probe_errors", state.files.providerErrors.probe, "count"],
      ["runtime.file_provider_put_errors", state.files.providerErrors.put, "count"],
      ["runtime.file_provider_open_errors", state.files.providerErrors.open, "count"],
      ["runtime.file_provider_attributes_errors", state.files.providerErrors.attributes, "count"],
      ["runtime.file_provider_delete_errors", state.files.providerErrors.delete, "count"],
    ];
    const metrics: readonly RuntimeMetric[] = [
      ["runtime.connections", state.connections, "gauge"],
      ["runtime.operations", state.activeOperations, "gauge"],
      ["runtime.operation_callers", state.activeOperationCallers, "gauge"],
      ["runtime.sse_streams", state.activeSse, "gauge"],
      ["runtime.realtime_sessions", realtime?.activeSessions ?? 0, "gauge"],
      ["runtime.realtime_reserved_sessions", realtime?.reservedSessions ?? 0, "gauge"],
      ["runtime.realtime_active_principals", realtime?.activePrincipals ?? 0, "gauge"],
      ["runtime.realtime_handshake_windows", realtime?.trackedHandshakeWindows ?? 0, "gauge"],
      ["runtime.realtime_offers", realtime?.offers ?? 0, "count"],
      ["runtime.realtime_accepted", realtime?.accepted ?? 0, "count"],
      ["runtime.realtime_rejected", realtime?.rejected ?? 0, "count"],
      ["runtime.realtime_overloaded", realtime?.overloaded ?? 0, "count"],
      ["runtime.realtime_failed", realtime?.failed ?? 0, "count"],
      ["runtime.realtime_closed", realtime?.closed ?? 0, "count"],
      ["runtime.realtime_recovery_attempts", realtime?.recoveryAttempts ?? 0, "count"],
      ["runtime.realtime_recovery_accepted", realtime?.recoveryAccepted ?? 0, "count"],
      ["runtime.realtime_recovery_rejected", realtime?.recoveryRejected ?? 0, "count"],
      ["runtime.realtime_recovery_failed", realtime?.recoveryFailed ?? 0, "count"],
      ["runtime.realtime_closed_client", realtime?.closeReasons.client ?? 0, "count"],
      ["runtime.realtime_closed_authentication", realtime?.closeReasons.authentication ?? 0, "count"],
      ["runtime.realtime_closed_transport", realtime?.closeReasons.transport ?? 0, "count"],
      ["runtime.realtime_closed_handler", realtime?.closeReasons.handler ?? 0, "count"],
      ["runtime.realtime_closed_draining", realtime?.closeReasons.draining ?? 0, "count"],
      ["runtime.realtime_closed_setup", realtime?.closeReasons.setup ?? 0, "count"],
      ["runtime.realtime_health_sampled_peers", realtime?.health.sampledPeers ?? 0, "gauge"],
      ["runtime.realtime_health_sample_failures", realtime?.health.sampleFailures ?? 0, "gauge"],
      ["runtime.realtime_direct_paths", realtime?.health.directPaths ?? 0, "gauge"],
      ["runtime.realtime_relay_paths", realtime?.health.relayPaths ?? 0, "gauge"],
      ["runtime.realtime_udp_paths", realtime?.health.udpPaths ?? 0, "gauge"],
      ["runtime.realtime_tcp_paths", realtime?.health.tcpPaths ?? 0, "gauge"],
      ["runtime.realtime_round_trip_time", realtime?.health.roundTripTimeAverageMs ?? 0, "milliseconds"],
      ["runtime.realtime_round_trip_time_max", realtime?.health.roundTripTimeMaxMs ?? 0, "milliseconds"],
      ["runtime.realtime_jitter_max", realtime?.health.jitterMaxMs ?? 0, "milliseconds"],
      ["runtime.realtime_packets", realtime?.health.packets ?? 0, "gauge"],
      ["runtime.realtime_packets_lost", realtime?.health.packetsLost ?? 0, "gauge"],
      ["runtime.realtime_frames", realtime?.health.frames ?? 0, "gauge"],
      ["runtime.realtime_frames_dropped", realtime?.health.framesDropped ?? 0, "gauge"],
      ["runtime.realtime_available_incoming_bitrate", realtime?.health.availableIncomingBitrate ?? 0, "gauge"],
      ["runtime.realtime_available_outgoing_bitrate", realtime?.health.availableOutgoingBitrate ?? 0, "gauge"],
      ["runtime.realtime_data_channel_buffered_amount", realtime?.health.dataChannelBufferedAmountMax ?? 0, "bytes"],
      ["runtime.realtime_native_queue_drops", realtime?.health.nativeQueueDrops ?? 0, "count"],
      ["runtime.realtime_native_process_reserved_bytes", realtime?.health.nativeProcessReservedBytes ?? 0, "bytes"],
      ["runtime.realtime_native_process_queue_saturations", realtime?.health.nativeProcessQueueSaturations ?? 0, "count"],
      ["runtime.realtime_native_generation_queue_saturations", realtime?.health.nativeGenerationQueueSaturations ?? 0, "count"],
      ["runtime.realtime_native_queue_limit_terminations", realtime?.health.nativeQueueLimitTerminations ?? 0, "count"],
      ["runtime.realtime_native_process_budget_terminations", realtime?.health.nativeProcessBudgetTerminations ?? 0, "count"],
      ["runtime.realtime_native_generation_budget_terminations", realtime?.health.nativeGenerationBudgetTerminations ?? 0, "count"],
      ["runtime.realtime_data_channel_pressure", realtime?.health.dataChannelPressure ?? 0, "count"],
      ["runtime.realtime_stream_capacity_pressure", realtime?.health.streamCapacityPressure ?? 0, "count"],
      ["runtime.realtime_stream_buffer_pressure", realtime?.health.streamBufferPressure ?? 0, "count"],
      ["runtime.realtime_handler_saturation", realtime?.health.handlerSaturation ?? 0, "count"],
      ["runtime.realtime_resource_saturation", realtime?.health.resourceSaturation ?? 0, "count"],
      ["runtime.realtime_auxiliary_peers", realtime?.resources.active.auxiliaryPeers ?? 0, "gauge"],
      ["runtime.realtime_decoded_streams", realtime?.resources.active.decodedStreams ?? 0, "gauge"],
      ["runtime.realtime_media_sources", realtime?.resources.active.mediaSources ?? 0, "gauge"],
      ["runtime.realtime_tracks", realtime?.resources.active.tracks ?? 0, "gauge"],
      ["runtime.realtime_auxiliary_peer_saturation", realtime?.resources.saturated.auxiliaryPeers ?? 0, "count"],
      ["runtime.realtime_decoded_stream_saturation", realtime?.resources.saturated.decodedStreams ?? 0, "count"],
      ["runtime.realtime_media_source_saturation", realtime?.resources.saturated.mediaSources ?? 0, "count"],
      ["runtime.realtime_track_saturation", realtime?.resources.saturated.tracks ?? 0, "count"],
      ["runtime.subscriptions", state.reactive.queryListeners + state.reactive.eventListeners, "gauge"],
      ["runtime.subscription_entries", state.reactive.sharedEntries, "gauge"],
      ["runtime.subscription_result_bytes", state.reactive.resultBytes, "bytes"],
      ["runtime.subscription_history_items", state.reactive.historyTransitions, "gauge"],
      ["runtime.subscription_history_bytes", state.reactive.historyBytes, "bytes"],
      ["runtime.read_queue_items", state.reader.queue.queuedItems, "gauge"],
      ["runtime.read_queue_bytes", state.reader.queue.queuedBytes, "bytes"],
      ["runtime.read_queue_age", state.reader.queue.oldestAgeMs, "milliseconds"],
      ["runtime.write_queue_items", state.writer.queue.queuedItems, "gauge"],
      ["runtime.write_queue_bytes", state.writer.queue.queuedBytes, "bytes"],
      ["runtime.write_queue_age", state.writer.queue.oldestAgeMs, "milliseconds"],
      ["runtime.revalidation_active", state.reactive.revalidation.active, "gauge"],
      ["runtime.revalidation_queue_items", state.reactive.revalidation.queue.queuedItems, "gauge"],
      ["runtime.revalidation_queue_bytes", state.reactive.revalidation.queue.queuedBytes, "bytes"],
      ["runtime.revalidation_queue_age", state.reactive.revalidation.queue.oldestAgeMs, "milliseconds"],
      ["runtime.publication_items", state.publication.items, "gauge"],
      ["runtime.publication_bytes", state.publication.bytes, "bytes"],
      ["runtime.publication_age", state.publication.oldestAgeMs, "milliseconds"],
      ["runtime.auth_capture_bytes", state.authCaptureBudget.bytes, "bytes"],
      ["runtime.sse_outbound_bytes", state.sseBudget.bytes, "bytes"],
      ["runtime.database_bytes", state.storage.databaseBytes, "bytes"],
      ["runtime.wal_bytes", state.storage.walBytes, "bytes"],
      ["runtime.checkpoint_completed", checkpoint === null ? 0 : 1, "gauge"],
      ["runtime.checkpoint_busy", checkpoint?.busy ?? 0, "gauge"],
      ["runtime.checkpoint_total_frames", checkpoint?.totalFrames ?? 0, "gauge"],
      ["runtime.checkpoint_checkpointed_frames", checkpoint?.checkpointedFrames ?? 0, "gauge"],
      ["runtime.checkpoint_residual_frames", checkpoint?.residualFrames ?? 0, "gauge"],
      ["runtime.checkpoint_duration", checkpoint?.durationMs ?? 0, "milliseconds"],
      ["runtime.checkpoint_age", state.storage.lastCheckpointAtMs === null
        ? 0
        : Math.max(0, Date.now() - state.storage.lastCheckpointAtMs), "milliseconds"],
      ["runtime.recovered_from_crash", state.storage.recoveredFromCrash ? 1 : 0, "gauge"],
      ["runtime.mutation_replay_records", state.storage.mutationRecords, "gauge"],
      ["runtime.mutation_replay_bytes", state.storage.mutationResultBytes, "bytes"],
      ["runtime.telemetry_queue_records", state.telemetry.queuedRecords, "gauge"],
      ["runtime.telemetry_queue_bytes", state.telemetry.queuedBytes, "bytes"],
      ["runtime.telemetry_queue_age", state.telemetry.oldestAgeMs, "milliseconds"],
      ["runtime.telemetry_local_queue_records", state.telemetry.localSink.pendingRecords, "gauge"],
      ["runtime.telemetry_local_queue_bytes", state.telemetry.localSink.pendingBytes, "bytes"],
      ["runtime.telemetry_export_attempts", state.telemetry.exporter.attempts, "count"],
      ["runtime.telemetry_export_failures", state.telemetry.exporter.failures, "count"],
      ["runtime.telemetry_export_timeouts", state.telemetry.exporter.timeouts, "count"],
      ["runtime.telemetry_export_duration", state.telemetry.exporter.lastDurationMs ?? 0, "milliseconds"],
      ["runtime.telemetry_drops", telemetryDrops, "count"],
      ["runtime.rss_bytes", process.memoryUsage().rss, "bytes"],
      ["runtime.cpu_cores", cores, "gauge"],
      ["runtime.event_loop_drift", eventLoopDrift, "milliseconds"],
      ...fileMetrics,
    ];
    for (const [name, value, unit] of metrics) {
      this.options.telemetry.recordMetric({ name, value, unit });
    }
    for (const [outcome, value] of Object.entries(state.files.upload.outcomes)) {
      if (value === 0) continue;
      this.options.telemetry.recordMetric({
        name: "runtime.file_upload_outcomes",
        value,
        unit: "count",
        labels: { outcome: outcome as keyof typeof state.files.upload.outcomes },
      });
    }
    for (const [outcome, value] of Object.entries(state.files.download.outcomes)) {
      if (value === 0) continue;
      this.options.telemetry.recordMetric({
        name: "runtime.file_download_outcomes",
        value,
        unit: "count",
        labels: { outcome: outcome as keyof typeof state.files.download.outcomes },
      });
    }
    this.options.sampleRealtime();
    this.options.flushDeliveryFailures();
  }
}
