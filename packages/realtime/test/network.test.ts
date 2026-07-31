import { describe, expect, test } from "bun:test";
import type { NetworkInterfaceInfo } from "node:os";
import { resolveRealtimeServerNetwork } from "../src/network.ts";

const interfaces = {
  en0: [{
    address: "10.0.0.4",
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:01",
    internal: false,
    cidr: "10.0.0.4/24",
  }],
  utun4: [{
    address: "fd00::4",
    netmask: "ffff:ffff:ffff:ffff::",
    family: "IPv6",
    mac: "00:00:00:00:00:02",
    internal: false,
    cidr: "fd00::4/64",
    scopeid: 0,
  }],
} satisfies Record<string, NetworkInterfaceInfo[]>;

describe("realtime server network", () => {
  test("resolves one deployment policy into native and redacted diagnostics", () => {
    const resolved = resolveRealtimeServerNetwork({
      interfaces: { include: ["en0"] },
      udpPortRange: { min: 50_000, max: 50_100 },
      advertisedAddressMappings: [{
        privateAddress: "10.0.0.4",
        publicAddress: "203.0.113.4",
      }],
      ignoreAdapterTypes: ["loopback", "vpn"],
      ice: {
        connectionReceivingTimeoutMs: 5_000,
        unwritableTimeoutMs: 2_000,
      },
    }, interfaces);

    expect(resolved).toMatchObject({
      ignoredInterfaces: ["utun4"],
      ignoredAdapterTypes: ["loopback", "vpn"],
      nativeConfiguration: {
        minPort: 50_000,
        maxPort: 50_100,
        iceConnectionReceivingTimeoutMs: 5_000,
        iceUnwritableTimeoutMs: 2_000,
      },
      addressMappings: [{
        privateAddress: "10.0.0.4",
        publicAddress: "203.0.113.4",
      }],
      diagnostic: {
        includedInterfaces: ["en0"],
        excludedInterfaces: ["utun4"],
        advertisedAddressMappings: 1,
        iceTimingOverrides: 2,
      },
    });
    expect(JSON.stringify(resolved.diagnostic)).not.toContain("10.0.0.4");
    expect(JSON.stringify(resolved.diagnostic)).not.toContain("203.0.113.4");
  });

  test("rejects contradictory or unusable deployment policy at startup", () => {
    expect(() =>
      resolveRealtimeServerNetwork({
        interfaces: { include: ["missing"] },
      }, interfaces)
    ).toThrow('interface "missing" does not exist');
    expect(() =>
      resolveRealtimeServerNetwork({
        interfaces: { include: ["en0"], exclude: ["en0"] },
      }, interfaces)
    ).toThrow("cannot be included and excluded");
    expect(() =>
      resolveRealtimeServerNetwork({
        udpPortRange: { min: 60_000, max: 50_000 },
      }, interfaces)
    ).toThrow("must not exceed");
    expect(() =>
      resolveRealtimeServerNetwork({
        advertisedAddressMappings: [{
          privateAddress: "192.0.2.20",
          publicAddress: "203.0.113.20",
        }],
      }, interfaces)
    ).toThrow("is not local");
    expect(() =>
      resolveRealtimeServerNetwork({
        ice: { inactiveTimeoutMs: 1 },
      }, interfaces)
    ).toThrow("must be an integer from 10");
  });
});
