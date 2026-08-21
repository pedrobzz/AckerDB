/** Addressed application definitions and their runtime indexes. */
import { APPLICATION_ADDRESS_ROOT } from "@ackerdb/core";
import type { AnyRegistered } from "./functions.ts";
import type { AnyRegisteredChannel } from "../channels/definition.ts";
import type { AnyJobDefinition } from "../jobs/definition.ts";
import type { CollectedDefinition, Definition } from "../definitions.ts";
import { checkRequirementAgainstVocabulary } from "../auth/scopes.ts";

export class Registry {
  private readonly functionDefinitions = new Map<string, AnyRegistered>();
  private readonly channelDefinitions = new Map<string, AnyRegisteredChannel>();
  private readonly jobDefinitions = new Map<string, AnyJobDefinition>();
  private readonly ownerByKey = new Map<string, CollectedDefinition>();
  private readonly ownerByObject = new Map<object, CollectedDefinition>();

  readonly functions: ReadonlyMap<string, AnyRegistered> = this.functionDefinitions;
  readonly channels: ReadonlyMap<string, AnyRegisteredChannel> = this.channelDefinitions;
  readonly jobs: ReadonlyMap<string, AnyJobDefinition> = this.jobDefinitions;

  static from(collected: readonly CollectedDefinition[]): Registry {
    const registry = new Registry();
    for (const item of collected) registry.add(item);
    return registry;
  }

  add(item: CollectedDefinition): void {
    const { definition, name } = item;
    switch (definition.kind) {
      case "query":
      case "mutation":
      case "procedure":
      case "sse": {
        const address = `${APPLICATION_ADDRESS_ROOT}.${name}`;
        this.registerAddress(address, item);
        this.functionDefinitions.set(address, definition);
        break;
      }
      case "channel": {
        const address = `${APPLICATION_ADDRESS_ROOT}.${name}`;
        this.registerAddress(address, item);
        this.channelDefinitions.set(address, definition);
        break;
      }
      case "job":
        this.registerAddress(name, item);
        this.jobDefinitions.set(name, definition);
        break;
      case "http":
        break;
      default:
        definition satisfies never;
        break;
    }
  }

  /** Every declared scope requirement must belong to the application vocabulary. */
  checkScopeRequirements(applicationScopes: readonly string[] | undefined): void {
    const vocabulary = applicationScopes ?? [];
    for (const [address, fn] of this.functions) {
      if (fn.scopes === undefined) continue;
      checkRequirementAgainstVocabulary(fn.scopes, vocabulary, `function "${address}"`);
    }
  }

  private registerAddress(address: string, item: CollectedDefinition): void {
    const keyOwner = this.ownerByKey.get(address);
    if (keyOwner !== undefined) {
      throw new Error(
        `server definition "${address}" is published by both "${keyOwner.origin}" and "${item.origin}"`,
      );
    }
    const objectOwner = this.ownerByObject.get(item.definition);
    if (objectOwner !== undefined) {
      throw new Error(
        `one definition is exported as both "${objectOwner.name}" from "${objectOwner.origin}" and "${item.name}" from "${item.origin}"`,
      );
    }
    this.ownerByKey.set(address, item);
    this.ownerByObject.set(item.definition, item);
  }

  get(address: string): AnyRegistered | undefined {
    return this.functionDefinitions.get(address);
  }

  getChannel(address: string): AnyRegisteredChannel | undefined {
    return this.channelDefinitions.get(address);
  }

  getJob(name: string): AnyJobDefinition | undefined {
    return this.jobDefinitions.get(name);
  }

  kindOf(address: string): Definition["kind"] | undefined {
    return this.functionDefinitions.get(address)?.kind ??
      this.channelDefinitions.get(address)?.kind ??
      this.jobDefinitions.get(address)?.kind;
  }

  addressOf(value: object): string | undefined {
    const item = this.ownerByObject.get(value);
    if (item === undefined) return undefined;
    return item.definition.kind === "job"
      ? item.name
      : `${APPLICATION_ADDRESS_ROOT}.${item.name}`;
  }
}
