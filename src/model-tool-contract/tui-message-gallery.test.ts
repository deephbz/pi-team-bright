import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import { visibleWidth } from "@earendil-works/pi-tui";
import piTeamBright from "../../extensions/index";
import { ModelResultSchemas } from "./result-projection";
import {
  DISPLAYED_TOOL_TYPES,
  exportTuiMessageGallery,
  modelResultKinds,
  tuiMessageGallery,
} from "./tui-message-gallery";
import { projectionAnsi, projectionLines } from "./tui-message-projection";
import {
  createToolCallRenderer,
  createToolResultRenderer,
  projectToolTuiMessage,
} from "./tui-projection";
import {
  createCustomMessageRenderer,
  projectTaskChangeMessage,
} from "./custom-message-projection";
import {
  LEGACY_TASK_CHANGE_ACK_ENTRY_TYPE,
  LEGACY_TASK_CHANGE_CUSTOM_TYPE,
  TASK_CHANGE_CUSTOM_TYPE,
  acknowledgedTaskDeliveryIdsFromEntries,
  formatTaskChangeBatch,
  presentedTaskDeliveryIdsFromEntries,
} from "../utils/task-delivery";
import { SYNC_NUDGE_CUSTOM_TYPE } from "../utils/sync-nudge";
import {
  DIRECT_MESSAGE_CUSTOM_TYPE,
  LEGACY_DIRECT_MESSAGE_ACK_ENTRY_TYPE,
  LEGACY_DIRECT_MESSAGE_CUSTOM_TYPE,
  acknowledgedMessageIdsFromEntries,
  formatDirectMessageBatch,
  pendingPresentedMessageIdsFromEntries,
} from "../alert-authority/direct-delivery";

const theme = {
  fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
  bold: (text: string) => `<bold>${text}</bold>`,
} as any;

function parseExpandedDetail(lines: string[]): unknown {
  const marker = lines.indexOf("details:");
  expect(marker).toBeGreaterThan(0);
  return JSON.parse(lines.slice(marker + 1).join("\n"));
}

