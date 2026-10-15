import { expect, it, vi } from "vitest";
import fc from "fast-check";
import { nodeHostEnv, runWithHostEnv } from "./env/host-env";

const io = vi.hoisted(() => ({ member: {} as any, status: {} as any, events: [] as any[], now: 1000,
  failures: 0, probe: "live", presence: "present", activity: "idle", fence: false, readFailure: false,
  leases: Promise.resolve(), publishingExit: false }));
vi.mock("node:fs", () => ({ default: { readFileSync: () => JSON.stringify({ terminalBackend: "herdr", members: [io.member] }) } }));
vi.mock("./utils/runtime", async original => ({ ...await original<any>(), readRuntimeStatus: async () => structuredClone(io.status) }));
vi.mock("./utils/teams", () => ({ withCurrentMembershipLease: async (_: string, _id: string, action: any) => {
  const previous = io.leases;
  let release!: () => void;
  io.leases = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    if (io.fence) { io.fence = false; io.status.startedAt++; }
    return await action(io.member);
  } finally { release(); }
} }));
vi.mock("./coordination/event-journal", () => ({
  readTeamEvents: (_: string, options: any) => {
    if (io.readFailure) throw new Error("read unavailable");
    const events = io.events.filter(e => Number(e.cursor) > Number(options.afterCursor)).slice(0, options.limit);
    const cursor = events.at(-1)?.cursor ?? options.afterCursor;
    return { events, cursor, truncated: Number(cursor) < io.events.length };
  },
  appendTeamEvent: async (_: string, event: any) => {
    if (io.failures > 0 && event.type === "worker") { io.failures--; throw new Error("append unavailable"); }
    const saved = structuredClone({ ...event, cursor: String(io.events.length + 1) });
    io.events.push(saved); return saved;
  },
}));
import { CarrierObserver, publishPredecessorExit, CARRIER_SAMPLE_TTL_MS } from "./carrier-observation";

const host = () => ({ ...nodeHostEnv,
  clock: { ...nodeHostEnv.clock, now: () => io.now, setTimeout: (() => 0) as any, clearTimeout: () => {} },
  process: { ...nodeHostEnv.process, generation: () => ({ kind: "absent" as const }), generations: async (pids: readonly number[]) => new Map(pids.map(pid => [pid,
    io.publishingExit || io.probe === "gone" ? { kind: "absent" as const } : io.probe === "unknown" ? { kind: "unknown" as const, reason: "source_unavailable" }
      : { kind: "found" as const, generation: { pid, osBirthToken: io.status.osBirthToken ?? "observed-birth", bootId: "boot" } }])) },
  exec: { ...nodeHostEnv.exec, run: async (_: string, args: readonly string[]) => ({ kind: "exited" as const, status: 0, stderr: "",
    stdout: JSON.stringify({ result: args[0] === "pane"
      ? { panes: io.presence === "present" ? [{ pane_id: io.member.terminalTarget.targetId }] : [], partial: io.presence === "unknown" }
      : { agents: io.activity === "unknown" ? [] : [{ name: "team-worker", pane_id: io.member.terminalTarget.targetId,
        agent_session: { source: "herdr:pi", agent: "pi", kind: "path", value: "/session" }, agent_status: io.activity }] } }) }) },
});
const sample = fc.record({
  process: fc.constantFrom("live", "gone", "unknown", "stopping", "reload"),
  presence: fc.constantFrom("present", "absent", "unknown"),
  activity: fc.constantFrom("working", "idle", "blocked", "unknown"),
  target: fc.constantFrom("pane-a", "pane-b"), kind: fc.constantFrom("pane", "window"),
  launch: fc.constantFrom("none", "requested", "started", "refused", "unknown"),
  launchId: fc.constantFrom("launch-a", "launch-b"), bound: fc.boolean(), tokenless: fc.boolean(),
  successor: fc.boolean(), membership: fc.boolean(), restart: fc.boolean(), fence: fc.boolean(),
  failures: fc.integer({ min: 0, max: 3 }), readFailure: fc.boolean(),
});
type Sample = typeof sample extends fc.Arbitrary<infer T> ? T : never;
type Change = { identity: unknown[]; field: string; from: string; to: string; reload?: true; attention?: string };
const initial: Sample = { process: "live", presence: "present", activity: "idle", target: "pane-a", kind: "pane",
  launch: "none", launchId: "launch-a", bound: true, tokenless: false, successor: false, membership: false,
  restart: false, fence: false, failures: 0, readFailure: false };

