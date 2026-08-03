# Tool-contract design dogfood observation

Date: 2026-08-02T09:11:26Z

Status: historical observation from the annotation-review Team. This is not an
accepted API decision.

While revising the model-invoked tool contract, the lead used the current Pi
Team Bright surface to wait for one remaining systems-observer Task.

The first `team_sync` supplied event cursor `9`, one `task_id`, Task-only event
selection, and a 300-second wait. New owner input interrupted the tool. Pi Team
Bright returned `Team event wait aborted` as an error. The lead then had to
repeat the same call with cursor `9`. The second call returned the Task-close
event at cursor `10`.

This small use reproduced three audit findings in the design workflow itself:

- owner steering is normal control flow but appears as a tool error;
- the model must preserve and repeat a low-level cursor after interruption; and
- the Task/event filters added no product value because a whole-Team wait would
  have returned the same relevant close event.

The observation supports the ideal direction in
[`docs/projects/model-invoked-tool-contract.md`](../projects/model-invoked-tool-contract.md):
keep any observation watermark in branch-safe completed-result evidence, return
no semantic Team observation on cancellation, and let the leader observe the
Team as a whole.

It does not prove that hidden watermark reconstruction or complete-or-none
observation is safe. Those claims still require provider, crash, resume, branch,
fork, authority-failure, and result-size tests.
