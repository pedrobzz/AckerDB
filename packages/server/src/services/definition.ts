/**
 * Application services: long-lived external resources an application owns for
 * the lifetime of one process generation — broker consumers, job workers,
 * webhook subscriptions — that must execute trusted application work.
 *
 * A Service is not a Plugin. A Plugin is an isolated capability with private
 * storage (ADR-0005); a Service is explicitly application-owned and therefore
 * receives root application authority through `system.run` (ADR-0015). It is
 * also not a function module: nothing addresses a Service, and no client can
 * call one.
 */
import { brand, hasBrand } from "../shared/identity.ts";
import type { Schema } from "../schema/definition.ts";
import type { SystemCtx, SystemRunner } from "../app/system.ts";

const SERVICE_IDENTITY = Symbol.for("@ackerdb/server/Service/v1");

type EmptyContextCapabilities = Readonly<Record<never, never>>;

/** Releases everything one service acquired. Awaited before the runtime closes. */
export type ServiceCleanup = () => unknown | Promise<unknown>;

export interface ServiceContext<Ctx = SystemCtx> {
  /** Trusted application authority, live from setup until cleanup returns. */
  readonly system: SystemRunner<Ctx>;
  /** Aborts the moment shutdown or a dev reload begins, before cleanup runs. */
  readonly abortSignal: AbortSignal;
  /**
   * Report a failure this service cannot recover from — a broker that ended
   * permanently, a worker that threw where nothing awaited it. The application
   * shuts down exactly as a termination signal would, naming this service.
   * AckerDB never restarts a service; the process supervisor owns that.
   * Idempotent, and ignored once shutdown has begun.
   */
  readonly fail: (error: unknown) => void;
}

export type ServiceStart<Ctx = SystemCtx> = (
  context: ServiceContext<Ctx>,
) => void | ServiceCleanup | Promise<void | ServiceCleanup>;

export interface ServiceDefinition<Ctx = SystemCtx> {
  readonly start: ServiceStart<Ctx>;
}

export interface Service<Ctx = SystemCtx> {
  readonly start: ServiceStart<Ctx>;
}

// Service registries deliberately erase each service's concrete context.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyService = Service<any>;

/**
 * The exact builder code generation publishes, bound to one application's
 * schema and mounted Plugin capabilities.
 */
export type ServiceBuilder<
  S extends Schema,
  Capabilities extends object = EmptyContextCapabilities,
  TransactionCapabilities extends object = EmptyContextCapabilities,
> = (
  definition: ServiceDefinition<SystemCtx<S, Capabilities, TransactionCapabilities>>,
) => Service<SystemCtx<S, Capabilities, TransactionCapabilities>>;

export function service<Ctx = SystemCtx>(
  definition: ServiceDefinition<Ctx>,
): Service<Ctx> {
  if (
    typeof definition !== "object" ||
    definition === null ||
    Array.isArray(definition)
  ) {
    throw new TypeError("service definition must be a plain object");
  }
  for (const option of Object.keys(definition)) {
    if (option !== "start") throw new TypeError(`unknown service option "${option}"`);
  }
  if (typeof definition.start !== "function") {
    throw new TypeError("service start must be a function");
  }
  const declared: Service<Ctx> = { start: definition.start };
  brand(declared, SERVICE_IDENTITY);
  return Object.freeze(declared);
}

/** True for a service created by any compatible @ackerdb/server instance. */
export function isService(value: unknown): value is AnyService {
  return hasBrand(value, SERVICE_IDENTITY);
}

/** One service and the exact name failures, telemetry, and readiness report. */
export interface DeclaredService {
  readonly name: string;
  readonly service: AnyService;
}

/**
 * Resolve service modules to declarations, mirroring how the function registry
 * addresses modules: `services/providers.ts` exporting `tuya` is
 * `providers.tuya`, in deterministic module-then-export order.
 *
 * Helpers may be exported alongside services and are ignored, exactly as
 * unrecognized function-module exports are. An unbranded export *shaped* like a
 * service is not ignored: it is the residue of forgetting `service(...)`, and
 * left unreported it is a silent no-op — the resource never opens, readiness
 * still publishes, and nothing ever says so.
 */
export function declareServices(
  modules: Record<string, Record<string, unknown>>,
): DeclaredService[] {
  const declared: DeclaredService[] = [];
  for (const [modulePath, exports] of Object.entries(modules).sort(([a], [b]) =>
    a.localeCompare(b))) {
    for (const [exportName, value] of Object.entries(exports).sort(([a], [b]) =>
      a.localeCompare(b))) {
      const name = `${modulePath}.${exportName}`;
      if (isService(value)) {
        declared.push({ name, service: value });
        continue;
      }
      if (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { readonly start?: unknown }).start === "function"
      ) {
        throw new TypeError(
          `service module export "${name}" has a start function but was not created with service(...)`,
        );
      }
    }
  }
  return declared;
}
