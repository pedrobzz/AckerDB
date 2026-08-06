import { createHash } from "node:crypto";
import { stableEncode } from "@ackerdb/core";
import type { ExternalAccount, Principal } from "../auth/credentials.ts";

/** Network identity used only to group anonymous transport work fairly. */
export interface TransportSource {
  readonly family: string;
  readonly address: string;
}

const UNKNOWN_TRANSPORT_SOURCE: TransportSource = Object.freeze({
  family: "unknown",
  address: "unknown",
});

export function transportSource(source: TransportSource | null): TransportSource {
  if (source === null) return UNKNOWN_TRANSPORT_SOURCE;
  if (
    typeof source.family !== "string" ||
    source.family.length === 0 ||
    typeof source.address !== "string" ||
    source.address.length === 0
  ) {
    throw new TypeError("transport source requires a family and address");
  }
  return Object.freeze({ family: source.family, address: source.address });
}

function fairnessKey(owner: unknown): string {
  return createHash("sha256")
    .update(stableEncode(["caller-fairness-v1", owner]))
    .digest("base64url");
}

/** Fixed-width ownership for verified credential work before application Identity exists. */
export function externalAccountFairnessKey(account: ExternalAccount): string {
  return fairnessKey(["external-account", account.issuer, account.subject]);
}

/** Fixed-width, non-sensitive ownership key shared by every external transport. */
export function callerFairnessKey(principal: Principal, source: TransportSource): string {
  return fairnessKey(principal.kind === "user"
    ? ["identity", principal.identity]
    : principal.kind === "workload"
      ? ["principal", principal.kind, principal.issuer, principal.subject]
      : principal.kind === "anonymous"
        ? ["source", source.family, source.address]
        : ["system"]);
}
