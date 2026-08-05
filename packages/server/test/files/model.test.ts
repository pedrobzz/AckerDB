import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Err, Status, type FileId } from "@ackerdb/core";
import { Registry } from "../../src/app/registry.ts";
import { Engine } from "../../src/database/engine.ts";
import { LocalFileStore } from "../../src/files/store/local.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { v } from "../../src/validation/v.ts";

describe("File references and grants", () => {
  let directory: string;
  let engine: Engine;
  let runtime: Runtime;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "ackerdb-file-model-"));
    engine = new Engine(defineSchema({
      documents: defineTable({
        id: v.primaryKey(),
        file: v.file(),
        preview: v.file().nullable(),
        title: v.string().nullable(),
      }),
    }), join(directory, "data.db"));
    reconcile(engine);
    runtime = new Runtime({
      engine,
      registry: new Registry({}),
      telemetry: false,
      files: {
        publicUrl: "https://files.example.test/",
        store: new LocalFileStore({ root: join(directory, "files") }),
      },
    });
  });

  afterEach(async () => {
    await runtime.drain().catch(() => {});
    engine.close("clean");
    rmSync(directory, { recursive: true, force: true });
  });

  test("rolls automatic claims back with the application row", async () => {
    const [thrownFile, applicationErrorFile] = await runtime.system.run(
      "test.files.rollback-stores",
      (ctx) => Promise.all([
        ctx.files.store(new Blob(["throw"]).stream(), { size: 5 }),
        ctx.files.store(new Blob(["error"]).stream(), { size: 5 }),
      ]),
    );

    await expect(runtime.system.run("test.files.rollback-throw", (ctx) =>
      ctx.tx(async (tx) => {
        await tx.db.documents!.insert({ file: thrownFile });
        throw new Error("later handler failure");
      }),
    )).rejects.toThrow("later handler failure");

    const applicationError = await runtime.system.run("test.files.rollback-error", (ctx) =>
      ctx.tx(async (tx) => {
        await tx.db.documents!.insert({ file: applicationErrorFile });
        return Err("document-rejected", null, Status.Conflict);
      }),
    );
    expect(applicationError).toMatchObject({
      ok: false,
      error: { kind: "application", code: "document-rejected" },
    });

    const state = await runtime.system.run("test.files.rollback-state", (ctx) =>
      ctx.tx(async (tx) => ({
        documents: await tx.db.documents!.query().collect(),
        thrown: await tx.files.get(thrownFile),
        applicationError: await tx.files.get(applicationErrorFile),
      })),
    );
    if (!state.ok) throw state.error;
    expect(state.data.documents).toEqual([]);
    expect(state.data.thrown?.state).toBe("pending");
    expect(state.data.applicationError?.state).toBe("pending");
  });

  test("claims changed nullable references without deleting old Files or protecting dangling references", async () => {
    const [primary, oldPreview, replacement] = await runtime.system.run(
      "test.files.reference-stores",
      (ctx) => Promise.all([
        ctx.files.store(new Blob(["primary"]).stream(), { size: 7 }),
        ctx.files.store(new Blob(["old"]).stream(), { size: 3 }),
        ctx.files.store(new Blob(["new"]).stream(), { size: 3 }),
      ]),
    );

    const result = await runtime.system.run("test.files.reference-lifecycle", (ctx) =>
      ctx.tx(async (tx) => {
        const documentId = await tx.db.documents!.insert({
          file: primary,
          preview: oldPreview,
          title: "before",
        });
        await tx.db.documents!.patch(documentId, { preview: replacement });
        const replaced = {
          oldPreview: await tx.files.get(oldPreview),
          replacement: await tx.files.get(replacement),
        };

        await tx.files.delete(primary);
        await tx.db.documents!.patch(documentId, { title: "after" });
        return {
          document: await tx.db.documents!.get(documentId),
          primary: await tx.files.get(primary),
          ...replaced,
        };
      }),
    );
    if (!result.ok) throw result.error;
    expect(result.data.document).toEqual({
      id: 1n,
      file: primary,
      preview: replacement,
      title: "after",
    });
    expect(result.data.primary?.state).toBe("deleting");
    expect(result.data.oldPreview?.state).toBe("active");
    expect(result.data.replacement?.state).toBe("active");
  });

  test("composes typed File metadata filters and ordered pagination", async () => {
    const fileId = await runtime.system.run("test.files.query-store", (ctx) =>
      ctx.files.store(new Blob(["query"]).stream(), { size: 5 }),
    );
    const result = await runtime.system.run("test.files.query-model", (ctx) =>
      ctx.tx(async (tx) => {
        await tx.files.claim(fileId);
        return tx.files.query()
          .where((row) => row.state.eq("active").and(row.owner.isNull()))
          .orderBy((row) => row.createdAt.asc())
          .thenBy((row) => row.id.asc())
          .collect();
      }),
    );
    if (!result.ok) throw result.error;
    expect(result.data.map((file) => file.id)).toContain(fileId);
  });

  test("returns the normalized immutable Grant disposition", async () => {
    const fileId = await runtime.system.run("test.files.grant-store", (ctx) =>
      ctx.files.store(new Blob(["grant"]).stream(), { size: 5 }),
    );
    const requested: { type: "attachment"; filename: string } = {
      type: "attachment",
      filename: "report.pdf",
    };
    const created = await runtime.system.run("test.files.normalized-grant", (ctx) =>
      ctx.tx(async (tx) => {
        await tx.files.claim(fileId);
        return tx.files.createGrant(fileId, {
          access: { type: "bearer" },
          permanent: true,
          disposition: requested,
        });
      }),
    );
    if (!created.ok) throw created.error;

    requested.filename = "mutated.pdf";
    expect(Object.isFrozen(created.data.disposition)).toBe(true);
    expect(created.data.disposition).toEqual({ type: "attachment", filename: "report.pdf" });
    const listed = await runtime.system.run("test.files.normalized-grant-list", (ctx) =>
      ctx.tx((tx) => tx.files.grants(fileId).collect()),
    );
    if (!listed.ok) throw listed.error;
    expect(listed.data[0]?.disposition).toEqual({ type: "attachment", filename: "report.pdf" });
  });

  test("revokes more than one database batch of Grants atomically", async () => {
    const fileId = await runtime.system.run("test.files.many-grants-store", (ctx) =>
      ctx.files.store(new Blob(["many"]).stream(), { size: 4 }),
    );
    const created = await runtime.system.run("test.files.many-grants-create", (ctx) =>
      ctx.tx(async (tx) => {
        await tx.files.claim(fileId);
        for (let index = 0; index < 257; index++) {
          await tx.files.createGrant(fileId, {
            access: { type: "bearer" },
            permanent: true,
          });
        }
        return tx.files.grants(fileId).count();
      }),
    );
    if (!created.ok) throw created.error;
    expect(created.data).toBe(257);

    const deleted = await runtime.system.run("test.files.many-grants-delete", (ctx) =>
      ctx.tx(async (tx) => {
        await tx.files.delete(fileId);
        return {
          grants: await tx.files.grants(fileId).count(),
          file: await tx.files.get(fileId),
        };
      }),
    );
    if (!deleted.ok) throw deleted.error;
    expect(deleted.data.grants).toBe(0);
    expect(deleted.data.file?.state).toBe("deleting");
  });
});
