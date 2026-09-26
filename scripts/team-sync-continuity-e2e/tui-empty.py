#!/usr/bin/env python3
"""Verify the empty manual Team sync notice in a real isolated Pi TUI."""

import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time


def read_until(fd: int, needle: bytes, deadline: float) -> bytes:
    output = bytearray()
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], min(0.2, max(0, deadline - time.monotonic())))
        if not ready:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        output.extend(chunk)
        if needle in output:
            break
    return bytes(output)


def main() -> None:
    node, cli, session, extension, project, home, agent_dir, tmux, pane, path = sys.argv[1:]
    env = {
        "HOME": home,
        "USERPROFILE": home,
        "PI_CODING_AGENT_DIR": agent_dir,
        "PI_TELEMETRY": "0",
        "TERM": "xterm-256color",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "NO_COLOR": "1",
        "PATH": path,
        "TMUX": tmux,
        "TMUX_PANE": pane,
        "NO_PROXY": "127.0.0.1,localhost",
        "no_proxy": "127.0.0.1,localhost",
        "BD_DISABLE_EVENT_FLUSH": "1",
        "BD_DISABLE_METRICS": "1",
    }
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 42, 180, 0, 0))
    process = subprocess.Popen(
        [node, cli, "--session", session, "--provider", "fixture", "--model", "scripted", "--thinking", "off",
         "--no-extensions", "-e", extension, "--no-skills", "--no-prompt-templates", "--no-themes",
         "--no-context-files", "--no-builtin-tools", "--no-approve"],
        cwd=project, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
    )
    os.close(slave)
    try:
        startup = read_until(master, b"scripted", time.monotonic() + 15)
        if b"scripted" not in startup:
            raise AssertionError(f"Pi TUI did not render its model status: {startup[-1500:]!r}")
        if process.poll() is not None:
            raise AssertionError(f"Pi TUI exited before command: {startup[-1500:]!r}")
        time.sleep(0.3)
        os.write(master, b"/teamsync\r")
        result = startup + read_until(master, b"No Team updates.", time.monotonic() + 15)
        if b"No Team updates." not in result:
            raise AssertionError(f"Pi TUI did not render the empty sync notice: {result[-2000:]!r}")
        print(json.dumps({"tui_empty_notice": True, "pi_alive": process.poll() is None}))
    finally:
        if process.poll() is None:
            process.send_signal(signal.SIGTERM)
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)
        os.close(master)


if __name__ == "__main__":
    main()
