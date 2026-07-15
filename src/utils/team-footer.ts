import {
  FooterComponent,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Member } from "./models";
import { assertCurrentSessionBinding } from "./teams";

export const TEAM_FOOTER_STATUS_KEYS = ["00-pi-teams", "pi-teams"] as const;

export interface TeamFooterCandidate {
  teamName?: string | null;
  role?: string;
  membershipId?: string;
}

export interface TeamFooterBinding {
  teamName: string;
  role: string;
  membershipId: string;
  sessionFile: string;
}

type FooterContext = Pick<
  ExtensionContext,
  "mode" | "ui" | "sessionManager" | "modelRegistry" | "getContextUsage"
>;
type FooterFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;

function sameMembership(candidate: TeamFooterCandidate, member: Member): member is Member & { membershipId: string } {
  return !!candidate.membershipId && member.membershipId === candidate.membershipId;
}

/**
 * Resolve display identity from the same exact Session/Membership authority as
 * team-scoped mutations. Environment variables and process state are never
 * enough to produce a label.
 */
export async function resolveTeamFooterBinding(
  ctx: FooterContext,
  candidate: TeamFooterCandidate,
): Promise<TeamFooterBinding | undefined> {
  const { teamName, role } = candidate;
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!teamName || !role || !candidate.membershipId || !sessionFile) return undefined;

  try {
    const member = await assertCurrentSessionBinding(teamName, role, sessionFile);
    if (!sameMembership(candidate, member)) return undefined;
    return { teamName, role, membershipId: member.membershipId, sessionFile };
  } catch {
    // This is a projection only. Stale/forked/unbound Sessions display no Team
    // identity; the authoritative operation still surfaces its own error.
    return undefined;
  }
}

function labelText(binding: TeamFooterBinding): string {
  return `[${binding.teamName} · ${binding.role}] `;
}

/**
 * Pi exposes one whole-footer replacement seam, not a decorator seam. Reuse
 * its public FooterComponent and provide only the AgentSession fields that the
 * exported component consumes, then modify the first rendered line.
 */
export function teamFooterFactory(
  pi: Pick<ExtensionAPI, "getThinkingLevel">,
  ctx: FooterContext,
  binding: TeamFooterBinding,
  getModel: () => ExtensionContext["model"],
): FooterFactory {
  return (tui, theme, footerData) => {
    const sessionView = {
      get state() {
        return { model: getModel(), thinkingLevel: pi.getThinkingLevel() };
      },
      sessionManager: ctx.sessionManager,
      modelRegistry: ctx.modelRegistry,
      getContextUsage: () => ctx.getContextUsage(),
    };
    const base = new FooterComponent(sessionView as never, footerData);
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
    const plainLabel = labelText(binding);

    return {
      invalidate() {
        base.invalidate();
      },
      dispose() {
        unsubscribe();
        base.dispose();
      },
      render(width: number): string[] {
        const lines = base.render(width);
        if (lines.length === 0 || width <= 0) return lines;
        const prefix = theme.fg("accent", plainLabel);
        lines[0] = truncateToWidth(prefix + lines[0], width, theme.fg("dim", "..."));
        return lines;
      },
    };
  };
}

/** Restore Pi's footer, then install the Team prefix only for an exact binding. */
export async function syncTeamFooter(
  pi: Pick<ExtensionAPI, "getThinkingLevel">,
  ctx: FooterContext,
  candidate: TeamFooterCandidate,
  getModel: () => ExtensionContext["model"],
): Promise<TeamFooterBinding | undefined> {
  const ui = ctx.ui as Partial<FooterContext["ui"]>;
  for (const key of TEAM_FOOTER_STATUS_KEYS) ui.setStatus?.(key, undefined);
  ui.setFooter?.(undefined);
  if (ctx.mode !== "tui") return undefined;

  const binding = await resolveTeamFooterBinding(ctx, candidate);
  if (!binding || !ui.setFooter) return undefined;
  ui.setFooter(teamFooterFactory(pi, ctx, binding, getModel));
  return binding;
}

export function clearTeamFooter(ctx: Pick<FooterContext, "ui">): void {
  const ui = ctx.ui as Partial<FooterContext["ui"]>;
  for (const key of TEAM_FOOTER_STATUS_KEYS) ui.setStatus?.(key, undefined);
  ui.setFooter?.(undefined);
}
