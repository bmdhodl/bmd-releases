# BMD releases

Build. Manage. Deploy.

This repository holds public Windows release assets and update metadata for
[BMD](https://bmdpat.com/bmd). Application source code is maintained separately.

Download the Windows installer from the [latest release](https://github.com/bmdhodl/bmd-releases/releases/latest).
Do not use GitHub's source archive buttons as an application download.

Each release includes `bmd-release.json` with the installer URL, byte count,
SHA256 and workspace compatibility range, plus `latest.yml` and a blockmap for
the updater. Publishing and signing remain controlled by the application
release workflow; the checks here never publish, install or execute a release.

## Verification

PRs run offline refusal tests. Hourly at minute 17 UTC, a hosted check compares
the latest public manifest, GitHub release assets and updater metadata, then
checks installer/blockmap availability and byte counts. It detects asset changes
even when this repository has no new commit. It does not download the installer
or claim checksum/signature verification.

Publishing a stable release also triggers a metadata audit pinned to that
release's tag. It reads versioned asset URLs, so a later release cannot silently
replace the event being checked. Scheduled audits continue to exercise the
public latest pointer. Prereleases do not trigger this stable-feed check.
The publication check uses the default branch's checker; manual dispatch uses
the selected workflow revision and accepts an optional `release_tag`.
Each publication tag has its own concurrency group, so a later publication
cannot replace another tag's pending audit. The publication trigger still needs
readback after the next authorized release. GitHub suppresses release-triggered
workflows when publication uses the repository's `GITHUB_TOKEN`; a publisher
using that token must explicitly dispatch this audit with the published tag.
Hourly checks remain the fallback. See [GitHub's trigger rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
Locally, set `BMD_RELEASE_TAG=v3.47.16` to audit an exact stable tag. Invalid tags
are refused before any network access. Publication checks do not download or
execute installers; nightly or explicit deep checks retain that separate role.

Nightly at 08:43 UTC, a hosted Windows job downloads the installer, verifies its
manifest SHA256 and updater SHA512, and checks a valid Authenticode signature
identifying BMD PAT LLC. The updater validator is reused from the desktop
release scripts; its source revision is recorded in the file. No private repo
credentials or signing keys are needed.

Checks have five-minute (metadata) and fifteen-minute (installer) bounds. Missed
cron runs can be delayed by GitHub; use Actions history to inspect the latest
completed result, not just the scheduled time. Failures remain visible and the
next schedule retries against current assets. Manual dispatch supports a deep
check. Concurrency preserves an in-flight run and coalesces pending runs.

Local validation:

```text
npm ci --ignore-scripts
npm test
pwsh -File tests/signature.test.ps1
node scripts/check-feed.cjs
node scripts/check-feed.cjs --deep
```

On Windows, run `scripts/verify-signature.ps1 -Installer <downloaded .exe>` after
the deep check. A passing metadata or checksum result alone is not signature
verification, install testing, or release approval.
