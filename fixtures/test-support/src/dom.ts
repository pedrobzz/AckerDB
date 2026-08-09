import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Captured before happy-dom replaces browser globals so tests can reach the
// real network stack when they talk to an in-process ackerdb server.
export const NativeWebSocket = globalThis.WebSocket;

// happy-dom's registration replaces Bun's runtime primitives process-wide, and
// `bun test` runs every test file in one process: a server or client test file
// running after this import would receive happy-dom's fetch/Response/timers
// and fail. These tests need happy-dom's DOM, never its runtime shims — they
// drive React against injected sockets and in-process ackerdb servers — so the
// displaced natives are restored immediately after registration.
const RESTORED_NATIVES = [
  "AbortController",
  "AbortSignal",
  "Blob",
  "File",
  "FormData",
  "Headers",
  "Request",
  "Response",
  "TransformStream",
  "URL",
  "WebSocket",
  "WritableStream",
  "atob",
  "btoa",
  "fetch",
  "queueMicrotask",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
] as const;

if (!GlobalRegistrator.isRegistered) {
  const natives = new Map<string, PropertyDescriptor>();
  for (const key of RESTORED_NATIVES) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    if (descriptor) natives.set(key, descriptor);
  }
  GlobalRegistrator.register();
  for (const [key, descriptor] of natives) Object.defineProperty(globalThis, key, descriptor);
}

export function actEnvironment(enabled: boolean): void {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = enabled;
}

export function mountPoint(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return container;
}
