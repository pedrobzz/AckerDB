import type { FilesConfig } from "../app/config.ts";

/** Stable physical identity; presentation and write-policy settings are not placement. */
export function fileStoreIdentity(files: FilesConfig): string {
  if (files.backend === "filesystem") {
    return `filesystem:${JSON.stringify({ root: files.root })}`;
  }
  return `s3:${JSON.stringify({
    endpoint: files.endpoint === undefined ? null : new URL(files.endpoint).href,
    region: files.region,
    bucket: files.bucket,
  })}`;
}
