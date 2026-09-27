// Single timing source for picture (scene.js), sound (music.mjs), and the reading budget (budget.mjs).
// 100 BPM: beat 0.6 s (18 frames), bar 2.4 s. Scene starts sit on the beat grid. The music drops at the title.
//
// Motion system ("follow the handoff"):
// - One world, one camera from the team scene through the timeline. Only the end card pushes in.
// - Source → carrier → contact: every state change travels on a visible carrier.
//   deliver = folded ticket (Task → Worker), slip = evidence slip (Worker → Task),
//   dep = red square (Task → Task), change = chip (Task → lead), batch/alert = envelopes.
// - Soft travel (minimum-jerk arcs, quintic camera), hard contact (input / receipt / decision).
// - Major contacts land on beats. Event times are relative to their scene start.
//
// Reading budget (v7): every text the eye must read holds for its reading time before the next focal
// event takes the eye away. `reads` lists those windows; `node budget.mjs` checks them.
(() => {
  const scenes = [
    ['cold', 0, 14.4],
    ['title', 14.4, 20.4],
    ['team', 20.4, 36.0],
    ['graph', 36.0, 49.2],
    ['lead', 49.2, 64.2],
    ['review', 64.2, 76.2],
    ['timeline', 76.2, 82.8],
    ['end', 82.8, 90.6],
  ];
  const at = name => scenes.find(s => s[0] === name)[1];
  const C = at('title'), S = at('team'), G = at('graph'), L = at('lead'), R = at('review'), T = at('timeline'), E = at('end');
  const hash = i => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

  const workers = [
    { name: 'scout', role: 'fast', label: 'fast explorer' },
    { name: 'builder', role: 'standard', label: 'impl + test' },
    { name: 'ui', role: 'standard', label: 'ui' },
    { name: 'reviewer', role: 'reviewer', label: 'fresh eyes' },
  ];

  // Cold open: four pi-agent tabs, each asking for the user. First visits hold for reading;
  // revisits accelerate until the view freezes.
  const demands = [
    { tab: 'auth', user: 'fix the flaky auth tests', ask: ['3 tests failing.', 'Keep going?'], ctx: 41 },
    { tab: 'settings', user: 'add a dark mode setting', ask: ['Overwrite settings.ts?', '[y/N]'], ctx: 58 },
    { tab: 'docs', user: 'update the API docs', ask: ['Docs for', 'v1 or v2?'], ctx: 33 },
    { tab: 'billing', user: 'refactor the billing module', ask: ['Context 97% full.', 'Compact now?'], ctx: 97 },
  ];
  const tabs = [];
  { let t = 0, i = 0;
    for (const d of [3.0, 1.7, 1.6, 1.6, .5, .4, .35, .3, 10 / 30, 8 / 30, 7 / 30, 6 / 30, 6 / 30, 5 / 30, 5 / 30, 5 / 30]) { tabs.push([t, i % 4, d]); t += d; i++; }
    tabs.freeze = t; }

  // The request is typed in three phrase bursts with an irregular human cadence.
  const PROMPT = 'please orchestrate a team to finish the task e2e';
  const promptTimes = [];
  { const bursts = [[0, 25, S + 0.9], [25, 44, S + 2.15], [44, 48, S + 3.0]];
    for (const [a, b, t0] of bursts) { let t = t0; for (let i = a; i < b; i++) { promptTimes.push(t); t += .03 + .035 * hash(i) + (PROMPT[i] === ' ' ? .04 : 0); } } }

  // Task graph. Each entry: [contact time, state, note, carrier seconds]. A 'run' arrives on a
  // delivery carrier; ok/failed/blocked and a resumed run arrive on an evidence slip.
  const tasks = {
    map: { worker: 'scout', needs: [], schedule: [[G + 7.8, 'run'], [G + 9.0, 'ok', '12 files mapped']] },
    api: { worker: 'builder', needs: ['map'], schedule: [[G + 10.2, 'run'], [L + 0.8, 'ok', 'impl + 14 tests ✓'], [R + 5.8, 'run', 'attempt 2', .4], [R + 7.0, 'ok', 'fix + regression test ✓']] },
    ui: { worker: 'ui', needs: ['map'], schedule: [[G + 10.2, 'run'], [G + 11.4, 'blocked', 'empty-state copy? next: lead'], [L + 12.6, 'run', 'resumed'], [R + 0.4, 'ok', 'screen + snapshots ✓']] },
    review: { worker: 'reviewer', needs: ['api', 'ui'], schedule: [[R + 1.2, 'run', null, .4], [R + 3.0, 'failed', '2 findings · null check'], [R + 5.4, 'wait', 'routed to api', 0], [R + 7.8, 'run', 'attempt 2', .3], [R + 8.4, 'ok', '0 findings ✓']] },
    notes: { worker: 'scout', needs: ['review'], schedule: [[R + 10.2, 'run', null, .35], [R + 10.8, 'ok', 'release notes ✓', .25]] },
  };
  // Dependency tokens along graph edges: [from, to, t0, t1, kind].
  const tokens = [
    ['map', 'api', G + 9.05, G + 9.45, 'ok'], ['map', 'ui', G + 9.05, G + 9.45, 'ok'],
    ['api', 'review', R + 0.45, R + 0.8, 'ok'], ['ui', 'review', R + 0.45, R + 0.8, 'ok'],
    ['review', 'api', R + 4.8, R + 5.4, 'fail'],
    ['api', 'review', R + 7.05, R + 7.4, 'ok'], ['review', 'notes', R + 9.6, R + 9.85, 'ok'],
  ];
  // Task changes the lead will receive in one batch: [task, state, time the change happens].
  const changes = [['map', 'goal_achieved', G + 9.0], ['ui', 'blocked', G + 11.4], ['api', 'goal_achieved', L + 0.8]];

  const beats = {
    freeze: tabs.freeze, stamp: 11.4,
    peel: C, teamLand: C + .6, piHit: C + 1.2, bright: C + 1.8, glyph: C + 2.1, tagline: [C + 2.4, C + 3.0, C + 3.6],
    unfold: [S, S + 0.7], prompt: promptTimes, enter: S + 3.6,
    teamCreate: S + 4.85, badge: [S + 5.4, S + 6.0], shrink: [S + 6.9, S + 7.5],
    ensure: [S + 7.5, S + 9.3, S + 10.5, S + 11.7], workerLand: [S + 8.4, S + 10.2, S + 11.4, S + 12.6], dims: S + 13.0,
    relayout: [G, G + 1.2], graphApply: G + 1.3, unfoldTickets: G + 2.4, edges: [G + 3.6, G + 4.1], syncCall: G + 4.6,
    waitNote: L + 1.0, batch: [L + 4.6, L + 4.9, L + 5.4], returned: L + 5.4, blockedNote: L + 5.8, alertType: L + 8.0, alert: [L + 10.2, L + 10.8],
    unchanged: [L + 11.0, L + 12.6], syncAgain: L + 12.9,
    keyV: T + 0.3, panesOut: [T + 0.3, T + 0.7], frame: [T + 0.55, T + 0.85], morph: [T + 0.6, T + 1.4], unfoldRows: [T + 1.3, T + 1.7], reveal: [T + 1.9, T + 3.9],
    tlSpan: [G + 7.2, R + 11.9],
    logo: E + 0.45,
  };
  // Camera keys: [time, shot]. Between keys the camera eases (quintic); equal shots hold.
  const camera = [
    [0, 'id'], [G, 'id'], [G + 1.2, 'overview'], [G + 6.0, 'overview'], [G + 7.0, 'dag'],
    [L, 'dag'], [L + 1.1, 'lead'], [L + 13.5, 'lead'], [L + 14.7, 'dag'],
  ];

  const captions = [
    ['ONE AGENT. ONE REQUEST.', S + 0.6, S + 4.4],
    ['THE AGENT BECOMES THE LEAD.', S + 4.4, S + 7.5],
    ['THE LEAD ASSEMBLES A TEAM.', S + 7.5, S + 12.9],
    ['EVERY WORKER, IN PLAIN SIGHT.', S + 12.9, G + 1.3],
    ['THE LEAD DECLARES THE GRAPH.', G + 1.3, G + 6.9],
    ['THE RUNTIME DELIVERS READY WORK.', G + 6.9, G + 10.8],
    ['BLOCKED? SAY WHY. NAME THE NEXT MOVE.', G + 10.8, L + 1.0],
    ['BLOCKING WAIT. NO SLEEP-AND-RECHECK.', L + 1.0, L + 4.4],
    ['ONE BATCH. ONE RETURN.', L + 4.4, L + 8.0],
    ['AN ALERT REACHES ONE WORKER.', L + 8.0, L + 15.0],
    ['FRESH EYES REVIEW IT.', R + 0.0, R + 2.8],
    ['FAILED? ROUTED BACK. BOUNDED.', R + 2.8, R + 6.4],
    ['DONE MEANS EVIDENCE.', R + 6.4, T],
    ['SAME RECORD. TWO VIEWS.', T + 0.1, T + 3.0],
    ['EVERY ATTEMPT. EVERY BLOCKED MINUTE.', T + 3.0, E],
  ];

  // In-picture reads: [text the eye must read, shown, next focal event, kind].
  // kind: 'super' = a new block of display text; 'new' = a new element; 'repeat' = a known pattern.
  // Code counts only its novel words. Captions are checked as 'super' automatically.
  const reads = [
    ...tabs.slice(0, 4).map(([t0, i, d]) => [demands[i].ask.join(' '), t0, t0 + d, i ? 'repeat' : 'super']),
    ["LET'S ASSEMBLE A TEAM.", beats.stamp, beats.peel, 'super'],
    ['PI TEAM BRIGHT ONE LEAD. A VISIBLE TEAM. WORK YOU CAN PROVE.', beats.bright, S, 'new'],
    ['team_create release', beats.teamCreate, beats.shrink[0], 'new'],
    ['ensure_worker scout fast', beats.ensure[0], beats.ensure[1], 'new'],
    ...[1, 2, 3].map(i => [`${workers[i].name} ${workers[i].role}`, beats.ensure[i], beats.ensure[i + 1] ?? beats.dims, 'repeat']),
    ['LEADER AGENT WORKER AGENTS TMUX / HERDR MULTIPLEXER INTEGRATED', beats.dims, G, 'new'],
    ['task_graph_apply map api ui review notes', beats.graphApply, beats.edges[0], 'new'],
    ['team_sync updates', beats.syncCall, G + 6.0, 'repeat'],
    ['empty-state copy? next: lead', G + 11.4, L + 0.6, 'new'],
    ['BLOCKING WAIT team_sync no sleep-and-recheck a Task change returns the call', L + 1.1, beats.batch[0], 'new'],
    ['returned 3 changes 1 batch ui blocked: needs empty-state copy', beats.returned, beats.alertType, 'repeat'], // the blocked reason was read at the ticket,
    ['alert_send ui clarification Use: Nothing here yet.', beats.alertType, beats.alert[0], 'repeat'],
    ['TASK STATE UNCHANGED', beats.unchanged[0], beats.unchanged[1], 'new'],
    ['2 findings · null check', R + 3.0, R + 4.8, 'new'],
    ['on_goal_failed → api · max 2 traversal 1/2', R + 4.8, R + 7.0, 'new'],
    ['fix + regression test ✓', R + 7.0, R + 8.4, 'repeat'],
    ['PROVEN 0 findings ✓', R + 8.4, R + 10.2, 'new'],
    ['release notes ✓', R + 10.8, T, 'repeat'],
    ['PI TEAM BRIGHT VISIBLE WORKERS MODEL ROLES DAG-NATIVE ROBUST TASK & MESSAGE ENGINE pi install npm:@hypercarrier/pi-team-bright github.com/deephbz/pi-team-bright MIT', beats.logo, 90.6 - .9, 'super'],
  ];

  // Sound cues. Decisions also duck the music.
  const cues = [], decisions = [beats.stamp, beats.badge[1], R + 3.0, R + 8.4];
  tabs.slice(1).forEach(([t]) => cues.push([t, 'tab']));
  cues.push([beats.freeze, 'freeze']);
  decisions.forEach(t => cues.push([t, 'decision']));
  cues.push([beats.peel, 'swoosh'], [beats.teamLand, 'land'], [beats.piHit, 'slam'], [beats.bright, 'slam']);
  promptTimes.forEach(t => cues.push([t, 'type']));
  cues.push([beats.enter, 'enter']);
  beats.workerLand.forEach(t => cues.push([t, 'pop']));
  for (let i = 0; i < 5; i++) cues.push([beats.unfoldTickets + i * .1 + .45, 'tick']);
  for (const task of Object.values(tasks)) for (const [t, s, note] of task.schedule) {
    if (s === 'run') cues.push([t, note === 'resumed' ? 'tick' : 'deliver']);
    if (s === 'ok') cues.push([t, 'ok']);
    if (s === 'failed') cues.push([t, 'fail']);
    if (s === 'blocked') cues.push([t, 'block']);
  }
  cues.push([beats.batch[2], 'wake'], [beats.alert[0], 'alert'], [beats.alert[1], 'tick'], [beats.keyV, 'key'], [E - .35, 'swoosh'], [beats.logo, 'slam']);

  globalThis.TL = {
    DUR: 90.6, FPS: 30, BEAT: 0.6, scenes, workers, demands, tabs, PROMPT, tasks, tokens, changes, beats, camera, captions, reads, cues, decisions,
    pushIn: ['end'],
  };
})();
