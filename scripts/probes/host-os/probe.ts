// Linux probes A7 and A9 against the real rc.2 production modules.
// Bundle with esbuild and run on the probed host with an isolated HOME (README).
import { spawn, spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeProcessGenerations, linuxStartToken } from "../../../src/env/process-generation";
import { writeJsonAtomicAsync } from "../../../src/utils/atomic-json";
import { withLock } from "../../../src/utils/lock";

const here = path.dirname(process.argv[1]!);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function refStat(pid: number) {
  const out = execFileSync("python3", ["-I", "-c", `s=open("/proc/${pid}/stat").read(); r=s[s.rindex(")")+2:].split(); print(r[0], r[19])`], { encoding: "utf8" }).trim().split(" ");
  return { state: out[0], starttime: out[1] };
}

async function waitGone(pid: number) {
  for (let i = 0; i < 200; i++) { if (!fs.existsSync(`/proc/${pid}`)) return true; await sleep(10); }
  return false;
}

async function a7() {
  const environment = { date: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version,
    kernel: os.release(), distro: fs.readFileSync("/etc/os-release", "utf8").match(/PRETTY_NAME="(.*)"/)?.[1],
    clkTck: execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim(),
    pidMax: fs.readFileSync("/proc/sys/kernel/pid_max", "utf8").trim(),
    procMount: fs.readFileSync("/proc/mounts", "utf8").split("\n").find(l => l.startsWith("proc /proc "))?.split(" ")[3] };
  const trials: unknown[] = [];
  for (let trial = 0; trial < 3; trial++) {
    const victim = spawn("sleep", ["600"], { stdio: "ignore" });
    const pid = victim.pid!;
    await sleep(50);
    const before = (await probeProcessGenerations([pid])).get(pid)!;
    const ref = refStat(pid);
    const diedAt = Date.now();
    victim.kill("SIGKILL");
    await new Promise(r => victim.once("exit", r));
    await waitGone(pid);
    const afterDeath = (await probeProcessGenerations([pid])).get(pid)!;
    const wrap = execFileSync(path.join(here, "pidwrap"), [String(pid), "16", "600"], { encoding: "utf8" }).trim().split(" ");
    const reusedAt = Date.now();
    const after = (await probeProcessGenerations([pid])).get(pid)!;
    const newcomerRef = fs.existsSync(`/proc/${pid}`) ? refStat(pid) : undefined;
    const batch = Object.fromEntries(await probeProcessGenerations([pid, process.pid]));
    if (wrap[0] === "found") { try { process.kill(pid, "SIGKILL"); } catch {} }
    const b = before.kind === "found" ? before.generation : undefined;
    const a = after.kind === "found" ? after.generation : undefined;
    trials.push({ trial, pid, before, referenceStarttimeBefore: ref.starttime, afterDeath, wrap: { outcome: wrap[0], forksByWinner: Number(wrap[2]), ms: Number(wrap[3]) },
      deathToReuseMs: reusedAt - diedAt, after, newcomerReference: newcomerRef, batch,
      checks: { tokenMatchesReference: b?.osBirthToken === ref.starttime, absentAfterDeath: afterDeath.kind === "absent",
        reusedPidFound: a?.pid === pid, tokenChanged: !!a && !!b && a.osBirthToken !== b.osBirthToken, sameBoot: !!a && !!b && a.bootId === b.bootId,
        batchAgrees: JSON.stringify(batch[pid]) === JSON.stringify(after) } });
  }
  // A comm with spaces and ')' must not shift field 22.
  const tricky = spawn("python3", ["-I", "-c", "import ctypes,time; ctypes.CDLL(None).prctl(15, b'a) b (c 1 2', 0, 0, 0); time.sleep(30)"], { stdio: "ignore" });
  await sleep(300);
  const trickyProbe = (await probeProcessGenerations([tricky.pid!])).get(tricky.pid!)!;
  const trickyStat = fs.readFileSync(`/proc/${tricky.pid}/stat`, "utf8");
  const trickyRef = refStat(tricky.pid!);
  tricky.kill("SIGKILL");
  // A zombie keeps its /proc entry until reaped.
  const zombieParent = spawn("python3", ["-I", "-c", "import os,sys,time\nc=os.fork()\nif c==0: os._exit(0)\nprint(c, flush=True); time.sleep(30)"], { stdio: ["ignore", "pipe", "ignore"] });
  const zombiePid = Number(await new Promise<string>(r => zombieParent.stdout!.once("data", d => r(String(d).trim()))));
  await sleep(200);
  const zombie = { pid: zombiePid, state: refStat(zombiePid).state, probe: (await probeProcessGenerations([zombiePid])).get(zombiePid)! };
  zombieParent.kill("SIGKILL");
  // A process owned by another user (root) stays readable unless hidepid is set.
  const rootPid = Number(execFileSync("pgrep", ["-o", "-u", "root", "systemd-journal"], { encoding: "utf8" }).trim());
  const foreignUser = { pid: rootPid, probe: (await probeProcessGenerations([rootPid])).get(rootPid)! };
  const checks = (trials as any[]).every(t => Object.values(t.checks).every(Boolean))
    && trickyProbe.kind === "found" && trickyProbe.generation.osBirthToken === trickyRef.starttime && foreignUser.probe.kind === "found";
  return { assumption: "Linux /proc/<pid>/stat starttime changes on pid reuse.", verdict: checks ? "holds" : "refuted",
    command: "node probe.cjs a7 (production probeProcessGenerations; pidwrap forces reuse)",
    observed: { environment, trials, trickyComm: { stat: trickyStat.slice(0, 40), probe: trickyProbe, reference: trickyRef.starttime, parser: linuxStartToken(trickyStat) },
      zombie, foreignUser,
      scope: "Process reuse after a full PID wrap on one boot. starttime has CLK_TCK resolution; a reuse inside one tick is not reachable by wrap at this pid_max and is not tested. A zombie reads as found until reaped." } };
}

