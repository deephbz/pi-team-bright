import { describe, expect, it } from "vitest";
import { projectDirectMessage } from "./custom-message-projection";
import { projectModelToolTuiMessage, projectToolTuiMessage } from "./tui-projection";
import { projectionLines, renderProjectionWithTheme } from "./tui-message-projection";

const theme = {
  fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
  bg: (_role: string, text: string) => text,
  bold: (text: string) => `<bold>${text}</bold>`,
} as any;

describe("shared PTB transcript presentation", () => {
  it("styles status by meaning when a source appears in the header", () => {
    const message = { ...projectModelToolTuiMessage("team_sync", {
      kind: "snapshot_required", reason: "observation_not_advanced", message: "Take a Team snapshot.",
      recovery: { action: "request_snapshot" },
    }), source: "Automatic" };
    const rendered = renderProjectionWithTheme(message, { expanded: false }, theme).render(200).join("\n");
    expect(rendered).toContain("PTB · Team sync · Automatic");
    expect(rendered).toContain("<warning>! Snapshot required</warning>");
    expect(rendered).toContain("Next: request a Team snapshot before continuing.");
  });

  it("shows full Alert text before diagnostic JSON when expanded", () => {
    const message = projectDirectMessage({ content: `Delivered.\n${JSON.stringify({ messages: [{ from: "team-lead", summary: "Check digest", content: "Compare package digest with release receipt." }] })}` });
    const collapsed = projectionLines(message, { expanded: false });
    const expanded = projectionLines(message, { expanded: true });
    expect(collapsed).toEqual(["PTB · Alert · From team-lead", "• Alert received", "Check digest", "▸ Details"]);
    expect(expanded.indexOf("Full Alert content:")).toBeLessThan(expanded.indexOf("details:"));
    expect(expanded.join("\n")).toContain("Compare package digest with release receipt.");
  });

  it("keeps malformed historical delivery inspectable without throwing", () => {
    const message = projectDirectMessage({ content: "old prose without JSON", details: { messageIds: ["old"] } });
    expect(projectionLines(message, { expanded: false }).join("\n")).toContain("Alert presentation payload is malformed.");
    expect(projectionLines(message, { expanded: true }).join("\n")).toContain('"old"');
  });

  it("does not execute terminal controls from an Alert sender or body", () => {
    const message = projectDirectMessage({ content: `Delivered.\n${JSON.stringify({ messages: [{ from: "\u001b[31mlead", summary: "\u001b]0;spoof\u0007Check", content: "Continue." }] })}` });
    const lines = projectionLines(message, { expanded: false });
    expect(lines.join("\n")).toContain("From lead");
    expect(lines.join("\n")).toContain("Check");
    expect(lines.join("\n")).not.toContain("\u001b");
  });

  it("does not classify an incomplete tool stream as a malformed result", () => {
    const message = projectToolTuiMessage({ tool: "team_sync", content: [{ type: "text", text: "{" }], details: {}, expanded: false, isPartial: true });
    const lines = projectionLines(message, { expanded: false });
    expect(lines).toContain("• In progress");
    expect(lines.join("\n")).not.toContain("projection error");
  });

  it("reads historical headings that begin with a JSON array marker", () => {
    const message = projectDirectMessage({ content: `[PiTeams direct-message]\n${JSON.stringify({ messages: [{ from: "lead", summary: "Review now", content: "Full instructions." }] })}` });
    expect(projectionLines(message, { expanded: false }).join("\n")).toContain("Review now");
  });

  it("shows full Task context before raw JSON in expanded tool results", () => {
    const message = projectModelToolTuiMessage("task_read", { kind: "found", task: {
      id: "t-1", title: "Check release", status: "in_progress", assignee: "worker", goal: "Verify package digest.",
      current_context: "Compare the exact archive and receipt digests.", version: "v_0123456789abcdef",
    } });
    const lines = projectionLines(message, { expanded: true });
    expect(lines.indexOf("Goal: Verify package digest.")).toBeLessThan(lines.indexOf("details:"));
    expect(lines.indexOf("Context: Compare the exact archive and receipt digests.")).toBeLessThan(lines.indexOf("details:"));
  });
});
