import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import * as paths from "./paths";
import * as teams from "./teams";
import {
  RAREBIT_AUTOMATIC_SUMMARY_POLICY_CONTRACT,
  RAREBIT_AUTOMATIC_SUMMARY_POLICY_EVENT,
  answerAutomaticSummaryPolicyQuery,
  registerAutomaticSummaryPolicyProvider,
} from "./automatic-summary-policy";
import type { Member } from "./models";

const testTeams: string[] = [];

function teamName(suffix: string): string {
  const name = `rarebit-policy-${suffix}-${process.pid}-${Date.now()}-${testTeams.length}`;
  testTeams.push(name);
  return name;
}

function member(overrides: Partial<Member> = {}): Member {
  return {
    membershipId: teams.newMembershipId(),
    agentId: "worker-agent",
    name: "worker",
    agentType: "teammate",
    joinedAt: Date.now(),
    tmuxPaneId: "",
    sessionFile: "/tmp/worker-session.jsonl",
    cwd: process.cwd(),
    subscriptions: [],
    isActive: true,
    ...overrides,
  };
}

function query(
  durableAssociation = "/tmp/worker-session.jsonl",
  respond: (response: unknown) => boolean = vi.fn((_response: unknown) => true),
) {
  const now = Date.now();
  return {
    contractVersion: RAREBIT_AUTOMATIC_SUMMARY_POLICY_CONTRACT,
    queryId: "query-1",
    operation: "automatic_summary",
    session: { id: "session-1", durableAssociation },
    issuedAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + 1_000).toISOString(),
    respond,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const name of testTeams.splice(0)) {
    fs.rmSync(paths.teamDir(name), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(name), { recursive: true, force: true });
  }
});

describe("Rarebit automatic-summary policy provider", () => {
  it("answers inhibit only with opaque exact current teammate provenance", async () => {
    const teammate = member();
    const respond = vi.fn((_response: unknown) => true);
    await answerAutomaticSummaryPolicyQuery(
      query(teammate.sessionFile, respond),
      {
        resolveBinding: async () => ({
          status: "bound",
          teamName: "private-team-name",
          member: teammate,
        }),
      },
    );
    expect(respond).toHaveBeenCalledTimes(1);
    const answer = respond.mock.calls[0][0] as any;
    expect(answer).toMatchObject({
      contractVersion: RAREBIT_AUTOMATIC_SUMMARY_POLICY_CONTRACT,
      queryId: "query-1",
      decision: "inhibit",
      provider: "pi-teams",
      reason: "current_teammate_membership",
    });
    expect(answer.provenance.identity).toMatch(/^team_[a-f0-9]{64}$/);
    expect(answer.provenance.generation).toMatch(/^membership_[a-f0-9]{64}$/);
    expect(answer.provenance.association).toMatch(/^session_[a-f0-9]{64}$/);
    expect(JSON.stringify(answer)).not.toContain("private-team-name");
    expect(JSON.stringify(answer)).not.toContain(teammate.sessionFile);
    expect(JSON.stringify(answer)).not.toContain(teammate.membershipId);
  });

  it.each([
    ["standalone", { status: "abstain", reason: "not_bound" }],
    ["leader", { status: "abstain", reason: "leader_or_non_teammate" }],
    ["replaced teammate", { status: "abstain", reason: "stale_binding" }],
    ["resumed but unbound", { status: "abstain", reason: "not_bound" }],
    ["fork", { status: "abstain", reason: "not_bound" }],
    ["ambiguous", { status: "abstain", reason: "ambiguous_binding" }],
  ] as const)("abstains for %s", async (_name, resolution) => {
    const respond = vi.fn(() => true);
    await answerAutomaticSummaryPolicyQuery(query(undefined, respond), {
      resolveBinding: async () => resolution,
    });
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "abstain",
        provider: "pi-teams",
        reason: resolution.reason,
      }),
    );
  });

  it("abstains if the resolved generation does not own the queried durable association", async () => {
    const respond = vi.fn(() => true);
    await answerAutomaticSummaryPolicyQuery(
      query("/tmp/query.jsonl", respond),
      {
        resolveBinding: async () => ({
          status: "bound",
          teamName: "team",
          member: member({ sessionFile: "/tmp/other.jsonl" }),
        }),
      },
    );
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "abstain", reason: "stale_binding" }),
    );
  });

  it("ignores malformed, incompatible, and expired requests", async () => {
    const resolveBinding = vi.fn();
    await answerAutomaticSummaryPolicyQuery({}, { resolveBinding });
    await answerAutomaticSummaryPolicyQuery(
      { ...query(), contractVersion: "future/2" },
      { resolveBinding },
    );
    await answerAutomaticSummaryPolicyQuery(
      {
        ...query(),
        deadlineAt: "2020-01-01T00:00:00.000Z",
      },
      { resolveBinding },
    );
    expect(resolveBinding).not.toHaveBeenCalled();
  });

  it("registers only the operation-specific shared event listener", async () => {
    let listener: ((value: unknown) => void) | undefined;
    const pi = {
      events: {
        on: vi.fn((channel: string, handler: (value: unknown) => void) => {
          expect(channel).toBe(RAREBIT_AUTOMATIC_SUMMARY_POLICY_EVENT);
          listener = handler;
          return () => {};
        }),
      },
    };
    registerAutomaticSummaryPolicyProvider(pi as never);
    expect(pi.events.on).toHaveBeenCalledTimes(1);
    listener?.({ contractVersion: "incompatible" });
  });
});

