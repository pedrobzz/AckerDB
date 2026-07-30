import { AckerDBError } from "../shared/errors.ts";

export type RealtimeGlobalResourceKind =
  | "auxiliaryPeers"
  | "decodedStreams"
  | "mediaSources"
  | "tracks";

export interface RealtimeGlobalResourceLimits {
  readonly maxAuxiliaryPeers: number;
  readonly maxDecodedStreams: number;
  readonly maxMediaSources: number;
  readonly maxTracks: number;
}

export interface RealtimeGlobalResourceSnapshot {
  readonly limits: RealtimeGlobalResourceLimits;
  readonly active: Readonly<Record<RealtimeGlobalResourceKind, number>>;
  readonly saturated: Readonly<Record<RealtimeGlobalResourceKind, number>>;
}

const RESOURCE_LIMIT = Object.freeze({
  auxiliaryPeers: "maxAuxiliaryPeers",
  decodedStreams: "maxDecodedStreams",
  mediaSources: "maxMediaSources",
  tracks: "maxTracks",
} as const satisfies Record<
  RealtimeGlobalResourceKind,
  keyof RealtimeGlobalResourceLimits
>);

export const REALTIME_GLOBAL_RESOURCE_DEFAULTS = Object.freeze({
  maxAuxiliaryPeers: 16_384,
  maxDecodedStreams: 32_768,
  maxMediaSources: 32_768,
  maxTracks: 131_072,
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
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`resourceLimits.${name} must be positive`);
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
