#!/usr/bin/env python3
"""Audit Pi Team Bright calls in an immutable Pi Session JSONL prefix snapshot."""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import hashlib
import json
import pathlib
import statistics
from typing import Any

TOOLS = {
    "team_create",
    "worker_ensure",
    "team_sync",
    "alert_send",
    "task_create",
    "task_update",
    "task_link",
    "team_shutdown",
    "task_read",
    "worker_stop",
}
TEAMS = ("rarebit-public-release-e2e", "worker-resource-projection-review")


def iso_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def parse_time(value: str) -> dt.datetime:
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    return ordered[int(fraction * (len(ordered) - 1))]


def text_of(message: dict[str, Any]) -> str:
    return "\n".join(
        part.get("text", "")
        for part in message.get("content", [])
        if part.get("type") == "text"
    )


def get_path(value: Any, *keys: str, default: Any = None) -> Any:
    for key in keys:
        if not isinstance(value, dict):
            return default
        value = value.get(key)
    return default if value is None else value


def classify_error(text: str) -> str:
    if "claim is an atomic assignment operation" in text:
        return "invalid_compound_claim"
    if text == "Team event wait aborted":
        return "wait_aborted"
    if "Beads command failed (timeout)" in text:
        return "beads_timeout"
    return "other"


def evidence_ref(row: dict[str, Any], include_text: bool = False) -> dict[str, Any]:
    result = {
        "actor": row["actor"],
        "tool": row["tool"],
        "timestamp": row["call_timestamp"],
        "source": row["source"],
        "callLine": row["call_line"],
        "resultLine": row.get("result_line"),
    }
    arguments = row["arguments"]
    for key in ("task_id", "worker", "cursor", "wait_ms", "limit", "continuation"):
        if key in arguments:
            result[key] = arguments[key]
    if include_text:
        result["result"] = row.get("result_text", "")[:500]
    return result


