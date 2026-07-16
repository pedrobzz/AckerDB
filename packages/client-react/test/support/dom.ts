import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Captured before happy-dom replaces browser globals so tests can reach the
// real network stack when they talk to an in-process dbzz server.
export const NativeWebSocket = globalThis.WebSocket;

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

export function actEnvironment(enabled: boolean): void {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = enabled;
}

export function mountPoint(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return container;
}
