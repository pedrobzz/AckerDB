import { createServer } from "node:net";

/**
 * Reserves a listener port for a fixture the test is about to spawn.
 *
 * The reservation is inherently advisory: the port is free when this returns
 * and the child binds it a moment later, so the kernel may hand the same
 * number to an unrelated process in between. `exclusive: true` is what keeps
 * that window small — without it the reservation may be satisfied by a shared
 * (SO_REUSEPORT) bind, which reports a port another listener in this same test
 * run already holds, and both children then race for it.
 */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    server.close();
    throw new Error("port reservation has no address");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}
