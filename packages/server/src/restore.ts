import { isApp, type App } from "./app.ts";
import {
  restoreVerifiedLayout,
  type BackupManifest,
  type EngineStatus,
} from "./engine.ts";
import { desiredPluginMounts, desiredStorageFingerprint } from "./plugin-storage.ts";

/**
 * Verify and publish one backup against the exact App requested by the caller.
 * App loading and layout derivation run while the canonical target is owned;
 * no public API exposes a partially staged restore.
 */
export function restoreVerifiedDatabase(
  source: string,
  target: string,
  manifest: BackupManifest,
  loadApp: () => App | Promise<App>,
): Promise<EngineStatus> {
  return restoreVerifiedLayout(source, target, manifest, async () => {
    const app = await loadApp();
    if (!isApp(app)) throw new TypeError("restore App loader must return an App created with defineApp(...)");
    if (desiredStorageFingerprint(app.schema, desiredPluginMounts(app)) !== manifest.schemaFingerprint) {
      throw new Error("backup schema fingerprint does not match the target App storage layout");
    }
    return app.schema;
  });
}
