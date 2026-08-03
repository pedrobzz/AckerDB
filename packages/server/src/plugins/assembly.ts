import { canonicalSchemaSnapshot } from "../schema/snapshot.ts";
import { isSchema } from "../schema/definition.ts";
import type { Descriptor } from "../validation/validator.ts";
import { assertIdentifier, BUILTIN_CONTEXT_FIELDS, isPluginDefinitionId } from "./identifiers.ts";
import {
  isPlainObject,
  isPluginContract,
  isPluginOperationSpec,
  type PluginContractTree,
} from "./contract.ts";
import type { PluginDependencyContracts } from "./capabilities.ts";
import { isPluginOperationImplementation } from "./builders.ts";
import {
  isPluginInstance,
  type PluginExportTree,
  type PluginInstance,
} from "./definition.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPluginInstance = PluginInstance<any, any, any, any, any>;
export type PluginMounts = Readonly<Record<string, AnyPluginInstance>>;

export interface PluginAssembly<Mounts extends PluginMounts = PluginMounts> {
  readonly mounts: Readonly<Mounts>;
  readonly order: readonly (keyof Mounts & string)[];
}

function assertExportTree(
  exports: unknown,
  path: string,
  active: WeakSet<object>,
): asserts exports is PluginExportTree {
  if (!isPlainObject(exports)) throw new TypeError(`${path} must be a plain object`);
  if (active.has(exports)) throw new TypeError(`${path} must be an acyclic tree`);
  active.add(exports);
  for (const [name, node] of Object.entries(exports)) {
    assertIdentifier(name, `${path} name`);
    if (isPluginOperationImplementation(node)) {
      if (!isPluginOperationSpec(node.spec) || typeof node.handler !== "function") {
        throw new TypeError(`${path}.${name} is a malformed Plugin operation implementation`);
      }
    } else {
      assertExportTree(node, `${path}.${name}`, active);
    }
  }
  active.delete(exports);
}

function sameDescriptor(left: Descriptor, right: Descriptor): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertProviderCompatible(
  required: PluginContractTree,
  provided: PluginExportTree,
  path: string,
): void {
  for (const [name, requirement] of Object.entries(required)) {
    const implementation = provided[name];
    const operationPath = `${path}.${name}`;
    if (isPluginOperationSpec(requirement)) {
      if (!isPluginOperationImplementation(implementation)) {
        throw new TypeError(`${operationPath} is missing from the provider`);
      }
      const providedSpec = implementation.spec;
      if (providedSpec.kind !== requirement.kind) {
        throw new TypeError(
          `${operationPath} is ${providedSpec.kind}, but the dependency requires ${requirement.kind}`,
        );
      }
      if (!sameDescriptor(providedSpec.argsDescriptor, requirement.argsDescriptor)) {
        throw new TypeError(`${operationPath} argument validators do not satisfy the dependency`);
      }
      if (!sameDescriptor(providedSpec.resultDescriptor, requirement.resultDescriptor)) {
        throw new TypeError(`${operationPath} result validator does not satisfy the dependency`);
      }
      continue;
    }
    if (!isPlainObject(implementation) || isPluginOperationImplementation(implementation)) {
      throw new TypeError(`${operationPath} namespace is missing from the provider`);
    }
    assertProviderCompatible(requirement, implementation as PluginExportTree, operationPath);
  }
}