function reset(): void {
  io.events = []; io.now = 1000; io.failures = 0; io.readFailure = false; io.fence = false; io.leases = Promise.resolve();
  io.member = { name: "worker", agentType: "teammate", membershipId: "m", sessionFile: "/session" };
  io.status = { membershipId: "m", pid: 42, startedAt: 10, osBirthToken: "birth", bootId: "boot" };
}
function source(s: Sample): void {
  io.now++;
  if (s.membership) { io.member.membershipId += "n"; io.status.membershipId = io.member.membershipId; }
  if (s.successor) io.status.startedAt++;
  io.status.osBirthToken = s.tokenless ? undefined : "birth";
  io.member.sessionFile = s.bound ? "/session" : undefined;
  io.member.terminalTarget = { backend: "herdr", kind: s.kind, targetId: s.target };
  io.member.launch = s.launch === "none" ? undefined : { launchId: s.launchId, state: s.launch, requestedAt: io.now };
  io.status.lastStop = s.process === "reload" || s.process === "stopping"
    ? { piReason: s.process === "reload" ? "reload" : "quit", observedAt: io.now, suspectedHumanStop: false } : undefined;
  io.probe = s.process; io.presence = s.presence; io.activity = s.activity;
  io.failures = s.failures; io.readFailure = s.readFailure; io.fence = s.fence;
}

// Independent reference: fold accepted visible changes only. Source failures never commit
// a baseline. A restart discards no accepted event and retains no transient observation.
function reference(history: Change[], s: Sample): void {
  if (s.fence || s.readFailure) return;
  const identity = [io.member.membershipId, io.status.startedAt, io.status.osBirthToken ?? null, s.launch === "none" ? null : s.launchId, "herdr", s.kind, s.target];
  const attention = s.tokenless && s.bound ? (s.process === "gone" ? "absent" : s.process === "unknown" ? "unknown" : "present") : undefined;
  const values: Record<string, string> = { binding: s.bound ? "bound" : "unbound", launch: s.launch,
    process: s.tokenless ? "unknown" : s.process === "reload" ? "stopping" : s.process, terminal: s.presence,
    activity: s.bound ? s.activity : "unknown" };
  for (const [field, to] of Object.entries(values)) {
    const last = history.findLast(e => e.field === field && JSON.stringify(e.identity) === JSON.stringify(identity));
    const from = last?.to ?? "unknown";
    if (from === to && (field !== "process" || last?.attention === attention)) continue;
    if (field === "process" && s.process === "reload" && ["live", "stopping"].includes(from) && ["live", "stopping"].includes(to)) continue;
    if (s.failures > 0) return;
    history.push({ identity, field, from, to, ...(field === "process" && attention ? { attention } : {}),
      ...(field === "process" && !s.tokenless && s.process === "reload" ? { reload: true as const } : {}) });
  }
}
function actual(): Change[] {
  return io.events.filter(e => e.carrier).map(({ carrier: c }) => ({
    identity: [c.membership, c.generation.startedAt, c.generation.osBirthToken ?? null, c.launchId ?? null, c.terminalTarget.backend, c.terminalTarget.kind, c.terminalTarget.targetId],
    field: c.field, from: c.from, to: c.to,
    ...(c.attention ? { attention: c.attention.message.match(/probe=(absent|present|unknown)/)?.[1] } : {}), ...(c.cause.fact === "reload" ? { reload: true as const } : {}),
  }));
}

const delta: fc.Arbitrary<Partial<Sample>> = fc.oneof(
  sample,
  fc.record({ process: fc.constantFrom("live", "gone", "unknown", "stopping", "reload") }),
  fc.record({ presence: fc.constantFrom("present", "absent", "unknown") }),
  fc.record({ activity: fc.constantFrom("working", "idle", "blocked", "unknown") }),
  fc.record({ target: fc.constantFrom("pane-a", "pane-b"), kind: fc.constantFrom("pane", "window") }),
  fc.record({ launch: fc.constantFrom("none", "requested", "started", "refused", "unknown"), launchId: fc.constantFrom("launch-a", "launch-b") }),
  fc.record({ bound: fc.boolean() }), fc.record({ tokenless: fc.boolean() }), fc.constant({}),
);
const occasional = fc.integer({ min: 0, max: 7 }).map(n => n === 0);
const command = fc.tuple(delta, fc.record({ restart: fc.boolean(), failures: fc.integer({ min: 0, max: 3 }),
  readFailure: occasional, fence: occasional, successor: occasional, membership: occasional }));

type Command = typeof command extends fc.Arbitrary<infer T> ? T : never;
const stable = { restart: false, failures: 0, readFailure: false, fence: false, successor: false, membership: false };
// c2-v3-terminal-probe.json: current pane A lost, pane B present, then pane B lost.
const terminalProbe: Command[] = [
  [{ presence: "absent" }, stable], [{ target: "pane-b", presence: "present" }, stable], [{ presence: "absent" }, stable],
];
const restartedRecovery: Command[] = [
  [{ presence: "absent" }, stable], [{ presence: "present" }, stable],
  [{ presence: "absent" }, { ...stable, restart: true, failures: 1 }], [{}, { ...stable, restart: true }],
];

