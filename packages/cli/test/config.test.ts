import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.ts";

describe("production profile configuration", () => {
  test("defaults to production durability with telemetry enabled", () => {
    expect(loadConfig(".", {})).toMatchObject({
      durability: "production",
      telemetry: "enabled",
      statusScope: "dbzz:status",
    });
  });

  test("accepts only the named durability and telemetry profiles", () => {
    expect(loadConfig(".", {
      DBZZ_DURABILITY: "balanced",
      DBZZ_TELEMETRY: "disabled",
    })).toMatchObject({
      durability: "balanced",
      telemetry: "disabled",
    });
  });

  test("rejects an unknown durability profile without normalization", () => {
    expect(() => loadConfig(".", { DBZZ_DURABILITY: "Production" })).toThrow(
      'DBZZ_DURABILITY must be exactly production or balanced; received "Production"',
    );
  });

  test("rejects an unknown telemetry profile without normalization", () => {
    expect(() => loadConfig(".", { DBZZ_TELEMETRY: "off" })).toThrow(
      'DBZZ_TELEMETRY must be exactly enabled or disabled; received "off"',
    );
  });

  test("loads external OIDC providers and one exact workload status scope", () => {
    const dir = mkdtempSync(join(tmpdir(), "dbzz-config-"));
    try {
      writeFileSync(join(dir, ".zdb.config.json"), JSON.stringify({
        statusScope: "ops:read",
        oidc: {
          providers: [{
            issuer: "https://identity.example.test",
            jwksUri: "https://identity.example.test/.well-known/jwks.json",
            audiences: ["dbzz"],
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
    const dir = mkdtempSync(join(tmpdir(), "dbzz-config-"));
    try {
      writeFileSync(join(dir, ".zdb.config.json"), JSON.stringify({
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
    const dir = mkdtempSync(join(tmpdir(), "dbzz-config-"));
    try {
      writeFileSync(join(dir, ".zdb.config.json"), JSON.stringify({
        oidc: { providers: [] },
        credentialVerifier: "./auth.ts",
      }));
      expect(() => loadConfig(dir, {})).toThrow(
        "oidc and credentialVerifier are mutually exclusive authentication sources",
      );

      for (const credentialVerifier of ["", 42, null]) {
        writeFileSync(join(dir, ".zdb.config.json"), JSON.stringify({ credentialVerifier }));
        expect(() => loadConfig(dir, {})).toThrow(
          "credentialVerifier must be a non-empty module path",
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects status scope lists and control characters", () => {
    const dir = mkdtempSync(join(tmpdir(), "dbzz-config-"));
    try {
      for (const invalid of ["ops read", "ops\nread", ""]) {
        writeFileSync(join(dir, ".zdb.config.json"), JSON.stringify({ statusScope: invalid }));
        expect(() => loadConfig(dir, {})).toThrow("statusScope must be one OAuth scope token");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects listener ports that Bun would otherwise coerce", () => {
    const dir = mkdtempSync(join(tmpdir(), "dbzz-config-"));
    try {
      for (const port of [-1, 0, 1.5, 65_536, "3211"]) {
        writeFileSync(join(dir, ".zdb.config.json"), JSON.stringify({ port }));
        expect(() => loadConfig(dir, {})).toThrow("port must be an integer from 1 through 65535");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
