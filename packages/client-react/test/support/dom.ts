import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Captured before happy-dom replaces browser globals so tests can reach the
// real network stack when they talk to an in-process dbzz server.
export const NativeWebSocket = globalThis.WebSocket;
export const nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);

// Bun runs every test file in one process, and registration replaces the
// process-wide network stack: Bun.serve rejects happy-dom Response instances,
// and suites from other packages break on happy-dom's fetch and WebSocket.
// Restore the native network primitives after registration so only the DOM
// comes from happy-dom.
const nativeNetworkGlobals = {
  fetch: globalThis.fetch,
  WebSocket: globalThis.WebSocket,
  Response,
  Request,
  Headers,
  AbortController,
  AbortSignal,
  URL,
  Blob,
  FormData,
  WritableStream,
  TransformStream,
} as const;

if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register();
  Object.assign(globalThis, nativeNetworkGlobals);
}

export function actEnvironment(enabled: boolean): void {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = enabled;
}

export function mountPoint(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return container;
}
