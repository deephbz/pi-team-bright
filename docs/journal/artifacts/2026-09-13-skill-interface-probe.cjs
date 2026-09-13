// Purpose: reproduce caller-visible graph distinctions for the skill review.
// Scope: disposable in-memory authority only; no Team, Worker, or store mutation.
// Run from the package root:
// node -r ts-node/register/transpile-only docs/journal/artifacts/2026-09-13-skill-interface-probe.cjs
const assert = require('node:assert/strict');
const { GraphTaskController } = require('../../../src/task-authority/graph-control');
const c = new GraphTaskController({default:'test/default',capable:'test/capable'});
const graph = [
 {key:'implement',title:'Implement',goal:'Pass the requested behavior check.',assignee:'builder'},
 {key:'review',title:'Review',goal:'Independently verify the behavior.',assignee:'reviewer',needs:['implement'],onGoalFailed:{target:'implement',maxTraversals:1}}
];
c.applyGraph({operationId:'initial',tasks:graph});
let n=0;
const transition=(id,transition,evidence)=>c.transition({taskId:id,operationId:`op-${++n}`,expectedVersion:c.readTask(id).version,transition,worker:c.readTask(id).assignee,...(evidence?{evidence}:{})});
transition('implement','claim'); transition('implement','goal_achieved','Behavior check passed.');
const accepted=c.readTask('implement').acceptedAttemptId;
c.applyGraph({operationId:'keep-keys',expectedGraphVersion:c.currentGraphVersion(),tasks:graph});
assert.equal(c.readTask('implement').acceptedAttemptId,accepted);
c.transition({taskId:'implement',operationId:'context-only',expectedVersion:c.readTask('implement').version,currentContext:'Additional execution evidence is available.'});
assert.equal(c.readTask('implement').acceptedAttemptId,accepted);
assert.equal(c.readTask('review').state.kind,'ready');
transition('review','claim');
const failed=transition('review','goal_failed','Independent check found a failing edge case.');
assert.equal(failed.task.state.kind,'dependency_waiting');
assert.equal(c.readTask('implement').state.kind,'ready');
console.log(JSON.stringify({stableKeyRevision:'preserves accepted attempt',contextOnlyUpdate:'does not invalidate accepted success',failedReviewState:failed.task.state.kind,repairState:c.readTask('implement').state.kind}));
transition('implement','claim'); transition('implement','goal_achieved','Repaired behavior check passed.');
const renamed=graph.map(t=>t.key==='implement'?{...t,key:'implement-new'}:{...t,needs:['implement-new'],onGoalFailed:{target:'implement-new',maxTraversals:1}});
c.applyGraph({operationId:'rename-key',expectedGraphVersion:c.currentGraphVersion(),tasks:renamed});
assert.equal(c.readTask('implement-new').attemptsStarted,0);
assert.equal(c.readTask('implement-new').state.kind,'ready');
console.log(JSON.stringify({renamedKey:'new Task with zero attempts',oldKeyInCurrentGraph:c.readTasks().some(t=>t.id==='implement')}));
