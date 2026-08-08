/**
 * The OpenAPI export: load the application's functions and write the document
 * for its HTTP surface. This is the default way to consume the schema — the
 * runtime endpoint is opt-in and off by default — so the export loads the app
 * exactly as a start does and needs no database, port, or credential authority.
 */
import { writeFileSync } from "node:fs";
import {
  Registry,
  openApiBytes,
  openApiDocument,
  type OpenApiDocument,
} from "@ackerdb/server";
import { runCodegen } from "./codegen.ts";
import { importApp, importFunctionModules } from "./manifest.ts";
import type { AppConfig } from "./config.ts";

export interface OpenApiExport {
  readonly file: string;
  /** Documented operations, which is never the count of registered functions. */
  readonly operations: number;
}

function operationCount(document: OpenApiDocument): number {
  return Object.values(document.paths)
    .reduce((total, item) => total + Object.keys(item).length, 0);
}

export async function exportOpenApi(config: AppConfig, file: string): Promise<OpenApiExport> {
  // Function modules import `_generated/server.ts`; generate it first exactly
  // as `acker start` does, so a fresh checkout exports in one pass.
  await runCodegen(config);
  const app = await importApp(config);
  // The document's identity is the application's own, because it describes
  // that application's API rather than AckerDB's — and it is the same name the
  // Admin API reports, resolved once in the configuration.
  const document = openApiDocument(
    new Registry(await importFunctionModules(config), app.apiPaths, config.admin),
    { title: config.admin.application.name, version: config.admin.application.version },
  );
  writeFileSync(file, openApiBytes(document));
  return { file, operations: operationCount(document) };
}