it("CarrierObserver publishes the accepted-journal reference across samples, failures, restarts and generation fences (1000 runs)", async () => {
  await fc.assert(fc.asyncProperty(fc.array(command, { minLength: 10, maxLength: 80 }), async commands => {
    let state = initial;
    const steps = commands.map(([patch, controls]) => (state = { ...state, ...patch, ...controls }));
    reset(); const expected: Change[] = [];
    await runWithHostEnv(host(), async () => {
      let observer: CarrierObserver | undefined;
      try {
        for (const s of [initial, ...steps]) {
          if (s.successor) {
            // Admission must publish the current predecessor before replacing it. This
            // action kills it in world truth without waiting for an observer poll.
            io.failures = s.failures; io.readFailure = s.readFailure;
            const identity = [io.member.membershipId, io.status.startedAt, io.status.osBirthToken ?? null, io.member.launch?.launchId ?? null,
              "herdr", io.member.terminalTarget.kind, io.member.terminalTarget.targetId];
            const before = expected.findLast(e => e.field === "process" && JSON.stringify(e.identity) === JSON.stringify(identity))?.to ?? "unknown";
            const blocked = !io.status.osBirthToken || s.readFailure || (before !== "gone" && s.failures > 0);
            io.publishingExit = true;
            try {
              if (blocked) {
                await expect(publishPredecessorExit("team", io.member, io.status, "herdr")).rejects.toThrow();
                expect(actual()).toEqual(expected);
                continue;
              }
              await publishPredecessorExit("team", io.member, io.status, "herdr");
              if (before !== "gone") expected.push({ identity, field: "process", from: before, to: "gone" });
              expect(actual()).toEqual(expected);
            } finally { io.publishingExit = false; }
          }
          source(s);
          reference(expected, s);
          if (!observer || s.restart) { observer?.stop(); observer = new CarrierObserver("team"); observer.start(); }
          await observer.refresh();
          expect(actual()).toEqual(expected);
        }
        // With a stable source and healthy journal, failed appends converge once. Repeat
        // after a fresh observer to detect duplicate publication and stale baseline replay.
        const drain = { ...steps.at(-1)!, successor: false, membership: false, fence: false, failures: 0, readFailure: false };
        for (let i = 0; i < 3; i++) {
          source(drain); reference(expected, drain);
          if (i === 1) { observer!.stop(); observer = new CarrierObserver("team"); observer.start(); }
          await observer!.refresh(); expect(actual()).toEqual(expected);
        }
      } finally { observer?.stop(); }
    });
  }), { numRuns: 1000, seed: 310003, examples: [[terminalProbe], [restartedRecovery]] });
}, 30000);

it("models tokenless attention across PID probes, expiry, token admission and observer restart (1000 runs)", async () => {
  const legacySample = fc.record({
    process: fc.constantFrom("live", "gone", "unknown"), tokenless: fc.boolean(),
    expire: fc.boolean(), restart: fc.boolean(), successor: fc.boolean(),
  });
  await fc.assert(fc.asyncProperty(fc.array(legacySample, { minLength: 5, maxLength: 60 }), async samples => {
    reset(); const expected: Change[] = [];
    await runWithHostEnv(host(), async () => {
      let observer: CarrierObserver | undefined;
      try {
        for (const s of samples) {
          const input = { ...initial, ...s };
          source(input); reference(expected, input);
          if (!observer || s.restart) { observer?.stop(); observer = new CarrierObserver("team"); observer.start(); }
          await observer.refresh();
          const fresh = observer.views.get(io.member.membershipId)!;
          expect(fresh.process).toBe(s.tokenless ? "unknown" : s.process);
          if (s.tokenless) {
            expect(fresh.attention).toMatchObject({ reason: "legacy_unverified", nextActionHint: "ask_human" });
            expect(fresh.attention!.message).toContain(`probe=${s.process === "live" ? "present" : s.process === "gone" ? "absent" : "unknown"}`);
          } else expect(fresh.attention).toBeUndefined();
          expect(actual()).toEqual(expected);
          if (s.expire) {
            io.now += CARRIER_SAMPLE_TTL_MS;
            const expired = observer.views.get(io.member.membershipId)!;
            expect(expired.process).toBe("unknown");
            if (s.tokenless) {
              expect(expired.attention).toMatchObject({ reason: "legacy_unverified", nextActionHint: "ask_human" });
              expect(expired.attention!.message).toContain("probe=unknown (sample_expired)");
              expect(expired.attention!.message).toMatch(/^Verify/);
            }
            expect(actual()).toEqual(expected); // Expiry alone never invents an accepted journal event.
          }
          await observer.refresh(); await observer.refresh();
          expect(actual()).toEqual(expected);
        }
      } finally { observer?.stop(); }
    });
  }), { numRuns: 1000, seed: 310004 });
}, 30000);

it("serializes two observers against the same accepted publication baseline", async () => {
  reset(); source(initial);
  await runWithHostEnv(host(), async () => {
    const a = new CarrierObserver("team"), b = new CarrierObserver("team");
    a.start(); b.start(); await Promise.all([a.refresh(), b.refresh()]);
    const expected: Change[] = []; reference(expected, initial); expect(actual()).toEqual(expected);
    source({ ...initial, presence: "absent" });
    await Promise.all([a.refresh(), b.refresh()]);
    reference(expected, { ...initial, presence: "absent" }); expect(actual()).toEqual(expected);
    a.stop(); b.stop();
  });
});
