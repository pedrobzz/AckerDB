/**
 * The OpenAPI export: load the application's functions and write the document
 * for its HTTP surface. This is the default way to consume the schema — the
 * runtime endpoint is opt-in and off by default — so the export loads the app
 * exactly as a start does and needs no database, port, or credential authority.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  Registry,
  openApiBytes,
  openApiDocument,
  type OpenApiDocument,
  type OpenApiInfo,
} from "@ackerdb/server";
import { runCodegen } from "./codegen.ts";
import { importFunctionModules } from "./manifest.ts";
import type { AppConfig } from "./config.ts";

export interface OpenApiExport {
  readonly file: string;
  /** Documented operations, which is never the count of registered functions. */
  readonly operations: number;
}

/**
 * The document's identity is the application's own: its package name and
 * version when the app directory ships a package.json, since the document
 * describes that application's API rather than AckerDB's. Without one the
 * directory names itself.
 */
function appInfo(config: AppConfig): OpenApiInfo {
  const manifest = join(config.appDir, "package.json");
  const packaged = existsSync(manifest)
    ? JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown; version?: unknown }
    : {};
  return {
    title: typeof packaged.name === "string" && packaged.name.length > 0
      ? packaged.name
      : basename(config.appDir),
    version: typeof packaged.version === "string" && packaged.version.length > 0
      ? packaged.version
      : "0.0.0",
  };
}

function operationCount(document: OpenApiDocument): number {
  return Object.values(document.paths)
    .reduce((total, item) => total + Object.keys(item).length, 0);
}

export async function exportOpenApi(config: AppConfig, file: string): Promise<OpenApiExport> {
  // Function modules import `_generated/server.ts`; generate it first exactly
  // as `acker start` does, so a fresh checkout exports in one pass.
  await runCodegen(config);
  const document = openApiDocument(
    new Registry(await importFunctionModules(config)),
    appInfo(config),
  );
  writeFileSync(file, openApiBytes(document));
  return { file, operations: operationCount(document) };
}
