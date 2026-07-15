# pi-teams: Agent Guide 🤖

This guide explains how `pi-teams` transforms your single Pi agent into a coordinated team of specialists. It covers the roles, capabilities, and coordination patterns available to you as the **Team Lead**.

---

## 🎭 The Two Roles

In a `pi-teams` environment, there are two distinct types of agents:

### 1. The Team Lead (You)
The agent in your main terminal window. You are responsible for:
- **Strategy**: Creating the team and defining its goals.
- **Delegation**: Spawning teammates and assigning them specific roles.
- **Coordination**: Managing the shared task board and broadcasting updates.
- **Quality Control**: Reviewing evidence and deciding whether complex or high-risk work is ready to execute or close.

### 2. Teammates (The Specialists)
Agents spawned in separate panes. They are designed for:
- **Focus**: Executing specific, isolated tasks (e.g., "Security Audit", "Frontend Refactor").
- **Parallelism**: Working on multiple parts of the project simultaneously.
- **Autonomy**: Receiving native Message/Task delivery, enriching Task context, and executing understood work without constant hand-holding. Inbox reads are explicit audit/history only.

---

## 🛠 Capabilities

### 🚀 Specialist Spawning
You can create teammates with custom identities, models, and reasoning depths:
- **Custom Roles**: "Spawn a 'CSS Expert' to fix the layout shifts."
- **Model Selection**: Use `gpt-4o` for complex architecture and `haiku` for fast, repetitive tasks.
- **Thinking Levels**: Set thinking to `high` for deep reasoning or `off` for maximum speed.

### 📋 Shared Task Board
A centralized source of truth for the entire team:
- **Visibility**: Everyone can see the full task list and its assignees.
- **Status Tracking**: Tasks use only `open`, `in_progress`, `blocked`, and `closed`.
- **Assignment**: Assigning a task to a teammate automatically notifies them.

### 💬 Coordination & Messaging
Communication flows naturally between team members:
- **Direct Messaging**: Send specific instructions to one teammate.
- **Broadcasts**: Announce global changes (like API updates) to everyone at once.
- **Native Delivery**: Accepted Messages and Task changes steer the exact current Session; agents don't poll inboxes to discover work.

### 🛡️ Review Convention
Simple work executes directly. For complex or high-risk work, the assigner says in
Task prose that review is required before execution. The teammate supplements the
same Task's `design` and notes, then sends a Message referencing the exact Task
version. Approval is an exact-version `task_update` to `in_progress`; rejection
appends feedback and leaves the Task `open`. There is no separate Plan object or
mechanical gate.

---

## 💡 Coordination Patterns

### Pattern 1: The "Parallel Sprint"
Use this when you have 3-4 independent features to build.
1. Create a team: `team_create({ team_name: "feature-sprint" })`
2. Spawn specialists for each feature.
3. Create tasks for each specialist.
4. Monitor progress while you work on the core architecture.

### Pattern 2: The "Safety First" Audit
Use this for refactoring or security work.
1. Spawn a teammate with an explicit instruction to propose a plan before implementation.
2. Assign one Task whose prose says review is required before implementation.
3. Have the teammate update its `design` and notes, then Message you the exact Task version.
4. Approve that version by moving the Task to `in_progress`, or append feedback and keep it `open`.

### Pattern 3: The "Quality Gate"
Use automated hooks to ensure standards.
1. Define a script at `.pi/team-hooks/task_closed.sh`.
2. When any teammate marks a task as `closed`, the hook runs (e.g., runs `npm test`).
3. If the hook fails, you'll know the work isn't ready.

---

## 🛑 When to Use pi-teams
- **Complex Projects**: Tasks that involve multiple files and logic layers.
- **Research & Execution**: One agent researches while another implements.
- **Parallel Testing**: Running different test suites in parallel.
- **Code Review**: Having one agent write code and another (specialized) agent review it.

## ⚠️ Best Practices
- **Isolation**: Give teammates tasks that don't overlap too much to avoid git conflicts.
- **Clear Prompts**: Be specific about the teammate's role and boundaries when spawning.
- **Check-ins**: Mutation receipts already contain post-state. Use `task_list`, `task_read`, or `check_teammate` on demand when a current projection or runtime diagnosis is actually needed, not as routine polling.
