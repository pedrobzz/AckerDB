import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import type { NativeRtcConfigurationBinding } from "./native/binding.ts";

export type RealtimeNetworkAdapterType =
  | "unknown"
  | "ethernet"
  | "wifi"
  | "cellular"
  | "vpn"
  | "loopback"
  | "any"
  | "cellular-2g"
  | "cellular-3g"
  | "cellular-4g"
  | "cellular-5g";

export interface RealtimeAddressMapping {
  readonly privateAddress: string;
  readonly publicAddress: string;
}

export interface RealtimeIceTimingOptions {
  readonly connectionReceivingTimeoutMs?: number;
  readonly backupCandidatePairPingIntervalMs?: number;
  readonly checkIntervalStrongConnectivityMs?: number;
  readonly checkIntervalWeakConnectivityMs?: number;
  readonly checkMinIntervalMs?: number;
  readonly unwritableTimeoutMs?: number;
  readonly inactiveTimeoutMs?: number;
  readonly stunCandidateKeepaliveIntervalMs?: number;
}

export interface RealtimeServerNetworkOptions {
  /** Allow only these operating-system interface names. */
  readonly interfaces?: {
    readonly include?: readonly string[];
    readonly exclude?: readonly string[];
  };
  /** Candidate UDP ports opened by each native peer. */
  readonly udpPortRange?: {
    readonly min: number;
    readonly max: number;
  };
  /** One-to-one NAT mappings applied only to advertised host candidates. */
  readonly advertisedAddressMappings?: readonly RealtimeAddressMapping[];
  /** Adapter classes libwebrtc must not gather from. Loopback is ignored by default. */
  readonly ignoreAdapterTypes?: readonly RealtimeNetworkAdapterType[];
  readonly ice?: RealtimeIceTimingOptions;
}

export interface RealtimeNetworkDiagnostic {
  readonly includedInterfaces: readonly string[] | null;
  readonly excludedInterfaces: readonly string[];
  readonly ignoredAdapterTypes: readonly RealtimeNetworkAdapterType[];
  readonly udpPortRange: { readonly min: number; readonly max: number } | null;
  readonly advertisedAddressMappings: number;
  readonly iceTimingOverrides: number;
}

export interface ResolvedRealtimeServerNetwork {
  readonly ignoredInterfaces: readonly string[];
  readonly ignoredAdapterTypes: readonly RealtimeNetworkAdapterType[];
  readonly nativeConfiguration: Readonly<NativeRtcConfigurationBinding>;
  readonly addressMappings: readonly RealtimeAddressMapping[];
  readonly diagnostic: RealtimeNetworkDiagnostic;
}

export function resolveRealtimeServerNetwork(
  options: RealtimeServerNetworkOptions = {},
  interfaces = networkInterfaces(),
): ResolvedRealtimeServerNetwork {
  const available = Object.keys(interfaces).sort();
  const include = names(options.interfaces?.include, "interfaces.include");
  const exclude = names(options.interfaces?.exclude, "interfaces.exclude");
  for (const name of [...include, ...exclude]) {
    if (!available.includes(name)) {
      throw new TypeError(`realtime network interface "${name}" does not exist`);
    }
  }
  if (include.length === 0 && options.interfaces?.include !== undefined) {
    throw new TypeError("realtime interfaces.include must not be empty");
  }
  for (const name of include) {
    if (exclude.includes(name)) {
      throw new TypeError(
        `realtime network interface "${name}" cannot be included and excluded`,
      );
    }
  }

  const ignoredInterfaces = include.length === 0
    ? exclude
    : available.filter((name) => !include.includes(name) || exclude.includes(name));
  const ignoredAdapterTypes = Object.freeze([
    ...(options.ignoreAdapterTypes ?? ["loopback"]),
  ]);
  const adapterTypes = new Set<RealtimeNetworkAdapterType>([
    "unknown",
    "ethernet",
    "wifi",
    "cellular",
    "vpn",
    "loopback",
    "any",
    "cellular-2g",
    "cellular-3g",
    "cellular-4g",
    "cellular-5g",
  ]);
  for (const type of ignoredAdapterTypes) {
    if (!adapterTypes.has(type)) {
      throw new TypeError(`realtime ignored adapter type "${type}" is invalid`);
    }
  }
  if (new Set(ignoredAdapterTypes).size !== ignoredAdapterTypes.length) {
    throw new TypeError("realtime ignoreAdapterTypes contains duplicates");
  }

  const range = options.udpPortRange;
  if (range !== undefined) {
    port(range.min, "udpPortRange.min");
    port(range.max, "udpPortRange.max");
    if (range.min > range.max) {
      throw new RangeError(
        "realtime udpPortRange.min must not exceed udpPortRange.max",
      );
    }
  }

  const localAddresses = new Set(
    Object.values(interfaces)
      .flatMap((entries) => entries ?? [])
      .map((entry) => entry.address),
  );
  const addressMappings = (options.advertisedAddressMappings ?? []).map(
    (mapping, index) => {
      const privateFamily = isIP(mapping.privateAddress);
      const publicFamily = isIP(mapping.publicAddress);
      if (privateFamily === 0 || publicFamily === 0) {
        throw new TypeError(
          `realtime advertisedAddressMappings[${index}] must contain IP addresses`,
        );
      }
      if (privateFamily !== publicFamily) {
        throw new TypeError(
          `realtime advertisedAddressMappings[${index}] must use one address family`,
        );
      }
      if (!localAddresses.has(mapping.privateAddress)) {
        throw new TypeError(
          `realtime advertised private address "${mapping.privateAddress}" is not local`,
        );
      }
      return Object.freeze({ ...mapping });
    },
  );
  if (
    new Set(addressMappings.map((mapping) => mapping.privateAddress)).size !==
      addressMappings.length
  ) {
    throw new TypeError(
      "realtime advertisedAddressMappings contains duplicate private addresses",
    );
  }

  const nativeConfiguration = Object.freeze({
    ...(range === undefined
      ? {}
      : { minPort: range.min, maxPort: range.max }),
    ...iceConfiguration(options.ice),
  });
  const diagnostic = Object.freeze({
    includedInterfaces: include.length === 0 ? null : Object.freeze(include),
    excludedInterfaces: Object.freeze(ignoredInterfaces),
    ignoredAdapterTypes,
    udpPortRange: range === undefined ? null : Object.freeze({ ...range }),
    advertisedAddressMappings: addressMappings.length,
    iceTimingOverrides: Object.keys(iceConfiguration(options.ice)).length,
  });
  return Object.freeze({
    ignoredInterfaces: Object.freeze(ignoredInterfaces),
    ignoredAdapterTypes,
    nativeConfiguration,
    addressMappings: Object.freeze(addressMappings),
    diagnostic,
  });
}

