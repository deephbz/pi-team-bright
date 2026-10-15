#!/usr/bin/env python3
"""Real Pi PTY latency probe; terminal bytes are not physical display paint.

Uses the same stdlib PTY approach as team-sync-continuity-e2e/tui-empty.py.
Each cold/warm pair owns its HOME, agent directory and jiti TMPDIR. Never
deletes a user's cache or submits input to an existing session.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import platform
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

ROOT = Path(__file__).resolve().parents[2]
ANSI = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)")


def ms():
    return time.monotonic_ns() / 1e6


class Pi:
    def __init__(self, root, provider, label, ptb=True, diagnostics=False):
        self.events = root / (label + '.jsonl')
        self.output = bytearray()
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 42, 180, 0, 0))
        env = {k: os.environ[k] for k in ['PATH', 'LANG'] if k in os.environ}
        env.update(HOME=str(root / 'home'), USERPROFILE=str(root / 'home'),
                   PI_CODING_AGENT_DIR=str(root / 'agent'), TMPDIR=str(root / 'tmp'),
                   PI_TELEMETRY='0', TERM='xterm-256color', LANG='C.UTF-8',
                   NO_PROXY='127.0.0.1,localhost', no_proxy='127.0.0.1,localhost',
                   PTB_TUI_EVENTS=str(self.events))
        command = [shutil.which('node'), str(ROOT / 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
                   '--session', str(root / (label + '.session.jsonl')), '--provider', 'fixture',
                   '--model', 'scripted', '--thinking', 'off', '--no-extensions',
                   '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
                   '--no-builtin-tools', '--no-approve']
        if diagnostics:
            env['PTB_FREEZE_DIR'] = str(root / ('diagnostics-' + label))
            command[1:1] = ['--require', str(ROOT / 'scripts/leader-responsiveness/diagnostic-preload.cjs')]
            command += ['-e', str(ROOT / 'scripts/leader-responsiveness/diagnostic-extension.ts')]
        if ptb:
            command += ['-e', str(ROOT / 'extensions/index.ts')]
        command += ['-e', str(ROOT / 'scripts/leader-responsiveness/fixture.ts')]
        self.start = ms()
        self.process = subprocess.Popen(command, cwd=root / 'project', env=env,
                                        stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)

    def pump(self):
        ready, _, _ = select.select([self.master], [], [], .005)
        if ready:
            try:
                self.output.extend(os.read(self.master, 65536))
            except OSError:
                pass
        if self.process.poll() is not None:
            raise RuntimeError('Pi exited: ' + ANSI.sub(b'', bytes(self.output))[-3000:].decode(errors='replace'))

    def records(self):
        if not self.events.exists():
            return []
        lines = self.events.read_text().splitlines(keepends=True)
        return [json.loads(line) for line in lines if line.endswith('\n')]

    def wait(self, predicate, timeout=30):
        deadline = ms() + timeout * 1000
        while ms() < deadline:
            self.pump()
            value = predicate()
            if value:
                return value
        raise TimeoutError('Probe timeout: ' + bytes(self.output[-2500:]).decode(errors='replace'))

    def event(self, name, after=0):
        return next((r for r in self.records() if r['event'] == name and r['monoMs'] >= after), None)

    def send(self, data):
        # A terminal driver's own echo must never count as Pi rendering.
        assert not termios.tcgetattr(self.master)[3] & termios.ECHO, 'PTY kernel echo is enabled'
        sent = ms()
        os.write(self.master, data)
        return sent

    def echo(self, token, offset):
        return token in ANSI.sub(b'', bytes(self.output[offset:]))

    def sample(self, mode, index):
        # Clear text left by the previous probe without sending it to a model.
        self.send(b'\x15')
        before = ms()
        self.send(('RUN_' + mode + '\r').encode())
        start = self.wait(lambda: self.event('work_start', before))
        target = start['monoMs'] + (200 if mode == 'block' else 50)
        while ms() < target:
            self.pump()
        token = ('KEYPROBE%03d' % index).encode()
        offset = len(self.output)
        sent = self.send(token)
        echo_at = None
        # Escape is injected on schedule, not after the echo (avoids masking stalls).
        while ms() < sent + 20:
            self.pump()
            if echo_at is None and self.echo(token, offset):
                echo_at = ms()
        escape_sent = self.send(b'\x1b')
        deadline = ms() + 15000
        while ms() < deadline:
            self.pump()
            if echo_at is None and self.echo(token, offset):
                echo_at = ms()
            end = self.event('work_end', before)
            agent_end = self.event('agent_end', before)
            if end and agent_end and echo_at is not None and self.event('escape_input', escape_sent) and self.event('abort_signal', escape_sent):
                break
        else:
            raise TimeoutError(f'{mode}: missing echo/tool-end/agent-end')
        escaped = self.event('escape_input', escape_sent)
        aborted = self.event('abort_signal', escape_sent)
        assert escaped and aborted, f'{mode}: Escape never reached native input/abort signal'
        return dict(mode=mode, key_echo_ms=echo_at-sent,
                    escape_dispatch_ms=escaped['monoMs']-escape_sent,
                    escape_abort_signal_ms=aborted['monoMs']-escape_sent,
                    escape_agent_end_ms=agent_end['monoMs']-escape_sent,
                    tool_wall_ms=end['wallMs'], iterations=end['iterations'])

    def close(self):
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGTERM)
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait()
        os.close(self.master)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--provider', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--diagnostics', action='store_true')
    parser.add_argument('--pairs', type=int, default=3)
    parser.add_argument('--samples', type=int, default=3)
    args = parser.parse_args()
    assert args.pairs > 0 and args.samples > 0
    result = dict(evidence='real Pi TUI in Linux PTY; scripted provider; synthetic carrier bindings',
                  platform=platform.platform(), node=subprocess.check_output(['node', '-v'], text=True).strip(),
                  pi=json.loads((ROOT/'node_modules/@earendil-works/pi-coding-agent/package.json').read_text())['version'],
                  base=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
                  diagnostics=args.diagnostics, loadavg=os.getloadavg(), startup=[], samples=[], status='incomplete')
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        for pair in range(args.pairs):
            with tempfile.TemporaryDirectory(prefix='ptb-tui-') as tmp:
                root = Path(tmp)
                for folder in ['home', 'agent', 'project', 'tmp']:
                    (root/folder).mkdir()
                (root/'agent/models.json').write_text(json.dumps({'providers': {'fixture': {
                    'baseUrl': args.provider, 'api': 'openai-completions', 'apiKey': 'fixture-local-only',
                    'models': [{'id': 'scripted', 'name': 'scripted', 'reasoning': False, 'input': ['text'],
                                'contextWindow': 32000, 'maxTokens': 4096,
                                'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}}]}}}))
                for cache in ['cold', 'warm']:
                    pi = Pi(root, args.provider, cache, diagnostics=args.diagnostics)
                    try:
                        pi.wait(lambda: b'PTB_PROBE_READY' in pi.output)
                        ready = ms()
                        token = f'STARTPROBE{pair}{cache}'.encode()
                        offset = len(pi.output)
                        sent = pi.send(token)
                        pi.wait(lambda: pi.echo(token, offset))
                        result['startup'].append(dict(pair=pair, cache=cache, ready_ms=ready-pi.start,
                                                      first_echo_ms=ms()-sent,
                                                      cache_files=len(list((root/'tmp').rglob('*')))))
                        if pair == 0 and cache == 'warm':
                            pi.send(b'\x15')
                            pi.send(b'/probe-prepare\r')
                            pi.wait(lambda: pi.event('prepared'), timeout=90)
                            for mode in ['async', 'coordination', 'block']:
                                for _ in range(args.samples):
                                    sample = pi.sample(mode, len(result['samples']))
                                    result['samples'].append(sample)
                                    print(json.dumps(sample), flush=True)
                        print(json.dumps(result['startup'][-1]), flush=True)
                    finally:
                        pi.close()
                        # Only controlled fixture metadata; never save terminal/session payloads.
                        for log in (root / ('diagnostics-' + cache)).glob('*.jsonl*'):
                            shutil.copyfile(log, output.with_name(output.stem+f'-{pair}-{cache}-'+log.name))
                        if pi.events.exists():
                            output.with_name(output.stem+f'-{pair}-{cache}.events.jsonl').write_text(pi.events.read_text())
        healthy = [s for s in result['samples'] if s['mode'] != 'block']
        controls = [s for s in result['samples'] if s['mode'] == 'block']
        result['gates'] = dict(
            healthy_echo_under_100ms=all(s['key_echo_ms'] < 100 for s in healthy),
            healthy_escape_signal_under_100ms=all(s['escape_abort_signal_ms'] < 100 for s in healthy),
            detects_700ms_block=all(s['key_echo_ms'] > 400 and s['escape_abort_signal_ms'] > 400 for s in controls))
        result['status'] = 'passed' if all(result['gates'].values()) else 'failed'
    except Exception as error:
        result['error'] = str(error)
        raise
    finally:
        output.write_text(json.dumps(result, indent=2)+'\n')
    if result['status'] != 'passed':
        raise SystemExit(1)


if __name__ == '__main__':
    main()
