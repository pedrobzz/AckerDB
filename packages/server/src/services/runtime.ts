/**
 * The Service supervisor: starts declared services in one deterministic order,
 * hands each trusted application authority, and releases them in reverse.
 *
 * Ordering is the whole contract. Services start after the Runtime exists and
 * before the server admits traffic, so `system.run` is live for every setup;
 * they stop before drain closes system-run admission, so it is still live for
 * every cleanup.
 */
import { AckerDBError } from "../shared/errors.ts";
import type { SystemRunner } from "../app/system.ts";
import type { AnyService, DeclaredService, ServiceCleanup } from "./definition.ts";

export type ServiceRuntimeState =
  | "created"
  | "starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed";

export interface ServiceRuntimeOptions {
  readonly services: readonly DeclaredService[];
  /** The application's own authority, handed to every service unchanged. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly system: SystemRunner<any>;
  /** Reports the service currently in setup, for readiness. */
  readonly onStarting?: (name: string | null) => void;
  /** Reports the first unrecoverable post-setup failure. Called at most once. */
  readonly onFatal?: (error: ServiceError) => void;
}

interface StartedService {
  readonly name: string;
  readonly cleanup: ServiceCleanup;
}

export type ServicePhase = "setup" | "runtime" | "cleanup";

/** A service failure always names its owner; an anonymous one is unactionable. */
export class ServiceError extends Error {
  override readonly name = "ServiceError";
  readonly service: string;
  readonly phase: ServicePhase;

