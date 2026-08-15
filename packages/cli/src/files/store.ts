/** The configured FileStore adapter: the CLI's one config → physical store step. */
import { LocalFileStore, type FileStore } from "@ackerdb/server";
import type { FilesConfig } from "../app/config.ts";

export async function createFileStore(files: FilesConfig): Promise<FileStore> {
  if (files.backend === "filesystem") {
    return new LocalFileStore({ root: files.root });
  }
  const { S3FileStore } = await import("@ackerdb/server/files/s3");
  return new S3FileStore({
    ...(files.endpoint === undefined ? {} : { endpoint: files.endpoint }),
    region: files.region,
    bucket: files.bucket,
    forcePathStyle: files.forcePathStyle,
    checksum: files.checksum,
    encryption: files.encryption,
  });
}