function assertInstanceDescriptor(instance: AnyPluginInstance, mount: string): void {
  if (
    typeof instance.definitionId !== "string" ||
    !isPluginDefinitionId(instance.definitionId)
  ) {
    throw new TypeError(`plugin mount "${mount}" has an invalid definition id`);
  }
  if (!isSchema(instance.schema)) {
    throw new TypeError(`plugin mount "${mount}" has an invalid private schema`);
  }
  assertExportTree(instance.exports, `plugin mount "${mount}" exports`, new WeakSet());
  if (!isPlainObject(instance.dependencies) || !isPlainObject(instance.providers)) {
    throw new TypeError(`plugin mount "${mount}" has malformed dependencies`);
  }
  if (
    instance.lifecycle !== undefined &&
    typeof instance.lifecycle !== "function"
  ) {
    throw new TypeError(`plugin mount "${mount}" has a malformed lifecycle`);
  }
  for (const [slot, contract] of Object.entries(instance.dependencies)) {
    assertIdentifier(slot, `plugin mount "${mount}" dependency`);
    if (BUILTIN_CONTEXT_FIELDS.has(slot)) {
      throw new TypeError(
        `plugin mount "${mount}" dependency "${slot}" collides with a built-in context field`,
      );
    }
    if (!isPluginContract(contract)) {
      throw new TypeError(`plugin mount "${mount}" dependency "${slot}" has an invalid contract`);
    }
    if (!Object.hasOwn(instance.providers, slot)) {
      throw new TypeError(`plugin mount "${mount}" dependency "${slot}" has no provider`);
    }
  }
  for (const slot of Object.keys(instance.providers)) {
    if (!Object.hasOwn(instance.dependencies, slot)) {
      throw new TypeError(`plugin mount "${mount}" has undeclared provider "${slot}"`);
    }
  }
}

export function assemblePlugins<const Mounts extends PluginMounts>(
  plugins: Mounts,
): PluginAssembly<Mounts> {
  if (!isPlainObject(plugins)) {
    throw new TypeError("application plugins must be a plain object");
  }
  const mounts: Record<string, AnyPluginInstance> = {};
  const mountOf = new Map<AnyPluginInstance, string>();
  const schemaByDefinition = new Map<
    string,
    { readonly mount: string; readonly snapshot: string }
  >();
  for (const [mount, instance] of Object.entries(plugins)) {
    assertIdentifier(mount, "plugin mount");
    if (BUILTIN_CONTEXT_FIELDS.has(mount)) {
      throw new TypeError(`plugin mount "${mount}" collides with a built-in context field`);
    }
    if (!isPluginInstance(instance)) {
      throw new TypeError(`plugin mount "${mount}" must be a Plugin instance`);
    }
    const previousMount = mountOf.get(instance);
    if (previousMount !== undefined) {
      throw new TypeError(
        `Plugin instance is mounted twice as "${previousMount}" and "${mount}"`,
      );
    }
    assertInstanceDescriptor(instance, mount);
    const snapshot = canonicalSchemaSnapshot(instance.schema);
    const established = schemaByDefinition.get(instance.definitionId);
    if (established !== undefined && established.snapshot !== snapshot) {
      throw new TypeError(
        `Plugin definition "${instance.definitionId}" has conflicting private schemas at mounts "${established.mount}" and "${mount}"`,
      );
    }
    if (established === undefined) {
      schemaByDefinition.set(instance.definitionId, { mount, snapshot });
    }
    mounts[mount] = instance;
    mountOf.set(instance, mount);
  }

  for (const [mount, instance] of Object.entries(mounts)) {
    for (const [slot, contract] of Object.entries(
      instance.dependencies as PluginDependencyContracts,
    )) {
      const provider = instance.providers[slot];
      if (!isPluginInstance(provider)) {
        throw new TypeError(`plugin "${mount}" dependency "${slot}" has an invalid provider`);
      }
      const providerMount = mountOf.get(provider);
      if (providerMount === undefined) {
        throw new TypeError(
          `plugin "${mount}" dependency "${slot}" provider is not mounted`,
        );
      }
      assertProviderCompatible(
        contract,
        provider.exports,
        `plugin "${mount}" dependency "${slot}"`,
      );
    }
  }

  const order: string[] = [];
  const states = new Map<AnyPluginInstance, "visiting" | "visited">();
  const visit = (instance: AnyPluginInstance): void => {
    const state = states.get(instance);
    if (state === "visited") return;
    const mount = mountOf.get(instance)!;
    if (state === "visiting") {
      throw new TypeError(`Plugin dependency cycle reaches mount "${mount}"`);
    }
    states.set(instance, "visiting");
    for (const provider of Object.values(instance.providers)) visit(provider);
    states.set(instance, "visited");
    order.push(mount);
  };
  for (const instance of Object.values(mounts)) visit(instance);

  return Object.freeze({
    mounts: Object.freeze(mounts) as Readonly<Mounts>,
    order: Object.freeze(order) as readonly (keyof Mounts & string)[],
  });
}
