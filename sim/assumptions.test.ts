import { expect, it } from "vitest";
import A1 from "./fixtures/probes/A1.json";
import A6 from "./fixtures/probes/A6.json";
import { assumptionEvidence } from "./assumptions";
import { HerdrFake } from "./herdr";
import { ProcessTable } from "./process-table";

it("matches the recorded shell process-info wire and missing-pane error", () => {
  const fake = new HerdrFake(new ProcessTable());
  fake.spawn("shell-pane");
  const shell = JSON.parse(fake.run(["pane", "process-info", "--pane", "shell-pane"]).stdout).result;
  expect(shell.type).toBe(A1.observed.shell.type);
  expect(shell.process_info.foreground_processes[0].argv0).toBe(A1.observed.shell.process_info.foreground_processes[0]!.argv0);
  expect(shell.process_info.shell_pid).toBe(shell.process_info.foreground_process_group_id);
  const reply = fake.run(["agent", "start", "worker", "--pane", "absent"]);
  expect(reply.stdout).toBe("");
  const refused = JSON.parse(reply.stderr);
  expect(refused.error.code).toBe(A6.observed.error.response.error.code);
});

it("keeps absent and inconclusive probes advisory without downgrading the six passing probes", () => {
  for (const id of ["A1", "A2", "A3", "A4", "A5", "A6"] as const) {
    expect(assumptionEvidence(id, "recorded scope")).toMatchObject({ status: "probe-backed", fixture: `sim/fixtures/probes/${id}.json`, versions: { pi: "0.83.0" } });
  }
  expect(assumptionEvidence("A8", "partial agent list")).toMatchObject({ status: "advisory", reason: "inconclusive" });
  expect(assumptionEvidence("A7", "PID reuse").status).toBe("advisory");
  expect(assumptionEvidence("A9", "host crash").status).toBe("advisory");
  expect(assumptionEvidence("A6", "pane geometry", "No geometry probe").status).toBe("advisory");
});
