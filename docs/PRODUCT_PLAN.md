# Product Plan: Claude Code + Codex Control TUI

Status: architecture validation
Working title: Splitlane (final name pending)
Last updated: 2026-07-26

## 1. Executive decision

This project should not become another generic tmux session manager or an autonomous “YOLO” agent loop.

The focused product is a local, human-controlled TUI for this workflow:

```text
ROUTE OR COMPARE → APPROVE HANDOFF → BUILD → TWO-LENS REVIEW → ACCEPT OR RETURN
```

Claude Code and Codex remain independent provider runtimes. The product adds a shared control plane for prompt routing, model selection, session state, permissions, workspace ownership, and review handoff.

The interface is terminal-first: agent interaction occupies the primary area, while a read-only evidence inspector on the right shows code, changed files, Git diffs, and review findings without turning the product into an IDE.

The unique promise is:

> Give each phase to the harness that is strongest for it, keep the routing visible, and verify the result with the other perspective.

The product is a meta-harness, not a lowest-common-denominator wrapper. Its primary job is comparative-advantage routing: use each harness for the work it tends to do best, then use native capabilities to make that role effective. It must never hide which harness is doing what or treat a default routing hypothesis as a universal fact.

## 2. What the GitHub landscape shows

### 2.1 Comparable projects

