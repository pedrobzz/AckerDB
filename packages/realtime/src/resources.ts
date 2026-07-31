import { AckerDBError } from "@ackerdb/server";
import type {
  RealtimeGlobalResourceKind,
  RealtimeGlobalResourceLimits,
  RealtimeGlobalResourceSnapshot,
} from "@ackerdb/server/realtime-host";

export type {
  RealtimeGlobalResourceKind,
  RealtimeGlobalResourceLimits,
  RealtimeGlobalResourceSnapshot,
} from "@ackerdb/server/realtime-host";

const RESOURCE_LIMIT = Object.freeze({
  auxiliaryPeers: "maxAuxiliaryPeers",
  decodedStreams: "maxDecodedStreams",
  mediaSources: "maxMediaSources",
  tracks: "maxTracks",
} as const satisfies Record<
  RealtimeGlobalResourceKind,
  keyof RealtimeGlobalResourceLimits
>);

/** N-API and the native semaphore represent queue capacity as an unsigned u32. */
export const MAX_NATIVE_QUEUE_BYTES = 0xffff_ffff;

export function nativeQueueBytes(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  if (value > MAX_NATIVE_QUEUE_BYTES) {
    throw new RangeError(`${label} must not exceed ${MAX_NATIVE_QUEUE_BYTES}`);
  }
  return value;
}

export const REALTIME_GLOBAL_RESOURCE_DEFAULTS = Object.freeze({
  maxAuxiliaryPeers: 2_048,
  maxDecodedStreams: 32_768,
  maxMediaSources: 32_768,
  maxTracks: 131_072,
  maxQueuedBytes: 512 * 1024 * 1024,
}) satisfies RealtimeGlobalResourceLimits;

export class RealtimeGlobalResourceBudget {
  private readonly active: Record<RealtimeGlobalResourceKind, number> = {
    auxiliaryPeers: 0,
    decodedStreams: 0,
    mediaSources: 0,
    tracks: 0,
  };
  private readonly saturated: Record<RealtimeGlobalResourceKind, number> = {
    auxiliaryPeers: 0,
    decodedStreams: 0,
    mediaSources: 0,
    tracks: 0,
  };

  constructor(readonly limits: RealtimeGlobalResourceLimits) {
    for (const [name, value] of Object.entries(limits)) {
      if (name === "maxQueuedBytes") {
        nativeQueueBytes(value, `resourceLimits.${name}`);
      } else if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`resourceLimits.${name} must be a positive safe integer`);
      }
    }
    this.limits = Object.freeze({ ...limits });
  }

  claim(kind: RealtimeGlobalResourceKind): () => void {
    if (this.active[kind] >= this.limits[RESOURCE_LIMIT[kind]]) {
      this.saturated[kind]++;
      throw new AckerDBError(
        "overloaded",
        `realtime global ${kind} capacity is full`,
        { resource: "connection", retryable: true, retryAfterMs: 0 },
      );
    }
    this.active[kind]++;
    let owned = true;
    return () => {
      if (!owned) return;
      owned = false;
      this.active[kind]--;
    };
  }

  snapshot(): RealtimeGlobalResourceSnapshot {
    return Object.freeze({
      limits: this.limits,
      active: Object.freeze({ ...this.active }),
      saturated: Object.freeze({ ...this.saturated }),
    });
  }
}
