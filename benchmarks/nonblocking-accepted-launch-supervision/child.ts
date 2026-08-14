import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

type Scenario =
  | "accepted_bound"
  | "stable_reuse"
  | "early_exit"
  | "live_unbound_timeout"
  | "pane_loss"
  | "late_binding_at_timeout"
  | "concurrent_ensure"
  | "leader_restart"
  | "stop"
  | "shutdown"
  | "task_delivery_before_binding";

type OperationPhase = "prepared" | "accepted" | "bound" | "failed" | "expired" | "cancelled";
type TerminalTarget = { backend: "herdr"; kind: "pane"; targetId: string };
type RuntimeGeneration = { membershipId: string; pid: number; startedAt: number };

type CleanupReceipt = {
  complete: boolean;
  target: "stopped" | "already_absent" | "none";
  membership: "deactivated" | "already_inactive" | "replaced" | "retained";
  reason?: string;
};

type Operation = {
  operationId: string;
  teamName: string;
  workerName: string;
  membershipId: string;
  launchId: string;
  phase: OperationPhase;
  revision: number;
  createdAtMs: number;
  deadlineAtMs: number;
  target?: TerminalTarget;
  acceptedAtMs?: number;
  boundGeneration?: RuntimeGeneration;
  cleanup?: CleanupReceipt;
  history: Array<{ phase: OperationPhase; reason: string }>;
};

type OperationState = {
  schema: "pi-team-bright/nonblocking-accepted-launch-supervision-operation/1";
  operations: Operation[];
};

type SourceModules = {
  teams: any;
  runtime: any;
  paths: any;
  eventJournal: any;
  terminalRegistry: any;
  withLock: <T>(path: string, action: () => Promise<T>) => Promise<T>;
  writeJsonAtomic: (path: string, value: unknown) => void;
  WorkerLaunchBridge: any;
  DurableTeamLifecyclePublication: any;
  TeamSessionLifecycleService: any;
  TeamLifecycleService: any;
  DurableTaskChangeDeliveryMembership: any;
  workerEnsureLifecycle: any;
};

type EnsureAction = "accepted" | "accepted_existing" | "reused";
type EnsureReceipt = {
  action: EnsureAction;
  operationId: string;
  responseMs: number;
  responseCompletedAt: number;
};

type ExactBinding = {
  member: any;
  generation: RuntimeGeneration;
};

type ReconcileHooks = {
  beforeExpireCleanup?: () => Promise<void>;
};

const SCENARIOS: readonly Scenario[] = [
  "accepted_bound",
  "stable_reuse",
  "early_exit",
  "live_unbound_timeout",
  "pane_loss",
  "late_binding_at_timeout",
  "concurrent_ensure",
  "leader_restart",
  "stop",
  "shutdown",
  "task_delivery_before_binding",
];

const OPERATION_SCHEMA = "pi-team-bright/nonblocking-accepted-launch-supervision-operation/1" as const;
const TEAM_NAME = "accepted_supervision";
const WORKER_NAME = "worker";
const DEFAULT_DEADLINE_MS = 1_000;

