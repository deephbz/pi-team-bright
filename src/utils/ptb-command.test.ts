import { describe, expect, it } from "vitest";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { getPtbArgumentCompletions, parsePtbCommand, PTB_COMMAND_USAGE } from "./ptb-command";

describe("/ptb command grammar", () => {
  it("resolves bounded operator requests and rejects extra or unsafe input", () => {
    expect(parsePtbCommand("")).toEqual({ kind: "palette" });
    expect(parsePtbCommand("help")).toEqual({ kind: "help" });
    expect(parsePtbCommand("status")).toEqual({ kind: "status" });
    expect(parsePtbCommand("sync")).toEqual({ kind: "sync" });
    expect(parsePtbCommand("graph all")).toEqual({ kind: "graph", limit: "all" });
    expect(parsePtbCommand("doctor team_1")).toEqual({ kind: "doctor", teamName: "team_1" });
    expect(parsePtbCommand("settings project")).toEqual({ kind: "settings", scope: "project" });
    expect(parsePtbCommand("settings check")).toEqual({ kind: "settings_check" });
    for (const input of ["graph 999", "graph ../escape", "doctor ../escape", "doctor team more", "settings local", "settings project more", "status now", "unknown", "doctor $SECRET"]) {
      expect(parsePtbCommand(input), input).toEqual({ kind: "invalid" });
    }
    expect(PTB_COMMAND_USAGE).toContain("/ptb settings check");
    expect(PTB_COMMAND_USAGE).toContain("/ptb doctor [team-name]");
  });

  it("offers only finite command tokens and stops before free-form Team names", () => {
    expect(getPtbArgumentCompletions("do")?.map((item) => item.value)).toEqual(["doctor"]);
    expect(getPtbArgumentCompletions("graph ")?.map((item) => item.value)).toEqual(["graph 25", "graph 50", "graph 100", "graph 200", "graph all"]);
    expect(getPtbArgumentCompletions("settings ")?.map((item) => item.value)).toEqual(["settings global", "settings project", "settings check"]);
    expect(getPtbArgumentCompletions("doctor ")).toBeNull();
    expect(getPtbArgumentCompletions("doctor private-team")).toBeNull();
    expect(getPtbArgumentCompletions("settings project more")).toBeNull();
    expect(getPtbArgumentCompletions("graph 20")?.map((item) => item.value)).toEqual(["graph 200"]);
    expect(getPtbArgumentCompletions("nothing")).toBeNull();
  });

  it("completes nested arguments through Pi's actual replacement semantics", async () => {
    const provider = new CombinedAutocompleteProvider([
      { name: "ptb", getArgumentCompletions: getPtbArgumentCompletions },
    ], process.cwd());
    for (const [input, expected] of [["/ptb graph 2", "/ptb graph 25"], ["/ptb settings pro", "/ptb settings project"]] as const) {
      const result = await provider.getSuggestions([input], 0, input.length, { signal: new AbortController().signal });
      expect(result).not.toBeNull();
      const item = result!.items.find((candidate) => candidate.value === expected.slice("/ptb ".length));
      expect(item, input).toBeDefined();
      expect(provider.applyCompletion([input], 0, input.length, item!, result!.prefix).lines).toEqual([expected]);
    }
    expect(await provider.getSuggestions(["/ptb doctor private"], 0, 19, { signal: new AbortController().signal })).toBeNull();
  });
});
