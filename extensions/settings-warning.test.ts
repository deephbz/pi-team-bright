import { describe, expect, it, vi } from "vitest";
import { createSettingsWarningPresenter } from "./settings-warning";
import type { ModelRoleDiagnostic } from "../src/utils/model-role-settings";

const issue: ModelRoleDiagnostic = {
  source: "global", file: "/fixture/.pi/agent/settings.json",
  path: "pi_team_bright.model_roles.review.model", code: "invalid_value",
  message: "A qualified model reference is required.", consequence: "The role cannot be selected.",
};

describe("Pi Team Bright settings warning", () => {
  it("uses one native warning per settings state without emitting a model message", () => {
    let diagnostics = [issue];
    const presenter = createSettingsWarningPresenter({ read: () => diagnostics });
    const notify = vi.fn();
    const ctx = { cwd: "/project", hasUI: true, ui: { notify }, sendMessage: vi.fn(), appendEntry: vi.fn() };

    presenter.refresh(ctx, false, true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("1 issue"), "warning");
    expect(notify.mock.calls[0][0]).toContain("pi_team_bright.model_roles.review.model");
    expect(notify.mock.calls[0][0]).toContain("docs/examples/pi-team-bright.settings.json");
    presenter.refresh(ctx, false, true);
    expect(notify).toHaveBeenCalledTimes(1);
    diagnostics = [];
    presenter.refresh(ctx, false, true);
    expect(notify).toHaveBeenCalledTimes(1);
    diagnostics = [issue];
    presenter.refresh(ctx, false, true);
    expect(notify).toHaveBeenCalledTimes(2);
    presenter.clear(ctx);
    presenter.refresh(ctx, false, true);
    expect(notify).toHaveBeenCalledTimes(3);
    expect(ctx.sendMessage).not.toHaveBeenCalled();
    expect(ctx.appendEntry).not.toHaveBeenCalled();
  });

  it("shows explicit diagnostics as a warning and a clean check as information", () => {
    let diagnostics = [issue];
    const notify = vi.fn();
    const presenter = createSettingsWarningPresenter({ read: () => diagnostics });
    const ctx = { cwd: "/project", hasUI: true, ui: { notify }, sendMessage: vi.fn(), appendEntry: vi.fn() };
    presenter.showAll(ctx, false);
    presenter.showAll(ctx, false);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenNthCalledWith(1, expect.stringContaining("1 issue"), "warning");
    expect(notify).toHaveBeenNthCalledWith(2, expect.stringContaining("1 issue"), "warning");
    diagnostics = [];
    presenter.showAll(ctx, false);
    expect(notify).toHaveBeenLastCalledWith("Pi Team Bright settings: no issues.", "info");
    expect(ctx.sendMessage).not.toHaveBeenCalled();
    expect(ctx.appendEntry).not.toHaveBeenCalled();
  });

  it("bounds and deduplicates headless stderr while keeping stdout untouched", () => {
    const writeStderr = vi.fn();
    const many = Array.from({ length: 40 }, (_, index) => ({
      ...issue, path: `pi_team_bright.model_roles.role_${index}`,
      message: "x".repeat(400),
    }));
    let diagnostics = many;
    const presenter = createSettingsWarningPresenter({ read: () => diagnostics, writeStderr });
    const ctx = { cwd: "/project", hasUI: false };
    presenter.refresh(ctx, false, true);
    presenter.refresh(ctx, false, true);
    expect(writeStderr).toHaveBeenCalledTimes(1);
    expect(writeStderr.mock.calls[0][0].length).toBeLessThanOrEqual(1601);
    expect(writeStderr.mock.calls[0][0]).toContain("40 issues");
    expect(writeStderr.mock.calls[0][0]).toContain("/pi-team-bright-settings");
    presenter.clear(ctx);
    presenter.refresh(ctx, false, true);
    expect(writeStderr).toHaveBeenCalledTimes(1);
    diagnostics = [];
    presenter.refresh(ctx, false, true);
    diagnostics = many;
    presenter.refresh(ctx, false, true);
    expect(writeStderr).toHaveBeenCalledTimes(2);
  });

  it("cannot abort startup when diagnostics or UI presentation fail", () => {
    const writeStderr = vi.fn();
    const presenter = createSettingsWarningPresenter({
      read: () => { throw new Error("private settings content"); },
      writeStderr,
    });
    const ctx = { cwd: "/project", hasUI: true, ui: { notify: () => { throw new Error("UI failed"); } } };
    expect(() => presenter.refresh(ctx, false, true)).not.toThrow();
    expect(writeStderr).toHaveBeenCalledTimes(1);
    expect(writeStderr.mock.calls[0][0]).not.toContain("private settings content");
  });
});