describe("TUI message gallery", () => {
  it("covers every displayed tool and every allowed top-level model-result kind", () => {
    const scenarios = tuiMessageGallery();
    const toolScenarios = scenarios.filter((scenario) => scenario.source === "tool");
    expect(new Set(toolScenarios.map((scenario) => scenario.message.type))).toEqual(new Set(DISPLAYED_TOOL_TYPES));

    for (const tool of DISPLAYED_TOOL_TYPES) {
      const expected = modelResultKinds(ModelResultSchemas[tool]);
      const actual = new Set(toolScenarios
        .filter((scenario) => scenario.message.type === tool)
        .map((scenario) => scenario.resultKind));
      expect([...actual].sort(), tool).toEqual([...expected].sort());
      for (const scenario of toolScenarios.filter((item) => item.message.type === tool)) {
        expect(Check(ModelResultSchemas[tool], scenario.message.detail), scenario.id).toBe(true);
      }
    }
  });

  it("renders one canonical header, concise collapsed text, and parseable expanded JSON", () => {
    for (const scenario of tuiMessageGallery()) {
      const collapsed = projectionLines(scenario.message, { expanded: false });
      const expanded = projectionLines(scenario.message, { expanded: true });
      expect(collapsed[0], scenario.id).toMatch(/^\[pi-team-bright\.[a-z0-9_-]+\]$/);
      expect(collapsed.filter((line) => /^\[pi-team-bright\./.test(line)), scenario.id).toHaveLength(1);
      expect(collapsed, scenario.id).not.toContain("details:");
      expect(parseExpandedDetail(expanded), scenario.id).toEqual(scenario.message.detail ?? null);
      expect([...collapsed, ...expanded].join("\n"), scenario.id).not.toMatch(/\[PiTeams|\[pi-teams\./);
      expect(projectionAnsi(scenario.message, { expanded: false })[0], scenario.id).toContain("\u001b[1m");
    }
    const sync = tuiMessageGallery().find((scenario) => scenario.id === "custom.sync-nudge")!;
    expect(projectionLines(sync.message, { expanded: false }).join("\n")).toContain("Team state needs reconciliation");
    expect(projectionLines(sync.message, { expanded: false }).join("\n")).not.toContain("Sync nudge presented");
  });

  it("bounds every plain and ANSI gallery line at the requested width", () => {
    for (const scenario of tuiMessageGallery()) {
      for (const line of projectionLines(scenario.message, { expanded: true, width: 72 })) {
        expect(visibleWidth(line), scenario.id).toBeLessThanOrEqual(72);
      }
      for (const line of projectionAnsi(scenario.message, { expanded: true, width: 72 })) {
        expect(visibleWidth(line), scenario.id).toBeLessThanOrEqual(72);
      }
    }
  });

  it("exports deterministic plain, ANSI, and structured review artifacts", () => {
    const plain = exportTuiMessageGallery({ format: "plain", expanded: false, width: 100 });
    const ansi = exportTuiMessageGallery({ format: "ansi", expanded: false, width: 100 });
    const structured = JSON.parse(exportTuiMessageGallery({ format: "json", expanded: true, width: 100 }));
    expect(plain).toContain("=== custom.task-change");
    expect(plain).not.toContain("details:");
    expect(ansi).toContain("\u001b[1m");
    expect(structured.schema).toBe("pi-team-bright/tui-message-gallery/1");
    expect(structured.style.header).toEqual({ bold: true, role: "customMessageLabel" });
    expect(structured.scenarios).toHaveLength(tuiMessageGallery().length);
  });

  it("uses the same production theme adapters for tool and custom messages", () => {
    const raw = { kind: "team_created", team: { name: "review", purpose: "Review.", lifecycle: "active" } };
    const call = createToolCallRenderer("team_create")({} as any, theme, {} as any).render(200).join("\n");
    const result = createToolResultRenderer("team_create")(
      { content: [{ type: "text", text: "{}" }], details: raw },
      { expanded: true, isPartial: false },
      theme,
      {} as any,
    ).render(200).join("\n");
    expect(call).toContain("<bold><customMessageLabel>[pi-team-bright.team_create]");
    expect(result).not.toContain("[pi-team-bright.team_create]");
    expect(result).toContain('"purpose": "Review."');

    const custom = createCustomMessageRenderer(projectTaskChangeMessage)({
      content: `Delivered.\n${JSON.stringify({ changes: [] })}`,
      details: {},
    }, { expanded: true }, theme)!.render(200).join("\n");
    expect(custom).toContain("<bold><customMessageLabel>[pi-team-bright.task-change]");
    expect(custom).toContain('"changes"');
  });

  it("keeps raw semantic JSON in detail mode instead of the lossy model projection", () => {
    const raw = { kind: "team_created", team: { name: "review", purpose: "Raw purpose", lifecycle: "active" } };
    const projection = projectToolTuiMessage({ tool: "team_create", details: raw, expanded: true });
    expect(parseExpandedDetail(projectionLines(projection, { expanded: true }))).toEqual(raw);
  });

  it("registers all tool headers plus current and historical custom identities", () => {
    const renderers = new Map<string, (...args: any[]) => any>();
    const tools = new Map<string, any>();
    piTeamBright({
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerMessageRenderer(type: string, renderer: (...args: any[]) => any) { renderers.set(type, renderer); },
      on() {},
      sendMessage() {},
      appendEntry() {},
      sendUserMessage() {},
    } as any);
    expect([...tools.keys()].sort()).toEqual([...DISPLAYED_TOOL_TYPES].sort());
    for (const [name, tool] of tools) expect(tool.renderCall, name).toBeTypeOf("function");
    expect([...renderers.keys()].sort()).toEqual([
      DIRECT_MESSAGE_CUSTOM_TYPE,
      LEGACY_DIRECT_MESSAGE_CUSTOM_TYPE,
      LEGACY_TASK_CHANGE_CUSTOM_TYPE,
      SYNC_NUDGE_CUSTOM_TYPE,
      TASK_CHANGE_CUSTOM_TYPE,
    ].sort());
  });
});

describe("custom-message namespace compatibility", () => {
  const taskDetails = {
    authority: "pi-teams-task-delivery",
    schemaVersion: 1,
    teamName: "review",
    recipient: "worker",
    recipientMembershipId: "membership-1",
    targetAgentRef: { kind: "session-trace", nativeId: "session-1" },
    deliveryIds: ["delivery-1"],
    changes: [{ ref: { kind: "task", taskId: "task-1", version: "v_0123456789abcdef" }, changeKind: "assigned" }],
  } as any;
  const messageDetails = {
    authority: "pi-teams-message",
    schemaVersion: 2,
    teamName: "review",
    recipient: "worker",
    recipientMembershipId: "membership-1",
    recipientSessionFile: "/tmp/session.jsonl",
    messageIds: ["message-1"],
  } as any;

  it("writes only pi-team-bright display identities and removes content headings", () => {
    expect(TASK_CHANGE_CUSTOM_TYPE).toBe("pi-team-bright.task-change");
    expect(DIRECT_MESSAGE_CUSTOM_TYPE).toBe("pi-team-bright.direct-message");
    expect(formatTaskChangeBatch([{ taskProjection: { id: "task-1" } } as any])).not.toContain("[PiTeams");
    expect(formatDirectMessageBatch([{ id: "message-1", from: "lead", timestamp: "now", summary: "Check", text: "Check it" } as any])).not.toContain("[PiTeams");
  });

  it("recognizes historical displayed and acknowledgement identities read-only", () => {
    const taskEntries = [
      { type: "custom_message", customType: LEGACY_TASK_CHANGE_CUSTOM_TYPE, details: taskDetails },
      { type: "custom", customType: LEGACY_TASK_CHANGE_ACK_ENTRY_TYPE, data: taskDetails },
    ] as any;
    expect(presentedTaskDeliveryIdsFromEntries([taskEntries[0]], "review", "worker", "membership-1")).toEqual(new Set(["delivery-1"]));
    expect(acknowledgedTaskDeliveryIdsFromEntries(taskEntries, "review", "worker", "membership-1")).toEqual(new Set(["delivery-1"]));

    const messageEntries = [
      { type: "custom_message", customType: LEGACY_DIRECT_MESSAGE_CUSTOM_TYPE, details: messageDetails },
      { type: "custom", customType: LEGACY_DIRECT_MESSAGE_ACK_ENTRY_TYPE, data: messageDetails },
    ] as any;
    expect(pendingPresentedMessageIdsFromEntries([messageEntries[0]], "review", "worker", "membership-1", "/tmp/session.jsonl")).toEqual(new Set(["message-1"]));
    expect(acknowledgedMessageIdsFromEntries(messageEntries, "review", "worker", "membership-1", "/tmp/session.jsonl")).toEqual(new Set(["message-1"]));
  });
});
