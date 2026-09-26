#!/usr/bin/env python3
"""Check Pi Team Bright warnings through isolated Pi TUI and RPC processes."""

import fcntl
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path


PACKAGE = Path(__file__).resolve().parent.parent
EXTENSION = PACKAGE / "extensions" / "index.ts"
PI = shutil.which("pi") or str(PACKAGE / "node_modules" / ".bin" / "pi")
TIMEOUT = 20


def environment(root: Path) -> dict[str, str]:
    agent = root / "agent"
    agent.mkdir()
    (root / "home").mkdir()
    (root / "project").mkdir()
    (agent / "settings.json").write_text(json.dumps({
        "pi_team_bright": {
            "model_roles": {"valid": {"model": "fixture/model", "thinking": "low", "use": "Fixture"}},
            "default_model_role": "missing",
        }
    }))
    env = dict(os.environ)
    env.pop("NO_COLOR", None)
    for key in ("PI_TEAM_NAME", "PI_AGENT_NAME", "PI_AGENT_LAUNCH_ID", "PI_TEAMS_SESSION_ROOT", "PI_TEAMS_TRACE_JSONL"):
        env.pop(key, None)
    env.update({
        "HOME": str(root / "home"),
        "USERPROFILE": str(root / "home"),
        "PI_CODING_AGENT_DIR": str(agent),
        "PI_OFFLINE": "1",
        "TERM": "xterm-256color",
    })
    return env


def arguments(mode: str | None = None) -> list[str]:
    assert Path(PI).exists(), "Pi executable is unavailable"
    args = [PI, "--offline", "--no-session", "--no-skills", "--no-context-files",
            "--no-extensions", "--extension", str(EXTENSION), "--no-approve"]
    if mode:
        args += ["--mode", mode]
    return args


def read_until(fd: int, predicate, deadline: float) -> bytes:
    output = bytearray()
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], min(0.25, max(0, deadline - time.monotonic())))
        if not ready:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        output.extend(chunk)
        if predicate(output):
            break
    return bytes(output)


def tui_check(root: Path, env: dict[str, str]) -> dict[str, bool | str]:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 220, 0, 0))
    process = subprocess.Popen(arguments(), cwd=root / "project", env=env,
                               stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    try:
        example_path = str(PACKAGE / "docs" / "examples" / "pi-team-bright.settings.json").encode()
        output = read_until(master, lambda data: b"Warning: Pi Team Bright settings:" in data
                            and b"default_model_role" in data
                            and example_path in data,
                            time.monotonic() + TIMEOUT)
        color_match = re.search(rb"\x1b\[[0-9;]*mWarning: Pi Team Bright settings:", output)
        result = {
            "warning_visible": b"Warning: Pi Team Bright settings:" in output and b"default_model_role" in output,
            "warning_theme_ansi": color_match is not None,
            "pi_alive_after_warning": process.poll() is None,
            "example_path_visible": example_path in output,
            "rendered_warning_excerpt": color_match.group(0).decode("utf-8", "replace") if color_match else "",
        }
        if not all(result.values()):
            raise AssertionError(f"TUI startup check failed: {result}; output tail={output[-1500:]!r}")
        return result
    finally:
        if process.poll() is None:
            process.send_signal(signal.SIGTERM)
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)
        os.close(master)


def rpc_check(root: Path, env: dict[str, str]) -> dict[str, bool]:
    process = subprocess.Popen(arguments("rpc"), cwd=root / "project", env=env,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        assert process.stdin and process.stdout
        process.stdin.write('{"type":"get_state","id":"startup-check"}\n')
        process.stdin.flush()
        lines: list[str] = []
        response = None
        deadline = time.monotonic() + TIMEOUT
        while time.monotonic() < deadline:
            ready, _, _ = select.select([process.stdout], [], [], 0.25)
            if not ready:
                if process.poll() is not None:
                    break
                continue
            line = process.stdout.readline()
            if not line:
                break
            lines.append(line)
            message = json.loads(line)
            if message.get("type") == "response" and message.get("id") == "startup-check":
                response = message
                break
        was_alive = process.poll() is None
        if was_alive:
            process.terminate()
        extra_stdout, stderr = process.communicate(timeout=3)
        if extra_stdout:
            lines.extend(extra_stdout.splitlines(keepends=True))
        events = [json.loads(line) for line in lines]
        result = {
            "stdout_jsonl_only": bool(lines) and all(line.endswith("\n") for line in lines),
            "state_response": response is not None,
            "no_model_history": response is not None and response.get("data", {}).get("messageCount") == 0,
            "pi_alive_after_warning": was_alive,
            "native_warning_notification": any(event.get("type") == "extension_ui_request"
                                               and event.get("method") == "notify"
                                               and event.get("notifyType") == "warning"
                                               and "Pi Team Bright settings:" in event.get("message", "")
                                               for event in events),
            "stderr_bounded": len(stderr) <= 1600,
        }
        if not all(result.values()):
            summary = [(event.get("type"), event.get("id"), event.get("command"), event.get("method")) for event in events]
            raise AssertionError(f"RPC startup check failed: {result}; events={summary!r}")
        return result
    finally:
        if process.poll() is None:
            process.terminate()
        try:
            process.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate(timeout=3)


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="pi-team-bright-model-role-startup-") as temporary:
        root = Path(temporary)
        env = environment(root)
        print(json.dumps({"tui": tui_check(root, env), "rpc": rpc_check(root, env)}, sort_keys=True))
