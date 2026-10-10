import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Inline hc-hud/1 identity contract. PTB has no dependency on the composer package. */
export const HUD_SLOT_CHANNEL = "hc.hud.slot";
export const HUD_COMPOSER_CHANNEL = "hc.hud.composer";
export interface TeamHudIdentity {
  kind: "identity";
  team: string;
  role: string;
  membershipId: string;
}
export interface TeamHudSlot {
  v: 1;
  key: "team.member";
  producer: "pi-team-bright";
  asOf: number;
  value: TeamHudIdentity | null;
}

type HudApi = Partial<Pick<ExtensionAPI, "events">>;

/** The caller supplies only exact bindings. This publisher owns no Team state. */
export class TeamHudPublisher {
  private value: TeamHudIdentity | null = null;
  private present = false;
  private asOf = Date.now();

  constructor(private readonly pi: HudApi, onPresence: (present: boolean) => void) {
    pi.events?.on(HUD_COMPOSER_CHANNEL, (payload: unknown) => {
      if (!payload || typeof payload !== "object") return;
      const signal = payload as { v?: unknown; present?: unknown; surface?: unknown };
      if (signal.v !== 1 || signal.surface !== "tui-footer" || typeof signal.present !== "boolean") return;
      this.present = signal.present;
      onPresence(this.present);
    });
  }

  get composerPresent(): boolean { return this.present; }

  update(value: TeamHudIdentity | null): void {
    this.value = value;
    this.asOf = Date.now();
    this.publish();
  }

  private publish(): void {
    const slot: TeamHudSlot = { v: 1, key: "team.member", producer: "pi-team-bright", asOf: this.asOf, value: this.value };
    this.pi.events?.emit(HUD_SLOT_CHANNEL, slot);
  }
}
