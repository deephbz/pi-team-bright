# Releasing

GitHub Releases are Pi Team Bright's release history; don't add a root
changelog. Versions, Git tags, npm bytes, dist-tags, and downstream
HyperCarrier composition are separate authorities and must be recorded
separately.

Keep integration E2E verification separate from release execution. For the
integration E2E test, use Herdr to launch a fresh independent Pi agent in a new
tab. That agent creates its own disposable test Team and exercises all
model-facing leader and Worker tools. Use Pi Team Bright Tasks and Alerts inside
that test Team; use Herdr only to create, prompt, observe, and wait for the
independent Pi agent. Do not add this agent as a release-process proxy. The
release operator executes the steps below directly from the exact release
repository.

1. Confirm the exact release commit is merged to `main`, CI is green, the npm
   version and Git tag are absent, and the working tree is clean.
2. Run the full tests, test-lane closure, generated/package verification, and
   inspect `npm pack --dry-run --json`.
3. Pack once from a clean detached checkout, record the tarball SHA-512, install
   that exact tarball into an isolated project, and run the Pi installation
   canary.
4. Dispatch **Publish npm package** with `dry_run: true`; record its nonce, run,
   exact head SHA, and skipped publish step.
5. Create and push the annotated version tag only after every reversible gate
   passes.
6. Prefer npm trusted publishing through GitHub Actions OIDC. Dispatch the
   tagged workflow with `dry_run: false` and an explicit dist-tag (`next` for a
   release candidate, `latest` for a stable release).
7. Only when npm cannot pre-bind a trusted publisher for a package that doesn't
   yet exist, the first version may use the explicitly approved human/2FA
   bootstrap: publish the exact recorded tarball locally with
   `npm publish <tarball> --access public --tag <dist-tag>`, then immediately
   bind GitHub owner `deephbz`, repository `pi-team-bright`, workflow
   `publish.yml`, and environment `npm`. Never store an npm token in the
   repository or workflow.
8. Prove registry integrity and the observed dist-tag against the recorded
   tarball before creating the matching GitHub Release or announcing the
   package. Every later OIDC publication must use a strictly higher version.

If a release must be withdrawn, don't rewrite published history, retarget a
tag, or replace package bytes. Deprecate the bad version if appropriate,
publish a corrected higher version, and tell operators to reinstall an exact
known-good version.
