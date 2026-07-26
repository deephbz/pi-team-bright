import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  createPiTeamsResultRenderer,
  formatPiTeamsToolResult,
  PI_TEAMS_PUBLIC_TOOLS,
} from "./tool-result-renderer";
import { toolResultDetails, warning } from "./tool-results";

function text(lines: ReturnType<typeof formatPiTeamsToolResult>): string {
  return lines.map((line) => line.text).join("\n");
}

describe("shared PiTeams tool-result renderer", () => {
  it("covers the exact ten-tool surface with one envelope renderer family", () => {
    const cases = [
      ["team_create", { kind: "team", id: "dogfood", teamName: "dogfood" }, {}],
      ["team_sync", { kind: "team", id: "dogfood", teamName: "dogfood" }, {}],
      ["team_shutdown", { kind: "team", id: "dogfood", teamName: "dogfood" }, {}],
      ["worker_ensure", { kind: "worker", id: "auditor", teamName: "dogfood" }, {}],
      ["worker_stop", { kind: "worker", id: "auditor", teamName: "dogfood" }, {}],
      ["task_create", { kind: "task", id: "pt-42", teamName: "dogfood" }, {}],
      ["task_read", { kind: "task", id: "pt-42", teamName: "dogfood" }, {}],
      ["task_update", { kind: "task", id: "pt-42", teamName: "dogfood" }, {}],
      ["task_link", { kind: "task", id: "pt-42", teamName: "dogfood" }, {
        team_name: "dogfood", task_id: "pt-42", action: "add", relation: "blocked_by", target_id: "pt-41",
      }],
      ["alert_send", { kind: "alert", id: "alert_opaque", teamName: "dogfood" }, {
        team_name: "dogfood", kind: "attention", to: "auditor", task_id: "pt-42",
      }],
    ] as const;

    for (const [tool, resource, args] of cases) {
      const first = formatPiTeamsToolResult({
        tool,
        args,
        expanded: false,
        details: toolResultDetails({ operation: tool, resource }),
      })[0].text;
      expect(first).toMatch(/^✓ Accepted:/);
      expect(first).not.toMatch(/Create|Sync|Shut Down|Ensure|Stop|Read|Update|Link|Send/);
      if (tool === "alert_send") expect(first).not.toContain("alert_opaque");
    }
  });

  it("keeps creation compact and quotes the exact model-facing hints", () => {
    const modelContent = [
      "Team dogfood created; Task authority is ready.",
      "Next: use worker_ensure when another capability is needed, or task_create to create the first work contract.",
    ].join("\n");
    const lines = formatPiTeamsToolResult({
      tool: "team_create",
      args: { team_name: "dogfood" },
      content: [{ type: "text", text: modelContent }],
      expanded: false,
      details: toolResultDetails({
        operation: "team_create",
        resource: { kind: "team", id: "dogfood", teamName: "dogfood" },
        postState: {
          lifecycle: "active",
          taskAuthorityReady: true,
          teamDirectory: "/home/user/.pi/teams/dogfood",
          taskWorkspace: "/home/user/.pi/teams/dogfood",
          beadsDatabase: "pi_teams_dogfood",
        },
        nextActions: [
          { tool: "worker_ensure", reason: "Create a stable Worker." },
          { tool: "task_create", reason: "Create the first work contract." },
        ],
      }),
    });
    const rendered = text(lines);

    expect(lines[0].text).toBe('✓ Accepted: team "dogfood" · active');
    expect(rendered).toContain("Task engine: Beads · workspace: /home/user/.pi/teams/dogfood · external view/edit: bd --directory <workspace> …");
    expect(rendered).toContain("Hints sent to agent:\n" + modelContent);
    expect(lines.filter((line) => line.italic).map((line) => line.text)).toEqual(modelContent.split("\n"));
    expect(rendered).not.toContain("→ worker_ensure");
    expect(rendered).not.toContain("→ task_create");
    expect(rendered).not.toContain("Beads database");
  });

  it("shows short model content exactly and defers long model content behind expansion", () => {
    const shortContent = "Worker reviewer prepared.\nNext: observe binding changes with team_sync.";
    const shortLines = formatPiTeamsToolResult({
      tool: "worker_ensure",
      args: { team_name: "dogfood", name: "reviewer" },
      content: [{ type: "text", text: shortContent }],
      expanded: false,
      details: toolResultDetails({
        operation: "worker_ensure",
        resource: { kind: "worker", id: "reviewer", teamName: "dogfood" },
        postState: { action: "created", carrier: "prepared" },
      }),
    });
    expect(text(shortLines)).toContain("Hints sent to agent:\n" + shortContent);
    expect(shortLines.filter((line) => line.italic).map((line) => line.text)).toEqual(shortContent.split("\n"));

    const longContent = [
      "Team dogfood events at cursor 42.",
      "Observed a long authoritative Task change with enough detail to keep the collapsed human receipt focused on the current decision.",
      "Next: reconcile the Task and Worker state before making another mutation.",
    ].join("\n");
    const compact = text(formatPiTeamsToolResult({
      tool: "team_sync",
      args: { team_name: "dogfood" },
      content: [{ type: "text", text: longContent }],
      expanded: false,
      details: toolResultDetails({ operation: "team_sync", resource: { kind: "team", id: "dogfood", teamName: "dogfood" } }),
    }));
    const expanded = text(formatPiTeamsToolResult({
      tool: "team_sync",
      args: { team_name: "dogfood" },
      content: [{ type: "text", text: longContent }],
      expanded: true,
      details: toolResultDetails({ operation: "team_sync", resource: { kind: "team", id: "dogfood", teamName: "dogfood" } }),
    }));
    expect(compact).toContain("Hints sent to agent: 3 lines");
    expect(compact).toContain("expand for exact text");
    expect(compact).not.toContain("Observed a long authoritative Task change");
    expect(expanded).toContain("Hints sent to agent:\n" + longContent);

    const whitespaceContent = "  leading spaces\n\ntrailing spaces  \n";
    const whitespaceLines = formatPiTeamsToolResult({
      tool: "team_sync",
      args: { team_name: "dogfood" },
      content: [{ type: "text", text: whitespaceContent }],
      expanded: true,
      details: toolResultDetails({ operation: "team_sync", resource: { kind: "team", id: "dogfood", teamName: "dogfood" } }),
    });
    expect(whitespaceLines.filter((line) => line.italic).map((line) => line.text).join("\n"))
      .toBe(whitespaceContent);
  });

  it("keeps outcome, semantic Task identity, and warnings collapsed without machine-only actions", () => {
    const rendered = text(formatPiTeamsToolResult({
      tool: "task_update",
      args: { team_name: "dogfood", task_id: "pt-42" },
      expanded: false,
      details: toolResultDetails({
        operation: "task_update",
        resource: { kind: "task", id: "pt-42", teamName: "dogfood" },
        postState: {
          status: "blocked",
          assignee: "event-auditor",
          version: "sha256:opaque-version",
          notes: "large machine evidence that belongs below the fold",
        },
        warnings: [warning("delivery_delayed", "Worker delivery is pending.", "event-auditor")],
        nextActions: [{
          tool: "team_sync",
          reason: "Wait for the next authoritative Task change.",
          args: { team_name: "dogfood", task_ids: ["pt-42"], cursor: "17" },
        }],
        evidence: { authorityId: "authority-secret", version: "sha256:opaque-version" },
        diagnostics: { sessionFile: "/private/runtime/session.jsonl", paneId: "%91" },
      }),
    }));

    expect(rendered).toContain('Accepted: task "pt-42" · team "dogfood"');
    expect(rendered).toContain("blocked · event-auditor");
    expect(rendered).toContain("Worker delivery is pending.");
    expect(rendered).not.toContain("event-auditor: Worker delivery");
    expect(rendered).not.toContain("team_sync");
    expect(rendered).not.toContain("sha256:opaque-version");
    expect(rendered).not.toContain("authority-secret");
    expect(rendered).not.toContain("session.jsonl");
    expect(rendered).not.toContain("{");
  });

  it("states a partial Team shutdown outcome once while retaining authority facts", () => {
    const details = toolResultDetails({
      outcome: "partial",
      operation: "team_shutdown",
      resource: { kind: "team", id: "dogfood", teamName: "dogfood" },
      postState: {
        lifecycle: "active",
        shutdownOutcome: "partial",
        stoppedWorkers: 1,
        stoppedWorkerNames: ["reviewer"],
        failures: [{ name: "delivery-broken", reason: "stop_not_confirmed" }],
        unfinishedTasks: [{ id: "pt-42", status: "open" }],
        currentMembers: ["team-lead", "delivery-broken"],
        taskAuthorityRetained: true,
      },
    });
    const compact = text(formatPiTeamsToolResult({
      tool: "team_shutdown",
      args: { team_name: "dogfood" },
      expanded: false,
      details,
    }));
    const expanded = text(formatPiTeamsToolResult({
      tool: "team_shutdown",
      args: { team_name: "dogfood" },
      expanded: true,
      details,
    }));

    for (const rendered of [compact, expanded]) {
      const header = rendered.split("\n")[0];
      expect(header).toBe('! Partial: team "dogfood" · active');
      expect(header.match(/\bPartial\b/g)).toHaveLength(1);
      expect(rendered).toContain("1 Workers stopped: reviewer · 1 failed · 1 unfinished Tasks retained");
      expect(rendered).toContain("Current members: team-lead, delivery-broken");
      expect(rendered).toContain("Task authority retained");
    }
  });

  it("does not repeat a Task resource ID in its own compact warning", () => {
    const rendered = text(formatPiTeamsToolResult({
      tool: "task_create",
      args: { team_name: "dogfood" },
      expanded: false,
      details: toolResultDetails({
        outcome: "partial",
        operation: "task_create",
        resource: { kind: "task", id: "pt-42", teamName: "dogfood" },
        postState: { title: "Recover delivery", status: "open", assignee: "auditor" },
        warnings: [warning(
          "task_delivery_degraded",
          "Task authority committed, but delivery enqueue for auditor failed",
          "pt-42",
        )],
      }),
    }));

    expect(rendered).toContain('Partial: task "pt-42" · team "dogfood"');
    expect(rendered).toContain("! Task authority committed, but delivery enqueue for auditor failed");
    expect(rendered.match(/pt-42/g)).toHaveLength(1);
  });

  it("does not repeat a missing Alert recipient in its compact warning", () => {
    const details = toolResultDetails({
      outcome: "refused",
      operation: "alert_send",
      postState: {
        attemptedKind: "attention",
        attemptedRecipient: "missing-worker",
        accepted: false,
        reason: "recipient_not_current",
      },
      warnings: [warning(
        "alert_recipient_not_current",
        "Recipient 'missing-worker' is not a current member of team 'dogfood'.",
        "missing-worker",
      )],
    });
    const compact = text(formatPiTeamsToolResult({
      tool: "alert_send",
      args: { team_name: "dogfood", to: "missing-worker", kind: "attention" },
      expanded: false,
      details,
    }));
    const expanded = text(formatPiTeamsToolResult({
      tool: "alert_send",
      args: { team_name: "dogfood", to: "missing-worker", kind: "attention" },
      expanded: true,
      details,
    }));

    expect(compact).toContain('attention alert to "missing-worker" · team "dogfood"');
    expect(compact).toContain("! Recipient is not a current Team member.");
    expect(compact.match(/missing-worker/g)).toHaveLength(1);
    expect(expanded).toContain("Recipient 'missing-worker'");
    expect(expanded).not.toContain("missing-worker: Recipient");
  });

  it("reveals labelled post-state, evidence, diagnostics, and action arguments only when expanded", () => {
    const rendered = text(formatPiTeamsToolResult({
      tool: "worker_ensure",
      args: { team_name: "dogfood", name: "event-auditor" },
      expanded: true,
      details: toolResultDetails({
        operation: "worker_ensure",
        resource: { kind: "worker", id: "event-auditor", teamName: "dogfood" },
        postState: { action: "reused", carrier: "session_bound" },
        evidence: { membershipId: "membership-17" },
        diagnostics: { terminal: { adapter: "tmux", targetId: "%91" } },
        nextActions: [{
          tool: "task_create",
          reason: "Bind executable work to this Worker.",
          args: { team_name: "dogfood", assignee: "event-auditor" },
        }],
      }),
    }));

    expect(rendered).toContain('Accepted: worker "event-auditor" · team "dogfood" · reused');
    expect(rendered).toContain("Post-state");
    expect(rendered).toContain("Action: reused");
    expect(rendered).toContain("Evidence");
    expect(rendered).toContain("Diagnostics");
    expect(rendered).not.toContain("membership-17");
    expect(rendered).not.toContain("Target Id: %91");
    expect(rendered).toContain("Machine next actions (not sent to agent)");
    expect(rendered).toContain("task_create — Bind executable work to this Worker.");
    expect(rendered).toContain("Assignee: event-auditor");
  });

  it("never projects warning resource IDs", () => {
    const rendered = text(formatPiTeamsToolResult({
      tool: "task_update",
      expanded: true,
      details: toolResultDetails({
        operation: "task_update",
        resource: { kind: "task", id: "semantic-task" },
        warnings: [
          { code: "opaque", message: "Authority warning", resourceId: "membership-opaque-17" },
          { code: "path", message: "Path warning", resourceId: "/private/operator/path" },
        ],
      }),
    }));
    expect(rendered).toContain("Authority warning");
    expect(rendered).toContain("Path warning");
    expect(rendered).not.toContain("membership-opaque-17");
    expect(rendered).not.toContain("/private/operator/path");
  });

  it("redacts opaque and private injected fields across every public tool", () => {
    const leaks = ["membership-secret", "session-secret", "terminal-secret", "authority-secret", "version-secret", "/private/operator/path"];
    for (const tool of PI_TEAMS_PUBLIC_TOOLS) {
      const rendered = text(formatPiTeamsToolResult({
        tool,
        expanded: true,
        details: toolResultDetails({
          operation: tool,
          resource: { kind: "team", id: "semantic-team" },
          postState: { membershipId: leaks[0], sessionId: leaks[1], terminalTarget: leaks[2], authorityFingerprint: leaks[3], authorityVersion: leaks[4], privatePath: leaks[5], taskId: "semantic-task" },
          evidence: { provenanceId: leaks[3], runtimePid: 4242, path: leaks[5], relation: "blocked_by" },
          diagnostics: { sessionFile: leaks[1], terminalId: leaks[2] },
          nextActions: [{ tool: "task_read", reason: "semantic follow-up", args: { task_id: "semantic-task", membershipId: leaks[0], path: leaks[5] } }],
        }),
      }));
      for (const leak of leaks) expect(rendered).not.toContain(leak);
      expect(rendered).toContain("semantic-task");
      expect(rendered).toContain("blocked_by");
    }
  });

  it("shows a reused idle Worker without irrelevant launch-readiness diagnostics", () => {
    const rendered = text(formatPiTeamsToolResult({
      tool: "worker_ensure",
      args: { team_name: "dogfood", name: "event-auditor" },
      expanded: false,
      details: toolResultDetails({
        operation: "worker_ensure",
        resource: { kind: "worker", id: "event-auditor", teamName: "dogfood" },
        postState: {
          name: "event-auditor",
          action: "reused",
          membership: "current",
          carrier: "session_bound",
          nonterminalTasks: [],
        },
        nextActions: [{
          tool: "task_create",
          reason: "Assign the next durable work contract to this Worker.",
          args: { team_name: "dogfood", assignee: "event-auditor" },
        }],
      }),
    }));

    expect(rendered).toContain('Accepted: worker "event-auditor" · team "dogfood" · reused');
    expect(rendered).toContain("Carrier: session_bound · State: idle · no nonterminal Task");
    expect(rendered).not.toContain("task_create");
    expect(rendered).not.toMatch(/Runtime|not observed/i);
  });

  it("uses Alert meaning instead of exposing its transport identity", () => {
    const rendered = text(formatPiTeamsToolResult({
      tool: "alert_send",
      args: {
        team_name: "dogfood",
        to: "team-lead",
        kind: "clarification",
        task_id: "pt-42",
      },
      expanded: false,
      details: toolResultDetails({
        operation: "alert_send",
        resource: { kind: "alert", id: "alert_opaque", teamName: "dogfood" },
        postState: { kind: "clarification", to: "team-lead", taskId: "pt-42" },
        evidence: { alertId: "alert_opaque", cursor: "18", messageId: "message_opaque" },
      }),
    }));

    expect(rendered).toContain('clarification alert to "team-lead" · task "pt-42" · team "dogfood"');
    expect(rendered).not.toContain("alert_opaque");
    expect(rendered).not.toContain("message_opaque");
  });

  it("distinguishes an applied Task link from an accepted idempotent no-op", () => {
    const applied = text(formatPiTeamsToolResult({
      tool: "task_link",
      args: { team_name: "dogfood", task_id: "pt-42", action: "add", relation: "blocked_by", target_id: "pt-41" },
      expanded: false,
      details: toolResultDetails({
        operation: "task_link",
        resource: { kind: "task", id: "pt-42", teamName: "dogfood" },
        evidence: { action: "add", relation: "blocked_by", targetId: "pt-41", changed: true, expectedVersion: "opaque-version-id" },
      }),
    }));
    const unchanged = text(formatPiTeamsToolResult({
      tool: "task_link",
      args: { team_name: "dogfood", task_id: "pt-42", action: "add", relation: "blocked_by", target_id: "pt-41" },
      expanded: false,
      details: toolResultDetails({
        operation: "task_link",
        resource: { kind: "task", id: "pt-42", teamName: "dogfood" },
        evidence: { action: "add", relation: "blocked_by", targetId: "pt-41", changed: false, noOpReason: "already_present", deliveryAttempted: false, expectedVersion: "opaque-version-id" },
      }),
    }));

    expect(applied).toContain("Relation change applied");
    expect(applied.match(/blocked_by → "pt-41"/g)).toHaveLength(1);
    expect(unchanged).toContain("Task unchanged · relation already present · delivery not attempted");
    expect(unchanged.match(/blocked_by → "pt-41"/g)).toHaveLength(1);
    expect(unchanged.match(/pt-42/g)).toHaveLength(1);
    expect(unchanged.match(/pt-41/g)).toHaveLength(1);
    expect(unchanged).not.toContain("opaque-version-id");
  });

  it("renders stale Task-link refusal as a conflict, never as an idempotent held state", () => {
    const details = toolResultDetails({
      outcome: "refused",
      operation: "task_link",
      resource: { kind: "task", id: "pt-42", teamName: "dogfood" },
      warnings: [warning("task_relation_stale_version", "The expected Task version is stale; no relation changed.", "pt-42")],
      nextActions: [{
        tool: "task_read",
        reason: "Read current Task authority before deciding whether to retry the relation change.",
        args: { team_name: "dogfood", task_id: "pt-42" },
      }],
      evidence: {
        action: "remove",
        relation: "parent",
        targetId: "pt-40",
        changed: false,
        conflictReason: "stale_version",
        requestedVersion: "stale-version",
        currentVersion: "current-version",
      },
    });
    const rendered = text(formatPiTeamsToolResult({
      tool: "task_link",
      args: { team_name: "dogfood", task_id: "pt-42", action: "remove", relation: "parent", target_id: "pt-40" },
      expanded: false,
      details,
    }));
    const expanded = text(formatPiTeamsToolResult({
      tool: "task_link",
      args: { team_name: "dogfood", task_id: "pt-42", action: "remove", relation: "parent", target_id: "pt-40" },
      expanded: true,
      details,
    }));

    expect(rendered).toContain('requested remove parent → "pt-40"');
    expect(rendered).toContain("No relation change · stale version conflict");
    expect(rendered).not.toMatch(/already present|already absent|already held/i);
    expect(expanded).toContain("Machine next actions (not sent to agent)");
    expect(expanded).toContain("task_read — Read current Task authority");
    expect(expanded).toContain("Current Version: current-version");
    expect(expanded).toContain("Requested Version: stale-version");
    expect(expanded).not.toContain("Expected Version");
  });

  it("gracefully renders errors and missing legacy details without a raw JSON fallback", () => {
    const errored = text(formatPiTeamsToolResult({
      tool: "worker_stop",
      args: { team_name: "dogfood", worker: "event-auditor" },
      expanded: false,
      isError: true,
      details: undefined,
      content: [{ type: "text", text: "Cannot stop Worker: assigned Task pt-42 is still open." }],
    }));
    expect(errored).toContain('Refused: worker "event-auditor" · team "dogfood"');
    expect(errored).toContain("assigned Task pt-42 is still open");

    const missing = text(formatPiTeamsToolResult({
      tool: "team_sync",
      args: { team_name: "dogfood" },
      expanded: false,
      details: undefined,
      content: [{ type: "text", text: JSON.stringify({ cursor: "19", events: [{ type: "task" }] }) }],
    }));
    expect(missing).toContain('Accepted: team "dogfood"');
    expect(missing).toContain("Structured result evidence is unavailable.");
    expect(missing).toContain("Hints sent to agent:");
    expect(missing).toContain('{\"cursor\":\"19\",\"events\"');
  });

  it("renders future-cursor refusal without inventing empty Team state", () => {
    const rendered = text(formatPiTeamsToolResult({
      tool: "team_sync",
      args: { team_name: "dogfood", cursor: "99" },
      expanded: false,
      details: toolResultDetails({
        outcome: "refused",
        operation: "team_sync",
        resource: { kind: "team", id: "dogfood", teamName: "dogfood" },
        postState: {
          changed: false,
          waited: false,
          reason: "cursor_ahead_of_journal",
          requestedCursor: "99",
          journalHeadCursor: "4",
        },
      }),
    }));

    expect(rendered).toContain("Current cursor: 4");
    expect(rendered).toContain("state unchanged · No events consumed or lost");
    expect(rendered).not.toContain("0 Workers");
    expect(rendered).not.toContain("0 Tasks");
  });

  it("binds Task events to IDs and deduplicates Worker overflow with exact remainder and membership", () => {
    const workerEvent = {
      type: "worker",
      worker: "reviewer",
      membershipId: "membership-current",
      phase: "failed",
      cursor: "6",
      at: "2026-07-17T00:00:00Z",
    };
    const rendered = text(formatPiTeamsToolResult({
      tool: "team_sync",
      args: { team_name: "dogfood", cursor: "5" },
      expanded: false,
      details: toolResultDetails({
        operation: "team_sync",
        resource: { kind: "team", id: "dogfood", teamName: "dogfood" },
        postState: {
          completion: "events",
          cursor: "25",
          projection: {
            workers: [{ name: "reviewer", membershipId: "membership-current", carrier: "session_bound", nonterminalTasks: [] }],
            tasks: [],
          },
          hydratedTasks: [],
          pagination: { events: { truncated: true, remaining: 60 } },
        },
        evidence: { events: Array.from({ length: 20 }, () => workerEvent) },
      }),
    }));

    expect(rendered).toContain("20 events returned · 60 remaining · truncated");
    expect(rendered).toContain("Worker reviewer failed");
    expect(rendered).toContain("×20");
    expect(rendered.match(/Worker reviewer failed/g)).toHaveLength(1);
    expect(rendered).not.toContain("membership-current");
  });

  it("preserves relation, Alert, blocked, and blocker meaning in a multi-change sync", () => {
    const rendered = text(formatPiTeamsToolResult({
      tool: "team_sync",
      args: { team_name: "dogfood", cursor: "25", task_ids: ["task-a"] },
      expanded: false,
      details: toolResultDetails({
        operation: "team_sync",
        resource: { kind: "team", id: "dogfood", teamName: "dogfood" },
        postState: {
          completion: "events",
          cursor: "92",
          projection: { workers: [], tasks: [] },
          hydratedTasks: [{
            id: "task-a",
            status: "blocked",
            assignee: null,
            notes: "Blocked on the scoring threshold; team-lead chooses it next.",
            relations: [{ relation: "blocked_by", targetId: "task-b" }],
          }],
          pagination: { events: { truncated: false, remaining: 0 } },
        },
        evidence: {
          events: [
            { type: "task", ref: { taskId: "task-a" }, change: "relation", actor: "team-lead" },
            { type: "alert", kind: "clarification", from: "team-lead", to: "reviewer", taskRef: { taskId: "task-a" } },
            { type: "task", ref: { taskId: "task-a" }, change: "status", actor: "reviewer" },
          ],
        },
      }),
    }));

    expect(rendered).toContain("Observed relation event for Task task-a by team-lead");
    expect(rendered).toContain("Clarification Alert team-lead → reviewer · Task task-a");
    expect(rendered).toContain("Observed status event for Task task-a by reviewer");
    expect(rendered).toContain("Current Task task-a: blocked · unassigned · blocked by task-b");
    expect(rendered).toContain("Blocker: Blocked on the scoring threshold");
  });

  it("separates an observed Task status event from hydrated current authority", () => {
    const rendered = text(formatPiTeamsToolResult({
      tool: "team_sync",
      args: { team_name: "dogfood", cursor: "4" },
      expanded: false,
      details: toolResultDetails({
        operation: "team_sync",
        resource: { kind: "team", id: "dogfood", teamName: "dogfood" },
        postState: {
          completion: "events",
          cursor: "5",
          projection: { workers: [], tasks: [] },
          hydratedTasks: [{ id: "task-a", status: "in_progress", assignee: "reviewer", relations: [] }],
          pagination: { events: { truncated: false, remaining: 0 } },
        },
        evidence: {
          events: [{ type: "task", ref: { taskId: "task-a" }, change: "status", actor: "reviewer" }],
        },
      }),
    }));

    expect(rendered).toContain("Observed status event for Task task-a by reviewer");
    expect(rendered).toContain("Current Task task-a: in_progress · @ reviewer");
    expect(rendered).not.toContain("Task task-a changed");
  });

  it("keeps blocked snapshot state visible even when its Task ID repeats in an action", () => {
    const rendered = text(formatPiTeamsToolResult({
      tool: "team_sync",
      args: { team_name: "dogfood" },
      expanded: false,
      details: toolResultDetails({
        operation: "team_sync",
        resource: { kind: "team", id: "dogfood", teamName: "dogfood" },
        postState: {
          completion: "snapshot",
          cursor: "4",
          projection: {
            workers: [],
            tasks: [
              { id: "task-active", title: "Active work", status: "in_progress" },
              { id: "task-blocked", title: "Blocked work", status: "blocked" },
            ],
          },
        },
        nextActions: [{
          tool: "task_update",
          reason: "Resolve blocker evidence on Task task-blocked.",
          args: { team_name: "dogfood", task_id: "task-blocked" },
        }],
      }),
    }));

    expect(rendered).toContain("task-active");
    expect(rendered).toContain("task-blocked “Blocked work” blocked · unassigned");
    expect(rendered.match(/task-blocked/g)).toHaveLength(1);
    expect(rendered).not.toContain("task_update");
  });

  it("hides opaque Worker Membership IDs only from expanded sync event rendering", () => {
    const details = toolResultDetails({
      operation: "team_sync",
      resource: { kind: "team", id: "dogfood", teamName: "dogfood" },
      postState: {
        completion: "events",
        cursor: "25",
        projection: { workers: [], tasks: [] },
        hydratedTasks: [],
        pagination: { events: { truncated: true, remaining: 60 } },
      },
      evidence: {
        events: [{
          type: "worker",
          worker: "reviewer",
          membershipId: "membership-opaque-secret",
          phase: "failed",
          cursor: "6",
          at: "2026-07-17T00:00:00Z",
        }],
      },
    });
    const rendered = text(formatPiTeamsToolResult({
      tool: "team_sync",
      args: { team_name: "dogfood", cursor: "5" },
      expanded: true,
      details,
    }));

    expect(rendered).toContain("Events 1 · Worker: reviewer");
    expect(rendered).toContain("Events 1 · Phase: failed");
    expect(rendered).not.toContain("membership-opaque-secret");
    expect((details.evidence as any).events[0].membershipId).toBe("membership-opaque-secret");
  });

  it("returns a Pi Text component from the one-line integration factory", () => {
    const renderer = createPiTeamsResultRenderer("team_create");
    const theme = {
      fg(_tone: string, value: string) { return value; },
      italic(value: string) { return `<i>${value}</i>`; },
    } as Theme;
    const component = renderer(
      {
        content: [{ type: "text", text: "model projection" }],
        details: toolResultDetails({
          operation: "team_create",
          resource: { kind: "team", id: "dogfood", teamName: "dogfood" },
          postState: { lifecycle: "active" },
        }),
      },
      { expanded: false, isPartial: false },
      theme,
      { args: { team_name: "dogfood" }, isError: false } as never,
    );
    const rendered = component.render(160).join("\n");
    expect(rendered).toContain('Accepted: team "dogfood" · active');
    expect(rendered).toContain("<i>model projection</i>");
  });
});