  constructor(service: string, phase: ServicePhase, cause: unknown) {
    const detail = cause instanceof Error
      ? cause.message
      : typeof cause === "string" ? cause : undefined;
    super(
      `service "${service}" failed during ${phase}${detail === undefined ? "" : `: ${detail}`}`,
      { cause },
    );
    this.service = service;
    this.phase = phase;
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason === undefined
    ? new DOMException("service startup was aborted", "AbortError")
    : signal.reason;
}

function cleanupFailure(errors: readonly unknown[]): unknown | undefined {
  if (errors.length === 0) return undefined;
  return errors.length === 1
    ? errors[0]
    : new AggregateError(errors, "One or more service cleanups failed");
}

function failureWithCleanup(primary: unknown, cleanupErrors: readonly unknown[]): unknown {
  return cleanupErrors.length === 0
    ? primary
    : new AggregateError(
        [primary, ...cleanupErrors],
        "Service startup failed and one or more service cleanups also failed",
      );
}

/**
 * Bound work by the caller's absolute deadline. The losing work stays attached
 * to the race, so a late rejection is observed rather than unhandled.
 */
function withDeadline<T>(work: Promise<T>, deadlineAtMs: number | undefined): Promise<T> {
  if (deadlineAtMs === undefined) return work;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new AckerDBError("deadline_exceeded", "service shutdown deadline exceeded", {
            resource: "operation",
          }),
        ),
      Math.max(0, deadlineAtMs - Date.now()),
    );
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export class ServiceRuntime {
  private readonly services: readonly DeclaredService[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly system: SystemRunner<any>;
  private readonly onStarting: (name: string | null) => void;
  private readonly onFatal: (error: ServiceError) => void;
  private fatal: ServiceError | null = null;
  private readonly controller = new AbortController();
  private readonly started: StartedService[] = [];
  private lifecycle: ServiceRuntimeState = "created";
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopRequested = false;

  constructor(options: ServiceRuntimeOptions) {
    const seen = new Map<AnyService, string>();
    for (const declared of options.services) {
      const owner = seen.get(declared.service);
      if (owner !== undefined) {
        throw new TypeError(
          `service is exported at both "${owner}" and "${declared.name}"`,
        );
      }
      seen.set(declared.service, declared.name);
    }
    this.services = Object.freeze([...options.services]);
    this.system = options.system;
    this.onStarting = options.onStarting ?? (() => {});
    this.onFatal = options.onFatal ?? (() => {});
  }

  get state(): ServiceRuntimeState {
    return this.lifecycle;
  }

  /** Names in start order — the order cleanup reverses. */
  get names(): readonly string[] {
    return this.services.map((declared) => declared.name);
  }

  start(): Promise<void> {
    if (this.lifecycle === "starting" || this.lifecycle === "ready") {
      return this.startPromise!;
    }
    if (this.lifecycle !== "created") {
      return Promise.reject(new Error(`service runtime cannot start from ${this.lifecycle}`));
    }
    this.lifecycle = "starting";
    this.startPromise = Promise.resolve()
      .then(() => this.startAll())
      .then(() => {
        if (this.controller.signal.aborted) throw abortReason(this.controller.signal);
        this.lifecycle = "ready";
      })
      .catch(async (error: unknown) => {
        this.controller.abort(error);
        const cleanupErrors = await this.cleanupStarted();
        this.lifecycle = this.stopRequested ? "stopped" : "failed";
        throw failureWithCleanup(error, cleanupErrors);
      })
      .finally(() => this.onStarting(null));
    return this.startPromise;
  }

  /**
   * Abort every service, then await cleanups in reverse start order, bounded by
   * the caller's shutdown deadline.
   */
  stop(
    reason: unknown = new Error("application services are stopping"),
    deadlineAtMs?: number,
  ): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise;
    this.stopRequested = true;
    this.controller.abort(reason);
    if (this.lifecycle === "created" || this.lifecycle === "stopped") {
      this.lifecycle = "stopped";
      return (this.stopPromise = Promise.resolve());
    }

    this.stopPromise = (async () => {
      if (this.lifecycle === "starting") {
        // The start path owns rollback of whatever it already acquired.
        await this.startPromise?.catch(() => {});
        return;
      }
      if (this.lifecycle === "failed") return;
      this.lifecycle = "stopping";
      const errors = await withDeadline(this.cleanupStarted(), deadlineAtMs);
      const failure = cleanupFailure(errors);
      if (failure !== undefined) {
        this.lifecycle = "failed";
        throw failure;
      }
      this.lifecycle = "stopped";
    })().catch((error: unknown) => {
      this.lifecycle = "failed";
      throw error;
    });
    return this.stopPromise;
  }

  private async startAll(): Promise<void> {
    for (const { name, service } of this.services) {
      if (this.controller.signal.aborted) throw abortReason(this.controller.signal);
      this.onStarting(name);
      let cleanup: void | ServiceCleanup;
      try {
        cleanup = await service.start(Object.freeze({
          system: this.system,
          abortSignal: this.controller.signal,
          fail: (error: unknown) => this.reportFatal(name, error),
        }));
      } catch (error) {
        throw new ServiceError(name, "setup", error);
      }
      if (cleanup !== undefined && typeof cleanup !== "function") {
        throw new ServiceError(
          name,
          "setup",
          new TypeError(`service "${name}" start must return void or a cleanup function`),
        );
      }
      if (cleanup !== undefined) this.started.push({ name, cleanup });
      // A setup that settles after cancellation still owns a discoverable
      // cleanup; never publish readiness for that resource.
      if (this.controller.signal.aborted) throw abortReason(this.controller.signal);
    }
  }

  /**
   * First failure wins. A shutdown already under way is not made worse by a
   * consumer noticing its socket died, so a late report is dropped rather than
   * starting a second teardown.
   */
  private reportFatal(name: string, error: unknown): void {
    if (this.fatal !== null || this.stopRequested) return;
    this.fatal = new ServiceError(name, "runtime", error);
    this.onFatal(this.fatal);
  }

  private async cleanupStarted(): Promise<unknown[]> {
    const started = this.started.splice(0).reverse();
    const errors: unknown[] = [];
    for (const { name, cleanup } of started) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(new ServiceError(name, "cleanup", error));
      }
    }
    return errors;
  }
}
