/**
 * The function registry: maps dot-joined addresses ("messages.list") to
 * registered functions. Addresses derive from module paths + export names,
 * exactly mirroring what codegen puts on the generated `api` object.
 */
import { getRef } from "@dbzz/core";
import { isRegisteredFunction, type AnyRegistered } from "./functions.ts";
import type { Schema, ScheduledHandler } from "./schema.ts";

export class Registry {
  readonly functions = new Map<string, AnyRegistered>();
  private readonly addressByObject = new Map<object, string>();

  /** `modules` is keyed by dot path: functions/messages.ts -> "messages". */
  constructor(modules: Record<string, Record<string, unknown>>) {
    for (const [modulePath, exports] of Object.entries(modules)) {
      if (modulePath === "events" || modulePath.startsWith("events.")) {
        throw new Error(
          `function module "${modulePath}": the "events" namespace is reserved for event-table references`,
        );
      }
      for (const [exportName, value] of Object.entries(exports)) {
        if (!isRegisteredFunction(value)) continue;
        const address = `${modulePath}.${exportName}`;
        if (this.functions.has(address)) {
          throw new Error(`duplicate function address "${address}"`);
        }
        this.functions.set(address, value);
        this.addressByObject.set(value, address);
      }
    }
  }

  get(address: string): AnyRegistered | undefined {
    return this.functions.get(address);
  }

  kindOf(address: string): string | undefined {
    return this.functions.get(address)?.kind;
  }

  /** Resolve a .scheduled(...) handler (string | ref | registered fn) to an address. */
  resolveHandler(handler: ScheduledHandler, where: string): string {
    let address: string;
    if (typeof handler === "string") {
      address = handler;
    } else if (isRegisteredFunction(handler)) {
      const found = this.addressByObject.get(handler);
      if (found === undefined) {
        throw new Error(`${where}: scheduled handler is not exported from any function module`);
      }
      address = found;
    } else {
      address = getRef(handler as never);
    }
    const kind = this.kindOf(address);
    if (kind === undefined) {
      throw new Error(`${where}: scheduled handler "${address}" does not exist`);
    }
    if (kind !== "mutation" && kind !== "procedure") {
      throw new Error(`${where}: scheduled handler "${address}" must be a mutation or procedure, got ${kind}`);
    }
    return address;
  }

  /** Validate every scheduled table's handler up front; returns table -> address. */
  resolveScheduled(schema: Schema): Map<string, string> {
    const resolved = new Map<string, string>();
    for (const [table, def] of Object.entries(schema.tables)) {
      if (def.scheduledHandler !== null) {
        resolved.set(table, this.resolveHandler(def.scheduledHandler, `table ${table}`));
      }
    }
    return resolved;
  }
}
