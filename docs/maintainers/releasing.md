# Releasing

GitHub Releases are Pi Team Bright's release history; do not add a root
changelog. This repository's release workflow is deliberately manual and uses
npm trusted publishing through GitHub Actions OIDC, never a long-lived npm
token.

1. Confirm the release commit is reviewed and CI is green.
2. Set the intended semver in `package.json`, regenerate `package-lock.json`,
   and run `npm test` plus `npm run verify:package` locally.
3. Inspect `npm pack --dry-run --json`; ensure only public runtime material and
   public operator/agent docs are present.
4. Create and push the release tag through the normal repository release
   process, then create the matching GitHub Release with user-visible notes.
5. From that exact release commit, dispatch **Publish npm package** first with
   its default `dry_run: true` to exercise the complete clean-install,
   package-local Beads, test, and pack gates without an npm mutation. After
   review, dispatch again with `dry_run: false` and choose the explicit npm
   dist-tag (`next` for release candidates, `latest` for a stable release). The
   workflow verifies first, then publishes with OIDC provenance.
6. Confirm the registry metadata and a clean `pi install
   npm:@hypercarrier/pi-team-bright@<version>` before announcing it.

If a release must be withdrawn, do not rewrite published history. Deprecate the
bad npm version if appropriate, publish a corrected version, and tell operators
to reinstall the known-good exact version as described in the root README.
