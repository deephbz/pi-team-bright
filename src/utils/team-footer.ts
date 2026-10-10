import {
  FooterComponent,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Member } from "../team-authority/contracts";
import { assertCurrentSessionBinding } from "./teams";
import { TeamHudPublisher } from "./team-hud";
import { teamSessionName } from "./team-labels";

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
    if (!sameMembership(candidate, member) || ctx.sessionManager.getSessionFile() !== sessionFile) return undefined;
    return { teamName, role, membershipId: member.membershipId, sessionFile };
  } catch {
    // This is a projection only. Stale/forked/unbound Sessions display no Team
    // identity; the authoritative operation still surfaces its own error.
    return undefined;
  }
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
      // FooterComponent moved subscription detection from the extension-facing
      // ModelRegistry to AgentSession.modelRuntime in Pi 0.80.8. Keep both
      // projections so the package remains compatible across the transition.
      modelRegistry: ctx.modelRegistry,
      modelRuntime: {
        isUsingOAuth: (_provider: string) => {
          const model = getModel();
          return model ? ctx.modelRegistry.isUsingOAuth(model) : false;
        },
        // Pi 0.84 asks the runtime for subscription-backed auth instead of
        // OAuth. Resolve both answers from the same ExtensionContext registry.
        isUsingSubscription: (provider: string) => {
          const model = getModel();
          if (!model || model.provider !== provider || !ctx.modelRegistry.isUsingOAuth(model)) return false;
          return (ctx.modelRegistry.getProvider(provider)?.auth.oauth as { isSubscription?: boolean } | undefined)?.isSubscription === true;
        },
      },
      getContextUsage: () => ctx.getContextUsage(),
    };
    const base = new FooterComponent(sessionView as never, footerData);
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

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
        const roleTone = binding.role === "team-lead" ? "accent" : "dim";
        const prefix = theme.fg(roleTone, `[${binding.role}] `);
        lines[0] = truncateToWidth(prefix + lines[0], width, theme.fg("dim", "..."));
        return lines;
      },
    };
  };
}

type TeamFooterApi = Pick<ExtensionAPI, "getThinkingLevel"> & Partial<Pick<ExtensionAPI, "events" | "setSessionName">>;
type FooterProjection = {
  hud: TeamHudPublisher;
  epoch: number;
  ctx?: FooterContext;
  binding?: TeamFooterBinding;
  getModel?: () => ExtensionContext["model"];
  wrapped: boolean;
};
const projections = new WeakMap<object, FooterProjection>();

function renderFallback(pi: TeamFooterApi, state: FooterProjection): void {
  const ui = state.ctx?.ui;
  if (!ui) return;
  if (state.hud.composerPresent) {
    // The composer announces itself before installing its footer.
    if (state.wrapped) ui.setFooter?.(undefined);
    state.wrapped = false;
    return;
  }
  if (state.ctx?.mode === "tui" && state.binding && state.getModel && ui.setFooter) {
    ui.setFooter(teamFooterFactory(pi, state.ctx, state.binding, state.getModel));
    state.wrapped = true;
  } else {
    ui.setFooter?.(undefined);
    state.wrapped = false;
  }
}

/** Subscribe before Session hooks so a composer-first load cannot lose presence. */
export function initializeTeamFooter(pi: TeamFooterApi): void {
  if (projections.has(pi)) return;
  const state = { epoch: 0, wrapped: false } as FooterProjection;
  state.hud = new TeamHudPublisher(pi, (present) => {
    renderFallback(pi, state);
    if (!present) return;
    const { ctx, binding, epoch } = state;
    if (!ctx || !binding) { state.hud.update(null); return; }
    void resolveTeamFooterBinding(ctx, binding).then((current) => {
      if (epoch !== state.epoch || state.binding !== binding || !state.hud.composerPresent) return;
      state.binding = current;
      state.hud.update(current ? { kind: "identity", team: current.teamName, role: current.role, membershipId: current.membershipId } : null);
    });
  });
  projections.set(pi, state);
}

/** Publish exact binding identity in every mode; the wrapper is TUI fallback only. */
export async function syncTeamFooter(
  pi: TeamFooterApi,
  ctx: FooterContext,
  candidate: TeamFooterCandidate,
  getModel: () => ExtensionContext["model"],
): Promise<TeamFooterBinding | undefined> {
  initializeTeamFooter(pi);
  const state = projections.get(pi)!;
  const epoch = ++state.epoch;
  state.ctx = ctx;
  state.binding = undefined;
  state.getModel = getModel;
  state.hud.update(null);
  renderFallback(pi, state);
  for (const key of TEAM_FOOTER_STATUS_KEYS) ctx.ui.setStatus?.(key, undefined);
  const binding = await resolveTeamFooterBinding(ctx, candidate);
  if (epoch !== state.epoch) return undefined;
  state.binding = binding;
  if (binding) {
    const workerName = teamSessionName(binding.teamName, binding.role);
    if (workerName !== undefined && ctx.sessionManager.getSessionName?.() !== workerName) {
      try { pi.setSessionName?.(workerName); }
      catch { console.warn("[pi-teams] Session label could not be set; exact binding is unchanged."); }
    }
    // Session naming emits hooks. A replaced generation cannot publish afterward.
    if (epoch !== state.epoch) return undefined;
    state.hud.update({ kind: "identity", team: binding.teamName, role: binding.role, membershipId: binding.membershipId });
  }
  renderFallback(pi, state);
  return binding;
}

export function clearTeamFooter(ctx: Pick<FooterContext, "ui">, pi?: TeamFooterApi): void {
  const ui = ctx.ui as Partial<FooterContext["ui"]>;
  for (const key of TEAM_FOOTER_STATUS_KEYS) ui.setStatus?.(key, undefined);
  const state = pi && projections.get(pi);
  if (!state) { ui.setFooter?.(undefined); return; }
  state.epoch++;
  state.binding = undefined;
  state.ctx = undefined;
  state.getModel = undefined;
  state.hud.update(null);
  if (!state.hud.composerPresent) ui.setFooter?.(undefined);
  state.wrapped = false;
}
