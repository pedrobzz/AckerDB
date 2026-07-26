import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../../src/app/config.ts";

describe("production profile configuration", () => {
  test("defaults to production durability with telemetry enabled", () => {
    expect(loadConfig(".", {})).toMatchObject({
      appPath: resolve("app.ts"),
      dbDir: resolve(".ackerdb"),
      durability: "production",
      telemetry: "enabled",
      statusScope: "ackerdb:status",
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

  test("accepts only the named durability and telemetry profiles", () => {
    expect(loadConfig(".", {
      ACKERDB_DURABILITY: "balanced",
      ACKERDB_TELEMETRY: "disabled",
    })).toMatchObject({
      durability: "balanced",
      telemetry: "disabled",
    });
  });

  test("rejects an unknown durability profile without normalization", () => {
    expect(() => loadConfig(".", { ACKERDB_DURABILITY: "Production" })).toThrow(
      'ACKERDB_DURABILITY must be exactly production or balanced; received "Production"',
    );
  });

  test("rejects an unknown telemetry profile without normalization", () => {
    expect(() => loadConfig(".", { ACKERDB_TELEMETRY: "off" })).toThrow(
      'ACKERDB_TELEMETRY must be exactly enabled or disabled; received "off"',
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
});
