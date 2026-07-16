import { useMemo, type ReactElement } from "react";
import { DbzzProvider as SharedDbzzProvider, type DbzzProviderProps } from "../provider.tsx";
import { withExpoCapabilities } from "./capabilities.ts";

/**
 * Native `DbzzProvider`: the same public contract as the shared provider. It
 * only fills the client's capability seams (`fetch`, `random`,
 * `createWebSocket`) with the Expo implementations before delegating, the
 * same way the base client fills them with browser globals. Capabilities the
 * caller injected explicitly still win.
 *
 * Capability functions do not participate in lifetime identity (see
 * `lifetimeKey` in ../provider.tsx), so wrapping the configuration object
 * never restarts a client lifetime.
 */
export function DbzzProvider({ config, children }: DbzzProviderProps): ReactElement {
  const nativeConfig = useMemo(() => withExpoCapabilities(config), [config]);
  return <SharedDbzzProvider config={nativeConfig}>{children}</SharedDbzzProvider>;
}
