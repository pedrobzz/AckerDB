import { useMemo, type ReactElement } from "react";
import { AckerDBProvider as SharedAckerDBProvider, type AckerDBProviderProps } from "../provider.tsx";
import { withExpoCapabilities } from "./capabilities.ts";

/**
 * Native `AckerDBProvider`: the same public contract as the shared provider. It
 * only fills the client's capability seams (`fetch`, `random`,
 * `createWebSocket`, `lifecycle`) with the Expo implementations before
 * delegating, the same way the base client fills them with browser globals.
 * Capabilities the caller injected explicitly still win.
 *
 * Capability functions do not participate in lifetime identity (see
 * `lifetimeKey` in ../provider.tsx), so wrapping the configuration object
 * never restarts a client lifetime.
 */
export function AckerDBProvider({ config, children }: AckerDBProviderProps): ReactElement {
  const nativeConfig = useMemo(() => withExpoCapabilities(config), [config]);
  return <SharedAckerDBProvider config={nativeConfig}>{children}</SharedAckerDBProvider>;
}
