#!/usr/bin/env python3

import json
import sys
from pathlib import Path

import tiktoken


def compact(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def count(encoding: tiktoken.Encoding, text: str) -> dict[str, int]:
    return {"characters": len(text), "tokens": len(encoding.encode(text))}


def surface(snapshot: dict, encoding: tiktoken.Encoding) -> dict:
    tools_text = compact(snapshot["tools"])
    lead_first = snapshot["prompts"]["lead"]["firstTurn"]["extensionDelta"]
    lead_steady = snapshot["prompts"]["lead"]["steadyState"]["extensionDelta"]
    worker_first = snapshot["prompts"]["worker"]["firstTurn"]["extensionDelta"]
    worker_steady = snapshot["prompts"]["worker"]["steadyState"]["extensionDelta"]
    skill = snapshot["skill"]
    tool_tokens = count(encoding, tools_text)["tokens"]
    skill_tokens = count(encoding, skill)["tokens"]
    lead_first_tokens = count(encoding, lead_first)["tokens"]
    lead_steady_tokens = count(encoding, lead_steady)["tokens"]
    worker_first_tokens = count(encoding, worker_first)["tokens"]
    worker_steady_tokens = count(encoding, worker_steady)["tokens"]
    per_tool = {}
    parameter_count = 0
    for tool in snapshot["tools"]:
        properties = tool.get("parameters", {}).get("properties", {})
        parameter_count += len(properties)
        per_tool[tool["name"]] = {
            **count(encoding, compact(tool)),
            "parameters": len(properties),
        }
    return {
        "tool_count": len(snapshot["tools"]),
        "top_level_parameter_count": parameter_count,
        "tool_names": [tool["name"] for tool in snapshot["tools"]],
        "lead_prompt_first_turn": count(encoding, lead_first),
        "lead_prompt_steady_state": count(encoding, lead_steady),
        "worker_prompt_first_turn": count(encoding, worker_first),
        "worker_prompt_steady_state": count(encoding, worker_steady),
        "tools_canonical_json": count(encoding, tools_text),
        "skill_markdown": count(encoding, skill),
        "lead_runtime_first_turn": count(encoding, lead_first + tools_text),
        "lead_runtime_steady_state": count(encoding, lead_steady + tools_text),
        "worker_runtime_first_turn": count(encoding, worker_first + tools_text),
        "worker_runtime_steady_state": count(encoding, worker_steady + tools_text),
        "lead_first_turn_with_skill_loaded": count(encoding, lead_first + tools_text + skill),
        "worker_first_turn_with_skill_loaded": count(encoding, worker_first + tools_text + skill),
        "lead_ten_calls_uncached_tokens": tool_tokens * 10 + lead_first_tokens + lead_steady_tokens * 9,
        "worker_ten_calls_uncached_tokens": tool_tokens * 10 + worker_first_tokens + worker_steady_tokens * 9,
        "lead_ten_calls_plus_skill_once_tokens": tool_tokens * 10 + lead_first_tokens + lead_steady_tokens * 9 + skill_tokens,
        "worker_ten_calls_plus_skill_once_tokens": tool_tokens * 10 + worker_first_tokens + worker_steady_tokens * 9 + skill_tokens,
        "per_tool": per_tool,
    }


def delta(before: int, after: int) -> dict[str, float | int]:
    change = after - before
    return {
        "before": before,
        "after": after,
        "change": change,
        "percent": round((change / before * 100) if before else 0, 1),
    }


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("usage: measure-agent-surface.py BEFORE.json AFTER.json OUTPUT.json")
    before_path, after_path, output_path = map(Path, sys.argv[1:])
    before_raw = json.loads(before_path.read_text())
    after_raw = json.loads(after_path.read_text())
    encoding = tiktoken.get_encoding("o200k_base")
    before = surface(before_raw, encoding)
    after = surface(after_raw, encoding)
    keys = [
        "tool_count",
        "top_level_parameter_count",
        "lead_prompt_first_turn",
        "lead_prompt_steady_state",
        "worker_prompt_first_turn",
        "worker_prompt_steady_state",
        "tools_canonical_json",
        "skill_markdown",
        "lead_runtime_first_turn",
        "lead_runtime_steady_state",
        "worker_runtime_first_turn",
        "worker_runtime_steady_state",
        "lead_first_turn_with_skill_loaded",
        "worker_first_turn_with_skill_loaded",
        "lead_ten_calls_uncached_tokens",
        "worker_ten_calls_uncached_tokens",
        "lead_ten_calls_plus_skill_once_tokens",
        "worker_ten_calls_plus_skill_once_tokens",
    ]
    comparison = {}
    for key in keys:
        if isinstance(before[key], dict):
            comparison[key] = {
                metric: delta(before[key][metric], after[key][metric])
                for metric in ("characters", "tokens")
            }
        else:
            comparison[key] = delta(before[key], after[key])
    output = {
        "schema": "pi-teams-agent-surface-measurement/1",
        "tokenizer": {
            "encoding": "o200k_base",
            "library": "tiktoken",
            "library_version": tiktoken.__version__,
            "scope": "content tokens only; provider message and tool-call framing excluded",
        },
        "serialization": "canonical compact JSON with recursively sorted object keys",
        "before": before,
        "after": after,
        "comparison": comparison,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, indent=2) + "\n")


if __name__ == "__main__":
    main()
