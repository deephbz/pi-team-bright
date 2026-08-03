#!/usr/bin/env python3
"""Estimate historical Beads task-engine cost from PiTeams outer-call timing.

Exact bd subprocess timing needs PI_TEAMS_TRACE_JSONL. It was not enabled for
these Sessions, so this script keeps exact observations separate from derived
upper bounds and source-based command-count lower bounds.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import importlib.util
import json
import pathlib
import statistics
from typing import Any

TEAMS = ("rarebit-public-release-e2e", "worker-resource-projection-review")
DIRECT_TASK_PATH_TOOLS = {
    "team_create",
    "task_create",
    "task_read",
    "task_update",
    "task_link",
    "worker_stop",
}


def load_base_analyzer(path: pathlib.Path) -> Any:
    spec = importlib.util.spec_from_file_location("pi_team_toolcall_audit", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def summary(values: list[float]) -> dict[str, Any]:
    ordered = sorted(values)
    if not ordered:
        return {"count": 0, "sumSeconds": 0}
    return {
        "count": len(ordered),
        "sumSeconds": round(sum(ordered) / 1000, 3),
        "meanMs": round(statistics.mean(ordered), 3),
        "medianMs": round(statistics.median(ordered), 3),
        "p95Ms": round(ordered[int(0.95 * (len(ordered) - 1))], 3),
        "maxMs": round(max(ordered), 3),
    }


def sync_post_wait_tail(row: dict[str, Any], base: Any) -> tuple[float | None, str]:
    duration = row.get("duration_ms")
    if duration is None:
        return None, "in_flight"
    if row.get("is_error"):
        if "Beads command failed (timeout)" in row.get("result_text", ""):
            return duration, "beads_timeout"
        return 0, "non_backend_error"

    completion = base.get_path(row, "details", "postState", "completion", default="missing")
    if completion == "timeout":
        return max(0, duration - row["arguments"].get("wait_ms", 0)), "timeout_tail"
    if completion == "snapshot":
        return duration, "snapshot"
    if completion == "events":
        call_at = base.parse_time(row["call_timestamp"])
        result_at = base.parse_time(row["result_timestamp"])
        event_times = [
            base.parse_time(event["at"])
            for event in base.get_path(row, "details", "evidence", "events", default=[])
            if event.get("at")
        ]
        anchor = max([call_at, *event_times])
        return max(0, (result_at - anchor).total_seconds() * 1000), "event_tail"
    return duration, "other"


def estimate_bd_commands(rows: list[dict[str, Any]], base: Any) -> collections.Counter[str]:
    """Count the minimum bd subprocesses implied by the audited source paths."""
    commands: collections.Counter[str] = collections.Counter()
    for row in rows:
        if not row.get("result_timestamp"):
            continue
        tool = row["tool"]
        text = row.get("result_text", "")
        if tool == "team_create":
            commands["init"] += 1
        elif tool == "task_create":
            if row["arguments"].get("idempotency_key"):
                commands["list"] += 1
            commands["create"] += 1
            commands["show"] += 1
        elif tool == "task_read":
            commands["show"] += 1
        elif tool == "task_update":
            if row.get("is_error") and "claim is an atomic assignment operation" in text:
                continue
            if base.get_path(row, "details", "outcome") == "refused":
                commands["show"] += 2
            else:
                commands["show"] += 2
                commands["update"] += 1
        elif tool == "task_link":
            commands["show"] += 3
            commands["dep_or_update"] += 1
        elif tool == "worker_stop":
            commands["list"] += 1
        elif tool == "team_sync":
            if row.get("is_error"):
                if "Beads command failed (timeout)" in text:
                    commands["list"] += 1
                    commands["show"] += 1
                continue
            commands["list"] += 1
            hydrated = base.get_path(row, "details", "postState", "hydratedTasks", default=[])
            if hydrated:
                commands["show"] += 1
    return commands


def event_prefix(snapshot: pathlib.Path, team: str) -> list[dict[str, Any]]:
    path = snapshot / "teams" / f"{team}-events.jsonl"
    return [json.loads(line) for line in path.open()]


def event_matches_contract(event: dict[str, Any], arguments: dict[str, Any]) -> bool:
    types = set(arguments.get("event_types", []))
    if types and event["type"] not in types:
        return False
    task_ids = set(arguments.get("task_ids", []))
    if not task_ids:
        return True
    if event["type"] == "task":
        return event["ref"]["taskId"] in task_ids
    if event["type"] == "alert":
        return event.get("taskRef", {}).get("taskId") in task_ids
    return False


def wait_filter_findings(
    team: str,
    rows: list[dict[str, Any]],
    events: list[dict[str, Any]],
    base: Any,
) -> dict[str, Any]:
    leader_syncs = [row for row in rows if row["actor"] == "team-lead" and row["tool"] == "team_sync"]
    contradictory = [
        row
        for row in leader_syncs
        if row["arguments"].get("task_ids")
        and "worker" in set(row["arguments"].get("event_types", []))
    ]
    suppressed_worker_timeouts: list[dict[str, Any]] = []
    contract_misses: list[dict[str, Any]] = []

    for row in leader_syncs:
        if base.get_path(row, "details", "postState", "completion") != "timeout":
            continue
        arguments = row["arguments"]
        after = int(arguments.get("cursor", "0"))
        head = int(base.get_path(row, "details", "postState", "journalHeadCursor", default=after))
        in_range = [event for event in events if after < int(event["cursor"]) <= head]
        matching = [event for event in in_range if event_matches_contract(event, arguments)]
        if matching:
            contract_misses.append(
                {
                    **base.evidence_ref(row),
                    "events": [{"cursor": event["cursor"], "type": event["type"]} for event in matching],
                }
            )
        if arguments.get("task_ids") and "worker" in set(arguments.get("event_types", [])):
            workers = [event for event in in_range if event["type"] == "worker"]
            if workers:
                suppressed_worker_timeouts.append(
                    {
                        **base.evidence_ref(row),
                        "durationMs": row["duration_ms"],
                        "suppressedWorkerEvents": [
                            {
                                "cursor": event["cursor"],
                                "worker": event["worker"],
                                "phase": event["phase"],
                                "at": event["at"],
                            }
                            for event in workers
                        ],
                    }
                )

    return {
        "leaderSyncCalls": len(leader_syncs),
        "taskFilteredCallsAlsoRequestingWorkerEvents": len(contradictory),
        "timeoutsDespiteContractMatchingEvent": contract_misses,
        "fullTimeoutsWithWorkerEventsSuppressedByTaskFilter": suppressed_worker_timeouts,
        "suppressedWaitSeconds": round(
            sum(item["durationMs"] for item in suppressed_worker_timeouts) / 1000, 3
        ),
    }


def team_result(team: str, rows: list[dict[str, Any]], snapshot: pathlib.Path, base: Any) -> dict[str, Any]:
    direct: dict[str, Any] = {}
    upper_by_operation_ms: dict[str, float] = {}
    for tool in sorted(DIRECT_TASK_PATH_TOOLS):
        durations = [
            row["duration_ms"]
            for row in rows
            if row["tool"] == tool and row.get("duration_ms") is not None
        ]
        if durations:
            direct[tool] = summary(durations)
            upper_by_operation_ms[tool] = sum(durations)

    tails: list[float] = []
    tails_by_kind: dict[str, list[float]] = collections.defaultdict(list)
    for row in rows:
        if row["tool"] != "team_sync":
            continue
        value, kind = sync_post_wait_tail(row, base)
        if value is not None:
            tails.append(value)
            tails_by_kind[kind].append(value)
    upper_by_operation_ms["team_sync_post_wait"] = sum(tails)

    direct_sum = sum(
        row.get("duration_ms") or 0 for row in rows if row["tool"] in DIRECT_TASK_PATH_TOOLS
    )
    all_non_wait = sum(row.get("duration_ms") or 0 for row in rows if row["tool"] != "team_sync") + sum(tails)
    task_upper = direct_sum + sum(tails)
    command_count = estimate_bd_commands(rows, base)

    slow_reads = [
        {**base.evidence_ref(row), "durationMs": row["duration_ms"]}
        for row in rows
        if row["tool"] == "task_read" and (row.get("duration_ms") or 0) >= 10000
    ]

    return {
        "directTaskPathOuterLatency": direct,
        "teamSyncPostWaitTail": {
            "all": summary(tails),
            "byCompletion": {key: summary(value) for key, value in sorted(tails_by_kind.items())},
        },
        "taskEnginePathUpperBoundSeconds": round(task_upper / 1000, 3),
        "adjustedAllToolLatencySeconds": round(all_non_wait / 1000, 3),
        "taskEnginePathUpperBoundSharePercent": round(task_upper / all_non_wait * 100, 3),
        "upperBoundByOperationSeconds": {
            key: round(value / 1000, 3) for key, value in sorted(upper_by_operation_ms.items())
        },
        "bdSubprocessLowerBound": {
            "total": sum(command_count.values()),
            "byCommand": dict(sorted(command_count.items())),
        },
        "slowTaskReads": slow_reads,
        "waitFilter": wait_filter_findings(team, rows, event_prefix(snapshot, team), base),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("snapshot", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path)
    args = parser.parse_args()
    base = load_base_analyzer(pathlib.Path(__file__).with_name("analyze.py"))
    rows, sources = base.read_rows(args.snapshot)

    event_sources = []
    for team in TEAMS:
        path = args.snapshot / "teams" / f"{team}-events.jsonl"
        raw = path.read_bytes()
        import hashlib
        event_sources.append(
            {
                "kind": "team_event_prefix",
                "team": team,
                "snapshotFile": str(path),
                "prefixLines": raw.count(b"\n"),
                "sha256": hashlib.sha256(raw).hexdigest(),
            }
        )

    teams = {
        team: team_result(team, [row for row in rows if row["team"] == team], args.snapshot, base)
        for team in TEAMS
    }
    upper_total = sum(value["taskEnginePathUpperBoundSeconds"] for value in teams.values())
    adjusted_total = sum(value["adjustedAllToolLatencySeconds"] for value in teams.values())
    command_total = sum(value["bdSubprocessLowerBound"]["total"] for value in teams.values())
    operation_totals: collections.Counter[str] = collections.Counter()
    command_totals: collections.Counter[str] = collections.Counter()
    for value in teams.values():
        operation_totals.update(value["upperBoundByOperationSeconds"])
        command_totals.update(value["bdSubprocessLowerBound"]["byCommand"])

    result = {
        "schema": "pi-team-bd-latency-audit/1",
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "method": {
            "exactBdTimingAvailable": False,
            "reason": "PI_TEAMS_TRACE_JSONL was not set and no semantic trace file exists for the audited processes.",
            "outerLatency": "Exact tool-call elapsed time from Session JSONL.",
            "taskEngineUpperBound": "Direct task-path elapsed time plus team_sync time after wakeup. It includes locks, local projection, delivery, and scheduling, so it is not exact bd time.",
            "teamSyncPostWaitTail": "For timeouts, elapsed minus requested wait. For event returns, result time minus the later of call time or newest returned event time.",
            "bdSubprocessLowerBound": "Minimum command count implied by the audited Beads adapter. Recovery and delivery reconciliation can add commands.",
            "runningSource": {
                "repository": "<home>/repos/pi-team-bright-release",
                "commit": "4e69ce2a8b68e45cb9ed4b2305725312f2cc3f50",
                "beadsTsSha256": "94d7639eba007452bc41726ad76f992776c866dd9fbf203905783033eb33d4e2",
                "teamEventsTsSha256": "7d37538244a6c5dca7e28102cb35c14b9722c531bb7e16ce55b0b0eb646724aa",
            },
        },
        "sources": sources + event_sources,
        "totals": {
            "taskEnginePathUpperBoundSeconds": round(upper_total, 3),
            "taskEnginePathUpperBoundMinutes": round(upper_total / 60, 3),
            "adjustedAllToolLatencySeconds": round(adjusted_total, 3),
            "taskEnginePathUpperBoundSharePercent": round(upper_total / adjusted_total * 100, 3),
            "bdSubprocessLowerBound": command_total,
            "upperBoundByOperationSeconds": {
                key: round(value, 3) for key, value in sorted(operation_totals.items())
            },
            "bdSubprocessLowerBoundByCommand": dict(sorted(command_totals.items())),
            "suppressedLeaderWaitSeconds": round(
                sum(value["waitFilter"]["suppressedWaitSeconds"] for value in teams.values()), 3
            ),
        },
        "teams": teams,
    }
    rendered = json.dumps(result, indent=2) + "\n"
    if args.output:
        args.output.write_text(rendered)
    else:
        print(rendered, end="")


if __name__ == "__main__":
    main()
