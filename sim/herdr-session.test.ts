import { expect, it } from "vitest";
import { HerdrFake } from "./herdr";
import { ProcessTable } from "./process-table";
import { herdrPiSessionPath } from "../src/adapters/herdr-session";
import probe from "./fixtures/probes/herdr-session.json";

// Recorded AgentSessionInfo shape; only the private Session path is replaced.
it("matches the recorded Herdr wire object in both the consumer and fake", () => {
  expect(herdrPiSessionPath(probe.agent_session)).toBe("/sessions/worker.jsonl");
  const fake = new HerdrFake(new ProcessTable());
  const pane = fake.spawn(); pane.sessionFile = "/sessions/worker.jsonl";
  fake.start(pane.id, "worker");
  const row = JSON.parse(fake.run(["agent", "list"]).stdout).result.agents[0];
  expect(row).toMatchObject(probe);
  expect(herdrPiSessionPath(row.agent_session)).toBe(pane.sessionFile);
});
it.each(["/sessions/worker.jsonl", null, { ...probe.agent_session, agent: "other" }, { ...probe.agent_session, kind: "id" }, { ...probe.agent_session, source: "untrusted" }])("rejects a malformed or foreign Session identity %j", value => {
  expect(herdrPiSessionPath(value)).toBeUndefined();
});
