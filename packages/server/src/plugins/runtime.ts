import type { Database } from "bun:sqlite";
import {
  makeDbReader,
  makeDbWriter,
  type ReadRecorder,
  type WriteCollector,
} from "../database/access.ts";
import type { Engine, StorageScope } from "../database/engine.ts";
import { deepFreeze } from "../shared/immutable.ts";
import type { Analytics } from "../signals/analytics.ts";
import type { Logger } from "../signals/logger.ts";
import {
  isPluginOperationSpec,
  type AnyPluginOperationSpec,
  type PluginContractTree,
  type PluginOperationKind,
} from "./contract.ts";
import type { PluginDependencyContracts } from "./capabilities.ts";
import {
  isPluginOperationImplementation,
  type AnyPluginOperationImplementation,
} from "./builders.ts";
import type { PluginExportTree } from "./definition.ts";
import type { AnyPluginInstance, PluginAssembly } from "./assembly.ts";

export type PluginRuntimeState =
  | "created"
  | "starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed";

export interface PluginRuntimeOptions {
  readonly engine: Engine;
  readonly assembly: PluginAssembly;
  /** Exact storage scopes reconciled for the assembly, keyed by manifest mount. */
  readonly scopes: ReadonlyMap<string, StorageScope>;
}

export interface PluginReadExecution {
  readonly connection: Database;
  readonly reads: ReadRecorder | null;
}

export interface PluginWriteExecution {
  readonly writes: WriteCollector;
}

export interface PluginInvocationCapabilities {
  readonly timestamp: number;
  readonly log: (functionAddress: string, functionKind: PluginOperationKind) => Logger;
  readonly analytics: (functionAddress: string, functionKind: PluginOperationKind) => Analytics;
}

export interface PluginQueryBinding extends PluginReadExecution {
  readonly invocation: Readonly<PluginInvocationCapabilities>;
}

export interface PluginMutationBinding extends PluginWriteExecution {
  readonly invocation: Readonly<PluginInvocationCapabilities>;
}

export interface PluginProcedureBinding {
  readonly invocation: Readonly<PluginInvocationCapabilities>;
  readonly abortSignal: AbortSignal;
  runQuery<T>(
    work: (execution: Readonly<PluginReadExecution>) => T | Promise<T>,
  ): Promise<T>;
  runMutation<T>(
    work: (execution: Readonly<PluginWriteExecution>) => T | Promise<T>,
  ): Promise<T>;
  runTransaction<T>(
    work: (execution: Readonly<PluginWriteExecution>) => T | Promise<T>,
  ): Promise<T>;
}

type InvocationBinding =
  | { readonly kind: "query"; readonly value: Readonly<PluginQueryBinding> }
  | { readonly kind: "mutation"; readonly value: Readonly<PluginMutationBinding> }
  | { readonly kind: "procedure"; readonly value: Readonly<PluginProcedureBinding> };

interface StartedPlugin {
  readonly mount: string;
  readonly cleanup: () => unknown | Promise<unknown>;
}

interface PlannedOperation {
  readonly type: "operation";
  readonly callers: number;
  readonly instance: AnyPluginInstance;
  readonly contract: AnyPluginOperationSpec;
  readonly implementation: AnyPluginOperationImplementation;
  readonly path: string;
}

interface PlannedEntry {
  readonly name: string;
  readonly node: PlannedOperation | PlannedNamespace;
}

interface PlannedNamespace {
  readonly type: "namespace";
  readonly callers: number;
  readonly entries: readonly PlannedEntry[];
}

const EMPTY_PLUGIN_BINDING: Readonly<Record<string, unknown>> = Object.freeze({});
const CALLER_BIT: Readonly<Record<PluginOperationKind, number>> = Object.freeze({
  query: 1,
  mutation: 2,
  procedure: 4,
});
const OPERATION_CALLERS: Readonly<Record<PluginOperationKind, number>> = Object.freeze({
  query: CALLER_BIT.query | CALLER_BIT.mutation | CALLER_BIT.procedure,
  mutation: CALLER_BIT.mutation | CALLER_BIT.procedure,
  procedure: CALLER_BIT.procedure,
});

