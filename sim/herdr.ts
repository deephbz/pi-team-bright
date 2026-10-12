import path from "node:path";
import type { ExecResult } from "../src/env/host-env";
import { ProcessTable } from "./process-table";

import { assumptionEvidence, type AssumptionId, type FakeEvidence } from "./assumptions";
export type { AssumptionId, FakeEvidence } from "./assumptions";
export interface Pane {
  id: string; shellPid: number; agentPid?: number; agentBirthToken?: string; agentBootId?: string; name?: string;
  state: "idle" | "working" | "blocked" | "done" | "unknown";
  sessionFile?: string;
  env: Record<string, string>; rect: { x: number; y: number; width: number; height: number };
}

/** Wire-level fake only. Assumptions are advisory until the probe lane validates them. */
export class HerdrFake {
  readonly panes = new Map<string, Pane>();
  readonly evidence: FakeEvidence[] = [];
  available = true;
  partialList?: Set<string>;
  private sequence = 0;
  onStart?: (pane: Pane, argv: string[]) => void;
  onPane?: (kind: "pane.create" | "pane.close", pane: Pane) => void;

  constructor(readonly processes: ProcessTable, private readonly stopProcess = (pid: number) => processes.kill(pid)) {}
  private cite(assumption: AssumptionId, behavior: string, unprobedScope?: string): void { this.evidence.push(assumptionEvidence(assumption, behavior, unprobedScope)); }

