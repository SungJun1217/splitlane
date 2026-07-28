# Repository Instructions

This file applies to the entire repository.

## Product identity

- Working title: **Splitlane**
- Planned CLI command: `splitlane`
- One-line description: A local TUI that routes prompts to Claude Code and Codex in parallel while keeping their sessions, models, output, and write access separate.
- Since 2026-07-29 the TUI has an optional desktop companion: a read-only Electron mirror of a running session. Both renderers are first-class; see `docs/GUI_TRANSITION_DECISIONS.md`. The terminal remains the only renderer that can grant authority until that document's stage 4 is approved.
- Core metaphor: each coding agent runs in its own lane; the user controls routing and merge decisions from above.

The final product name is pending. Do not use `Duet`, `AgentMux`, or `Coduo`; they are already used by adjacent products. Do not claim that any candidate name is trademark-cleared without a proper review.

## Current status

The project is in the **product-planning and architecture-validation phase**.

The current product plan is `docs/PRODUCT_PLAN.md`. Treat it as the product source of truth, subject to the explicit pending decisions in that document.

The existing Node implementation in `bin/duet.js` is a disposable technical spike. It may be used to learn about Claude Code and Codex event streams, but it is not the approved product architecture or UX specification.

Before extending production code:

1. Write or update the relevant product/architecture plan.
2. Identify unresolved behavior and safety decisions.
3. Obtain user agreement on decisions that materially affect scope or architecture.
4. Only then implement the smallest approved increment.

Do not silently turn prototype behavior into a product requirement.

## Product goal

The product should let one developer operate the installed official Claude Code and Codex CLIs from one terminal interface.

The first release should support:

- Sending one prompt to both providers at nearly the same time.
- Sending a prompt to only Claude Code or only Codex.
- Independent provider model selection.
- Independent conversation/session continuity.
- Streaming output and isolated provider status.
- Cancellation without terminating the other provider.
- Read-only comparison and an explicit single-writer policy.
- A human-controlled handoff from writer to read-only reviewer.
- A visible role profile that routes exploration, planning, implementation, debugging, and review to the harness best suited to that phase.
- A capability-aware action palette that supports those role assignments without reducing both providers to the lowest common denominator.
- Clear display of commands, tool calls, changed files, failures, and blocked permission requests.
- Project-level and user-level settings with visible precedence.

## v0.1 non-goals

Do not add these without a new product decision:

- Automatic agent-to-agent debate.
- Automatic answer grading or winner selection.
- Automatic task decomposition and delegation.
- Simultaneous writes to the same working tree.
- Automatic diff merging.
- Provider API-key fallback or direct model API integration.
- Remote execution, team collaboration, or cloud persistence.
- A public plugin SDK.
- Cost-based automatic model routing.

## Product invariants

These rules are more important than feature convenience:

1. **No unsafe permission bypass by default.** Never add dangerous sandbox or approval bypass flags as a hidden default.
2. **No shared-tree concurrent writers.** Both providers may write concurrently only when they have isolated worktrees or equivalent isolation.
3. **No silent model fallback.** If a selected model cannot run, show a provider-specific error.
4. **No coupled failures.** One provider failing, blocking, or cancelling must not stop the other provider.
5. **No fabricated session continuity.** Resume using provider session IDs; do not reconstruct a session by silently replaying old prompts unless that behavior is explicit.
6. **No terminal escape injection.** Sanitize provider output before rendering it in the TUI.
7. **No secret persistence.** Do not copy tokens, API keys, or provider credentials into product configuration or logs.
8. **No hidden writes.** The active write policy and current writer must always be visible before a prompt is sent.
9. **No false feature parity.** Provider-native capabilities stay visibly provider-specific; do not imitate them with weaker behavior and present them as equivalent.
10. **No silent experimental enablement.** Experimental Claude or Codex features require an explicit user action and a visible stability label.
11. **No authority outside the terminal.** A mirrored snapshot is a view. The interaction state machine is shared (`src/ui/interaction.ts`), but until an authenticated intent channel is approved, only the TUI may promote a writer, resolve an approval, start a turn, or remove a worktree.
12. **No network surface for the mirror.** The mirror is a local socket in the user state directory with owner-only permissions. It is never a TCP listener and never reachable from another machine.
13. **No permanent winner assumptions.** Comparative strengths are configurable routing hypotheses, not universal facts. Every recommendation remains visible and overridable.