function finiteTimestamp(timestamp: number): void {
  if (!Number.isFinite(timestamp)) {
    throw new RangeError("Plugin invocation timestamp must be finite milliseconds");
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason === undefined
    ? new DOMException("Plugin startup was aborted", "AbortError")
    : signal.reason;
}

function failureWithCleanup(
  primary: unknown,
  cleanupErrors: readonly unknown[],
): unknown {
  return cleanupErrors.length === 0
    ? primary
    : new AggregateError(
        [primary, ...cleanupErrors],
        "Plugin startup failed and one or more Plugin cleanups also failed",
      );
}

function cleanupFailure(errors: readonly unknown[]): unknown | undefined {
  if (errors.length === 0) return undefined;
  return errors.length === 1
    ? errors[0]
    : new AggregateError(errors, "One or more Plugin cleanups failed");
}

function exposedCall(
  spec: AnyPluginOperationSpec,
  canonical: (args: unknown) => Promise<unknown>,
  path: string,
): (...args: unknown[]) => Promise<unknown> {
  const exposed = spec.expose === undefined
    ? canonical
    : spec.expose(canonical as never);
  if (typeof exposed !== "function") {
    throw new TypeError(`${path} expose must return a function`);
  }
  return Object.freeze(exposed) as (...args: unknown[]) => Promise<unknown>;
}

/**
 * One assembled Plugin graph: lifecycle owner plus invocation binder.
 *
 * Runtime passes the current reader/writer boundary explicitly. This object
 * never discovers a transaction from ambient state and never opens one itself.
 */
export class PluginRuntime {
  private readonly engine: Engine;
  private readonly assembly: PluginAssembly;
  private readonly scopes: ReadonlyMap<string, StorageScope>;
  private readonly mountOf = new Map<AnyPluginInstance, string>();
  private readonly operationPathOf = new Map<AnyPluginOperationImplementation, string>();
  private readonly mountPlan: PlannedNamespace | undefined;
  private readonly dependencyPlans: ReadonlyMap<
    AnyPluginInstance,
    PlannedNamespace | undefined
  >;
  private readonly controller = new AbortController();
  private readonly started: StartedPlugin[] = [];
  private lifecycle: PluginRuntimeState = "created";
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopRequested = false;

  constructor(options: PluginRuntimeOptions) {
    this.engine = options.engine;
    this.assembly = options.assembly;
    const scopes = new Map<string, StorageScope>();
    for (const [mount, instance] of Object.entries(options.assembly.mounts)) {
      const scope = options.scopes.get(mount);
      if (scope === undefined) {
        throw new TypeError(`Plugin mount "${mount}" has no reconciled storage scope`);
      }
      if (scope.mount !== mount) {
        throw new TypeError(`Plugin mount "${mount}" received storage scope "${scope.mount ?? "root"}"`);
      }
      if (scope.schema !== instance.schema) {
        throw new TypeError(`Plugin mount "${mount}" storage scope has the wrong schema`);
      }
      scopes.set(mount, scope);
      this.mountOf.set(instance, mount);
    }
    for (const mount of options.scopes.keys()) {
      if (!Object.hasOwn(options.assembly.mounts, mount)) {
        throw new TypeError(`Plugin storage scope "${mount}" has no manifest mount`);
      }
    }
    this.scopes = scopes;

    this.mountPlan = this.planMounts();
    const dependencyPlans = new Map<AnyPluginInstance, PlannedNamespace | undefined>();
    for (const [mount, instance] of Object.entries(this.assembly.mounts)) {
      dependencyPlans.set(instance, this.planDependencies(instance, mount));
    }
    this.dependencyPlans = dependencyPlans;
  }

  get state(): PluginRuntimeState {
    return this.lifecycle;
  }

  start(signal?: AbortSignal): Promise<void> {
    if (this.lifecycle === "starting" || this.lifecycle === "ready") {
      return this.startPromise!;
    }
    if (this.lifecycle !== "created") {
      return Promise.reject(new Error(`Plugin runtime cannot start from ${this.lifecycle}`));
    }
    this.lifecycle = "starting";

    let detachSignal = (): void => {};
    if (signal !== undefined) {
      const abort = () => this.controller.abort(abortReason(signal));
      if (signal.aborted) abort();
      else {
        signal.addEventListener("abort", abort, { once: true });
        detachSignal = () => signal.removeEventListener("abort", abort);
      }
    }

    this.startPromise = Promise.resolve()
      .then(() => this.startAll())
      .then(() => {
        if (this.controller.signal.aborted) throw abortReason(this.controller.signal);
        this.lifecycle = "ready";
      })
      .catch(async (error) => {
        this.controller.abort(error);
        const cleanupErrors = await this.cleanupStarted();
        this.lifecycle = this.stopRequested ? "stopped" : "failed";
        throw failureWithCleanup(error, cleanupErrors);
      })
      .finally(detachSignal);
    return this.startPromise;
  }

  stop(reason: unknown = new Error("Plugin runtime is stopping")): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise;
    this.stopRequested = true;
    this.controller.abort(reason);
    if (this.lifecycle === "created") {
      this.lifecycle = "stopped";
      return (this.stopPromise = Promise.resolve());
    }
    if (this.lifecycle === "stopped") return (this.stopPromise = Promise.resolve());

    this.stopPromise = (async () => {
      if (this.lifecycle === "starting") {
        await this.startPromise?.catch(() => {});
        return;
      }
      if (this.lifecycle === "failed") return;
      this.lifecycle = "stopping";
      const errors = await this.cleanupStarted();
      const failure = cleanupFailure(errors);
      if (failure !== undefined) {
        this.lifecycle = "failed";
        throw failure;
      }
      this.lifecycle = "stopped";
    })();
    return this.stopPromise;
  }

  bindQuery(binding: Readonly<PluginQueryBinding>): Readonly<Record<string, unknown>> {
    this.assertReady();
    finiteTimestamp(binding.invocation.timestamp);
    return this.bindPlan(this.mountPlan, "query", { kind: "query", value: binding });
  }

  bindMutation(binding: Readonly<PluginMutationBinding>): Readonly<Record<string, unknown>> {
    this.assertReady();
    finiteTimestamp(binding.invocation.timestamp);
    return this.bindPlan(this.mountPlan, "mutation", { kind: "mutation", value: binding });
  }

  bindProcedure(binding: Readonly<PluginProcedureBinding>): Readonly<Record<string, unknown>> {
    this.assertReady();
    finiteTimestamp(binding.invocation.timestamp);
    return this.bindPlan(this.mountPlan, "procedure", { kind: "procedure", value: binding });
  }

  private async startAll(): Promise<void> {
    for (const mount of this.assembly.order) {
      if (this.controller.signal.aborted) throw abortReason(this.controller.signal);
      const lifecycle = this.assembly.mounts[mount]!.lifecycle;
      if (lifecycle === undefined) continue;
      const cleanup = await lifecycle(Object.freeze({
        mount,
        abortSignal: this.controller.signal,
      }));
      if (cleanup !== undefined && typeof cleanup !== "function") {
        throw new TypeError(`Plugin "${mount}" lifecycle must return void or a cleanup function`);
      }
      if (cleanup !== undefined) this.started.push({ mount, cleanup });
      // A callback that settles after cancellation owns an immediately
      // discoverable cleanup; never publish readiness for that resource.
      if (this.controller.signal.aborted) throw abortReason(this.controller.signal);
    }
  }

  private async cleanupStarted(): Promise<unknown[]> {
    const started = this.started.splice(0).reverse();
    const errors: unknown[] = [];
    for (const plugin of started) {
      try {
        await plugin.cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  private assertReady(): void {
    if (this.lifecycle !== "ready") {
      throw new Error(`Plugin runtime is ${this.lifecycle}, expected ready`);
    }
  }

  private planMounts(): PlannedNamespace | undefined {
    const entries: PlannedEntry[] = [];
    for (const [mount, instance] of Object.entries(this.assembly.mounts)) {
      const tree = this.planExportTree(instance, instance.exports, mount);
      if (tree !== undefined) entries.push(Object.freeze({ name: mount, node: tree }));
    }
    return this.namespacePlan(entries);
  }

  private planExportTree(
    instance: AnyPluginInstance,
    exports: PluginExportTree,
    path: string,
  ): PlannedNamespace | undefined {
    const entries: PlannedEntry[] = [];
    for (const [name, node] of Object.entries(exports)) {
      const operationPath = `${path}.${name}`;
      if (isPluginOperationImplementation(node)) {
        this.operationPathOf.set(node, operationPath);
        entries.push(Object.freeze({
          name,
          node: Object.freeze({
            type: "operation",
            callers: OPERATION_CALLERS[node.spec.kind],
            instance,
            contract: node.spec,
            implementation: node,
            path: operationPath,
          }),
        }));
        continue;
      }
      const nested = this.planExportTree(instance, node, operationPath);
      if (nested !== undefined) entries.push(Object.freeze({ name, node: nested }));
    }
    return this.namespacePlan(entries);
  }

  private planContractTree(
    provider: AnyPluginInstance,
    contract: PluginContractTree,
    exports: PluginExportTree,
    path: string,
  ): PlannedNamespace | undefined {
    const entries: PlannedEntry[] = [];
    for (const [name, requirement] of Object.entries(contract)) {
      const operationPath = `${path}.${name}`;
      const implementation = exports[name]!;
      if (isPluginOperationSpec(requirement)) {
        entries.push(Object.freeze({
          name,
          node: Object.freeze({
            type: "operation",
            callers: OPERATION_CALLERS[requirement.kind],
            instance: provider,
            contract: requirement,
            implementation: implementation as AnyPluginOperationImplementation,
            path: operationPath,
          }),
        }));
        continue;
      }
      const nested = this.planContractTree(
        provider,
        requirement,
        implementation as PluginExportTree,
        operationPath,
      );
      if (nested !== undefined) entries.push(Object.freeze({ name, node: nested }));
    }
    return this.namespacePlan(entries);
  }

  private planDependencies(
    instance: AnyPluginInstance,
    mount: string,
  ): PlannedNamespace | undefined {
    const entries: PlannedEntry[] = [];
    for (const [slot, contract] of Object.entries(
      instance.dependencies as PluginDependencyContracts,
    )) {
      const provider = instance.providers[slot]!;
      const capability = this.planContractTree(
        provider,
        contract,
        provider.exports,
        `${mount}.${slot}`,
      );
      if (capability !== undefined) {
        entries.push(Object.freeze({ name: slot, node: capability }));
      }
    }
    return this.namespacePlan(entries);
  }

  private namespacePlan(entries: PlannedEntry[]): PlannedNamespace | undefined {
    return entries.length === 0
      ? undefined
      : Object.freeze({
          type: "namespace",
          callers: entries.reduce((callers, entry) => callers | entry.node.callers, 0),
          entries: Object.freeze(entries),
        });
  }

  private bindPlan(
    plan: PlannedNamespace | undefined,
    caller: PluginOperationKind,
    binding: InvocationBinding,
  ): Readonly<Record<string, unknown>> {
    const callerBit = CALLER_BIT[caller];
    if (plan === undefined || (plan.callers & callerBit) === 0) {
      return EMPTY_PLUGIN_BINDING;
    }
    const capabilities: Record<string, unknown> = {};
    for (const entry of plan.entries) {
      if ((entry.node.callers & callerBit) === 0) continue;
      capabilities[entry.name] = entry.node.type === "operation"
        ? this.bindOperation(
          entry.node.instance,
          entry.node.contract,
          entry.node.implementation,
          binding,
          entry.node.path,
        )
        : this.bindPlan(entry.node, caller, binding);
    }
    return Object.freeze(capabilities);
  }

  private bindOperation(
    instance: AnyPluginInstance,
    contract: AnyPluginOperationSpec,
    implementation: AnyPluginOperationImplementation,
    binding: InvocationBinding,
    path: string,
  ): (...args: unknown[]) => Promise<unknown> {
    const canonical = (rawArgs: unknown): Promise<unknown> =>
      this.invokeOperation(instance, implementation, binding, rawArgs);
    return exposedCall(contract, canonical, path);
  }

  private invokeOperation(
    instance: AnyPluginInstance,
    implementation: AnyPluginOperationImplementation,
    binding: InvocationBinding,
    rawArgs: unknown,
  ): Promise<unknown> {
    if (binding.kind === "procedure" && implementation.spec.kind === "query") {
      return binding.value.runQuery((execution) => this.invokeValidated(
        instance,
        implementation,
        {
          kind: "query",
          value: {
            ...execution,
            invocation: binding.value.invocation,
          },
        },
        rawArgs,
      ));
    }
    if (binding.kind === "procedure" && implementation.spec.kind === "mutation") {
      return binding.value.runMutation((execution) => this.invokeValidated(
        instance,
        implementation,
        {
          kind: "mutation",
          value: {
            ...execution,
            invocation: binding.value.invocation,
          },
        },
        rawArgs,
      ));
    }
    return this.invokeValidated(instance, implementation, binding, rawArgs);
  }

  private invokeValidated(
    instance: AnyPluginInstance,
    implementation: AnyPluginOperationImplementation,
    binding: InvocationBinding,
    rawArgs: unknown,
  ): Promise<unknown> {
    try {
      const args = deepFreeze(
        implementation.spec.args.check(rawArgs === undefined ? {} : rawArgs, "args"),
      );
      const functionAddress = this.operationPathOf.get(implementation);
      if (functionAddress === undefined) {
        throw new TypeError("Plugin invocation targets an unregistered operation");
      }
      const context = this.operationContext(
        instance,
        implementation.spec.kind,
        binding,
        functionAddress,
        implementation.spec.kind,
      );
      return Promise.resolve(implementation.handler(context, args));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private operationContext(
    instance: AnyPluginInstance,
    kind: PluginOperationKind,
    binding: InvocationBinding,
    functionAddress: string,
    functionKind: PluginOperationKind,
  ): Readonly<Record<string, unknown>> {
    const mount = this.mountOf.get(instance);
    if (mount === undefined) throw new TypeError("Plugin invocation targets an unmounted instance");
    const scope = this.scopes.get(mount)!;
    const dependencies = this.bindDependencies(instance, kind, binding);

    if (kind === "query") {
      if (binding.kind === "procedure") {
        throw new TypeError(`Plugin query "${mount}" has no reader boundary`);
      }
      const read = binding.kind === "query"
        ? binding.value
        : {
            connection: this.engine.writer,
            reads: null,
            invocation: binding.value.invocation,
          };
      const db = makeDbReader(
        this.engine,
        read.connection,
        read.reads,
        scope,
      );
      return Object.freeze({
        timestamp: read.invocation.timestamp,
        mount,
        log: read.invocation.log(functionAddress, functionKind),
        db,
        ...dependencies,
      });
    }

    if (kind === "mutation") {
      if (binding.kind !== "mutation") {
        throw new TypeError(`Plugin mutation "${mount}" has no writer boundary`);
      }
      const db = makeDbWriter(
        this.engine,
        binding.value.writes,
        () => {
          throw new Error("Plugin private schemas cannot contain event tables");
        },
        scope,
      );
      return Object.freeze({
        timestamp: binding.value.invocation.timestamp,
        mount,
        analytics: binding.value.invocation.analytics(functionAddress, functionKind),
        log: binding.value.invocation.log(functionAddress, functionKind),
        db,
        ...dependencies,
      });
    }

    if (binding.kind !== "procedure") {
      throw new TypeError(`Plugin procedure "${mount}" has no procedure boundary`);
    }
    return Object.freeze({
      timestamp: binding.value.invocation.timestamp,
      mount,
      log: binding.value.invocation.log(functionAddress, functionKind),
      abortSignal: binding.value.abortSignal,
      ...dependencies,
      tx: <T>(work: (context: Readonly<Record<string, unknown>>) => T | Promise<T>) =>
        binding.value.runTransaction((execution) => work(this.operationContext(
          instance,
          "mutation",
          {
            kind: "mutation",
            value: {
              ...execution,
              invocation: binding.value.invocation,
            },
          },
          functionAddress,
          functionKind,
        ))),
    });
  }

  private bindDependencies(
    instance: AnyPluginInstance,
    caller: PluginOperationKind,
    binding: InvocationBinding,
  ): Readonly<Record<string, unknown>> {
    return this.bindPlan(this.dependencyPlans.get(instance), caller, binding);
  }
}