describe("strict current teammate binding", () => {
  it("distinguishes exact teammate, leader, standalone/fork, and replaced generation", async () => {
    paths.ensureDirs();
    const name = teamName("identity");
    const leadSession = `/tmp/${name}-lead.jsonl`;
    const teammateSession = `/tmp/${name}-worker.jsonl`;
    const forkSession = `/tmp/${name}-fork.jsonl`;
    await teams.createTeam(name, leadSession, "lead-agent");
    const current = member({ sessionFile: teammateSession });
    await teams.addMember(name, current);

    const exact =
      await teams.resolveCurrentTeammateSessionBinding(teammateSession);
    expect(exact).toMatchObject({
      status: "bound",
      teamName: name,
      member: {
        membershipId: current.membershipId,
        sessionFile: teammateSession,
      },
    });
    expect(
      await teams.resolveCurrentTeammateSessionBinding(teammateSession),
    ).toMatchObject({
      status: "bound",
    });
    expect(
      await teams.resolveCurrentTeammateSessionBinding(leadSession),
    ).toEqual({
      status: "abstain",
      reason: "leader_or_non_teammate",
    });
    expect(
      await teams.resolveCurrentTeammateSessionBinding(forkSession),
    ).toEqual({
      status: "abstain",
      reason: "not_bound",
    });

    await teams.deactivateMembership(name, current.membershipId!, "replaced");
    await teams.addMember(
      name,
      member({
        membershipId: teams.newMembershipId(),
        sessionFile: `/tmp/${name}-replacement.jsonl`,
      }),
    );
    expect(
      await teams.resolveCurrentTeammateSessionBinding(teammateSession),
    ).toEqual({
      status: "abstain",
      reason: "not_bound",
    });
  });

  it("fails open when the same durable Session is current in two Memberships", async () => {
    paths.ensureDirs();
    const shared = `/tmp/rarebit-ambiguous-${process.pid}-${Date.now()}.jsonl`;
    for (const suffix of ["a", "b"]) {
      const name = teamName(`ambiguous-${suffix}`);
      await teams.createTeam(name, `/tmp/${name}-lead.jsonl`, "lead-agent");
      await teams.addMember(name, member({ sessionFile: shared }));
    }
    expect(await teams.resolveCurrentTeammateSessionBinding(shared)).toEqual({
      status: "abstain",
      reason: "ambiguous_binding",
    });
  });
});
