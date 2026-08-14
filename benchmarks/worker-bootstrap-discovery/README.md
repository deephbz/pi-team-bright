# Worker bootstrap resource-discovery benchmark

This is disposable exploration code. It does not create a Team or change production.

Run it from the package root:

```sh
node benchmarks/worker-bootstrap-discovery/run.mjs --samples 10
```

The default artifact is `docs/journal/artifacts/2026-08-14-worker-bootstrap-discovery.json`.

The runner uses one fresh temporary Pi home, agent directory, session directory,
and project directory for every sample. It starts Pi in offline RPC mode and
loads the exact Pi Team Bright extension explicitly. Fixture resources include
an unrelated global extension, Skill, prompt template, theme, project Skill,
and context file. It compares targeted discovery exclusions against the exact
current discovery shape and a Bun-bundled exact extension.

It measures process-spawn to RPC `get_state` response. Its probe records
extension-factory, `session_start`, and `resources_discover` observations. It
also proves that the normal exact-launch fixture retains an unrelated Skill and
that a globally discovered second Pi Team Bright copy fails. The temporary
fixtures contain no credentials, Team data, Task text, Session identifiers, or
private paths. The committed output redacts those fields.

This is not a Worker readiness benchmark. RPC readiness is not exact Worker
binding, Herdr `interactive_ready`, or Task delivery. Those fields are recorded
as not attempted because the harness deliberately creates no durable Team
Membership.