def read_rows(snapshot: pathlib.Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    sessions_dir = snapshot / "sessions"
    configs_dir = snapshot / "teams"
    rows: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    seen_sources: set[str] = set()

    for team in TEAMS:
        config_path = configs_dir / f"{team}-config.json"
        config_raw = config_path.read_bytes()
        config = json.loads(config_raw)
        sources.append(
            {
                "kind": "team_config",
                "originalPath": str(pathlib.Path.home() / ".pi" / "teams" / team / "config.json"),
                "snapshotFile": str(config_path),
                "sha256": hashlib.sha256(config_raw).hexdigest(),
            }
        )
        for member in config["members"]:
            original = pathlib.Path(member["sessionFile"])
            source = sessions_dir / original.name
            if not source.exists():
                raise FileNotFoundError(f"Snapshot lacks {original.name}")
            raw = source.read_bytes()
            if str(original) not in seen_sources:
                seen_sources.add(str(original))
                sources.append(
                    {
                        "kind": "session_prefix",
                        "originalPath": str(original),
                        "snapshotFile": str(source),
                        "prefixLines": raw.count(b"\n"),
                        "sha256": hashlib.sha256(raw).hexdigest(),
                    }
                )

            calls: dict[str, dict[str, Any]] = {}
            with source.open() as handle:
                for line_number, line in enumerate(handle, 1):
                    record = json.loads(line)
                    if record.get("type") != "message":
                        continue
                    message = record.get("message", {})
                    if message.get("role") == "assistant":
                        for part in message.get("content", []):
                            arguments = part.get("arguments") or {}
                            if (
                                part.get("type") == "toolCall"
                                and part.get("name") in TOOLS
                                and arguments.get("team_name") == team
                            ):
                                row = {
                                    "team": team,
                                    "actor": member["name"],
                                    "source": str(original),
                                    "call_line": line_number,
                                    "call_timestamp": record["timestamp"],
                                    "tool_call_id": part["id"],
                                    "tool": part["name"],
                                    "arguments": arguments,
                                }
                                calls[part["id"]] = row
                                rows.append(row)
                    elif message.get("role") == "toolResult":
                        row = calls.get(message.get("toolCallId"))
                        if row is not None:
                            row.update(
                                result_line=line_number,
                                result_timestamp=record["timestamp"],
                                is_error=bool(message.get("isError")),
                                result_text=text_of(message),
                                model_content_bytes=len(text_of(message).encode()),
                                details=message.get("details"),
                                session_record_bytes=len(line.encode()),
                            )

    for row in rows:
        if row.get("result_timestamp"):
            row["duration_ms"] = (
                parse_time(row["result_timestamp"]) - parse_time(row["call_timestamp"])
            ).total_seconds() * 1000
        else:
            row["duration_ms"] = None
    return rows, sources


def tool_metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for tool in sorted({row["tool"] for row in rows}):
        selected = [row for row in rows if row["tool"] == tool]
        durations = [row["duration_ms"] for row in selected if row["duration_ms"] is not None]
        result[tool] = {
            "calls": len(selected),
            "errors": sum(row.get("is_error", False) for row in selected),
            "refused": sum(get_path(row, "details", "outcome") == "refused" for row in selected),
            "modelContentMiB": round(
                sum(row.get("model_content_bytes", 0) for row in selected) / 1048576, 4
            ),
            "sessionRecordMiB": round(
                sum(row.get("session_record_bytes", 0) for row in selected) / 1048576, 4
            ),
            "latency": {
                "sumSeconds": round(sum(durations) / 1000, 3),
                "medianMs": round(statistics.median(durations), 3) if durations else None,
                "p95Ms": round(percentile(durations, 0.95), 3) if durations else None,
                "maxMs": round(max(durations), 3) if durations else None,
            },
        }
    return result


def sync_metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    syncs = [row for row in rows if row["tool"] == "team_sync"]
    completion = collections.Counter(
        get_path(row, "details", "postState", "completion", default="missing") for row in syncs
    )
    wait_ms = collections.Counter(str(row["arguments"].get("wait_ms", "absent")) for row in syncs)
    payload_by_completion: dict[str, int] = collections.Counter()
    stop_hints: collections.Counter[str] = collections.Counter()
    truncated: list[dict[str, Any]] = []
    filtered_full_projection = 0

    for row in syncs:
        kind = get_path(row, "details", "postState", "completion", default="missing")
        payload_by_completion[kind] += row.get("model_content_bytes", 0)
        pagination = get_path(row, "details", "postState", "pagination", "projection", default={})
        if pagination.get("truncated"):
            truncated.append(row)
        projection_tasks = get_path(row, "details", "postState", "projection", "tasks", default=[])
        if row["arguments"].get("task_ids") and len(projection_tasks) > len(row["arguments"]["task_ids"]):
            filtered_full_projection += 1
        for action in get_path(row, "details", "nextActions", default=[]):
            if action.get("tool") == "worker_stop":
                worker = get_path(action, "args", "worker", default="unknown")
                stop_hints[worker] += 1

    return {
        "calls": len(syncs),
        "completion": dict(sorted(completion.items())),
        "requestedWaitMs": dict(sorted(wait_ms.items())),
        "actualLatencySumSeconds": round(
            sum(row["duration_ms"] or 0 for row in syncs) / 1000, 3
        ),
        "modelContentMiB": round(
            sum(row.get("model_content_bytes", 0) for row in syncs) / 1048576, 4
        ),
        "sessionRecordMiB": round(
            sum(row.get("session_record_bytes", 0) for row in syncs) / 1048576, 4
        ),
        "modelContentMiBByCompletion": {
            key: round(value / 1048576, 4) for key, value in sorted(payload_by_completion.items())
        },
        "projectionTruncatedCalls": len(truncated),
        "continuationCalls": sum("continuation" in row["arguments"] for row in syncs),
        "taskFilteredCallsReturningBroaderProjection": filtered_full_projection,
        "workerStopHints": dict(sorted(stop_hints.items())),
        "truncationEvidence": [evidence_ref(row) for row in truncated[:5]],
    }


def redundant_read_candidates(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    by_actor: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    for row in rows:
        by_actor[row["actor"]].append(row)

    for actor_rows in by_actor.values():
        actor_rows.sort(key=lambda row: row["call_timestamp"])
        for index, row in enumerate(actor_rows):
            if row["tool"] != "task_read":
                continue
            task_id = row["arguments"].get("task_id")
            read_time = parse_time(row["call_timestamp"])
            for prior in reversed(actor_rows[:index]):
                if not prior.get("result_timestamp"):
                    continue
                age = (read_time - parse_time(prior["result_timestamp"])).total_seconds()
                if age > 30:
                    break
                if prior["tool"] == "team_sync":
                    hydrated = {
                        task.get("id")
                        for task in get_path(prior, "details", "postState", "hydratedTasks", default=[])
                    }
                    if task_id in hydrated:
                        item = evidence_ref(row)
                        item.update(
                            reason="same Task was present in the preceding team_sync machine-details hydration",
                            priorCallLine=prior["call_line"],
                            ageSeconds=round(age, 3),
                        )
                        candidates.append(item)
                        break
                if prior["arguments"].get("task_id") == task_id and prior["tool"] in {
                    "task_read",
                    "task_update",
                }:
                    item = evidence_ref(row)
                    item.update(
                        reason=f"same Task was present in preceding {prior['tool']} machine details",
                        priorCallLine=prior["call_line"],
                        ageSeconds=round(age, 3),
                    )
                    candidates.append(item)
                    break
    return candidates


def team_metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    errors = [row for row in rows if row.get("is_error")]
    refused = [row for row in rows if get_path(row, "details", "outcome") == "refused"]
    error_classes = collections.Counter(classify_error(row.get("result_text", "")) for row in errors)
    slow_nonwait = [
        row
        for row in rows
        if row["tool"] != "team_sync" and (row.get("duration_ms") or 0) >= 10000
    ]
    actors = collections.Counter(row["actor"] for row in rows)
    outcomes = collections.Counter(
        get_path(row, "details", "outcome", default="missing") for row in rows
    )
    return {
        "calls": len(rows),
        "actors": dict(sorted(actors.items())),
        "outcomes": dict(sorted(outcomes.items())),
        "errors": {
            "count": len(errors),
            "classes": dict(sorted(error_classes.items())),
            "evidence": [evidence_ref(row, include_text=True) for row in errors],
        },
        "refused": {
            "count": len(refused),
            "evidence": [evidence_ref(row, include_text=True) for row in refused],
        },
        "tools": tool_metrics(rows),
        "sync": sync_metrics(rows),
        "readsWithin30SecondsOfStructuredHydration": redundant_read_candidates(rows),
        "slowNonWaitCalls": [
            {**evidence_ref(row), "durationMs": row["duration_ms"]} for row in slow_nonwait
        ],
        "modelContentMiB": round(
            sum(row.get("model_content_bytes", 0) for row in rows) / 1048576, 4
        ),
        "sessionRecordMiB": round(
            sum(row.get("session_record_bytes", 0) for row in rows) / 1048576, 4
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("snapshot", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path)
    args = parser.parse_args()
    rows, sources = read_rows(args.snapshot)
    result = {
        "schema": "pi-team-toolcall-audit/1",
        "generatedAt": iso_now(),
        "scope": {
            "teams": list(TEAMS),
            "includedTools": sorted(TOOLS),
            "selection": "Calls from configured lead and Worker Session files whose team_name equals the configured Team. Non-PiTeams calls and calls to other Teams are excluded.",
            "snapshot": str(args.snapshot),
        },
        "sources": sources,
        "totals": {
            "calls": len(rows),
            "errors": sum(row.get("is_error", False) for row in rows),
            "refused": sum(get_path(row, "details", "outcome") == "refused" for row in rows),
            "modelContentMiB": round(
                sum(row.get("model_content_bytes", 0) for row in rows) / 1048576, 4
            ),
            "sessionRecordMiB": round(
                sum(row.get("session_record_bytes", 0) for row in rows) / 1048576, 4
            ),
        },
        "teams": {
            team: team_metrics([row for row in rows if row["team"] == team]) for team in TEAMS
        },
    }
    rendered = json.dumps(result, indent=2) + "\n"
    if args.output:
        args.output.write_text(rendered)
    else:
        print(rendered, end="")


if __name__ == "__main__":
    main()
