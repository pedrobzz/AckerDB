import { ACKERDB_VERSION } from "./version.ts";

export class ProtocolError extends Error {
  constructor(
    readonly code: "malformed" | "version_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

export type ProtocolObject = Record<string, unknown>;

export function malformed(message: string): never {
  throw new ProtocolError("malformed", message);
}

export function protocolObject(
  value: unknown,
  name: string,
): ProtocolObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    malformed(`${name} must be an object`);
  }
  return value as ProtocolObject;
}

export function exactFields(
  value: ProtocolObject,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) malformed(`missing field ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      malformed(`unknown field ${key}`);
    }
  }
}

export function boundedString(
  value: unknown,
  name: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    malformed(`${name} must be a non-empty bounded string`);
  }
  return value;
}

/** Which end of the wire produced a frame, so a refusal can name both sides. */
export type FrameSender = "client" | "application";

// Long enough for any semantic version with prerelease and build metadata, and
// short enough that a peer cannot spend the refusal message on itself: the
// string lands in a server log and in a bounded outcome, so it is a field with
// a limit like every other framework-owned field.
const MAX_VERSION_LENGTH = 64;

/**
 * Every frame declares the AckerDB build that produced it, and a decoder
 * accepts exactly its own.
 *
 * There is no protocol number to negotiate with, because there was never a
 * compatibility on offer to negotiate: all eleven packages ship one lockstep
 * version with `workspace:X.Y.Z` interdependencies, so AckerDB X is contracted
 * to speak to AckerDB X and nothing else. A separate number could only have
 * promised what the contract refuses — "both releases speak protocol 6" reads
 * as "the older client can talk to the newer server" — while taxing every
 * reshape of the wire with a bump, which makes adding a field cheaper than
 * fixing one. What is left when it goes is the half that was doing work:
 * naming a mixed install, on the first frame that crosses, rather than at
 * whichever field the two builds happen to disagree about first.
 *
 * A mixed install is user error with a one-command fix, so the refusal names
 * both versions and the fix instead of a compatibility rule. The sender is what
 * keeps that sentence true from either end — the same refusal is raised by a
 * server reading a client's hello and by a client reading a server's welcome,
 * and only the decoding side knows which way the frame travelled.
 */
export function frameVersion(value: unknown, sender: FrameSender): void {
  const sent = boundedString(value, "frame version v", MAX_VERSION_LENGTH);
  if (sent === ACKERDB_VERSION) return;
  const application = sender === "application" ? sent : ACKERDB_VERSION;
  const client = sender === "client" ? sent : ACKERDB_VERSION;
  throw new ProtocolError(
    "version_mismatch",
    `this application runs AckerDB ${application} and this client is ${client}` +
      " — install matching versions",
  );
}