## Workflow modes

The product model has four workflow modes:

| Mode | Claude Code | Codex | Intended use |
|---|---|---|---|
| `compare` | Read-only | Read-only | Compare answers, plans, and reviews |
| `build` | One writer or inactive | One writer or inactive | Normal implementation work |
| `review` | Writer paused | Reviewer read-only | Review the selected writer's diff |
| `isolated` | Own worktree | Own worktree | Future parallel implementation work |

`compare` should be the safe first-run default. Entering `build` and selecting the writer are explicit user actions. `review` never grants the reviewer write access. `isolated` is not complete until worktree creation, cleanup, diff inspection, and recovery are designed and tested.

## Model selection

Model selection belongs to each provider, not to the global prompt target.

- Each panel displays its effective model.
- `default` means “inherit the provider CLI configuration” and passes no model override.
- Users may enter an exact provider-specific model ID.
- Do not hardcode the model picker to a permanently fixed list.
- Recent valid model IDs may be offered as conveniences.
- A model change applies to the next request unless the UI explicitly says otherwise.
- If resuming with a different model is unsupported, explain that a new provider session is required.

Configuration precedence, highest first:

1. Per-request override.
2. Project configuration.
3. User configuration.
4. Provider CLI default.

## Session behavior

- Claude Code and Codex sessions are always independent.
- Session IDs are scoped by project and provider.
- Resetting one panel must not reset the other.
- Persistent session restoration must be opt-in or confirmed until its UX is approved.
- Project session metadata belongs in the user data directory, not in tracked repository files.
- Cancelling a running turn should terminate the full child process group and leave the TUI usable.

## Architecture boundaries

Keep these responsibilities separate regardless of implementation language:

1. **TUI:** rendering, focus, keyboard input, modals, scrolling, and accessibility.
   - **Snapshot mirror:** publishing the immutable `AppSnapshot` of a running session over a local socket, one direction only, opt-in per session. It adds no normalization layer and accepts no commands.
   - **Desktop renderer:** drawing a mirrored snapshot. It holds no session, constructs no orchestrator, and in the read-only stage has no channel for commands.
2. **Orchestrator:** routing, queues, cancellation, status transitions, and provider isolation.
3. **Provider adapters:** CLI discovery, argument construction, structured stream parsing, and session ID extraction.
4. **Role router:** visible, overridable recommendations for scout, architect, builder, debugger, and review lenses.
5. **Capability registry:** runtime discovery of common and provider-native features, stability, requirements, and safety effects.
6. **Composite workflows:** explicit human-controlled actions that combine capabilities across providers.
7. **Normalized events:** provider-independent output consumed by the TUI.
8. **Git observer:** repository status, baseline fingerprint, changed-file index, read-only diff generation, and review locations.
9. **Workspace guard:** read/write policy, writer leases, worktree isolation, and changed-file tracking.
10. **Session store:** non-secret project/provider/model/session metadata.
11. **Configuration:** schema, precedence, validation, and migrations.

Provider-specific JSON shapes and command-line flags must not leak into the TUI layer.

Provider-native actions may expose provider-specific inputs, but they must do so through typed capability descriptors rather than UI conditionals scattered across the application.

The normalized event vocabulary should cover at least:

- `session_started`
- `turn_started`
- `text_delta`
- `tool_started`
- `tool_finished`
- `file_changed`
- `permission_blocked`
- `turn_completed`
- `turn_failed`
- `turn_cancelled`

## Provider integration

Prefer the official structured, non-interactive CLI modes over scraping decorative interactive output.