function names(value: readonly string[] | undefined, name: string): string[] {
  if (value === undefined) return [];
  if (value.length > 64) throw new RangeError(`realtime ${name} exceeds 64 entries`);
  const result = value.map((entry) => {
    if (entry.length === 0 || entry.length > 256) {
      throw new TypeError(`realtime ${name} contains an invalid interface name`);
    }
    return entry;
  });
  if (new Set(result).size !== result.length) {
    throw new TypeError(`realtime ${name} contains duplicates`);
  }
  return result;
}

function port(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1_024 || value > 65_535) {
    throw new RangeError(`realtime ${name} must be an integer from 1024 to 65535`);
  }
}

function iceConfiguration(
  options: RealtimeIceTimingOptions | undefined,
): Readonly<NativeRtcConfigurationBinding> {
  if (options === undefined) return {};
  return {
    ...timing(
      options.connectionReceivingTimeoutMs,
      "connectionReceivingTimeoutMs",
      "iceConnectionReceivingTimeoutMs",
    ),
    ...timing(
      options.backupCandidatePairPingIntervalMs,
      "backupCandidatePairPingIntervalMs",
      "iceBackupCandidatePairPingIntervalMs",
    ),
    ...timing(
      options.checkIntervalStrongConnectivityMs,
      "checkIntervalStrongConnectivityMs",
      "iceCheckIntervalStrongConnectivityMs",
    ),
    ...timing(
      options.checkIntervalWeakConnectivityMs,
      "checkIntervalWeakConnectivityMs",
      "iceCheckIntervalWeakConnectivityMs",
    ),
    ...timing(
      options.checkMinIntervalMs,
      "checkMinIntervalMs",
      "iceCheckMinIntervalMs",
    ),
    ...timing(
      options.unwritableTimeoutMs,
      "unwritableTimeoutMs",
      "iceUnwritableTimeoutMs",
    ),
    ...timing(
      options.inactiveTimeoutMs,
      "inactiveTimeoutMs",
      "iceInactiveTimeoutMs",
    ),
    ...timing(
      options.stunCandidateKeepaliveIntervalMs,
      "stunCandidateKeepaliveIntervalMs",
      "stunCandidateKeepaliveIntervalMs",
    ),
  };
}

function timing(
  value: number | undefined,
  name: string,
  nativeName: keyof NativeRtcConfigurationBinding,
): Partial<NativeRtcConfigurationBinding> {
  if (value === undefined) return {};
  if (
    !Number.isSafeInteger(value) ||
    value < 10 ||
    value > 3_600_000
  ) {
    throw new RangeError(
      `realtime ice.${name} must be an integer from 10 to 3600000`,
    );
  }
  return { [nativeName]: value };
}
