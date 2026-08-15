/**
 * Put one started Runtime on a port: the listener and the activation, which is
 * the last step of the server's boot and the only part a suite that builds
 * its Runtime by hand still needs. Production hosts boot through
 * `boot()` from `@ackerdb/server`; this exists so a runtime-level suite does
 * not restate the listener's options at every site.
 */
import {
  AckerDBServer,
  type AckerDBServerOptions,
  type Runtime,
} from "@ackerdb/server";

export type ListenOptions =
  & Omit<AckerDBServerOptions, "limits" | "fileMaxBytes" | "port">
  & { readonly port?: number };

export function listen(runtime: Runtime, options: ListenOptions = {}): AckerDBServer {
  const server = new AckerDBServer({
    ...options,
    limits: runtime.limits,
    fileMaxBytes: runtime.fileMaxBytes,
    port: options.port ?? 0,
  });
  server.activate(runtime);
  return server;
}
