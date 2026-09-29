# Releasing

A release is a version tag on `main`. Pushing the tag runs
[`publish.yml`](../../.github/workflows/publish.yml): it tests the tagged
source, publishes it to npm with provenance, and creates the GitHub Release.
GitHub Releases are the release history; don't add a root changelog.

1. Merge the change to `main` through a normal PR with green CI. In the same
   PR, bump `version` in `package.json` and `package-lock.json`, and add
   `docs/release/v<version>-release-notes.md`. The workflow uses that file as
   the GitHub Release body.
2. Run the privacy scan on the release commit:
   `git-privacy-scan --ref HEAD history`. Findings in commits before
   `privacy.baseline` are known; any later finding blocks the release. Never
   print a detected value.
3. Tag and push: `git tag -a v<version> -m v<version>` then
   `git push origin v<version>`.

A version with a prerelease suffix goes to npm `next`; any other version goes
to `latest`. If the workflow fails before `npm publish`, fix the problem,
delete the tag, and tag the fixed commit. If it fails after `npm publish`, the
version is spent: release the next version.

Publication adds no commit. Don't add checklist or receipt files, and don't
write the published version into `docs/current/`.

If a published version is bad, deprecate it and publish a corrected higher
version. Never retarget a pushed tag of a published version or replace package
bytes.
