/** One command grammar supplies direct routing, help, and completions. */
export const PTB_GRAPH_LIMITS = ["25", "50", "100", "200", "all"] as const;
export const PTB_SETTINGS_SCOPES = ["global", "project"] as const;

export type PtbGraphLimit = typeof PTB_GRAPH_LIMITS[number];
export type PtbSettingsScope = typeof PTB_SETTINGS_SCOPES[number];

export type PtbCommand =
  | { kind: "palette" }
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "sync" }
  | { kind: "graph"; limit?: PtbGraphLimit }
  | { kind: "doctor"; teamName?: string }
  | { kind: "settings"; scope?: PtbSettingsScope }
  | { kind: "settings_check" }
  | { kind: "invalid" };

export type PtbAction = Exclude<PtbCommand, { kind: "palette" | "invalid" }>;

export const PTB_COMMANDS = [
  { kind: "help", command: "help", argument: "", description: "Show command help" },
  { kind: "status", command: "status", argument: "", description: "Diagnose the current Team and Task authority" },
  { kind: "sync", command: "sync", argument: "", description: "Read current Team updates once" },
  { kind: "graph", command: "graph", argument: " [25|50|100|200|all]", description: "Toggle the Task graph pane" },
  { kind: "doctor", command: "doctor", argument: " [team-name]", description: "Send the Team doctor guide and sampled metadata" },
  { kind: "settings", command: "settings", argument: " [global|project]", description: "Review and edit Pi Team Bright settings" },
  { kind: "settings_check", command: "settings check", argument: "", description: "Check settings diagnostics" },
] as const;

export const PTB_COMMAND_USAGE = [
  "Usage: /ptb [command]. Bare /ptb opens the command palette in a TUI; otherwise it shows help.",
  ...PTB_COMMANDS.map(({ command, argument, description }) => `  /ptb ${command}${argument} — ${description}`),
].join("\n");

const teamNamePattern = /^[A-Za-z0-9_-]{1,64}$/;

export function parsePtbCommand(args = ""): PtbCommand {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { kind: "palette" };
  const [name, value] = tokens;
  const specification = PTB_COMMANDS.find((command) => command.command === name);
  if (!specification || tokens.length > 2) return { kind: "invalid" };
  switch (specification.kind) {
    case "help": case "status": case "sync":
      return tokens.length === 1 ? { kind: specification.kind } : { kind: "invalid" };
    case "graph":
      if (tokens.length === 1) return { kind: "graph" };
      if (PTB_GRAPH_LIMITS.some((limit) => limit === value)) return { kind: "graph", limit: value as PtbGraphLimit };
      break;
    case "doctor":
      if (tokens.length === 1) return { kind: "doctor" };
      if (teamNamePattern.test(value)) return { kind: "doctor", teamName: value };
      break;
    case "settings":
      if (tokens.length === 1) return { kind: "settings" };
      if (value === "check") return { kind: "settings_check" };
      if (PTB_SETTINGS_SCOPES.some((scope) => scope === value)) return { kind: "settings", scope: value as PtbSettingsScope };
      break;
  }
  return { kind: "invalid" };
}

export function getPtbArgumentCompletions(prefix: string) {
  const input = String(prefix ?? "").trimStart();
  const space = input.indexOf(" ");
  if (space < 0) {
    const matches = PTB_COMMANDS.filter(({ command }) => !command.includes(" ") && command.startsWith(input));
    return matches.length ? matches.map(({ command, description }) => ({ value: command, label: command, description })) : null;
  }
  const command = input.slice(0, space);
  const argument = input.slice(space + 1);
  if (/\s/.test(argument)) return null;
  const values = command === "graph" ? PTB_GRAPH_LIMITS
    : command === "settings" ? [...PTB_SETTINGS_SCOPES, "check"]
      : [];
  const matches = values.filter((value) => value.startsWith(argument));
  return matches.length ? matches.map((value) => ({ value: `${command} ${value}`, label: value,
    description: command === "graph" ? value === "all" ? "Show all Tasks" : `Show at most ${value} recent Tasks`
      : value === "check" ? "Check settings diagnostics" : `Edit ${value} settings` })) : null;
}
