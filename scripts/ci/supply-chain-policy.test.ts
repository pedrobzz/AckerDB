import { describe, expect, test } from "bun:test";

const ciWorkflow = await Bun.file(".github/workflows/ci.yml").text();
const releaseWorkflow = await Bun.file(".github/workflows/release.yml").text();
const publisher = await Bun.file("scripts/release/publish.ts").text();
const bunConfig = await Bun.file("bunfig.toml").text();

describe("public repository CI boundaries", () => {
  test("never executes pull-request code on a self-hosted runner", () => {
    expect(ciWorkflow).not.toContain("self-hosted");
    expect(ciWorkflow).not.toContain("hetzner");
  });

  test("keeps the release job cache-free and read-only", () => {
    expect(releaseWorkflow).toContain("contents: read");
    expect(releaseWorkflow).not.toContain("contents: write");
    expect(releaseWorkflow).not.toContain("actions/cache@");
    expect(releaseWorkflow).not.toContain("./.github/actions/bun-workspace");
    expect(releaseWorkflow).toContain("node-version: 24.18.0");
  });

  test("auto-publishes canaries but requires stable approval", () => {
    expect(releaseWorkflow).toContain("environment: npm");
    expect(releaseWorkflow).toContain("environment: npm-stable-approval");
    expect(releaseWorkflow).toContain("if: github.ref_name == 'main'");
    expect(releaseWorkflow).toContain("needs: approve-stable");
    expect(releaseWorkflow).toContain("workflow_dispatch:");
    expect(publisher).toMatch(/"npm",\s*"publish",\s*tarball/);
    expect(releaseWorkflow).toContain("from protected ${{ github.ref_name }}");
  });

  test("disables install scripts and quarantines fresh dependency releases", () => {
    expect(bunConfig).toContain("ignoreScripts = true");
    expect(bunConfig).toContain("minimumReleaseAge = 604800");
  });
});