- Claude Code adapter: use documented structured CLI or SDK capabilities and capture its session ID. Do not depend on reverse-engineered private flags.
- Codex adapter: prefer the documented app-server protocol for interactive approvals and streaming; retain exec/JSONL as a constrained fallback.
- Resolve CLIs from the user's environment; do not download or replace them without explicit consent.
- Detect and report missing binaries, unsupported versions, expired authentication, invalid models, malformed events, and non-zero exits separately.
- Treat CLI flags and event schemas as version-sensitive. Verify them against locally installed CLI help before changing an adapter.
- Discover native capabilities at runtime and classify them as `stable`, `preview`, `experimental`, or `unavailable`.
- Do not infer a capability from version text alone when a safe probe is available.
- Keep common actions, Claude-native actions, Codex-native actions, and cross-harness composites distinct in the action palette and event log.
- Treat default role assignments as configurable starting hypotheses. Do not claim that one harness is categorically better, and do not silently route a task.

Do not invoke real paid model turns in automated tests.

## TUI behavior

The default screen should provide:

- Terminal-first Claude Code and Codex lanes.
- A read-only evidence inspector on the right for changed files, Git diff, file preview, and review findings.
- A shared prompt editor.
- A visible prompt target: both, Claude, or Codex.
- A visible workspace mode and active writer.
- A visible effective model for each provider.
- A visible role strip showing the recommended and selected harness for each active workflow phase.
- Independent state badges such as `READY`, `RUNNING`, `BLOCKED`, `FAILED`, and `CANCELLED`.
- Collapsed tool/command details with an accessible expansion path.
- A raw diagnostic view for adapter errors.

The terminal area is always primary. The evidence inspector must be collapsible and must not turn into a built-in editor in v0.1. The interface must remain usable in narrow terminals and with Korean or other wide characters. Keyboard actions must be discoverable in the UI; do not rely on undocumented shortcuts.

## Queueing and cancellation

Until a different policy is approved:

- Each provider may have one running turn.
- Do not silently append input to a running turn.
- A queued request must be visible and removable.
- Cancelling one lane affects only that lane.
- Sending to both while one lane is busy must produce an explicit choice or clear refusal, not partial silent delivery.

## Configuration

Use a versioned, validated configuration schema. Keep user and project configuration separate. Project settings must be safe to commit and must never contain credentials or session IDs.

Illustrative settings only; do not treat this as the final schema:

```yaml
version: 1
providers:
  claude:
    model: default
  codex:
    model: default
workspace:
  mode: compare
ui:
  layout: auto
  show_tools: collapsed
  restore_sessions: ask
```

Reject unknown or invalid safety-critical values with actionable errors. Do not silently downgrade `compare`, `build`, or `review` protections.

## Testing expectations

Every provider parser change requires captured, redacted fixtures and tests for:

- Normal streaming output.
- Session creation and resume.
- Tool and command events.
- Provider-reported errors.
- Malformed or unknown events.
- Cancellation and abrupt process exit.

Use fake CLI executables for integration tests. They should simulate interleaved output, delays, failures, and ignored termination signals without network access or model cost.

Before considering a user-visible increment complete, verify:

- Both lanes stream independently.
- One lane can fail or cancel without affecting the other.
- Wide-character rendering does not break borders or input.
- The effective model, workspace mode, and active writer are visible.
- No test requires provider credentials or internet access.
- Packaging works from a clean checkout.

## Change discipline

- Keep changes scoped to the approved milestone.
- Prefer adapter-local compatibility fixes over global special cases.
- Document new shortcuts and configuration keys in the same change.
- Preserve user work and unrelated working-tree changes.
- Do not modify provider-owned configuration files automatically.
- Do not introduce telemetry, background services, or network calls without explicit approval.
- When a behavior is ambiguous, update the plan and surface the decision instead of guessing through implementation.

## Pending decisions

Do not present these as finalized until the user approves them:

- Production implementation stack and packaging format, including whether the desktop mirror is packaged and signed at all.
- Whether the desktop renderer ever gains command authority (stage 4 of the GUI transition), which requires the interaction state machine to be shared first.
- Exact approval/permission interaction inside the TUI.
- Persistent session restoration UX.
- Worktree creation, retention, and merge workflow.
- Queue behavior when only one selected provider is busy.
- Final configuration file locations and format.
- Whether token/cost usage belongs in v0.1.
- Final product name and CLI command.
- Which two provider-native capabilities per harness belong in v0.1.
- Which cross-harness composite workflows belong in v0.1.
- The default v0.1 role profile and whether role recommendations are enabled on first run.
