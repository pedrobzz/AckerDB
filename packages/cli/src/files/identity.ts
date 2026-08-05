import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { join } from "node:path";
import type { FilesConfig } from "../app/config.ts";

const FILE_STORE_ID = ".ackerdb-store-id";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await fs.open(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function localIdentity(root: string): Promise<string> {
  await fs.mkdir(root, { recursive: true });
  const marker = join(root, FILE_STORE_ID);
  try {
    const handle = await fs.open(marker, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(`${randomUUID()}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(root);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }

  const stat = await fs.lstat(marker);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`filesystem FileStore marker must be a regular file: ${marker}`);
  }
  const id = (await fs.readFile(marker, "utf8")).trim();
  if (!UUID.test(id)) {
    throw new Error(`filesystem FileStore marker is invalid: ${marker}`);
  }
  return `filesystem:${id}`;
}

/** Durable physical identity; presentation, path, and write policy are not placement. */
export async function fileStoreIdentity(files: FilesConfig): Promise<string> {
  if (files.backend === "filesystem") {
    return localIdentity(files.root);
  }
  return `s3:${JSON.stringify({
    endpoint: files.endpoint === undefined ? null : new URL(files.endpoint).href,
    region: files.region,
    bucket: files.bucket,
  })}`;
}