  spawn(id = `pane-${++this.sequence}`, env: Record<string, string> = {}): Pane {
    this.cite("A1", "new terminal has a shell before managed agent start");
    if (this.panes.has(id)) throw new Error(`Pane already exists: ${id}`);
    const shell = this.processes.spawn(`shell:${id}`, { command: "shell", identity: { processKind: "shell" } });
    const pane: Pane = { id, shellPid: shell.pid, state: "unknown", env, rect: { x: 0, y: 0, width: 240, height: 80 } };
    this.panes.set(id, pane);
    this.onPane?.("pane.create", pane);
    return pane;
  }
  start(paneId: string, name: string, argv: string[] = []): Pane {
    this.cite("A6", "start fails for a disappeared pane");
    const pane = this.panes.get(paneId);
    if (!pane) throw new Error("agent_pane_not_found");
    if (this.agentLive(pane)) throw new Error("agent_pane_busy");
    const actorName = pane.env.PI_AGENT_NAME || name;
    const actor = pane.env.PI_TEAM_NAME ? `${pane.env.PI_TEAM_NAME}/${actorName}` : actorName;
    const membershipId = pane.env.PI_TEAM_MEMBERSHIP_ID;
    const process = this.processes.spawn(actor, { parentPid: pane.shellPid,
      identity: membershipId ? { processKind: "worker_pi", membershipId } : { processKind: "other" },
    });
    pane.agentPid = process.pid;
    pane.agentBirthToken = process.osBirthToken;
    pane.agentBootId = process.bootId;
    pane.name = name;
    pane.state = "idle";
    this.onStart?.(pane, argv);
    return pane;
  }
  close(id: string): void {
    this.cite("A2", "pane closure kills its shell and agent", "A2 probes Pi exit, not pane-close process-tree semantics");
    const pane = this.panes.get(id);
    if (!pane) return;
    if (this.agentLive(pane)) this.stopProcess(pane.agentPid!);
    if (this.processes.exists(pane.shellPid)) this.stopProcess(pane.shellPid);
    this.panes.delete(id);
    this.onPane?.("pane.close", pane);
  }
  list(): unknown[] {
    this.cite("A1", "agent list excludes shell-only panes");
    this.cite("A2", "agent name disappears after Pi exit while shell remains");
    if (this.partialList) this.cite("A8", "agent list may omit live recognized agents");
    return [...this.panes.values()]
      .filter(p => this.agentLive(p) && (!this.partialList || this.partialList.has(p.id)))
      .map(p => this.agent(p));
  }
  agentLive(pane: Pane): boolean {
    const process = pane.agentPid === undefined ? undefined : this.processes.current(pane.agentPid);
    return !!process && process.osBirthToken === pane.agentBirthToken && process.bootId === pane.agentBootId;
  }
  private agent(p: Pane) {
    return { name: p.name, pane_id: p.id, terminal_id: `terminal:${p.id}`, tab_id: "tab-1", workspace_id: "workspace-1", agent: "pi", interactive_ready: true, agent_status: p.state, agent_session: p.sessionFile ? { source: "herdr:pi", agent: "pi", kind: "path", value: p.sessionFile } : null };
  }
  private wirePane(p: Pane) {
    return { pane_id: p.id, tab_id: "tab-1", workspace_id: "workspace-1", terminal_id: `terminal:${p.id}`, rect: p.rect };
  }
  run(args: readonly string[]): ExecResult {
    if (!this.available) return { stdout: "", stderr: "Herdr unavailable", status: 1 };
    const flag = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
    const ok = (result: unknown): ExecResult => ({ stdout: JSON.stringify({ result }), stderr: "", status: 0 });
    const paneId = flag("--pane") ?? args[2];
    const pane = this.panes.get(paneId ?? "");
    const command = `${args[0]} ${args[1]}`;
    try {
      switch (command) {
        case "status server": this.cite("A8", "server availability is independent from list completeness"); return ok({ running: true });
        case "agent list": return ok({ type: "agent_list", agents: this.list() });
        case "pane split": {
          if (!pane) throw new Error("pane_not_found");
          const env: Record<string, string> = { ...pane.env };
          args.forEach((arg, i) => { if (arg === "--env") { const pair = args[i + 1]!; const split = pair.indexOf("="); env[pair.slice(0, split)] = pair.slice(split + 1); } });
          const child = this.spawn(undefined, env);
          const ratio = Number(flag("--ratio") ?? "0.5");
          const axis = flag("--direction") === "down" ? "height" : "width";
          const coordinate = axis === "height" ? "y" : "x";
          child.rect = { ...pane.rect };
          pane.rect[axis] = Math.floor(pane.rect[axis] * ratio);
          child.rect[coordinate] += pane.rect[axis];
          child.rect[axis] -= pane.rect[axis];
          return ok({ pane: this.wirePane(child) });
        }
        case "agent start": {
          const started = this.start(paneId!, args[2]!, args.slice(args.indexOf("--") + 1));
          return ok({ type: "agent_started", argv: ["pi"], agent: this.agent(started) });
        }
        case "pane close": this.close(paneId!); return ok({});
        case "pane list": this.cite("A2", "shell panes remain present after Pi exit"); return ok({ type: "pane_list", panes: [...this.panes.values()].map(p => this.wirePane(p)) });
        case "pane get": this.cite("A2", "shell pane remains queryable after agent exit"); if (!pane) throw new Error("pane_not_found"); return ok({ pane: this.wirePane(pane) });
        case "pane layout": this.cite("A6", "split geometry is visible at the pane boundary", "No pane geometry probe"); return ok({ layout: { tab_id: "tab-1", workspace_id: "workspace-1", panes: [...this.panes.values()].map(p => this.wirePane(p)) } });
        case "pane rename": this.cite("A6", "pane label does not start an agent", "No rename probe"); if (!pane) throw new Error("pane_not_found"); return ok({});
        case "pane process-info": {
          this.cite("A2", "process-info distinguishes shell and Pi child");
          if (!pane) throw new Error("pane_not_found");
          const foreground = this.processes.current(this.agentLive(pane) ? pane.agentPid! : pane.shellPid)!;
          return ok({ type: "pane_process_info", process_info: { pane_id: pane.id, shell_pid: pane.shellPid, foreground_process_group_id: foreground.pid, foreground_processes: [{ pid: foreground.pid, argv0: foreground.command === "shell" ? "zsh" : "pi", name: foreground.command === "shell" ? "zsh" : "node" }] } });
        }
        default: throw new Error(`Unmodeled Herdr command: ${command}`);
      }
    } catch (error) {
      if (!(error instanceof Error) || !["pane_not_found", "agent_pane_not_found", "agent_pane_busy"].includes(error.message)) throw error;
      return { stdout: JSON.stringify({ error: { code: error.message, message: error.message } }), stderr: "", status: 1 };
    }
  }
}

/** No subprocess is ever launched. Unknown commands fail rather than returning success. */
export class ExecRouter {
  readonly calls: Array<{ command: string; args: string[]; result: ExecResult }> = [];
  readonly failures: Error[] = [];
  private readonly routes = new Map<string, (args: readonly string[]) => ExecResult>();
  constructor(herdr: HerdrFake) { this.routes.set("herdr", args => herdr.run(args)); }
  register(command: string, handler: (args: readonly string[]) => ExecResult): void { this.routes.set(command, handler); }
  runSync(command: string, args: readonly string[]): ExecResult {
    const route = this.routes.get(command) ?? this.routes.get(path.basename(command));
    try {
      if (!route) throw new Error(`Unmodeled exec: ${command}`);
      const result = route(args);
      this.calls.push({ command, args: [...args], result });
      return result;
    } catch (error) {
      this.failures.push(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
}