async function lockWorker(dir: string, rounds: number) {
  const counter = path.join(dir, "counter.json");
  for (let i = 0; i < rounds; i++) {
    await withLock(counter, async () => {
      const value = JSON.parse(fs.readFileSync(counter, "utf8")).value as number;
      if (i % 7 === 0) await sleep(1);
      await writeJsonAtomicAsync(counter, { value: value + 1 });
    }, 100000);
  }
}

async function crashHolder(dir: string) {
  await withLock(path.join(dir, "stale"), async () => { process.kill(process.pid, "SIGKILL"); await sleep(10000); });
}

async function atomicWriter(file: string) {
  let seq = (() => { try { return JSON.parse(fs.readFileSync(file, "utf8")).seq as number; } catch { return 0; } })();
  const pad = "x".repeat(256 * 1024);
  for (;;) { seq++; await writeJsonAtomicAsync(file, { seq, pad }); fs.writeFileSync(file + ".committed", String(seq)); }
}

function appendWriter(file: string) {
  let seq = 0;
  const pad = "y".repeat(2000);
  for (;;) {
    const fd = fs.openSync(file, "a", 0o600);
    try { fs.writeSync(fd, `${JSON.stringify({ seq: ++seq, pid: process.pid, pad })}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
}

function self(args: string[]) { return spawn(process.execPath, [process.argv[1]!, ...args], { stdio: "ignore" }); }

async function a9() {
  const root = fs.mkdtempSync(path.join(os.homedir(), "a9-"));
  const environment = { date: new Date().toISOString(), platform: process.platform, node: process.version, kernel: os.release(),
    filesystem: process.platform === "darwin"
      ? execFileSync("mount", { encoding: "utf8" }).split("\n").find(l => l.includes(" on /System/Volumes/Data ")) ?? ""
      : execFileSync("findmnt", ["-n", "-o", "FSTYPE,OPTIONS", "-T", root], { encoding: "utf8" }).trim() };

  // 1. Exclusive create: 16 processes increment one counter under the production lock.
  const lockDir = path.join(root, "lock"); fs.mkdirSync(lockDir);
  await writeJsonAtomicAsync(path.join(lockDir, "counter.json"), { value: 0 });
  const workers = 16, rounds = 200, t0 = Date.now();
  await Promise.all(Array.from({ length: workers }, () => new Promise(r => self(["lock-worker", lockDir, String(rounds)]).once("exit", r))));
  const counted = JSON.parse(fs.readFileSync(path.join(lockDir, "counter.json"), "utf8")).value;
  const lockResult = { workers, rounds, expected: workers * rounds, counted, ms: Date.now() - t0, leftovers: fs.readdirSync(lockDir).filter(f => f !== "counter.json") };

  // 2. A lock owner dies by SIGKILL while holding the lock; a contender recovers it.
  const staleDir = path.join(root, "stale"); fs.mkdirSync(staleDir);
  await new Promise(r => self(["crash-holder", staleDir]).once("exit", r));
  const staleLeft = fs.existsSync(path.join(staleDir, "stale.lock"));
  const t1 = Date.now();
  let recovered = false;
  try { await withLock(path.join(staleDir, "stale"), async () => { recovered = true; }, 1000); } catch (e) { recovered = false; }
  const staleResult = { lockLeftByKilledOwner: staleLeft, recovered, recoveryMs: Date.now() - t1, leftovers: fs.readdirSync(staleDir) };

  // 3. Async atomic replacement under random SIGKILL with concurrent readers.
  const atomicDir = path.join(root, "atomic"); fs.mkdirSync(atomicDir);
  const target = path.join(atomicDir, "state.json");
  await writeJsonAtomicAsync(target, { seq: 0, pad: "" });
  let reads = 0, readErrors: Record<string, number> = {}, regressions = 0, last = 0, stop = false;
  const reader = (async () => {
    while (!stop) {
      try { const seq = JSON.parse(fs.readFileSync(target, "utf8")).seq; reads++; if (seq < last) regressions++; last = seq; }
      catch (e: any) { const k = e.code ?? e.name; readErrors[k] = (readErrors[k] ?? 0) + 1; }
      await new Promise(r => setImmediate(r));
    }
  })();
  const kills = 150; let lostCommits = 0, unparsableAfterKill = 0;
  for (let k = 0; k < kills; k++) {
    const child = self(["atomic-writer", target]);
    await sleep(20 + Math.floor(Math.random() * 60));
    child.kill("SIGKILL");
    await new Promise(r => child.once("exit", r));
    try {
      const seq = JSON.parse(fs.readFileSync(target, "utf8")).seq;
      const committed = Number(fs.existsSync(target + ".committed") ? fs.readFileSync(target + ".committed", "utf8") : 0);
      if (seq < committed) lostCommits++;
    } catch { unparsableAfterKill++; }
  }
  stop = true; await reader;
  const tempLeftovers = fs.readdirSync(atomicDir).filter(f => f.endsWith(".tmp")).length;
  const atomicResult = { kills, reads, readErrors, regressions, unparsableAfterKill, lostCommits, tempLeftovers, finalSeq: JSON.parse(fs.readFileSync(target, "utf8")).seq };

  // 4. Journal-style append (open a, one write, fsync) under random SIGKILL.
  const journal = path.join(root, "journal.jsonl");
  for (let k = 0; k < 100; k++) {
    const child = self(["append-writer", journal]);
    await sleep(10 + Math.floor(Math.random() * 40));
    child.kill("SIGKILL");
    await new Promise(r => child.once("exit", r));
  }
  const lines = fs.readFileSync(journal, "utf8").split("\n");
  const tail = lines.pop();
  let torn = 0; for (const line of lines) { try { JSON.parse(line); } catch { torn++; } }
  const appendResult = { kills: 100, lines: lines.length, tornLines: torn, trailingPartial: tail !== "" };

  fs.rmSync(root, { recursive: true, force: true });
  const holds = counted === workers * rounds && staleLeft && recovered && reads > 0 && Object.keys(readErrors).length === 0 && regressions === 0
    && unparsableAfterKill === 0 && lostCommits === 0 && torn === 0 && tail === "";
  return { assumption: "Filesystem rename, exclusive create, and fsync behave as the fake states.", verdict: holds ? "holds" : "refuted",
    command: "node probe.cjs a9 (production withLock and writeJsonAtomicAsync; journal append mirrors appendTeamEvent)",
    observed: { environment, exclusiveCreate: lockResult, staleOwnerRecovery: staleResult, atomicReplace: atomicResult, journalAppend: appendResult,
      scope: "Process crash (SIGKILL) only, one ext4 host. Host crash, power loss and fsync durability are not tested. Leftover temp files after SIGKILL are recorded, not judged." } };
}

const [cmd, ...args] = process.argv.slice(2);
(async () => {
  if (cmd === "lock-worker") return lockWorker(args[0]!, Number(args[1]));
  if (cmd === "crash-holder") return crashHolder(args[0]!);
  if (cmd === "atomic-writer") return atomicWriter(args[0]!);
  if (cmd === "append-writer") return appendWriter(args[0]!);
  const result = cmd === "a7" ? await a7() : cmd === "a9" ? await a9() : undefined;
  if (!result) throw new Error(`unknown command ${cmd}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