| Project | Primary shape | What it proves | Lesson for this project |
|---|---|---|---|
| [Claude Squad](https://github.com/smtg-ai/claude-squad) | Go TUI + tmux + worktrees | A simple TUI can manage multiple CLI agents and isolated tasks | Bubble Tea and a single binary are credible; tmux is useful but adds a required dependency and nested terminal UX |
| [Agent Deck](https://github.com/asheshgoplani/agent-deck) | Go/Bubble Tea + tmux + worktrees | Worktree lifecycle, setup/teardown hooks, profiles, and session search matter in real use | Future isolation must handle ignored files, setup scripts, cleanup, bare repos, and recovery—not just `git worktree add` |
| [claude_codex_bridge](https://github.com/SeemSeam/claude_codex_bridge) | tmux workspace + agent routing | Per-agent provider/model config and visible message routing are valuable | Avoid its breadth in v0.1; keep topology fixed to two lanes and keep configuration small |
| [loop](https://github.com/axeldelafosse/loop) | Bun CLI + Codex/Claude bridge + tmux | Worker/reviewer pairing, plan review, persistent run IDs, and proof criteria are useful | Adopt the human-visible worker/reviewer concept, but do not default to unsafe autonomous loops |
| [Superset](https://github.com/superset-sh/superset) | Desktop app + worktrees + diff/editor | Diff review, model picker, notifications, and workspace setup become central at scale | These are later-stage features; do not turn the TUI into an IDE or desktop platform |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | Web Kanban + workspaces | Task planning and agent workspaces can become an entire product category | Its announced sunset is a warning against oversized surface area and heavy service architecture for this focused tool |
| [claude-review-loop](https://github.com/hamelsmu/claude-review-loop) | Claude plugin invoking Codex reviews | A second model is useful as an independent reviewer | Reviews need bounded rounds and safe flags; never copy its dangerous bypass default |
| [Codex app-server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) | Documented JSON-RPC control protocol | Streaming, models, sessions, interruption, usage, and approval requests can power a real UI | Prefer this over scraping the Codex TUI or only wrapping `codex exec` |

### 2.2 Market gap

Existing projects cluster into three groups:

1. **Session multiplexers:** many independent terminals and worktrees.
2. **Autonomous loops:** one agent writes while another reviews until a stopping condition.
3. **Desktop workspaces:** full diff, terminal, browser, editor, and project management environments.

The under-served use case is a small TUI where one developer can route each phase to the harness best suited to it, compare Claude and Codex when uncertain, and review the resulting diff through complementary lenses without surrendering control.

### 2.3 Specific engineering lessons

- Worktree isolation is necessary for parallel writers but is not sufficient by itself. Provider config and session state can still leak across worktrees.
- Worktrees must account for ignored environment files, setup/teardown tasks, orphan cleanup, existing dirty state, bare repositories, and provider-specific project directories.
- Long-running agents cannot be declared stuck using a short “no output” timer. Use explicit completion events when available, a heartbeat state, and a separate hard deadline.
- Approval requests must be elevated into a global inbox. Hidden approvals make an apparently running agent stall indefinitely.
- Provider versions and event schemas change. Adapter fixtures and version capabilities are product features, not implementation details.
- Persistent completed sessions remain useful because their transcript and diff are evidence. Do not delete them immediately.
- A model picker must show the effective model rather than only the requested model.

## 3. Target user and jobs

### Primary user

A developer who already has Claude Code and Codex installed and authenticated, works locally in a terminal, and wants a second opinion without manually copying prompts and diffs between sessions.

### Core jobs

1. Compare two plans or explanations before editing code.
2. Choose the better agent/model for a task.
3. Give exactly one agent write authority.
4. Review that agent's diff with the other agent.
5. Continue or reject based on visible evidence.
6. Assign different phases of one job to the harness best suited to each phase without manually copying context.

### Explicitly not the primary user

- A team needing a shared cloud agent platform.
- A user wanting ten autonomous workers.
- A user seeking an IDE replacement.
- A user without the official provider CLIs or their own provider subscriptions.

## 4. Revised v0.1 scope

### Included

- Exactly two first-class lanes: Claude Code and Codex.
- Broadcast or single-lane prompt routing.
- Provider-specific model and effort selection where supported.
- Capability discovery and a namespaced native-action palette.
- Visible, overridable role recommendations for exploration, planning, implementation, debugging, and review.
- A structured handoff packet between phases: objective, constraints, acceptance criteria, relevant files, unresolved questions, and evidence basis.
- A deliberately small set of provider-native actions selected for v0.1.
- Independent sessions with explicit reset and resume behavior.
- Structured streaming output.
- Read-only compare mode.
- Explicit writer promotion and revocation.
- Diff summary and changed-file list.
- A collapsible read-only evidence inspector with Git diff and file preview.
- Read-only reviewer handoff after a build turn.
- Inline approval inbox if both provider transports can support it reliably.
- Independent cancellation and failure recovery.
- Local, non-secret run metadata.

### Excluded

- More providers.
- More than two lanes.
- Automatic debate or consensus generation.
- Automatic repeated review/fix loops.
- Simultaneous shared-tree writers.
- Built-in editor, browser, Kanban, PR creation, or remote control.
- Editing code directly inside the evidence inspector.
- Worktree-based parallel implementation.
- Provider installation, credential storage, or direct API fallback.
- Automatic enabling of experimental provider features.

## 5. User workflow

### 5.1 Start

```text
$ <final-command> /path/to/repo
```

Startup checks:

1. Resolve the project path and Git state.
2. Detect `claude` and `codex` binaries and versions.
3. Check provider authentication without sending a paid model turn, if supported.
4. Load user and project-safe configuration.
5. Restore metadata only according to the approved session policy.
6. Enter `COMPARE` mode.

### 5.2 Compare

- Both lanes are read-only.
- The default target is `BOTH`.
- The same immutable prompt envelope is sent to both within a bounded dispatch window.
- Output streams independently.
- Each lane shows requested model, effective model, state, elapsed time, and session indicator.
- The user may continue either conversation independently.

### 5.3 Choose writer

The user invokes `Promote to writer` on one lane.

Before promotion, show:

- Provider and effective model.
- Project path and branch.
- Existing dirty files.
- Permission/sandbox policy that will apply.
- The other lane's resulting state: read-only or paused.

Promotion changes the global workflow mode to `BUILD`. It does not alter the provider's permanent configuration.

### 5.4 Build

- Only the selected writer receives implementation prompts.
- The other lane cannot mutate files.
- Changed files and Git diff statistics update after each completed turn.
- The evidence inspector can follow the latest changed file without stealing terminal focus.
- Approval requests identify provider, command/tool, working directory, affected paths, and reason.
- The user can revoke writer authority between turns.

### 5.5 Review

- The writer is paused.
- The other provider receives a generated review envelope containing the original task, acceptance criteria, base revision, and current diff reference.
- The reviewer runs read-only.
- Findings are rendered separately from ordinary chat output.
- Selecting a finding opens its file and line in the evidence inspector.
- The user chooses `Accept`, `Return to writer with findings`, or `Exit without action`.
- v0.1 never loops automatically.

## 6. TUI information architecture

### 6.1 Product frame

The TUI has two conceptual regions:

1. **Terminal workspace:** prompts, provider output, tool activity, approvals, and lane controls.
2. **Evidence inspector:** changed-file navigation, Git diff, file preview, and review findings.

The terminal workspace always has visual and keyboard priority. The inspector is read-only in v0.1 and can be hidden instantly.

### 6.2 Very wide terminal (180+ columns)

```text
┌ project / branch ─ COMPARE ─ writer: none ─ approvals: 0 ───────────────────────────┐
├ Claude ─ model ─ READY ┬ Codex ─ model ─ READY ┬ CHANGES / DIFF / FILE / FINDINGS ─┤
│                        │                       │ M src/adapter.ts                    │
│ terminal stream        │ terminal stream       │ @@ -12,7 +12,9 @@                  │
│                        │                       │ - previous                         │
│                        │                       │ + current                          │
├────────────────────────┴───────────────────────┤                                    │
│ target: BOTH  prompt…                          │                                    │
└ Enter send · Alt+1/2 lane · Ctrl+I inspector ─┴────────────────────────────────────┘
```

Suggested width allocation: terminal workspace 68–72%, inspector 28–32%. Three columns are used only when both agent lanes remain above their minimum readable width.

### 6.3 Normal terminal (100–179 columns)

Use stacked agent lanes plus the inspector. This gives each agent the full terminal-workspace width and prevents excessive line wrapping:

```text
┌ COMPARE · writer: none ────────────────────────────────┬ DIFF ───────────┐
│ Claude · READY                                        │                 │
│ terminal stream using the full left-side width        │ selected diff   │
├────────────────────────────────────────────────────────┤                 │
│ Codex · RUNNING                                       │                 │
│ terminal stream using the full left-side width        │                 │
├────────────────────────────────────────────────────────┤                 │
│ target: BOTH  prompt…                                  │                 │
└────────────────────────────────────────────────────────┴─────────────────┘
```

The view control has two states:

- `Both`: Claude and Codex are stacked vertically.
- `Focus`: one selected lane takes the full terminal height.

At very large widths, `Both` may automatically become side-by-side lanes. The inspector remains on the right in either state.

### 6.4 Narrow terminal (under 100 columns)

- Show one focused lane at a time.
- Keep the unfocused lane's state badge visible in a tab bar.
- Make the evidence inspector a full-screen tab or overlay.
- Never compress away workflow mode, writer, pending approval count, effective model, or dirty-state indicator.

### 6.5 Evidence inspector

Tabs:

| Tab | Purpose |
|---|---|
| `CHANGES` | Staged, unstaged, untracked, pre-existing, and run-touched file groups |
| `DIFF` | Read-only unified diff for the selected file or whole change set |
| `FILE` | Read-only file contents with line numbers and lightweight syntax color |
| `FINDINGS` | Reviewer findings linked to file and line when available |

Behavior:

- Default to `CHANGES` before a file is selected and `DIFF` afterward.
- Preserve terminal focus when the selected changed file updates.
- Refresh on debounced Git/file events and at turn completion, not on every text delta.
- Show the diff basis explicitly: `HEAD`, `staged`, `working tree`, or `run start`.
- Mark files that were already dirty at run start.
- Never claim a line was changed by an agent when attribution is uncertain.
- Allow opening the selected file in the user's external editor; do not edit it in the inspector.
- Cap rendered diff size and provide clear truncation with a file filter.

### 6.6 Focus and key model

`Tab` should be reserved for moving focus between major regions, not for silently changing the prompt target.

Proposed actions:

| Action | Default key |
|---|---|
| Focus Claude lane | `Alt+1` |
| Focus Codex lane | `Alt+2` |
| Focus/toggle inspector | `Ctrl+I` |
| Cycle inspector tabs | `[` / `]` while inspector is focused |
| Change prompt target | Action palette or explicit target control |
| Model picker | `Ctrl+M` |
| Action palette | `Ctrl+P` |
| Help | `?` when composer is not editing |

Final bindings require a terminal compatibility pass; every action must also be reachable from the action palette.

### Required overlays

- Model picker.
- Action palette.
- Writer promotion confirmation.
- Approval inbox.
- Session restore/reset confirmation.
- Raw diagnostics.
- Help and key map.

## 7. State models

### Lane state

```text
UNAVAILABLE
READY → STARTING → RUNNING → READY
                  ├→ BLOCKED_ON_APPROVAL → RUNNING
                  ├→ CANCELLING → CANCELLED → READY
                  ├→ FAILED → READY
                  └→ COMPLETED → READY
```

Provider process state and turn state must remain separate. A persistent provider process may be healthy while its current turn has failed.

### Workflow state

```text
COMPARE → BUILD → REVIEW → ACCEPTED
    ↑        ↑        └→ BUILD (return findings)
    └────────┴──────────→ COMPARE (revoke/reset)
```

### Dispatch rules

- Each lane supports at most one active turn.
- Broadcast dispatch is atomic from the user's perspective: if one selected lane cannot accept, ask whether to wait, send only to the available lane, or cancel.
- Never silently deliver to only one side.
- Queueing is disabled in the first vertical slice. Add it only with visible queue management.

## 8. Transport architecture

### 8.1 Principle

Use provider-supported structured control protocols. Do not scrape colored TUI text for core state, and do not make tmux a v0.1 dependency.

### 8.2 Codex

Preferred transport: `codex app-server` over stdio JSON-RPC.

Reasons:

- Documented thread start/resume/list behavior.
- Turn-level model, cwd, sandbox, and approval options.
- Text deltas, tool events, token usage, completion events, and interruption.
- Server-initiated approval requests that a client can display.
- Version-specific TypeScript and JSON Schema generation.

Fallback transport: `codex exec --json` for read-only compare if app-server initialization or capability negotiation fails. The fallback is not sufficient for the full build/approval experience.

Known risk: open Codex issues show approval events can occasionally be incomplete or stall. Add an approval watchdog based on protocol state, not guessed terminal text.

### 8.3 Claude Code

Initial transport candidate: official CLI print mode with stream JSON and session resume.

Requirements before build mode ships:

- A supported, version-detectable bidirectional permission callback.
- Reliable cancellation of the provider process and its descendants.
- Effective model and session ID surfaced from structured initialization.
- A documented or officially supported way to continue turns without private flags.

Do not depend on reverse-engineered `--sdk-url` behavior. If official CLI structured mode cannot deliver interactive approvals reliably, choose one of these explicitly:

1. Use an official Claude Agent SDK transport that preserves the user's supported authentication path.
2. Keep Claude write mode disabled and ship read-only comparison first.
3. Revisit a PTY transport as a separately scoped fallback.

Do not silently run Claude with permissive flags to avoid solving approval UX.

### 8.4 Adapter contract

Each provider adapter exposes equivalent operations:

```text
probe() → capabilities, version, auth state
start_session(options) → session
resume_session(id, options) → session
start_turn(session, prompt, options) → event stream
respond_approval(request_id, decision)
interrupt(turn_id)
close()
```

Capabilities are negotiated, not assumed:

```text
streaming
resume
model_override
effort_override
read_only
workspace_write
interactive_approval
interrupt
usage_reporting
```

## 9. Meta-harness capability layer

### 9.1 Comparative advantage comes first

The differentiator is not exposing every native command. It is assigning each phase to the harness that can use its model, context management, tools, and control surface most effectively.

The initial role profile is a product hypothesis to validate, not a permanent ranking:

| Workflow role | Recommended harness | Why the harness is a plausible fit | Required output |
|---|---|---|---|
| Scout | Claude Code | Plan mode and context-isolated Explore subagents support broad repository research without flooding the main conversation | Repository map, relevant files, constraints, open questions |
| Architect | Claude Code | Read-only planning and subagent-assisted synthesis fit requirements clarification and change design | Approved implementation brief and acceptance criteria |
| Builder | Codex | The Codex workflow is oriented around sustained code changes, tool execution, tests, and inspectable turn state | Working diff, commands run, test evidence |
| Debugger | Codex | Reproducible execution loops and structured turn/tool events fit hypothesis-test-fix cycles | Reproduction, root cause, minimal fix, regression evidence |
| Intent reviewer | Claude Code | The planning context can check whether the diff still matches the original constraints and architecture | Spec gaps, architectural risks, missing cases |
| Correctness reviewer | Codex | Native review and structured findings fit line-specific bug and regression review | Severity, file/line, rationale, suggested verification |

This starting profile is an inference from the documented harness affordances, not a vendor-published head-to-head benchmark. Claude documents plan-mode and subagent workflows for codebase research in its [common workflows](https://code.claude.com/docs/en/common-workflows) and [parallel agents guide](https://code.claude.com/docs/en/agents). OpenAI documents Codex workflows for difficult iterative problems, codebase changes, testing, and review in the [Codex use-case catalog](https://developers.openai.com/codex/use-cases), while the [app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) provides inspectable control for turns, tools, approvals, and interruption.

These assignments must be visible and individually overridable. v0.1 uses a static configurable role profile; it does not silently classify or route prompts. A later profiler may recommend changes using repository-local evidence such as accepted plans, test outcomes, review findings confirmed by the user, latency, and usage. Raw output length or provider self-confidence must never be treated as quality evidence.

The same harness can hold more than one role in a workflow. Independence is still valuable: when the builder and correctness reviewer would be the same harness, offer a fresh review thread and an optional second-harness review rather than pretending self-review is independent.

### 9.2 Design layers

The architecture has four capability layers:

```text
COMMON CORE
  prompt · stream · model · session · cancel · approval · read/write policy

CLAUDE NATIVE                    CODEX NATIVE
  plan mode                       app-server thread controls
  subagents / agent teams         structured review / output schema
  hooks                           sandbox and approval profiles
  worktree lifecycle              profiles and local/OSS providers
  Chrome integration              versioned protocol schemas
  Remote Control                  thread fork/resume and usage events

CROSS-HARNESS COMPOSITES
  scout/architect/builder route · two-lens review · plan duel · findings relay
```

Common core behavior is normalized. Native capabilities are not flattened into fake equivalents. Composite workflows must identify the provider and native action used at every step.

### 9.3 Capability registry

Every adapter returns a runtime capability manifest:

```text
id
provider
label
stability: stable | preview | experimental
availability: available | unavailable | blocked
transport
requirements
input_schema
safety_effect
session_effect
conflicts
```

Examples:

```text
claude.plan_mode
claude.subagent
claude.worktree
claude.chrome
claude.remote_control
codex.thread_fork
codex.review
codex.output_schema
codex.local_provider
codex.sandbox_profile
```

Capability discovery uses supported probes and local CLI help. Version checks are fallback evidence, not the sole source of truth. Unsupported actions do not appear as disabled clutter unless diagnostics are open.

### 9.4 Claude-native opportunities

Claude Code's official extension surface includes skills, MCP, subagents, agent teams, hooks, and plugins. It also supports worktree-isolated sessions and subagents, Chrome-connected browser work, and Remote Control. These features should be surfaced only when the locally installed CLI and account support them. See the official [extension overview](https://code.claude.com/docs/en/features-overview), [parallel agents guide](https://code.claude.com/docs/en/agents), [worktree guide](https://code.claude.com/docs/en/worktrees), and [Chrome integration](https://code.claude.com/docs/en/chrome).

Candidate native actions:

| Action | Product use | v0.1 recommendation |
|---|---|---|
| `Claude: Plan` | Run a read-only planning turn before writer promotion | Include |
| `Claude: Explore subagent` | Isolate broad repository research from the main session | Include only if structured child status is observable |
| `Claude: Worktree session` | Use Claude's native isolation and cleanup behavior | Defer to isolated mode |
| `Claude: Browser verify` | Validate a web flow using the user's signed-in Chrome | Defer; permission and evidence UX required |
| `Claude: Agent team` | Coordinate several Claude sessions | Defer; experimental and outside the two-lane v0.1 scope |
| `Claude: Remote Control` | Continue the local session from another device | Defer; separate lifecycle and security design |

Hooks remain provider-owned. The product may display hook activity and outcomes, but must not rewrite Claude hook configuration automatically.

### 9.5 Codex-native opportunities

Codex app-server exposes structured threads, turns, streaming items, model and sandbox overrides, interruption, token usage, and server-initiated approvals. Its schema can be generated for the installed Codex version. See the official [Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md).

The installed Codex CLI also exposes review execution, output schemas, configuration profiles, image inputs, and local/OSS provider selection. Treat local CLI help and capability probes as the authority for the current machine.

Candidate native actions:

| Action | Product use | v0.1 recommendation |
|---|---|---|
| `Codex: Review diff` | Run Codex's native review path against the current change | Include |
| `Codex: Structured findings` | Require a findings schema for the inspector | Include if app-server/CLI output-schema behavior validates cleanly |
| `Codex: Fork thread` | Explore an alternative without mutating the original conversation | Defer until session persistence |
| `Codex: Sandbox profile` | Select a visible per-turn safety envelope | Include as part of writer promotion, not as a free-form shortcut |
| `Codex: Local provider` | Run an OSS model through the Codex harness | Defer; capability and UX matrix expands significantly |
| `Codex: Image context` | Attach a screenshot or visual reference to a turn | Defer unless both input and transcript rendering are designed |

### 9.6 Cross-harness composites

Composite actions are small deterministic state machines, not autonomous agent societies.

#### Scout → architect → builder

```text
Claude Scout maps the repository
→ Claude Architect produces a bounded implementation brief
→ human approves or edits the brief
→ Codex Builder implements and tests
→ review lenses inspect one immutable diff
```

The handoff packet contains evidence and constraints, not the entire hidden transcript. The receiving harness may request missing context before work begins.

#### Plan duel

```text
same task
→ Claude native plan turn (read-only)
→ Codex independent plan/analysis turn (read-only)
→ side-by-side plans
→ human chooses writer
```

#### Writer/reviewer handoff

```text
selected provider builds
→ writer is paused
→ other provider receives task + acceptance criteria + diff basis
→ native review action where available
→ findings open in Inspector
→ human accepts or returns selected findings
```

#### Two-lens review

```text
same immutable diff
→ Claude checks intent, constraints, and architectural coherence
→ Codex runs line-specific correctness and regression review
→ group exact/near-duplicate findings
→ human resolves disagreements
```

Each lens receives a distinct review contract; this is not the same generic prompt sent twice. Duplicate grouping must be deterministic or clearly labeled as heuristic. The product must never present agreement as proof that a finding is correct.

#### Findings relay

Only user-selected findings are sent back to the writer. Relay includes original provider, file/line, severity if provided, and exact review text. Do not silently summarize away dissent or attribution.

### 9.7 Role strip and action palette

The role strip is the primary meta-harness control:

```text
SCOUT Claude · ARCHITECT Claude · BUILDER Codex · REVIEW Claude + Codex
```

Selecting a role shows its assignment, model, workspace authority, expected artifact, and the evidence used for any recommendation. The user can replace the assigned harness before the phase starts. The native action palette is secondary and supplies the mechanism for the selected role.

Group actions visibly:

```text
Common
  Send to Both
  Promote writer
  Start review

Claude Code
  Plan
  Explore with subagent        PREVIEW
  Browser verify              UNAVAILABLE

Codex
  Review diff
  Structured findings
  Fork thread                 LATER

Cross-harness
  Scout → architect → builder
  Two-lens review
  Plan duel                    OPTIONAL
```

The palette shows stability and safety effects before execution. Experimental capabilities are hidden by default and require an explicit user setting before they can be invoked.

### 9.8 v0.1 role and capability budget

To avoid recreating the full surface area of both products, v0.1 should include at most:

- Two Claude-native actions.
- Two Codex-native actions.
- Two cross-harness composites.

Recommended initial set:

```text
Role profile: Claude Scout / Architect / Intent reviewer
Role profile: Codex Builder / Debugger / Correctness reviewer
Claude: Plan
Claude: Explore subagent, only if observable and cancellable
Codex: Review diff
Codex: Structured findings
Composite: Scout → architect → builder
Composite: Two-lens review
```

If Claude subagent observation is not reliable during M0, replace it with no second Claude-native action rather than shipping a hidden background process.

## 10. Normalized event model

Minimum envelope:

```text
event_id
provider
session_id
turn_id
timestamp
kind
payload
raw_version
```

Required event kinds:

- `session.started`
- `session.resumed`
- `turn.started`
- `message.delta`
- `message.completed`
- `tool.started`
- `tool.progress`
- `tool.completed`
- `file.changed`
- `approval.requested`
- `approval.resolved`
- `usage.updated`
- `turn.completed`
- `turn.failed`
- `turn.cancelled`
- `provider.warning`

Unknown provider events are retained in diagnostics but do not crash rendering.

File events are hints that trigger Git observation; they are not trusted as the sole source of repository truth.

Native action events additionally retain:

```text
capability_id
capability_stability
native_event_kind
safety_effect
```

Unknown native events remain available in diagnostics without entering common state transitions until an adapter explicitly supports them.

## 11. Permissions and safety

### Approval inbox

Every pending request must show:

- Provider and lane.
- Exact command or tool name.
- Working directory.
- Affected paths and requested network access when known.
- Provider-supplied reason.
- Available decisions from that provider.

Decisions should include only what the provider actually supports, such as deny, allow once, or allow for session. Do not invent a persistent rule when the provider cannot enforce it.

### Safety defaults

- Start in read-only compare mode.
- Never pass dangerous bypass flags by default.
- Never alter the user's Claude or Codex config files automatically.
- Never copy provider credentials.
- Sanitize ANSI/OSC sequences and bound retained output.
- Record requested and effective safety policy in diagnostics.

### Deadlock detection

- Prefer explicit `approval.requested` state.
- Show `RUNNING · no events for …` as a diagnostic, not as failure.
- Use a configurable hard turn deadline only as a final guard.
- Interrupt should retry a bounded number of times if the provider reports busy.
- After forced termination, mark the session as requiring capability-safe resume validation.

Native actions cannot weaken the current workspace mode. A Claude or Codex native action that requests a broader sandbox, additional tools, worktree creation, browser control, remote control, or child agents must show that effect before execution.

## 12. Model selection

### UX

`Ctrl+M` opens one dialog with separate Claude and Codex sections.

Each shows:

- Requested model.
- Effective model.
- Effort/reasoning control if supported.
- `default` to inherit CLI config.
- Recent successful model IDs.
- Custom exact model ID entry.

### Rules

- No hardcoded permanent model catalog.
- Use provider model-list capability when available.
- Otherwise accept an exact ID and validate by starting the next turn.
- Invalid models fail visibly; never fall back silently.
- Changing a model prompts if the provider requires a new session.
- Presets store per-provider choices, not one fake cross-provider model name.

## 13. Session and local state

Store only non-secret metadata under the platform user-data directory.

Suggested logical layout:

```text
state/
  projects/<repo-hash>/
    project.json
    runs/<run-id>/
      manifest.json
      events.ndjson        # opt-in transcript retention
      diagnostics.ndjson   # bounded and redacted
```

The manifest includes provider session IDs, requested/effective models, workflow state, writer, base revision, timestamps, and schema version.

Writes must be atomic. On startup, incomplete runs are marked interrupted and offered for provider-safe resume. Session IDs never belong in committed project config.

Native child sessions and forked threads have parent/child relationships in the run manifest. Resetting a parent must never silently orphan a native child process or discard its evidence.

## 14. Git and diff behavior

### Git observer

The Git observer is read-only and independent of provider adapters. It owns:

- Repository root and branch discovery.
- Startup baseline fingerprint.
- Staged, unstaged, and untracked status.
- Pre-existing dirty-file labels.
- Run-touched file hints.
- Unified diff generation and truncation metadata.
- Mapping review findings to file/line locations.

Use the local `git` executable with non-interactive, no-pager, no-external-diff behavior. Never execute repository-defined diff drivers or pagers for inspector rendering. Refresh after provider file events using a debounce, and always reconcile at turn completion.

The inspector must display which comparison it is showing:

```text
Working tree ↔ HEAD
Staged ↔ HEAD
Working tree ↔ staged
Current file ↔ run-start snapshot
```

Exact `run-start` diffs for an already-dirty file require a local baseline snapshot. Until that snapshot mechanism is implemented and bounded, show the normal working-tree diff and label the file `pre-existing dirty` rather than fabricating agent attribution.

### v0.1 current-tree policy

- Parallel writing is prohibited.
- Before writer promotion, fingerprint `HEAD`, branch, staged files, unstaged files, and untracked paths.
- Existing dirty changes remain user-owned and are never reset or stashed automatically.
- The product reports changes made during the run separately when attribution is reliable; otherwise it clearly labels the combined working-tree diff.
- Accepting a review does not commit or push.
- The inspector is observational; selecting or viewing a diff cannot change the index or working tree.

### Future isolated mode

Before isolated worktrees ship, design and test:

- Branch and directory naming.
- Existing worktree and bare-repository discovery.
- Ignored file inclusion without overwriting.
- Setup and teardown scripts with explicit consent and timeouts.
- Port/environment collision handling.
- Orphan detection and recoverable cleanup.
- Provider project configuration propagation.
- Diff comparison and user-controlled merge/cherry-pick.

## 15. Configuration

Separate safe project preferences from user/session state.

Proposed project-safe configuration:

```yaml
version: 1
providers:
  claude:
    model: default
  codex:
    model: default
workflow:
  startup_mode: compare
  roles:
    scout: claude
    architect: claude
    builder: codex
    debugger: codex
    intent_reviewer: claude
    correctness_reviewer: codex
ui:
  layout: auto
  tool_details: collapsed
native_capabilities:
  experimental: false
```

Not allowed in project configuration:

- Credentials.
- Provider auth paths.
- Session IDs.
- Blanket bypass flags.
- Absolute secret-file paths.

Precedence:

```text
per-turn override
→ project-safe config
→ user config
→ provider CLI defaults
```

## 16. Technology decision

The earlier Go + Bubble Tea recommendation is no longer considered final.

Decision approved on 2026-07-26: use a **TypeScript adapter/orchestrator stack
with Bun as the M1 packaging path**. A staged clean-checkout installation,
offline test run, and single-executable compilation passed on macOS arm64; wider
platform artifact validation remains a release concern rather than an M1 block.
The reasons are concrete rather than stylistic: the installed Codex
CLI generates version-matched TypeScript protocol bindings, while Claude's
supported interactive approval round trip was proven through the official
TypeScript Agent SDK and was not proven through the public print-mode CLI wire
contract. Claude uses the official Agent SDK transport and Codex uses app-server;
provider-specific transports remain behind the adapter boundary.

Ink 7 is selected for the M1 renderer. Its renderer stays isolated in the TUI
layer, and M1 must validate CJK width, alternate-screen restoration, input, and
Bun packaging before this becomes a distribution commitment. OpenTUI remains a
fallback if Ink fails those gates; adopting its Zig/FFI core would require a new
packaging decision.

Research supports two viable approaches:

| Option | Strengths | Risks |
|---|---|---|
| Go + Bubble Tea | Proven by Claude Squad and Agent Deck; single binary; strong process control | Manual protocol types; Claude approval integration may require a custom bridge |
| TypeScript/Bun + terminal renderer | Close to Claude/Codex structured ecosystems; fast adapter work; Bun can build binaries as demonstrated by `loop` | TUI renderer choice and binary portability require validation |

Decide after the protocol spike, not before it. Transport reliability and approval support outweigh language preference.

## 17. Delivery milestones

### M0 — Protocol and safety spike

No polished TUI.

Deliverables:

- Capability probe for locally installed Claude and Codex versions.
- Redacted fixtures for startup, streaming, tool use, completion, failure, and cancellation.
- Codex app-server start/resume/model/interrupt round trip.
- Claude supported start/resume/model/interrupt round trip.
- Approval request and response proof for both providers, or a documented blocker.
- Process-tree termination test.
- Adapter contract and event schema draft.
- Runtime capability manifest for both installed harnesses.
- Proof that selected native actions can be observed, cancelled, and safety-gated.
- A small repo-local evaluation set that tests the proposed role profile without declaring a universal winner.

Exit gate: choose production stack and declare which v0.1 modes each provider can safely support.

### M1 — Read-only compare vertical slice

- Two lanes and shared prompt editor.
- Broadcast and single target.
- Model picker with default/custom IDs.
- Independent streaming and cancellation.
- Terminal-first responsive layout and collapsible read-only inspector shell.
- Project status and existing Git diff viewing.
- No writes, queue, persistence, or review automation.
- Namespaced action palette with unavailable and experimental actions handled according to policy.
- Visible role strip with per-role override and no silent routing.

Exit gate: ten consecutive real compare sessions without mixed output, lost completion, or orphan process.

Exit gate result: **passed on 2026-07-26**. The corrected M1 build completed ten
consecutive live compare pairs with stable provider-local sessions, expected
output markers, an unchanged workspace fingerprint, and no lingering child
process after shutdown. Redacted evidence is retained in
`test/fixtures/m1-live-gate-2026-07-26.redacted.json`.

### M2 — Single-writer build

- Writer promotion confirmation.
- Git fingerprint and changed-file summary.
- Approval inbox.
- Writer revocation.
- Other lane read-only or paused.
- Debounced changed-file index and per-file diff refresh.

Exit gate: no path allows both providers to write to the same tree concurrently.

### M3 — Reviewer handoff

- Review envelope generated from task, criteria, base, and diff.
- Scout/architect handoff packet with objective, constraints, relevant files, open questions, and acceptance criteria.
- Structured findings view.
- File/line navigation from findings into the inspector.
- Codex native review and structured-findings path when supported.
- Claude plan handoff with provider attribution preserved.
- Return findings to writer as a user-confirmed action.
- No automatic loop.

Exit gate: reviewer cannot modify the workspace and the user can trace every handoff.

### M4 — Persistence and recovery

- Run manifests.
- Confirmed session restoration.
- Interrupted run detection.
- Bounded diagnostics and optional transcript retention.

### M5 — Isolated worktrees

- Optional parallel writers in separate worktrees.
- Setup/teardown lifecycle.
- Diff comparison and user-controlled integration.
- Orphan recovery.

### M6 — Distribution

- Clean single-command install for macOS and Linux.
- Version diagnostics.
- Shell completions.
- Reproducible release artifacts.
- No automatic provider installation or config mutation.

## 18. Test strategy

### Unit

- Version capability mapping.
- Provider event parsing.
- Unknown/malformed events.
- State machines and illegal transitions.
- Model/config precedence.
- Capability probing, stability labels, and native-action safety effects.
- Role-profile parsing, override precedence, handoff schema, and routing audit events.
- ANSI/OSC sanitization and wide-character layout.
- Diff parsing, truncation, binary-file handling, and safe pager/diff-driver suppression.

### Integration with fake providers

Fake executables simulate:

- Interleaved deltas.
- Delayed startup.
- Approval requests.
- Malformed messages.
- Non-zero exit.
- Ignored SIGTERM.
- Child processes that must be terminated.
- Long quiet periods followed by valid completion.
- Native capability present, absent, blocked, and malformed-probe states.
- Child/fork lifecycle and cancellation.

### Opt-in live compatibility

- Never part of ordinary automated tests.
- Requires explicit confirmation because it may consume subscription usage.
- Captures only redacted protocol fixtures.
- Records provider versions with every result.

## 19. Release acceptance criteria

v0.1 is ready only when:

- Broadcast never silently becomes single-provider delivery.
- Provider output and session IDs never cross lanes.
- Effective models are visible and invalid models fail explicitly.
- One provider can fail, block, or cancel without affecting the other.
- The full child process tree is cleaned up on cancel and exit.
- Both providers are read-only in compare mode.
- Exactly one writer is possible in build mode.
- Reviewer mode is technically read-only, not merely instructed to avoid edits.
- The inspector is read-only and always labels its diff basis.
- Pre-existing dirty files are distinguishable from clean-at-start files.
- Pending approvals cannot remain invisible.
- Existing dirty files are preserved.
- No credentials or secret values enter project config or logs.
- Narrow terminals and Korean text remain usable.
- Unsupported native actions never appear as working actions.
- Experimental actions are never enabled implicitly.
- Every native or composite action preserves provider attribution and declared safety effects.
- A child agent, forked thread, or native background task cannot become an invisible orphan.
- Every workflow phase shows its recommended and selected harness, and the user can override it before execution.
- Handoffs carry explicit artifacts and evidence instead of relying on hidden cross-provider transcript copying.

## 20. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Provider protocol drift | Broken parsing or approvals | Capability probe, versioned fixtures, adapter-local compatibility |
| Hidden approval deadlock | Turn appears hung | Explicit approval state, watchdog, diagnostics, bounded interrupt retry |
| Worktree/config leakage | Cross-session corruption | Defer parallel writers; test provider state isolation before M5 |
| Scope growth into an IDE | Slow delivery and weak differentiation | Keep v0.1 to compare/build/review; reject browser/editor/Kanban features |
| Unsafe automation pressure | Host damage | Read-only default, explicit writer lease, no bypass defaults |
| High model usage | Unexpected subscription consumption | No automatic loops, visible elapsed/usage when available, live tests opt-in |
| Name collision | Rebranding cost | Keep name as working title until package/domain/trademark check |
| Native capability sprawl | v0.1 becomes two products embedded in one | Enforce the two-per-provider capability budget |
| Experimental provider drift | Actions break or change semantics | Hidden by default, stability labels, capability probes, adapter-local gates |
| Nested agents multiply cost | Unexpected usage and difficult cancellation | Explicit launch, child tree visibility, no automatic nesting |
| Stale strength assumptions | The wrong harness is repeatedly recommended as models and repositories change | Configurable role profile, repo-local evaluation, visible overrides, no automatic winner claims |

## 21. Decisions still requiring user approval

1. Product thesis: approve `route or compare → approve handoff → build → two-lens review` as the primary flow.
2. v0.1 workspace: approve current-tree single writer, with worktrees deferred to M5.
3. Transport fallback: decide whether Claude build mode should be withheld if supported approval callbacks cannot be proven, rather than falling back to PTY scraping.
4. Technology: approved TypeScript/Bun proposal with Claude Agent SDK and Codex
   app-server as separate provider transports. Bun release packaging remains
   gated on M1/M6 artifact validation.
5. Persistence: decide whether transcripts are off by default or retained locally by default.
6. Final product name and CLI command.
7. Approve the initial native capability set: Claude Plan, conditional Claude Explore subagent, Codex Review diff, and Codex Structured findings.
8. Approve the initial composites: Scout → architect → builder and Two-lens review.
9. Approve the initial role profile: Claude for scout/architect/intent review; Codex for builder/debugger/correctness review.
