import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { loadConfig } from "../../src/app/config.ts";

describe("production profile configuration", () => {
  test("defaults to production durability", () => {
    expect(loadConfig(".", {})).toMatchObject({
      appPath: resolve("app.ts"),
      dbDir: resolve(".ackerdb"),
      hostname: "127.0.0.1",
      durability: "production",
      statusScope: "ackerdb:status",
      files: {
        backend: "filesystem",
        root: resolve(".ackerdb/files"),
        publicUrl: "http://127.0.0.1:3211/",
        maxBytes: 1024 ** 3,
      },
    });
  });

  test("selects one application manifest and rejects the removed schema path", () => {
    const dir = mkdtempSync(join(tmpdir(), "ackerdb-config-"));
    try {
      writeFileSync(join(dir, ".ackerdb.config.json"), JSON.stringify({ app: "./backend.ts" }));
      expect(loadConfig(dir, {})).toMatchObject({ appPath: resolve(dir, "backend.ts") });

      writeFileSync(join(dir, ".ackerdb.config.json"), JSON.stringify({ schema: "./schema.ts" }));
      expect(() => loadConfig(dir, {})).toThrow("unknown configuration field: schema");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects unknown configuration fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "ackerdb-config-"));
    try {
      writeFileSync(join(dir, ".ackerdb.config.json"), JSON.stringify({ unexpected: true }));
      expect(() => loadConfig(dir, {})).toThrow("unknown configuration field: unexpected");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts the named durability profiles", () => {
    expect(loadConfig(".", {
      ACKERDB_DURABILITY: "balanced",
    })).toMatchObject({ durability: "balanced" });
  });

  test("rejects an unknown durability profile without normalization", () => {
    expect(() => loadConfig(".", { ACKERDB_DURABILITY: "Production" })).toThrow(
      'ACKERDB_DURABILITY must be exactly production or balanced; received "Production"',
    );
  });

  test("loads external OIDC providers and one exact workload status scope", () => {
    const dir = mkdtempSync(join(tmpdir(), "ackerdb-config-"));
    try {
      writeFileSync(join(dir, ".ackerdb.config.json"), JSON.stringify({
        statusScope: "ops:read",
        oidc: {
          providers: [{
            issuer: "https://identity.example.test",
            jwksUri: "https://identity.example.test/.well-known/jwks.json",
            audiences: ["ackerdb"],
            algorithms: ["RS256"],
            tokenType: "at+jwt",
            principalKind: "workload",
          }],
        },
      }));

      expect(loadConfig(dir, {})).toMatchObject({
        statusScope: "ops:read",
        authentication: {
          kind: "oidc",
          options: {
            providers: [{
              issuer: "https://identity.example.test",
              principalKind: "workload",
            }],
          },
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolves an application credential verifier relative to the app directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "ackerdb-config-"));
    try {
      writeFileSync(join(dir, ".ackerdb.config.json"), JSON.stringify({
        credentialVerifier: "./auth/credential-verifier.ts",
      }));

      expect(loadConfig(dir, {})).toMatchObject({
        authentication: {
          kind: "credential-verifier-module",
          path: resolve(dir, "auth/credential-verifier.ts"),
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects competing or malformed custom authentication configuration", () => {
    const dir = mkdtempSync(join(tmpdir(), "ackerdb-config-"));
    try {
      writeFileSync(join(dir, ".ackerdb.config.json"), JSON.stringify({
        oidc: { providers: [] },
        credentialVerifier: "./auth.ts",
      }));
      expect(() => loadConfig(dir, {})).toThrow(
        "oidc and credentialVerifier are mutually exclusive authentication sources",
      );

      for (const credentialVerifier of ["", 42, null]) {
        writeFileSync(join(dir, ".ackerdb.config.json"), JSON.stringify({ credentialVerifier }));
        expect(() => loadConfig(dir, {})).toThrow(
          "credentialVerifier must be a non-empty module path",
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects status scope lists and control characters", () => {
    const dir = mkdtempSync(join(tmpdir(), "ackerdb-config-"));
    try {
      for (const invalid of ["ops read", "ops\nread", ""]) {
        writeFileSync(join(dir, ".ackerdb.config.json"), JSON.stringify({ statusScope: invalid }));
        expect(() => loadConfig(dir, {})).toThrow("statusScope must be one OAuth scope token");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects listener ports that Bun would otherwise coerce", () => {
    const dir = mkdtempSync(join(tmpdir(), "ackerdb-config-"));
    try {
      for (const port of [-1, 0, 1.5, 65_536, "3211"]) {
        writeFileSync(join(dir, ".ackerdb.config.json"), JSON.stringify({ port }));
        expect(() => loadConfig(dir, {})).toThrow("port must be an integer from 1 through 65535");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loads an explicit listener hostname and rejects malformed values", () => {
    const dir = mkdtempSync(join(tmpdir(), "ackerdb-config-"));
    try {
      writeFileSync(join(dir, ".ackerdb.config.json"), JSON.stringify({
        hostname: "0.0.0.0",
      }));
      expect(loadConfig(dir, {})).toMatchObject({ hostname: "0.0.0.0" });

      for (const hostname of ["", " 127.0.0.1", "127.0.0.1\n", 42, null]) {
        writeFileSync(join(dir, ".ackerdb.config.json"), JSON.stringify({ hostname }));
        expect(() => loadConfig(dir, {})).toThrow(
          "hostname must be a non-empty host name or IP address",
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("configures one local or generic S3-compatible File backend", () => {
    const dir = mkdtempSync(join(tmpdir(), "ackerdb-config-"));
    try {
      writeFileSync(join(dir, ".ackerdb.config.json"), JSON.stringify({
        files: {
          backend: "filesystem",
          path: "./blobs",
          publicUrl: "https://files.example.test",
          maxBytes: 42,
        },
      }));
      expect(loadConfig(dir, {})).toMatchObject({
        files: {
          backend: "filesystem",
          root: resolve(dir, "blobs"),
          publicUrl: "https://files.example.test/",
          maxBytes: 42,
        },
      });

      writeFileSync(join(dir, ".ackerdb.config.json"), JSON.stringify({
        files: {
          backend: "s3",
          endpoint: "https://account.r2.cloudflarestorage.com",
          region: "auto",
          bucket: "documents",
          forcePathStyle: true,
          checksum: "disabled",
          encryption: { type: "disabled" },
        },
      }));
      expect(loadConfig(dir, {})).toMatchObject({
        files: {
          backend: "s3",
          endpoint: "https://account.r2.cloudflarestorage.com",
          region: "auto",
          bucket: "documents",
          forcePathStyle: true,
          checksum: "disabled",
          encryption: { type: "disabled" },
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects malformed File backend configuration", () => {
    const dir = mkdtempSync(join(tmpdir(), "ackerdb-config-"));
    try {
      for (const files of [
        { backend: "unknown" },
        { backend: "s3", region: "", bucket: "files" },
        { backend: "s3", region: "auto", bucket: "" },
        { backend: "s3", region: "auto", bucket: "files", checksum: "md5" },
        { backend: "filesystem", maxBytes: 5 * 1024 ** 3 + 1 },
        { backend: "filesystem", path: "." },
        { backend: "filesystem", path: ".." },
      ]) {
        writeFileSync(join(dir, ".ackerdb.config.json"), JSON.stringify({ files }));
        expect(() => loadConfig(dir, {})).toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the admin object", () => {
  test("names the application from its own package, and the directory otherwise", () => {
    const dir = mkdtempSync(join(tmpdir(), "ackerdb-config-"));
    try {
      // Nothing to read: the directory names itself, which is also what the
      // OpenAPI document has always fallen back to.
      expect(loadConfig(dir, {}).admin.application).toEqual({
        name: basename(dir),
        version: "0.0.0",
      });

      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "savoria", version: "2.1.0" }),
      );
      expect(loadConfig(dir, {}).admin.application).toEqual({
        name: "savoria",
        version: "2.1.0",
      });

      // An operator naming the deployment overrides the package.
      writeFileSync(
        join(dir, ".ackerdb.config.json"),
        JSON.stringify({ admin: { application: { name: "savoria-eu" } } }),
      );
      expect(loadConfig(dir, {}).admin.application).toEqual({
        name: "savoria-eu",
        version: "2.1.0",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects an unknown field and a malformed value", () => {
    const dir = mkdtempSync(join(tmpdir(), "ackerdb-config-"));
    try {
      const write = (admin: unknown) =>
        writeFileSync(join(dir, ".ackerdb.config.json"), JSON.stringify({ admin }));

      write({ dashboard: {} });
      expect(() => loadConfig(dir, {})).toThrow("unknown admin field: dashboard");
      write({ application: { title: "savoria" } });
      expect(() => loadConfig(dir, {})).toThrow("unknown admin.application field: title");
      write({ application: { name: 7 } });
      expect(() => loadConfig(dir, {})).toThrow(
        "admin.application.name must be a trimmed non-empty string",
      );
      write("savoria");
      expect(() => loadConfig(dir, {})).toThrow("admin must be a JSON object");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
