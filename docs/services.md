# Services

A Service is a long-lived external resource an application owns for one process
generation: an MQTT consumer, a BullMQ or Redis worker, a Kafka or NATS
subscription, a webhook subscription manager, a change-data-capture reader. Each
one opens a persistent connection, lives for the whole process, and must execute
trusted application work whenever it fires.

AckerDB starts services after the database and runtime are ready, supervises
them, and releases them before the runtime closes. It does not restart them.

A Service is not a Plugin. A Plugin is an isolated capability with a private
schema (see [Plugins](plugins.md)); a Service is explicitly application-owned
and therefore holds root application authority over the application's own
tables. A Service is also not a function module: nothing addresses it, and no
client can call it.

## Declare a service

Services live in `services/` beside `functions/`, and are named the same way
function addresses are formed — module path plus export name. `services/providers.ts`
exporting `tuya` is the service `providers.tuya`.

```ts
// services/providers.ts
import { service } from "../_generated/server.ts";
import { connectMqtt } from "../lib/mqtt.ts";

export const tuya = service({
  start: async ({ system, abortSignal }) => {
    const client = await connectMqtt(process.env.TUYA_BROKER_URL!);

    client.on("message", (topic, payload) => {
      void system.run("providers.tuya.event", (ctx) =>
        ctx.tx((tx) => tx.db.deviceEvents.insert({
          topic,
          body: payload.toString(),
          receivedAt: Date.now(),
        })), { signal: abortSignal });
    });

    return () => client.close();
  },
});
```

`start` receives the application's own authority and returns an optional cleanup
function. Helpers may be exported from the same module and are ignored. An
export that has a `start` function but was not created with `service(...)` fails
startup rather than silently never running.

Services are declared in `services/`, not in `defineApp`. Two reasons: the
generated module already imports the manifest to derive the application's exact
types, so a manifest-declared service could not import its own typed authority
without a cycle; and every code-generation and migration child process imports
the manifest, so a manifest-declared service would load its broker client during
schema tooling. See [ADR-0016](adr/0016-services-are-application-owned-lifecycles.md).

Configure a different directory with `services` in `.ackerdb.config.json`.

## The service context

| Field | What it is |
| --- | --- |
| `system` | The application's `SystemRunner`. Live from setup until cleanup returns. |
| `abortSignal` | Aborts the moment shutdown or a dev reload begins, before cleanup runs. |
| `fail` | Reports an unrecoverable failure. Ends the application, naming this service. |

`system.run` behaves exactly as it does anywhere else: normal admission,
transaction, telemetry, and cancellation ownership, under the frozen system
principal. See [ADR-0015](adr/0015-system-runs-are-explicit-host-capabilities.md).

Passing `abortSignal` to `system.run` is worth doing for work started from a
callback: it lets in-flight work cancel cooperatively the instant shutdown
begins, instead of running to completion against a draining runtime.

## Typed authority

`service` and `ServiceCtx` come from the generated module, already bound to the
application's schema and mounted Plugin capabilities. Nothing needs explicit
type arguments, and a wrong table or column is a compile error:

```ts
import { service, type ServiceCtx } from "../_generated/server.ts";

async function reconcile({ system }: ServiceCtx) {
  await system.run("providers.reconcile", (ctx) =>
    ctx.tx((tx) => tx.db.devices.insert({ vendor: "tuya" })));
}
```

The untyped `service` exported from `@ackerdb/server` works too, for
applications that do not use code generation.

## Startup

Services start after storage, migrations, plugins, and the runtime are ready,
and before the server admits its first request. `system.run` therefore works in
setup, and readiness never describes a half-started application.

They start **sequentially, in name order**. While that happens, `/ready`
reports the `starting-services` phase and names the service currently in setup,
so a stalled broker handshake is attributable:

```json
{ "version": 1, "ready": false, "state": "starting",
  "phase": "starting-services", "service": "providers.tuya" }
```

If a setup fails, every service already started is released in reverse order,
startup fails with the failing service named, and the process exits non-zero.
The server is never left partially functional.

Setup should not block forever. There is no per-service startup timeout — a
service that wants one writes it itself.

## Shutdown

On `SIGTERM`, or on an `acker dev` reload, one deadline is computed for the
whole sequence and AckerDB:

1. takes the server out of readiness and stops admitting new transport work;
2. aborts every service's `abortSignal`;
3. awaits every cleanup in reverse start order;
4. drains the runtime and closes the database.

Because the runtime is still live for step 3, **cleanup may use `system.run`** —
this is where a consumer flushes what it still holds:

```ts
export const pending = service({
  start: ({ system }) => {
    const worker = startWorker();
    return async () => {
      await worker.close();
      await system.run("jobs.flush", (ctx) =>
        ctx.tx((tx) => tx.db.jobs.insert({ state: "interrupted" })));
    };
  },
});
```

The shared deadline is the application's configured graceful shutdown window,
not an additional budget on top of it. A cleanup that outruns it produces the
ordinary deadline-exceeded outcome and an unclean close instead of a hang, and
the server still drains. Cleanup failures are reported together, each naming its
service.

## Fatal failures

Setup failures fail startup. For everything after that — a broker that ends
permanently, a worker that throws where nothing awaits it — call `fail`:

```ts
export const queue = service({
  start: ({ fail }) => {
    const worker = new Worker("notifications", handler, { connection });
    worker.on("error", (error) => fail(error));
    return () => worker.close();
  },
});
```

`fail` runs the same shutdown path `SIGTERM` does and exits non-zero, with the
service named. It is idempotent and ignored once shutdown has begun.

**AckerDB does not restart services.** Restarting a process is the supervisor's
job — systemd, Kubernetes, or whatever runs the container. A service that wants
to reconnect internally may do so; `fail` is for the case where it cannot.

Programmatic hosts get the same event without the exit. `startApp` returns
`serviceFailure`, a promise that resolves with the failing service's error and
otherwise never settles, so the host drives its own drain:

```ts
const running = await startApp(loadConfig("."));
const failure = await running.serviceFailure;
console.error(failure.service, failure.cause);
await running.drain();
```

Signal ownership stays with the CLI adapter, as ADR-0015 requires.

## Generations and tooling

Each declared service starts **exactly once per process generation**. `acker dev`
reloads by replacing the serving child process, so a save fully releases the
previous generation's services — signals aborted, cleanups awaited — before the
next generation starts them. Two generations never hold the same subscription,
and a service from a drained generation can never reach `system.run`.

Nothing else imports a service module. `acker codegen`, migration planning and
generation, plugin storage inspection, `acker status`, `acker backup`, and
`acker restore` all import the manifest but never `services/`, so none of them
opens a connection. A service module that throws at import fails `acker start`
and leaves code generation working.
