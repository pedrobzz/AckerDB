# Shai-Hulud-resistant CI and npm publishing

Updated: 2026-08-02

## Conclusion

AckerDB already has several strong controls: CI installs the committed lockfile
with lifecycle scripts disabled, third-party Actions are pinned to full commit
SHAs, ordinary pull requests have read-only repository permissions, and npm
publication uses OIDC instead of a stored npm write token. The remaining
high-impact weakness is that the same release job restores a dependency cache,
runs repository-controlled code, holds an npm-capable OIDC permission, and can
publish directly without an independent human approval. See the current
[workspace action](../../.github/actions/bun-workspace/action.yml),
[release workflow](../../.github/workflows/release.yml), and
[publisher](../../scripts/release/publish.ts).

Before the repository becomes public, the release boundary should be changed
so that no job which executes project code or restores a cache can mint an npm
publishing credential. CI should create fixed tarballs in an unprivileged job;
a separate fresh, cache-free job should do nothing except verify those exact
tarballs and submit them through npm **staged publishing**. Each release should
become public only after Pedro reviews the staged artifacts and approves them
with npm 2FA. npm identifies stage-only trusted publishing plus disallowed
traditional tokens as its maximum-security configuration.
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[npm staged publishing](https://docs.npmjs.com/staged-publishing/)

## Adopted lockstep-release tradeoff

npm's staged-publishing interface approves exactly one stage ID at a time and
requires 2FA for every approval. It has no atomic multi-package approval. A
lockstep AckerDB release would therefore require twelve proof-of-presence
actions. Pedro rejected that recurring operational cost.

AckerDB adopts one reviewer gate on the GitHub `npm` environment followed by
direct OIDC publication in a single billed job. The compensating boundaries
are: external contributions are Issue-only; pull-request code runs only on
credential-free GitHub-hosted runners; the release restores no dependency
cache; all installs disable lifecycle scripts; the lockfile is frozen; Action
dependencies are full-SHA pinned and repository-allowlisted; fresh dependency
resolution is delayed seven days; and the npm account has no access tokens.
This is deliberately weaker than npm's maximum-security
stage-only posture: compromise of Pedro's GitHub approval session or approval
of a malicious protected commit can still authorize direct publication.

## Threat evidence

GitHub describes Shai-Hulud as a multi-wave JavaScript supply-chain campaign.
Its first wave abused compromised maintainer accounts and malicious install
scripts to steal credentials and republish infected packages. Its second wave
expanded credential harvesting, adapted its behavior inside CI, attempted
build-agent privilege escalation, registered self-hosted GitHub runners for
persistence and added destructive behavior.
[GitHub Security Lab campaign summary](https://github.blog/security/supply-chain-security/strengthening-supply-chain-security-preparing-for-the-next-malware-campaign/)

The 2026 Mini Shai-Hulud waves retained the same decisive properties: legitimate
package names and maintainer authority, install-time execution, developer and CI
secret harvesting, GitHub API abuse, and automated infection and republication
of other packages accessible to the stolen npm identity. Artifact inspection of
the May 2026 AntV wave found a malicious `preinstall` hook, encrypted
exfiltration, GitHub repositories used as a fallback exfiltration channel, and
logic to enumerate, modify and republish packages.
[Aikido's initial AntV detection](https://www.aikido.dev/blog/mini-shai-hulud-antv-npm-supply-chain-attack),
[Socket's artifact analysis](https://socket.dev/blog/antv-packages-compromised)

OIDC trusted publishing alone does not make the build job trustworthy. In the
May 2026 TanStack compromise, an attacker chained a `pull_request_target` pwn
request, a poisoned Actions cache and code execution in a release job. The
malware extracted the lazily minted GitHub OIDC token from the runner process
and published 84 malicious versions through TanStack's legitimate npm trusted
publisher even though the workflow's intended publish step did not run.
[TanStack's first-party postmortem](https://tanstack.com/blog/npm-supply-chain-compromise-postmortem),
[TanStack security advisory](https://github.com/TanStack/router/security/advisories/GHSA-g7cv-rxg3-hmpx)

GitHub has since made default-branch cache tokens read-only for untrusted events
such as externally triggered `pull_request_target` runs. Ordinary `push`,
`workflow_dispatch`, default `pull_request` scopes and other listed events still
retain their documented cache behavior; restored cache contents must therefore
remain untrusted at a credential boundary.
[GitHub's June 2026 cache-token change](https://github.blog/changelog/2026-06-26-read-only-actions-cache-for-untrusted-triggers),
[GitHub cache security guidance](https://docs.github.com/en/enterprise-cloud@latest/actions/concepts/workflows-and-actions/dependency-caching#cache-security)

## AckerDB exposure and required controls

| Priority | Current AckerDB boundary | Required control |
| --- | --- | --- |
| Critical | `release.yml` grants `id-token: write`, restores `~/.bun/install/cache`, and then executes repository code. Any code execution in that job can attempt the TanStack-style OIDC path. | Split release into an unprivileged pack/test job and a fresh publish job. The publish job must restore no cache, run no lifecycle scripts, and execute no project JavaScript/TypeScript. Give `id-token: write` only to that job. |
| Critical | The trusted publisher currently permits direct `npm publish`; one compromised release execution can make malware immediately installable under all AckerDB package names. | Configure every npm package's trusted publisher as **stage-only**, change automation to `npm stage publish`, set package publishing access to **Require 2FA and disallow tokens**, and revoke every remaining automation/write token. A separate interactive 2FA approval must make each staged tarball public. [npm's maximum-security configuration](https://docs.npmjs.com/trusted-publishers/#how-to-configure-maximum-security) |
| High | The publish job also has `contents: write` so it can create tags. Code executing beside npm OIDC therefore has two privileged capabilities. | Remove `contents: write` from the npm job. Create the tag in a later, narrowly scoped workflow only after registry bytes and provenance have been verified. |
| High | Native binaries downloaded from a successful pull-request run become release inputs. Their manifests and hashes are useful integrity evidence but are not an external signature tying the artifact to a source commit and workflow. | Prefer rebuilding native packages from the protected merge commit in an unprivileged release-candidate job. If PR-built binaries remain necessary, attest each binary/SBOM, verify the attestation against the exact repository, commit and signer workflow before staging, and still inspect the staged tarballs. GitHub notes that attestations establish provenance, not safety. [GitHub artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations), [attestation implementation](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations) |
| Critical | The Hetzner machine is a persistent repository-level self-hosted runner and the public PR workflow checks out and executes pull-request code on it. | Unregister it from the public repository before visibility changes. Run public PR benchmarks on GitHub-hosted runners, or dispatch only immutable, reviewed benchmark inputs to an ephemeral one-job machine that has no host credentials, no sibling services, no Docker socket, no inbound SSH from CI, and is destroyed after the job. GitHub says self-hosted runners should almost never serve public repositories because a pull request can compromise the environment; JIT registration alone is insufficient if the hardware is reused without cleaning. [GitHub secure-use reference](https://docs.github.com/en/actions/reference/security/secure-use#hardening-for-self-hosted-runners) |
| High | Local developer `bun install` has no repository-wide `ignoreScripts` policy. Bun blocks arbitrary dependency scripts by default but implicitly trusts a maintained default list of popular packages; CI already passes `--ignore-scripts`. | Set `install.ignoreScripts = true` in the root `bunfig.toml`, and run the repository's own `prepare` script explicitly when Git hooks must be installed. Keep any exception as an explicit, reviewed package allowlist rather than accepting Bun's implicit list. [Bun lifecycle-script policy](https://bun.com/docs/pm/lifecycle) |
| Medium | New dependency resolution has no age gate. The lockfile protects unchanged CI runs, but a dependency update can select a just-published malicious version. | Set a minimum release age for new resolutions (seven days is a reasonable conservative default), document exceptional allowlist entries, and require review of every lockfile change. Bun states the age filter applies to new direct and transitive resolutions but not versions already present in `bun.lock`. [Bun minimum release age](https://bun.sh/docs/pm/cli/install#minimum-release-age) |
| High | Repository Actions policy previously allowed arbitrary public Actions even though checked-in usages are SHA-pinned. A future workflow edit could introduce an unpinned or unexpected action. | Restrict allowed Actions to GitHub-owned plus the exact reviewed publishers used here, and enable the policy requiring full-length commit SHAs. GitHub states a full commit SHA is currently the only immutable way to reference a third-party Action. [GitHub secure-use reference](https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions) |

## Target release architecture

1. A protected-branch event starts on a fresh GitHub-hosted runner with
   `contents: read`, no secrets and no OIDC permission.
2. It installs exactly `bun.lock` with `--frozen-lockfile --ignore-scripts` and
   without an Actions package cache, builds/tests, and creates all eleven
   publishable tarballs with package scripts disabled.
3. It records each tarball's SHA-256 and creates provenance/attestations for
   native binaries and release artifacts. Attestations make the producing
   repository, workflow, event and commit verifiable, but do not prove that the
   resulting code is benign.
   [GitHub artifact-attestation model](https://docs.github.com/en/actions/concepts/security/artifact-attestations)
4. A separate fresh job has only `contents: read` and `id-token: write`. It
   downloads the fixed artifacts, verifies hashes and attestations, runs no
   repository code, restores no cache, and calls `npm stage publish` on each
   prebuilt tarball.
5. Pedro downloads and inspects the staged tarballs, compares their file lists
   and hashes to CI's candidate manifest, and approves them interactively with
   npm 2FA. An OIDC token can stage but cannot run `npm stage approve`; npm
   requires proof of presence for approval.
   [npm stage command contract](https://docs.npmjs.com/cli/v11/commands/npm-stage/)
6. A post-publication verifier waits for npm's publish-time malware scan,
   downloads the registry tarballs, compares them byte-for-byte with the
   approved candidate, validates provenance, and only then creates the Git tag.
   npm began scanning new packages before install availability in July 2026;
   that detection is useful defense-in-depth, not authorization.
   [npm publish-time scanning](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/)

## Pull-request and workflow rules

- Keep every pull-request job at `contents: read` or lower, with no secrets,
  OIDC, deployment environment or writable production identity. Never combine
  `pull_request_target` or a privileged `workflow_run` with checkout or execution
  of fork-controlled code; GitHub documents this as a repository-takeover path.
  [GitHub secure-use reference](https://docs.github.com/en/actions/reference/security/secure-use#mitigating-the-risks-of-untrusted-code-checkout)
- Keep third-party Actions pinned to reviewed full SHAs and add Dependabot for
  GitHub Actions so updating the pins is deliberate. An allowlist constrains
  which new Actions a compromised workflow can introduce.
  [GitHub Actions dependency guidance](https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions)
- Treat caches and artifacts as untrusted inputs. Never put secrets in caches,
  and never restore a cache in npm-, tag-, deployment- or server-credential jobs.
  [GitHub cache security guidance](https://docs.github.com/en/enterprise-cloud@latest/actions/concepts/workflows-and-actions/dependency-caching#cache-security)
- Enable Dependabot malware alerts after the repository becomes public. GitHub
  now ingests OpenSSF malicious-package advisories for npm and other ecosystems,
  but alerts arrive after detection and do not replace install-time isolation.
  [GitHub malware-alert coverage](https://github.blog/changelog/2026-07-28-dependabot-alerts-on-malicious-packages-across-more-ecosystems)
- Keep GitHub, npm and the email account protecting recovery flows behind
  phishing-resistant WebAuthn/passkeys; audit and revoke unused OAuth/GitHub
  Apps and tokens. GitHub recommends phishing-resistant MFA, token expiry,
  trusted publishing, branch protection and pinned CI dependencies in direct
  response to Shai-Hulud.
  [GitHub Security Lab recommendations](https://github.blog/security/supply-chain-security/strengthening-supply-chain-security-preparing-for-the-next-malware-campaign/)

## Detection and response boundary

Preventive controls need an independent alarm. Monitor npm for any
`@ackerdb/*` version whose time, version, provenance, source commit, workflow or
tarball hash is absent from the approved release manifest. Alert on creation of
repository-level self-hosted runners, changes to `.github/workflows/**`, npm
maintainer/trusted-publisher changes, new OAuth/GitHub App grants, package
publishing-access changes and unexpected release tags.

If any unapproved package or runner appears, stop all release workflows, reject
pending stages, revoke npm/GitHub/OAuth credentials, remove unknown runners and
Apps, preserve logs, and treat every credential readable by the affected runner
or developer machine as compromised. This response matches the campaign's
observed credential harvesting and delayed reuse: GitHub notes that attackers
may retain stolen tokens for later waves rather than use them immediately.
[GitHub Security Lab campaign summary](https://github.blog/security/supply-chain-security/strengthening-supply-chain-security-preparing-for-the-next-malware-campaign/)
