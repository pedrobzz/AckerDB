import { describe, expect, test } from "bun:test";
import type { VerifiedCandidate } from "../packages/realtime/native/webrtc/candidate.ts";
import { PACKAGES } from "./lib.ts";
import {
  exactPublishCommand,
  matchesVerifiedTarball,
} from "./publish-local.ts";

function candidate(): VerifiedCandidate {
  const tarballs = PACKAGES.map((pkg) => {
    const packageName = `@ackerdb/${pkg}`;
    return {
      packageName,
      file: `${pkg}.tgz`,
      sha256: new Bun.CryptoHasher("sha256").update(packageName).digest("hex"),
      sourceManifestSha256: "0".repeat(64),
      packedManifestSha256: "0".repeat(64),
    };
  });
  return {
    manifest: { tarballs } as VerifiedCandidate["manifest"],
    tarballs: new Map(PACKAGES.map((pkg) => [
      `@ackerdb/${pkg}`,
      `/candidate/${pkg}.tgz`,
    ])),
  };
}

describe("stable candidate publication", () => {
  test("uses the verified tarball path directly for every lockstep package", () => {
    const verified = candidate();
    expect(PACKAGES.map((pkg) => exactPublishCommand(verified, pkg))).toEqual(
      PACKAGES.map((pkg) => ["bun", "publish", `/candidate/${pkg}.tgz`]),
    );
  });

  test("cannot substitute a newly resolved or repacked package", () => {
    expect(() => exactPublishCommand(candidate(), "missing")).toThrow(
      "verified release candidate has no tarball",
    );
  });

  test("resumes only when registry bytes equal the verified candidate", () => {
    const verified = candidate();
    expect(matchesVerifiedTarball(
      verified,
      "@ackerdb/core",
      new TextEncoder().encode("@ackerdb/core"),
    )).toBe(true);
    expect(matchesVerifiedTarball(
      verified,
      "@ackerdb/core",
      new TextEncoder().encode("different tarball"),
    )).toBe(false);
  });
});
