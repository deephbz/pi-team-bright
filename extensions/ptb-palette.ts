import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, SettingsList, truncateToWidth, type SettingItem } from "@earendil-works/pi-tui";

/**
 * The palette presents choices only. The coordinator owns native prompts,
 * authority checks, configuration writes, and Team operations.
 */
export const PTB_PALETTE_TABS = ["Actions", "Models", "Team", "Workers"] as const;
export type PtbPaletteTab = (typeof PTB_PALETTE_TABS)[number];

export interface PtbPaletteItem {
  id: string;
  tab: PtbPaletteTab;
  label: string;
  description: string;
  currentValue?: string;
  values?: readonly string[];
  disabledReason?: string;
}

export interface PtbPaletteOptions {
  items: readonly PtbPaletteItem[];
  isCurrent: () => boolean;
  initialTab?: PtbPaletteTab;
  subtitle?: string;
  scope?: string;
}

export interface PtbPaletteSelection {
  id: string;
  tab: PtbPaletteTab;
  value?: string;
}

export interface PtbPaletteRenderHost {
  requestRender: (force?: boolean) => void;
  terminalRows?: () => number;
}

export function createPtbPaletteComponent(
  options: PtbPaletteOptions,
  host: PtbPaletteRenderHost,
  theme: Theme,
  done: (selection: PtbPaletteSelection | undefined) => void,
) {
  let activeTab: PtbPaletteTab = options.initialTab ?? "Actions";
  let closed = false;
  let settingsList: SettingsList;

  const finish = (selection?: PtbPaletteSelection) => {
    if (closed) return;
    closed = true;
    done(options.isCurrent() ? selection : undefined);
  };

  const createList = () => {
    const visible = options.items.filter((item) => item.tab === activeTab);
    const settings: SettingItem[] = visible.map((item) => ({
      id: item.id,
      label: item.label,
      description: item.disabledReason
        ? `${item.description} Unavailable: ${item.disabledReason}`
        : item.description,
      currentValue: item.disabledReason ? "Unavailable" : item.currentValue ?? "Open",
      values: item.disabledReason ? ["Unavailable"] : item.values?.length ? [...item.values] : ["Open"],
    }));
    return new SettingsList(
      settings,
      7,
      {
        label: (text, selected) => selected ? theme.fg("accent", text) : text,
        value: (text, selected) => theme.fg(selected ? "accent" : "muted", text),
        description: (text) => theme.fg("dim", text),
        cursor: theme.fg("accent", "→ "),
        hint: (text) => theme.fg("dim", text),
      },
      (id, value) => {
        const item = visible.find((candidate) => candidate.id === id);
        if (!item || item.disabledReason) return;
        finish({ id, tab: activeTab, ...(item.values?.length ? { value } : {}) });
      },
      () => finish(),
    );
  };

  const switchTab = (step: number) => {
    const currentIndex = PTB_PALETTE_TABS.indexOf(activeTab);
    activeTab = PTB_PALETTE_TABS[
      (currentIndex + step + PTB_PALETTE_TABS.length) % PTB_PALETTE_TABS.length
    ];
    settingsList = createList();
    host.requestRender(true);
  };

  settingsList = createList();

  return {
    render(width: number): string[] {
      const rule = theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
      const tabs = PTB_PALETTE_TABS.map((tab) =>
        tab === activeTab ? theme.fg("accent", theme.bold(tab)) : theme.fg("dim", tab),
      ).join(theme.fg("dim", "  /  "));
      const listLines = settingsList.render(width);
      if (listLines.at(-1)?.includes("Enter/Space")) listLines.pop();
      const fixedRows = 7 + Number(Boolean(options.subtitle)) + Number(Boolean(options.scope));
      const terminalRows = host.terminalRows?.() ?? 24;
      const bodyRows = Math.max(1, terminalRows - fixedRows);
      if (listLines.length > bodyRows) {
        listLines.length = bodyRows;
        listLines[bodyRows - 1] = theme.fg("dim", "  …");
      }
      return [
        rule,
        theme.fg("accent", theme.bold("  Pi Team Bright")),
        ...(options.subtitle ? [theme.fg("dim", `  ${options.subtitle}`)] : []),
        ...(options.scope ? [theme.fg("dim", `  ${options.scope}`)] : []),
        "",
        `  ${tabs}`,
        rule,
        ...listLines,
        theme.fg("dim", "  Tab/Shift+Tab sections · ↑/↓ rows · Enter/Space choose · Esc cancel"),
        rule,
      ].map((line) => truncateToWidth(line, Math.max(0, width), ""));
    },
    invalidate(): void {
      settingsList.invalidate();
    },
    handleInput(data: string): void {
      if (closed) return;
      if (!options.isCurrent() || matchesKey(data, Key.escape)) {
        finish();
        return;
      }
      if (matchesKey(data, Key.shift(Key.tab))) {
        switchTab(-1);
        return;
      }
      if (matchesKey(data, Key.tab)) {
        switchTab(1);
        return;
      }
      settingsList.handleInput(data);
      if (!closed) host.requestRender();
    },
    dispose(): void {
      closed = true;
    },
  };
}

export async function openPtbPalette(
  ctx: ExtensionContext,
  options: PtbPaletteOptions,
): Promise<PtbPaletteSelection | undefined> {
  if (ctx.mode !== "tui" || ctx.hasUI === false || !options.isCurrent()) return undefined;
  return ctx.ui.custom<PtbPaletteSelection | undefined>((tui, theme, _keybindings, done) =>
    createPtbPaletteComponent(options, {
      requestRender: (force) => tui.requestRender(force),
      terminalRows: () => tui.terminal.rows,
    }, theme, done),
  );
}
