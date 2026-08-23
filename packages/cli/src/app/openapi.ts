/**
 * The OpenAPI export: load the application's functions and write the document
 * for its HTTP surface. This is the default way to consume the schema — the
 * runtime endpoint is opt-in and off by default — so the export loads the app
 * exactly as a start does and needs no database, port, or credential authority.
 */
import { writeFileSync } from "node:fs";
import {
  Registry,
  collectDefinitions,
  openApiBytes,
  openApiDocument,
  type OpenApiDocument,
} from "@ackerdb/server";
import { runCodegen } from "./codegen.ts";
import { importDefinitionModules } from "./manifest.ts";
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
  // The document's identity is the application's own, because it describes
  // that application's API rather than AckerDB's: its package manifest, read
  // once in the configuration.
  const document = openApiDocument(
    Registry.from(collectDefinitions(await importDefinitionModules(config))),
    { title: config.application.name, version: config.application.version },
  );
  writeFileSync(file, openApiBytes(document));
  return { file, operations: operationCount(document) };
}
