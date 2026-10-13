import A1 from "./fixtures/probes/A1.json";
import A2 from "./fixtures/probes/A2.json";
import A3 from "./fixtures/probes/A3.json";
import A4 from "./fixtures/probes/A4.json";
import A5 from "./fixtures/probes/A5.json";
import A6 from "./fixtures/probes/A6.json";
import A7 from "./fixtures/probes/A7.json";
import A8 from "./fixtures/probes/A8.json";
import A9 from "./fixtures/probes/A9.json";

export type AssumptionId = "A1" | "A2" | "A3" | "A4" | "A5" | "A6" | "A7" | "A8" | "A9";
const probes = { A1, A2, A3, A4, A5, A6, A7, A8, A9 };
const versionKeys = ["pi", "herdr", "kernel"] as const;
export interface FakeEvidence {
  assumption: AssumptionId; behavior: string; status: "probe-backed" | "advisory";
  fixture?: string; versions?: { pi?: string; herdr?: string; kernel?: string }; reason?: string;
}

/** Evidence applies to the fixture's recorded versions and observed scope only. */
export function assumptionEvidence(assumption: AssumptionId, behavior: string, unprobedScope?: string): FakeEvidence {
  const fixture = probes[assumption as keyof typeof probes];
  const environment = fixture?.observed.environment as Record<string, string> | undefined;
  return {
    assumption, behavior,
    status: fixture?.verdict === "holds" && !unprobedScope ? "probe-backed" : "advisory",
    ...(fixture ? { fixture: `sim/fixtures/probes/${assumption}.json`, versions: Object.fromEntries(versionKeys.filter(key => environment?.[key]).map(key => [key, environment![key]])) } : {}),
    ...(unprobedScope ? { reason: unprobedScope } : !fixture || fixture.verdict !== "holds" ? { reason: fixture?.verdict ?? "no_probe" } : {}),
  };
}