class SimulatedLeaderCrash extends Error {
  constructor() {
    super("simulated leader crash after target persistence");
    this.name = "SimulatedLeaderCrash";
  }
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function errorKind(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "Error";
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sourceUrl(repository: string, relative: string): string {
  return pathToFileURL(path.join(repository, relative)).href;
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function isTerminal(phase: OperationPhase): boolean {
  return phase === "bound" || phase === "failed" || phase === "expired" || phase === "cancelled";
}

function transitionsFrom(phase: OperationPhase): readonly OperationPhase[] {
  switch (phase) {
    case "prepared": return ["accepted", "failed", "cancelled"];
    case "accepted": return ["bound", "failed", "expired", "cancelled"];
    case "bound":
    case "failed":
    case "expired":
    case "cancelled": return [];
  }
}

function transition(operation: Operation, next: OperationPhase, reason: string): void {
  if (operation.phase === next) return;
  if (!transitionsFrom(operation.phase).includes(next)) {
    throw new Error(`Illegal prototype transition ${operation.phase} -> ${next}.`);
  }
  operation.phase = next;
  operation.revision += 1;
  operation.history.push({ phase: next, reason });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function readState(file: string): OperationState {
  if (!fs.existsSync(file)) return { schema: OPERATION_SCHEMA, operations: [] };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as OperationState;
  if (parsed.schema !== OPERATION_SCHEMA || !Array.isArray(parsed.operations)) {
    throw new Error("Prototype operation store is malformed.");
  }
  return parsed;
}

class OperationStore {
  constructor(
    readonly file: string,
    private readonly source: Pick<SourceModules, "withLock" | "writeJsonAtomic">,
  ) {}

  read(): OperationState {
    return readState(this.file);
  }

  async transact<T>(action: (state: OperationState, persist: () => void) => Promise<T>): Promise<T> {
    return this.source.withLock(this.file, async () => {
      const state = readState(this.file);
      const persist = () => this.source.writeJsonAtomic(this.file, state);
      const result = await action(state, persist);
      persist();
      return clone(result);
    });
  }
}

type CarrierRecord = {
  operationId: string;
  targetId: string;
  carrierName: string;
  alive: boolean;
};

type CarrierState = {
  schema: "pi-team-bright/nonblocking-accepted-launch-supervision-carriers/1";
  next: number;
  carriers: CarrierRecord[];
};

class SyntheticHerdrAcceptedActuator {
  private readonly schema = "pi-team-bright/nonblocking-accepted-launch-supervision-carriers/1" as const;

  constructor(private readonly file: string, private readonly writeJsonAtomic: SourceModules["writeJsonAtomic"]) {}

  private read(): CarrierState {
    if (!fs.existsSync(this.file)) return { schema: this.schema, next: 0, carriers: [] };
    const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as CarrierState;
    if (parsed.schema !== this.schema || !Array.isArray(parsed.carriers) || !Number.isSafeInteger(parsed.next)) {
      throw new Error("Synthetic Herdr carrier registry is malformed.");
    }
    return parsed;
  }

  private write(state: CarrierState): void {
    this.writeJsonAtomic(this.file, state);
  }

  /** Models a positive accepted-start response, not real Herdr command behavior. */
  accept(operationId: string, initiallyAlive = true): TerminalTarget {
    const state = this.read();
    const targetId = `bench-pane-${++state.next}`;
    const carrierName = `bench-${state.next}`;
    const response = {
      type: "agent_started",
      agent: {
        agent: "pi",
        name: carrierName,
        pane_id: targetId,
        terminal_id: `terminal-${state.next}`,
        launch_pending: true,
        interactive_ready: false,
      },
    };
    const agent = response.agent;
    assert(response.type === "agent_started" && agent.agent === "pi" && agent.name === carrierName
      && agent.pane_id === targetId && !!agent.terminal_id && agent.launch_pending === true,
    "Synthetic accepted response did not prove the exact Pi carrier and pane.");
    state.carriers.push({ operationId, targetId, carrierName, alive: initiallyAlive });
    this.write(state);
    return { backend: "herdr", kind: "pane", targetId };
  }

  owns(target: TerminalTarget | undefined, operationId: string): boolean {
    if (!target || target.backend !== "herdr" || target.kind !== "pane") return false;
    return this.read().carriers.some((carrier) => carrier.targetId === target.targetId && carrier.operationId === operationId);
  }

  isAlive(targetId: string): boolean {
    return this.read().carriers.some((carrier) => carrier.targetId === targetId && carrier.alive);
  }

  stopExact(target: TerminalTarget, operationId: string): "stopped" | "already_absent" {
    const state = this.read();
    const carrier = state.carriers.find((candidate) => candidate.targetId === target.targetId && candidate.operationId === operationId);
    if (!carrier) throw new Error("Synthetic carrier ownership does not match the operation.");
    const outcome = carrier.alive ? "stopped" : "already_absent";
    carrier.alive = false;
    this.write(state);
    return outcome;
  }

  stopByTarget(targetId: string): void {
    const state = this.read();
    const carrier = state.carriers.find((candidate) => candidate.targetId === targetId);
    if (!carrier) return;
    carrier.alive = false;
    this.write(state);
  }

  lose(target: TerminalTarget): void {
    this.stopByTarget(target.targetId);
  }

  count(): number {
    return this.read().carriers.length;
  }
}

function memberTarget(member: any): TerminalTarget | undefined {
  const target = member?.terminalTarget;
  if (!target || target.backend !== "herdr" || target.kind !== "pane" || typeof target.targetId !== "string") return undefined;
  return { backend: "herdr", kind: "pane", targetId: target.targetId };
}

function sameTarget(left: TerminalTarget | undefined, right: TerminalTarget | undefined): boolean {
  return !!left && !!right && left.backend === right.backend && left.kind === right.kind && left.targetId === right.targetId;
}

function sameGeneration(left: RuntimeGeneration | undefined, right: RuntimeGeneration | undefined): boolean {
  return !!left && !!right && left.membershipId === right.membershipId && left.pid === right.pid && left.startedAt === right.startedAt;
}

class AcceptedLaunchSupervisorPrototype {
  readonly bridge: any;
  readonly sessionLifecycle: any;

  constructor(
    private readonly source: SourceModules,
    readonly store: OperationStore,
    private readonly carriers: SyntheticHerdrAcceptedActuator,
    readonly teamName: string,
    readonly workerName: string,
    private readonly project: string,
  ) {
    const publication = new source.DurableTeamLifecyclePublication();
    this.bridge = new source.WorkerLaunchBridge({
      buildWorkerArgv: () => ["pi"],
      resolveModel: () => null,
      resolveSettingsModel: () => null,
      workerAggregate: () => ({ projectTrusted: true }),
      lifecyclePublication: publication,
    });
    this.sessionLifecycle = new source.TeamSessionLifecycleService(publication);
  }

  private operationInState(state: OperationState): Operation | undefined {
    return [...state.operations].reverse().find((candidate) => candidate.teamName === this.teamName && candidate.workerName === this.workerName);
  }

  private async currentMember(): Promise<any | undefined> {
    return this.source.teams.currentMembership(this.teamName, this.workerName).catch(() => undefined);
  }

  private historicalMember(membershipId: string): any | undefined {
    try {
      const config = this.source.teams.readConfigSync
        ? this.source.teams.readConfigSync(this.teamName)
        : undefined;
      if (config) return config.members.find((member: any) => member.membershipId === membershipId);
    } catch {
      // The async fallback below is used on current source.
    }
    return undefined;
  }

  private async historicalMembership(membershipId: string): Promise<any | undefined> {
    const config = await this.source.teams.readConfig(this.teamName).catch(() => undefined);
    return config?.members.find((member: any) => member.membershipId === membershipId);
  }

  private async exactBinding(operation: Operation): Promise<ExactBinding | undefined> {
    const member = await this.currentMember();
    if (!member || member.membershipId !== operation.membershipId || !member.sessionFile) return undefined;
    const status = await this.source.runtime.readRuntimeStatus(this.teamName, this.workerName);
    const generation = this.source.runtime.runtimeGeneration(status) as RuntimeGeneration | null;
    if (!generation || generation.membershipId !== operation.membershipId) return undefined;
    const events = this.source.eventJournal.readTeamEvents(this.teamName, { eventTypes: ["worker"] }).events;
    const eventMatches = events.some((event: any) => event.type === "worker" && event.worker === this.workerName
      && event.membershipId === operation.membershipId && event.phase === "session_bound"
      && sameGeneration(event.generation, generation));
    return eventMatches ? { member, generation } : undefined;
  }

  private markBound(operation: Operation, binding: ExactBinding, reason: string): void {
    if (operation.phase === "prepared") {
      assert(!!operation.target, "A Session-bound prepared operation has no exact accepted target.");
      transition(operation, "accepted", "reconstructed_before_bound");
    }
    if (operation.phase === "accepted") transition(operation, "bound", reason);
    assert(operation.phase === "bound", "Only accepted operations may become bound.");
    operation.boundGeneration = binding.generation;
  }

  private async createPreparedOperation(state: OperationState): Promise<Operation> {
    const existing = await this.currentMember();
    if (existing) {
      const operationId = typeof existing.prototypeOperationId === "string" ? existing.prototypeOperationId : undefined;
      const launchId = typeof existing.prototypeLaunchId === "string" ? existing.prototypeLaunchId : existing.pendingLaunchId;
      if (!operationId || !launchId || !existing.membershipId) {
        throw new Error("A current Membership exists without a recoverable prototype operation fence.");
      }
      const target = memberTarget(existing);
      const recovered: Operation = {
        operationId,
        teamName: this.teamName,
        workerName: this.workerName,
        membershipId: existing.membershipId,
        launchId,
        phase: existing.sessionFile ? "accepted" : target ? "accepted" : "prepared",
        revision: 0,
        createdAtMs: Date.now(),
        deadlineAtMs: Date.now() + DEFAULT_DEADLINE_MS,
        ...(target ? { target, acceptedAtMs: Date.now() } : {}),
        history: [{ phase: existing.sessionFile || target ? "accepted" : "prepared", reason: "reconstructed_from_membership_fence" }],
      };
      state.operations.push(recovered);
      return recovered;
    }

    const operationId = `operation-${randomUUID()}`;
    const membershipId = this.source.teams.newMembershipId();
    const launchId = this.source.teams.newLaunchId();
    const member = {
      membershipId,
      pendingLaunchId: launchId,
      prototypeOperationId: operationId,
      prototypeLaunchId: launchId,
      agentId: `${this.workerName}@${this.teamName}`,
      name: this.workerName,
      agentType: "teammate",
      joinedAt: Date.now(),
      cwd: this.project,
      subscriptions: [],
      isActive: true,
      prompt: "Prototype-only accepted launch supervision.",
      color: "blue",
    };
    await this.source.teams.addMember(this.teamName, member);
    const publication = new this.source.DurableTeamLifecyclePublication();
    await publication.recordWorkerPrepared({ teamName: this.teamName, workerName: this.workerName, membershipId });
    const operation: Operation = {
      operationId,
      teamName: this.teamName,
      workerName: this.workerName,
      membershipId,
      launchId,
      phase: "prepared",
      revision: 0,
      createdAtMs: Date.now(),
      deadlineAtMs: Date.now() + DEFAULT_DEADLINE_MS,
      history: [{ phase: "prepared", reason: "membership_prepared" }],
    };
    state.operations.push(operation);
    return operation;
  }

  private async ensurePrepared(): Promise<Operation> {
    return this.store.transact(async (state) => {
      const operation = this.operationInState(state) ?? await this.createPreparedOperation(state);
      return operation;
    });
  }

  async ensureWorker(options: { initiallyAlive?: boolean; crashAfterTargetPersistence?: boolean } = {}): Promise<EnsureReceipt> {
    const started = performance.now();
    const prepared = await this.ensurePrepared();
    const outcome = await this.store.transact(async (state) => {
      const operation = this.operationInState(state);
      assert(operation && operation.operationId === prepared.operationId, "Prototype operation disappeared while ensure was running.");

      const bound = await this.exactBinding(operation);
      if (bound) {
        this.markBound(operation, bound, "observed_during_ensure");
        return { action: "reused" as const, operationId: operation.operationId };
      }
      if (operation.phase === "bound") {
        throw new Error("Bound prototype operation lacks exact durable binding evidence.");
      }
      if (operation.phase === "accepted") {
        return { action: "accepted_existing" as const, operationId: operation.operationId };
      }
      if (isTerminal(operation.phase)) {
        throw new Error(`Terminal operation ${operation.phase} cannot create a replacement carrier.`);
      }

      const current = await this.currentMember();
      assert(current?.membershipId === operation.membershipId && current.pendingLaunchId === operation.launchId,
        "Prepared Membership no longer matches the operation fence.");
      const persisted = memberTarget(current);
      if (persisted && this.carriers.owns(persisted, operation.operationId)) {
        operation.target = persisted;
        operation.acceptedAtMs = Date.now();
        transition(operation, "accepted", "reconstructed_after_target_persistence");
        return { action: "accepted_existing" as const, operationId: operation.operationId };
      }
      if (persisted) throw new Error("Prepared Membership already points at a target outside the operation fence.");

      const receipt = await this.bridge.launchPreparedMembership(
        this.teamName,
        current,
        null,
        () => {
          const target = this.carriers.accept(operation.operationId, options.initiallyAlive ?? true);
          return { terminalId: target.targetId, isWindow: false, backend: target.backend };
        },
      );
      const target: TerminalTarget = { backend: "herdr", kind: "pane", targetId: receipt.terminalId };
      const durable = await this.currentMember();
      assert(durable?.membershipId === operation.membershipId && sameTarget(memberTarget(durable), target),
        "Accepted target was not persisted to the exact Membership.");
      assert(this.carriers.owns(target, operation.operationId), "Accepted target is not owned by the operation.");
      if (options.crashAfterTargetPersistence) throw new SimulatedLeaderCrash();
      operation.target = target;
      operation.acceptedAtMs = Date.now();
      transition(operation, "accepted", "exact_target_persisted_after_accepted_actuation");
      return { action: "accepted" as const, operationId: operation.operationId };
    });
    return { ...outcome, responseMs: rounded(performance.now() - started), responseCompletedAt: performance.now() };
  }

  async bindWorker(options: { reconcile?: boolean } = {}): Promise<{ elapsedMs: number; operation: Operation }> {
    const started = performance.now();
    const operation = this.store.read().operations.at(-1);
    assert(operation && operation.phase === "accepted" && operation.target, "Binding requires one accepted operation.");
    const sessionFile = path.join(this.project, "worker-session.jsonl");
    const startup = await this.sessionLifecycle.admitWorker({
      teamName: this.teamName,
      workerName: this.workerName,
      sessionFile,
      placement: { kind: "placed", update: { terminalTarget: operation.target } },
      identitySource: "launch_env",
      launchId: operation.launchId,
      expectedMembershipId: operation.membershipId,
    });
    assert(startup.kind === "admitted", "Exact child Session admission was refused.");
    if (options.reconcile === false) {
      const binding = await this.exactBinding(operation);
      assert(binding, "Exact Session admission did not produce matching runtime and event evidence.");
      return { elapsedMs: rounded(performance.now() - started), operation: this.operation() };
    }
    const reconciled = await this.reconcile(Date.now());
    assert(reconciled.phase === "bound", "Supervisor did not record exact Session binding.");
    return { elapsedMs: rounded(performance.now() - started), operation: reconciled };
  }

  async requestCancellation(reason: "stop" | "shutdown"): Promise<Operation> {
    return this.store.transact(async (state, persist) => {
      const operation = this.operationInState(state);
      assert(operation, "No operation exists to cancel.");
      const binding = await this.exactBinding(operation);
      if (binding) {
        this.markBound(operation, binding, "binding_won_before_cancellation");
        return operation;
      }
      if (operation.phase === "prepared" || operation.phase === "accepted") {
        transition(operation, "cancelled", `${reason}_requested`);
        persist();
      }
      return operation;
    });
  }

  private async completeCleanup(operation: Operation, persist: () => void): Promise<Operation> {
    if (operation.cleanup?.complete) return operation;
    const binding = await this.exactBinding(operation);
    if (binding) {
      this.markBound(operation, binding, "binding_won_during_cleanup");
      return operation;
    }

    const current = await this.currentMember();
    if (!current || current.membershipId !== operation.membershipId) {
      const historical = await this.historicalMembership(operation.membershipId);
      let target: CleanupReceipt["target"] = "none";
      if (operation.target) {
        target = this.carriers.stopExact(operation.target, operation.operationId);
        assert(!this.carriers.isAlive(operation.target.targetId), "Exact carrier remained live after cleanup.");
      }
      operation.cleanup = {
        complete: true,
        target,
        membership: historical?.isActive === false ? "already_inactive" : "replaced",
      };
      return operation;
    }

    const cleanup = await this.source.teams.withCurrentMembershipLease(
      this.teamName,
      operation.membershipId,
      async (leased: any) => {
        const status = await this.source.runtime.readRuntimeStatus(this.teamName, this.workerName);
        const generation = this.source.runtime.runtimeGeneration(status) as RuntimeGeneration | null;
        if (leased.sessionFile) {
          throw new Error("Refusing cleanup because the exact Membership has a Session binding without complete bound evidence.");
        }
        if (generation?.membershipId === operation.membershipId) {
          throw new Error("Refusing cleanup because the exact Membership has an unbound runtime generation.");
        }
        let target: CleanupReceipt["target"] = "none";
        if (operation.target) {
          target = this.carriers.stopExact(operation.target, operation.operationId);
          assert(!this.carriers.isAlive(operation.target.targetId), "Exact carrier remained live after cleanup.");
        }
        await this.source.teams.deactivateMembership(this.teamName, operation.membershipId, "replaced");
        return { target, membership: "deactivated" as const };
      },
    );
    operation.cleanup = { complete: true, ...cleanup };
    persist();
    return operation;
  }

  async reconcile(now: number, hooks: ReconcileHooks = {}): Promise<Operation> {
    return this.store.transact(async (state, persist) => {
      const operation = this.operationInState(state);
      assert(operation, "No operation exists to reconcile.");
      const binding = await this.exactBinding(operation);
      if (binding) {
        this.markBound(operation, binding, "exact_session_runtime_event_match");
        return operation;
      }
      if (operation.phase === "bound") {
        throw new Error("Bound operation lost its exact binding evidence.");
      }

      if (operation.phase === "prepared") {
        const current = await this.currentMember();
        const target = memberTarget(current);
        if (current?.membershipId === operation.membershipId && target && this.carriers.owns(target, operation.operationId)) {
          operation.target = target;
          operation.acceptedAtMs ||= Date.now();
          transition(operation, "accepted", "reconstructed_after_leader_restart");
          persist();
        } else if (now >= operation.deadlineAtMs) {
          transition(operation, "failed", "prepared_deadline_without_exact_target");
          persist();
          return this.completeCleanup(operation, persist);
        } else {
          return operation;
        }
      }

      if (operation.phase === "accepted") {
        assert(operation.target, "Accepted operation has no exact target.");
        if (!this.carriers.owns(operation.target, operation.operationId) || !this.carriers.isAlive(operation.target.targetId)) {
          transition(operation, "failed", "carrier_missing_before_session_binding");
          persist();
          return this.completeCleanup(operation, persist);
        }
        if (now >= operation.deadlineAtMs) {
          await hooks.beforeExpireCleanup?.();
          const lateBinding = await this.exactBinding(operation);
          if (lateBinding) {
            this.markBound(operation, lateBinding, "binding_won_at_expiry_fence");
            return operation;
          }
          transition(operation, "expired", "accepted_deadline_elapsed");
          persist();
          return this.completeCleanup(operation, persist);
        }
        return operation;
      }

      if (operation.phase === "failed" || operation.phase === "expired" || operation.phase === "cancelled") {
        return this.completeCleanup(operation, persist);
      }
      return operation;
    });
  }

  operation(): Operation {
    const operation = this.store.read().operations.at(-1);
    assert(operation, "No prototype operation exists.");
    return operation;
  }

  currentTarget(): TerminalTarget | undefined {
    return this.operation().target;
  }

  carrierCount(): number {
    return this.carriers.count();
  }
}

function sourceFence(repository: string) {
  const files = {
    bridge: path.join(repository, "src/team-authority/worker-launch-bridge.ts"),
    session: path.join(repository, "src/team-authority/team-session-lifecycle-service.ts"),
    lifecycle: path.join(repository, "src/team-authority/team-lifecycle-service.ts"),
    delivery: path.join(repository, "src/adapters/durable-task-change-delivery-membership.ts"),
    planner: path.join(repository, "src/utils/worker-ensure-lifecycle.ts"),
    publication: path.join(repository, "src/adapters/durable-team-lifecycle-publication.ts"),
  };
  const bridge = fs.readFileSync(files.bridge, "utf8");
  const session = fs.readFileSync(files.session, "utf8");
  const lifecycle = fs.readFileSync(files.lifecycle, "utf8");
  const delivery = fs.readFileSync(files.delivery, "utf8");
  const planner = fs.readFileSync(files.planner, "utf8");
  const prepared = bridge.indexOf("await teams.addMember");
  const preparedEvent = bridge.indexOf("recordWorkerPrepared", prepared);
  const launch = bridge.indexOf("this.launchPreparedMembership", preparedEvent);
  const observe = bridge.indexOf("this.observeLaunchedWorker", launch);
  const runtimeWrite = session.indexOf("await runtime.writeRuntimeStatus");
  const bind = session.indexOf("await teams.bindMemberSession", runtimeWrite);
  const sessionEvent = session.indexOf("recordWorkerSessionBound", bind);
  return {
    sha256: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, sha256(file)])),
    bridge_prepared_before_target_and_observation: prepared >= 0 && preparedEvent > prepared && launch > preparedEvent && observe > launch,
    exact_session_runtime_bind_event_order: runtimeWrite >= 0 && bind > runtimeWrite && sessionEvent > bind,
    delivery_requires_exact_session_recipient: delivery.includes("candidate.sessionFile === input.sessionFile")
      && delivery.includes("withCurrentSessionBinding"),
    stop_shutdown_use_topology_and_membership_fences: lifecycle.includes("withTeamTopologyLease")
      && lifecycle.includes("withCurrentMembershipLease"),
    prepared_live_planner_text_classification: /case "prepared":[\s\S]*?if \(observation === "live"\) return \{ action: "refuse", carrier, reason: "unbound_live" \};/.test(planner)
      ? "refuse"
      : /case "prepared":[\s\S]*?if \(observation === "live"\) return \{ action: "reuse", carrier \};/.test(planner)
        ? "reuse"
        : "unrecognized",
  };
}

async function loadSource(repository: string): Promise<SourceModules> {
  const [
    teams,
    runtime,
    paths,
    eventJournal,
    terminalRegistry,
    lock,
    atomicJson,
    bridge,
    publication,
    session,
    lifecycle,
    delivery,
    workerEnsureLifecycle,
  ] = await Promise.all([
    import(sourceUrl(repository, "src/utils/teams.ts")),
    import(sourceUrl(repository, "src/utils/runtime.ts")),
    import(sourceUrl(repository, "src/utils/paths.ts")),
    import(sourceUrl(repository, "src/coordination/event-journal.ts")),
    import(sourceUrl(repository, "src/adapters/terminal-registry.ts")),
    import(sourceUrl(repository, "src/utils/lock.ts")),
    import(sourceUrl(repository, "src/utils/atomic-json.ts")),
    import(sourceUrl(repository, "src/team-authority/worker-launch-bridge.ts")),
    import(sourceUrl(repository, "src/adapters/durable-team-lifecycle-publication.ts")),
    import(sourceUrl(repository, "src/team-authority/team-session-lifecycle-service.ts")),
    import(sourceUrl(repository, "src/team-authority/team-lifecycle-service.ts")),
    import(sourceUrl(repository, "src/adapters/durable-task-change-delivery-membership.ts")),
    import(sourceUrl(repository, "src/utils/worker-ensure-lifecycle.ts")),
  ]);
  return {
    teams,
    runtime,
    paths,
    eventJournal,
    terminalRegistry,
    withLock: lock.withLock,
    writeJsonAtomic: atomicJson.writeJsonAtomic,
    WorkerLaunchBridge: bridge.WorkerLaunchBridge,
    DurableTeamLifecyclePublication: publication.DurableTeamLifecyclePublication,
    TeamSessionLifecycleService: session.TeamSessionLifecycleService,
    TeamLifecycleService: lifecycle.TeamLifecycleService,
    DurableTaskChangeDeliveryMembership: delivery.DurableTaskChangeDeliveryMembership,
    workerEnsureLifecycle,
  };
}

async function setup(repository: string) {
  const project = requiredEnv("PTB_NB_PROJECT");
  fs.mkdirSync(project, { recursive: true, mode: 0o700 });
  process.chdir(project);
  const source = await loadSource(repository);
  const carrierRegistry = new SyntheticHerdrAcceptedActuator(
    path.join(project, "synthetic-herdr-carriers.json"),
    source.writeJsonAtomic,
  );
  const terminal = {
    name: "herdr",
    isDirectCarrier: () => true,
    detect: () => true,
    currentTargetId: () => "bench-leader-pane",
    spawn: () => { throw new Error("The prototype must use the explicit accepted actuator."); },
    kill: (targetId: string) => carrierRegistry.stopByTarget(targetId),
    isAlive: (targetId: string) => carrierRegistry.isAlive(targetId),
    setTitle: () => {},
    supportsWindows: () => false,
    spawnWindow: () => { throw new Error("Synthetic Herdr has no windows."); },
    setWindowTitle: () => {},
    killWindow: () => {},
    isWindowAlive: () => false,
  };
  source.terminalRegistry.setAdapter(terminal);
  const leaderSession = path.join(project, "leader-session.jsonl");
  await source.teams.createTeam(
    TEAM_NAME,
    leaderSession,
    "benchmark-lead",
    "benchmark accepted launch supervision",
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    { backend: "herdr", leadTarget: { backend: "herdr", kind: "pane", targetId: "bench-leader-pane" } },
  );
  const store = new OperationStore(
    path.join(source.paths.teamDir(TEAM_NAME), "nonblocking-accepted-launch-operation.json"),
    source,
  );
  const supervisor = new AcceptedLaunchSupervisorPrototype(source, store, carrierRegistry, TEAM_NAME, WORKER_NAME, project);
  return { source, project, carrierRegistry, supervisor };
}

function compactOperation(operation: Operation) {
  return {
    phase: operation.phase,
    revision: operation.revision,
    history: operation.history.map((entry) => ({ ...entry })),
    target_persisted: !!operation.target,
    bound_generation_persisted: !!operation.boundGeneration,
    cleanup: operation.cleanup ? { ...operation.cleanup } : null,
  };
}

async function currentBoundCheck(source: SourceModules, supervisor: AcceptedLaunchSupervisorPrototype): Promise<boolean> {
  const operation = supervisor.operation();
  const member = await source.teams.currentMembership(TEAM_NAME, WORKER_NAME).catch(() => undefined);
  const status = await source.runtime.readRuntimeStatus(TEAM_NAME, WORKER_NAME);
  const generation = source.runtime.runtimeGeneration(status) as RuntimeGeneration | null;
  const events = source.eventJournal.readTeamEvents(TEAM_NAME, { eventTypes: ["worker"] }).events;
  return member?.membershipId === operation.membershipId && !!member.sessionFile
    && sameGeneration(operation.boundGeneration, generation ?? undefined)
    && events.some((event: any) => event.type === "worker" && event.phase === "session_bound"
      && event.membershipId === operation.membershipId && sameGeneration(event.generation, generation ?? undefined));
}

async function testScenario(scenario: Scenario, repository: string) {
  const started = performance.now();
  const context = await setup(repository);
  const { source, supervisor, carrierRegistry } = context;
  // Observations preserve returned facts, including values that may change over
  // source revisions. Safety assertions alone decide whether this run passes.
  const observations: Record<string, boolean | number | string> = {};
  const checks: Record<string, boolean> = {};
  const timing: Record<string, number> = {};

  if (scenario === "accepted_bound") {
    const receipt = await supervisor.ensureWorker();
    timing.response_ms = receipt.responseMs;
    const operationBefore = supervisor.operation();
    observations.response_action = receipt.action;
    checks.response_is_accepted = receipt.action === "accepted";
    checks.prebind_phase_accepted = operationBefore.phase === "accepted";
    checks.target_persisted = !!operationBefore.target;
    checks.carrier_live_before_bind = !!operationBefore.target && carrierRegistry.isAlive(operationBefore.target.targetId);
    const memberBefore = await source.teams.currentMembership(TEAM_NAME, WORKER_NAME);
    checks.session_absent_before_bind = !memberBefore.sessionFile;
    const binding = await supervisor.bindWorker();
    timing.later_binding_ms = binding.elapsedMs;
    checks.bound_exactly = await currentBoundCheck(source, supervisor);
  } else if (scenario === "stable_reuse") {
    const first = await supervisor.ensureWorker();
    const binding = await supervisor.bindWorker();
    const reused = await supervisor.ensureWorker();
    timing.first_response_ms = first.responseMs;
    timing.later_binding_ms = binding.elapsedMs;
    timing.stable_reuse_response_ms = reused.responseMs;
    observations.reuse_action = reused.action;
    checks.reused_exact_bound_carrier = reused.action === "reused";
    checks.one_carrier_for_reuse = supervisor.carrierCount() === 1;
    const member = await source.teams.currentMembership(TEAM_NAME, WORKER_NAME);
    const plan = source.workerEnsureLifecycle.planWorkerEnsure(source.workerEnsureLifecycle.normalizeWorkerCarrier(member), "live");
    checks.source_bound_plan_is_reuse = plan.action === "reuse";
    checks.bound_exactly = await currentBoundCheck(source, supervisor);
  } else if (scenario === "early_exit") {
    const receipt = await supervisor.ensureWorker({ initiallyAlive: false });
    timing.response_ms = receipt.responseMs;
    const reconciled = await supervisor.reconcile(Date.now());
    checks.failed = reconciled.phase === "failed";
    checks.cleanup_complete = reconciled.cleanup?.complete === true;
    checks.exact_target_absent = !!reconciled.target && !carrierRegistry.isAlive(reconciled.target.targetId);
    const historical = (await source.teams.readConfig(TEAM_NAME)).members.find((member: any) => member.membershipId === reconciled.membershipId);
    checks.membership_deactivated = historical?.isActive === false;
  } else if (scenario === "live_unbound_timeout") {
    const receipt = await supervisor.ensureWorker();
    timing.response_ms = receipt.responseMs;
    const before = supervisor.operation();
    const sourcePlan = source.workerEnsureLifecycle.planWorkerEnsure(
      source.workerEnsureLifecycle.normalizeWorkerCarrier(await source.teams.currentMembership(TEAM_NAME, WORKER_NAME)),
      "live",
    );
    const reconciled = await supervisor.reconcile(before.deadlineAtMs + 1);
    checks.expired = reconciled.phase === "expired";
    checks.cleanup_complete = reconciled.cleanup?.complete === true;
    observations.integrated_source_prepared_live_plan_action = sourcePlan.action;
    observations.integrated_source_prepared_live_plan_reason = typeof sourcePlan.reason === "string" ? sourcePlan.reason : "absent";
    checks.prototype_never_reused_unbound = receipt.action === "accepted";
    checks.integrated_source_refuses_live_prepared_carrier = sourcePlan.action === "refuse" && sourcePlan.reason === "unbound_live";
    checks.target_absent_after_timeout = !!reconciled.target && !carrierRegistry.isAlive(reconciled.target.targetId);
  } else if (scenario === "pane_loss") {
    const receipt = await supervisor.ensureWorker();
    timing.response_ms = receipt.responseMs;
    const target = supervisor.currentTarget();
    assert(target, "Pane-loss test needs an exact target.");
    carrierRegistry.lose(target);
    const reconciled = await supervisor.reconcile(Date.now());
    checks.failed = reconciled.phase === "failed";
    checks.cleanup_complete = reconciled.cleanup?.complete === true;
    checks.target_absent = !carrierRegistry.isAlive(target.targetId);
  } else if (scenario === "late_binding_at_timeout") {
    const receipt = await supervisor.ensureWorker();
    timing.response_ms = receipt.responseMs;
    const operation = supervisor.operation();
    let bindingElapsed = 0;
    const reconciled = await supervisor.reconcile(operation.deadlineAtMs + 1, {
      beforeExpireCleanup: async () => {
        const binding = await supervisor.bindWorker({ reconcile: false });
        bindingElapsed = binding.elapsedMs;
      },
    });
    timing.later_binding_ms = bindingElapsed;
    checks.bound_won_expiry_fence = reconciled.phase === "bound";
    checks.target_retained_after_bound = !!reconciled.target && carrierRegistry.isAlive(reconciled.target.targetId);
    checks.cleanup_not_run = !reconciled.cleanup;
    checks.bound_exactly = await currentBoundCheck(source, supervisor);
  } else if (scenario === "concurrent_ensure") {
    const [left, right] = await Promise.all([supervisor.ensureWorker(), supervisor.ensureWorker()]);
    timing.first_response_ms = left.responseMs;
    timing.second_response_ms = right.responseMs;
    checks.one_carrier = supervisor.carrierCount() === 1;
    checks.same_operation = left.operationId === right.operationId;
    checks.one_new_acceptance = [left.action, right.action].filter((action) => action === "accepted").length === 1;
    checks.other_is_operation_receipt = [left.action, right.action].filter((action) => action === "accepted_existing").length === 1;
    checks.unbound_not_reused = ![left.action, right.action].includes("reused");
  } else if (scenario === "leader_restart") {
    let crashSeen = false;
    try {
      await supervisor.ensureWorker({ crashAfterTargetPersistence: true });
    } catch (error) {
      crashSeen = error instanceof SimulatedLeaderCrash;
    }
    const preRestart = supervisor.operation();
    checks.simulated_crash_after_target_persistence = crashSeen;
    checks.pre_restart_phase_prepared = preRestart.phase === "prepared";
    const restarted = new AcceptedLaunchSupervisorPrototype(
      source,
      supervisor.store,
      carrierRegistry,
      TEAM_NAME,
      WORKER_NAME,
      context.project,
    );
    const reconstructed = await restarted.reconcile(Date.now());
    checks.accepted_reconstructed_from_target = reconstructed.phase === "accepted";
    checks.same_carrier_after_restart = restarted.carrierCount() === 1;
    const binding = await restarted.bindWorker();
    timing.later_binding_ms = binding.elapsedMs;
    checks.bound_after_restart = await currentBoundCheck(source, restarted);
  } else if (scenario === "stop") {
    const receipt = await supervisor.ensureWorker();
    timing.response_ms = receipt.responseMs;
    const cancelled = await supervisor.requestCancellation("stop");
    const lifecycle = new source.TeamLifecycleService({
      assignedWorkGuard: {
        nonterminalTaskIds: async () => [],
        nonterminalTaskIdsAssignedToWorker: async () => [],
      },
      lifecyclePublication: new source.DurableTeamLifecyclePublication(),
    });
    const stopped = await lifecycle.stopWorker(TEAM_NAME, WORKER_NAME);
    const reconciled = await supervisor.reconcile(Date.now());
    checks.cancelled_before_stop = cancelled.phase === "cancelled";
    checks.source_stop_confirmed = stopped.kind === "stopped";
    checks.cancelled_after_stop = reconciled.phase === "cancelled";
    checks.cleanup_complete = reconciled.cleanup?.complete === true;
  } else if (scenario === "shutdown") {
    const receipt = await supervisor.ensureWorker();
    timing.response_ms = receipt.responseMs;
    const cancelled = await supervisor.requestCancellation("shutdown");
    const lifecycle = new source.TeamLifecycleService({
      assignedWorkGuard: {
        nonterminalTaskIds: async () => [],
        nonterminalTaskIdsAssignedToWorker: async () => [],
      },
      lifecyclePublication: new source.DurableTeamLifecyclePublication(),
    });
    const shutdown = await lifecycle.shutdownTeam(TEAM_NAME);
    const reconciled = await supervisor.reconcile(Date.now());
    checks.cancelled_before_shutdown = cancelled.phase === "cancelled";
    checks.source_shutdown_confirmed = shutdown.kind === "shutdown" && shutdown.stoppedWorkers.includes(WORKER_NAME);
    checks.cancelled_after_shutdown = reconciled.phase === "cancelled";
    checks.cleanup_complete = reconciled.cleanup?.complete === true;
  } else if (scenario === "task_delivery_before_binding") {
    const receipt = await supervisor.ensureWorker();
    timing.response_ms = receipt.responseMs;
    const deliveryMembership = new source.DurableTaskChangeDeliveryMembership();
    const sessionFile = path.join(context.project, "worker-session.jsonl");
    const before = await deliveryMembership.currentRecipient({
      teamName: TEAM_NAME,
      recipient: WORKER_NAME,
      sessionFile,
    });
    checks.delivery_refused_before_exact_binding = before === null;
    const binding = await supervisor.bindWorker();
    timing.later_binding_ms = binding.elapsedMs;
    const after = await deliveryMembership.currentRecipient({
      teamName: TEAM_NAME,
      recipient: WORKER_NAME,
      sessionFile,
    });
    checks.delivery_allows_exact_bound_membership = after?.membershipId === supervisor.operation().membershipId;
    checks.bound_exactly = await currentBoundCheck(source, supervisor);
  }

  const finalOperation = supervisor.operation();
  const allSafetyAssertionsPass = Object.values(checks).every(Boolean);
  return {
    schema: "pi-team-bright/nonblocking-accepted-launch-supervision-child/2",
    status: allSafetyAssertionsPass ? "complete" : "partial",
    scenario,
    source_fence: sourceFence(repository),
    timing_ms: Object.fromEntries(Object.entries(timing).map(([name, value]) => [name, rounded(value)])),
    observations,
    safety_assertions: checks,
    operation: compactOperation(finalOperation),
    carrier_count: supervisor.carrierCount(),
    child_elapsed_ms: rounded(performance.now() - started),
  };
}

async function main(): Promise<void> {
  const repository = requiredEnv("PTB_NB_REPOSITORY");
  const scenario = option("--scenario") as Scenario | undefined;
  if (!scenario || !SCENARIOS.includes(scenario)) {
    throw new Error(`--scenario must be one of ${SCENARIOS.join(", ")}.`);
  }
  const result = await testScenario(scenario, repository);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "complete") process.exitCode = 2;
}

void main().catch((error) => {
  if (process.env.PTB_NB_DEBUG === "1") {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  }
  const fallback = {
    schema: "pi-team-bright/nonblocking-accepted-launch-supervision-child/2",
    status: "error",
    scenario: (option("--scenario") as Scenario | undefined) ?? "unknown",
    error_kind: errorKind(error),
  };
  process.stdout.write(`${JSON.stringify(fallback)}\n`);
  process.exitCode = 1;
});
