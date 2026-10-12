import { EventEmitter } from "node:events";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index";
import type { RegisteredToolLike } from "../test/support/external-harness";
import { createSimSession } from "./session";
import { SimWorld } from "./world";

type Handler = (event: any, context: any) => unknown;

/** Fake Pi boundary around the real extension. No PTB authority or algorithm is replaced. */
export class SimActor {
  readonly tools = new Map<string, RegisteredToolLike>();
  readonly handlers = new Map<string, Handler[]>();
  readonly session;
  readonly context;
  readonly api: ExtensionAPI;
  readonly queuedMessages: Array<() => void> = [];
  idle = true;
  private activeTools: string[] = [];
  private callSequence = 0;
  private initialized = false;

  constructor(readonly world: SimWorld, readonly id: string, variables: Record<string, string> = {}) {
    const env = world.envs.get(id) ?? world.createActor(id, variables);
    this.session = createSimSession(env, world.workspace.home);
    const record = (kind: string, value?: unknown) => world.record(id, kind, value);
    this.context = {
      cwd: world.workspace.home, mode: "tui", hasUI: true,
      isIdle: () => this.idle, isProjectTrusted: () => true,
      sessionManager: this.session,
      shutdown: () => world.enqueue(id, "pi.shutdown.request", () => this.emit("session_shutdown", { reason: "quit" })),
      ui: {
        notify: (message: string, level: string) => record("ui.notify", { message, level }),
        setStatus() {}, setFooter() {}, setTitle() {}, setWidget() {},
      },
    };
    const events = new EventEmitter();
    this.api = {
      registerTool: (tool: RegisteredToolLike) => { this.tools.set(tool.name, tool); this.activeTools.push(tool.name); },
      on: (event: string, handler: Handler) => {
        this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
        return () => this.handlers.set(event, (this.handlers.get(event) ?? []).filter(item => item !== handler));
      },
      registerCommand() {}, registerMessageRenderer() {},
      getActiveTools: () => [...this.activeTools],
      getAllTools: () => [...this.tools.values()].map(tool => ({ name: tool.name })),
      setActiveTools: (names: string[]) => { this.activeTools = [...names]; },
      setSessionName: (name: string) => this.session.appendSessionInfo(name),
      appendEntry: (type: string, data: unknown) => this.session.appendCustomEntry(type, data),
      sendMessage: (message: any, options?: { deliverAs?: string; triggerTurn?: boolean }) => {
        const append = () => {
          this.session.appendCustomMessageEntry(message.customType, message.content, message.display ?? false, message.details);
          record("pi.message", { message, options });
        };
        // A4: follow-ups wait for the active model turn. The probe lane owns validation.
        if (!this.idle && options?.deliverAs === "followUp") this.queuedMessages.push(append);
        else append();
      },
      sendUserMessage: (content: string) => record("pi.userMessage", content),
      events: { on: events.on.bind(events), off: events.off.bind(events), emit: events.emit.bind(events) },
    } as unknown as ExtensionAPI;
  }

  initialize(): void {
    if (this.initialized) throw new Error(`Extension already initialized: ${this.id}`);
    this.world.enter(this.id, () => extension(this.api));
    this.initialized = true;
  }
  async emit(event: string, payload: unknown = {}): Promise<unknown[]> {
    return this.world.enter(this.id, async () => {
      const results: unknown[] = [];
      for (const handler of [...(this.handlers.get(event) ?? [])]) results.push(await handler(payload, this.context));
      return results;
    });
  }
  async tool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unregistered tool ${name} on ${this.id}`);
    this.idle = false;
    const callId = `${this.id}-call-${++this.callSequence}`;
    await this.emit("tool_call", { toolName: name, toolCallId: callId, input: args });
    const result = await this.world.enter(this.id, () => tool.execute(callId, args, new AbortController().signal, undefined, this.context));
    this.session.appendMessage({ role: "toolResult", toolCallId: callId, toolName: name, content: result.content ?? [], details: result.details, isError: result.isError ?? false, timestamp: this.world.scheduler.now } as any);
    this.world.record(this.id, "tool.result", { name, result });
    await this.emit("tool_result", { toolName: name, toolCallId: callId, input: args, ...result });
    return result;
  }
  async settle(): Promise<void> {
    this.idle = true;
    for (const append of this.queuedMessages.splice(0)) this.world.enqueue(this.id, "pi.followUp", append);
    await this.emit("agent_settled");
  }
}
