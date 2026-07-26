# v0.1 Completion Decisions

Status: approved for implementation on 2026-07-26

Last updated: 2026-07-26

## Purpose

This document fixes the behavior required to turn the current M3 engineering
preview into a usable v0.1. It covers the requested TUI, queue, configuration,
session, composite-review, role-handoff, isolated-worktree, and compatibility
increments. The existing safety invariants remain unchanged: compare is
read-only, a shared tree has at most one writer, provider failures stay isolated,
and no model turn or handoff is started silently.

Implementation proceeds as independently releasable increments. Each increment
must include offline tests, CJK/narrow rendering checks where relevant, bundle
and standalone compilation, a clean-checkout packaging check, a scoped commit,
and a push to `main`.

## 1. TUI interaction contract

- Keep the terminal lanes primary and the evidence inspector read-only and
  collapsible.
- Each lane owns an independent viewport with line-based scrolling, follow-tail
  mode, a visible offset, and discoverable `PgUp`, `PgDn`, `Home`, and `End`
  controls. New output does not steal the user's position while follow-tail is
  disabled.
- Retain a bounded structured activity log per lane. Text, command/tool start,
  progress, completion, file changes, approvals, warnings, and failures remain
  separate entries rather than one lossy `toolSummary` string.
- Tool entries start collapsed. The user can select and expand one entry to see
  sanitized command, path, status, duration, and bounded provider-native detail.
- The layout has explicit wide, medium, and narrow modes. Narrow terminals show
  one focused lane and a compact status bar; switching focus never drops output.
- Help is an in-product overlay. Every active modal shows its own available
  actions, and unavailable actions explain their requirement.
- Errors are classified as discovery, authentication, invalid model, protocol,
  permission, process exit, and configuration errors. The primary lane shows a
  short action; the diagnostic overlay keeps bounded sanitized detail.
- Approval modals show provider, safety effect, exact bounded command/tool,
  cwd, affected paths, network effect, and only supported decisions. Read-only
  approval requests remain deny-only and never enter an allow-capable inbox.

## 2. Queue contract

- Each provider has one active turn and a visible FIFO queue capped at 10
  immutable prompt envelopes.
- A request targeting one provider may be queued only for that provider. The
  user can inspect and remove it before dispatch.
- A request targeting both providers is one atomic queue group. It starts only
  when both lanes can start together; it is never partially dispatched.
- When either selected lane is busy, sending opens an explicit choice to queue
  the whole request or cancel. There is no implicit append and no automatic
  retargeting.
- Model, workspace mode, writer identity, and per-request overrides are frozen
  into the queued envelope. If the writer lease or safety mode changes before
  dispatch, the item becomes `NEEDS_CONFIRMATION` rather than inheriting new
  authority.
- Cancelling a running lane does not remove unrelated queued items. Closing the
  application discards queues; queue persistence is outside v0.1.

## 3. Configuration contract

- Use versioned JSON with strict hand-written validation so the standalone
  binary does not add a YAML parser solely for configuration.
- Project-safe config is `.splitlane/config.json` under the Git repository root
  and may be committed. It contains models, UI preferences, role hypotheses,
  queue limit up to 10, and stable/preview capability preferences only.
- User config is:
  - macOS: `~/Library/Application Support/Splitlane/config.json`
  - Linux: `${XDG_CONFIG_HOME:-~/.config}/splitlane/config.json`
- Session/run state is separate:
  - macOS: `~/Library/Application Support/Splitlane/state/`
  - Linux: `${XDG_STATE_HOME:-~/.local/state}/splitlane/`
- Precedence is per-request, project, user, then provider CLI default.
- Unknown safety-critical keys and invalid values fail with an actionable path;
  they are never silently ignored. Unknown non-safety keys are also rejected in
  v0.1 to catch typos.
- Configuration never stores credentials, provider config paths, writer leases,
  blanket approvals, or session IDs.
- Model selection remains provider-local. `default` passes no override; exact
  IDs are allowed; recent successful IDs are conveniences, not a fixed catalog.
  A model change clearly requires a new provider session.

## 4. Session and recovery contract

- Store atomic `session-state/v1` JSON records keyed by a SHA-256 project-root
  identity and provider. Records contain only opaque provider session ID,
  requested/effective model, project identity, provider version, timestamps,
  and clean/interrupted status.
- Transcript retention is OFF by default. Enabling it later stores bounded,
  sanitized normalized events; raw provider messages and secrets are never
  persisted.
- First startup with restorable sessions uses an explicit `Restore`, `Start
  new`, or `Inspect metadata` modal. `restore_sessions: ask` is the default.
- Restoration uses provider session/thread IDs. Splitlane never replays prompts
  to simulate continuity.
- Provider/version/model/project incompatibility produces a provider-specific
  refusal and leaves the other provider independently restorable.
- An unclean shutdown marks sessions interrupted. Resuming an interrupted
  session requires separate confirmation and never restores a writer lease,
  approval, queue, running turn, or build/review mode.
- Resetting one lane deletes only that lane's Splitlane metadata after explicit
  confirmation; it does not modify provider-owned history.

## 5. Two-lens review and role handoff contract

- Two-lens review freezes one exact review envelope and starts Claude and Codex
  as independent read-only reviewers only after the writer lease is revoked.
- Both reviews may stream concurrently, fail independently, and be cancelled
  independently. Findings stay separated by provider/mechanism and envelope
  hash. Splitlane does not grade, merge, deduplicate, or declare agreement.
- A missing/busy provider causes an explicit refusal or a user-selected
  single-lens fallback before any review starts; there is no silent partial run.
- Role recommendations are visible routing hypotheses and are enabled by
  default, but never dispatch automatically. The default profile remains
  Claude for scout/architect/intent review and Codex for builder/debugger/
  correctness review; user and project config can override every role.
- Scout → architect → builder is a sequence of user-confirmed artifact packets,
  not automatic delegation. Each step previews objective, constraints, relevant
  files, open questions, acceptance criteria, source provider/session, and
  frozen Git fingerprint before the user selects the next harness.
- Handoffs copy only the explicit bounded packet, never hidden transcript data.

## 6. Isolated worktree contract

- `isolated` is an explicit workflow mode. Each active provider receives its
  own Git worktree and may write only inside that worktree; the primary working
  tree remains observational.
- Worktrees live under the user state directory, not inside the repository:
  `state/worktrees/<repo-hash>/<run-id>/<provider>/`.
- Branches use `splitlane/<run-id>/<provider>` after collision checks. Splitlane
  refuses dirty/unborn/unsupported repositories until the relevant recovery
  case is explicitly handled; it never stashes, resets, or discards files.
- Creation previews base commit, branch, directory, provider, and cleanup policy
  and requires confirmation. No repository setup script runs automatically and
  ignored/untracked files are not copied silently.
- A manifest records worktree path, branch, base commit, provider, process state,
  and lifecycle state using atomic writes. Startup detects orphaned manifests
  and offers inspect, keep, or safe cleanup.
- Cleanup requires idle provider processes and a clean worktree. Dirty or
  unmerged worktrees are retained with recovery commands; `--force` removal is
  never a product action.
- Integration is user-controlled. Splitlane provides read-only diff/commit
  evidence and copyable merge or cherry-pick commands, but does not execute an
  automatic merge, cherry-pick, branch deletion, or conflict resolution in
  v0.1.

## 7. Compatibility and verification contract

- Ordinary tests use captured redacted fixtures and fake CLIs only. They start
  no provider model turn and need no credentials or internet.
- Every adapter parser or resume change adds normal, malformed, error,
  cancellation, and abrupt-exit fixtures for the affected installed CLI
  contract.
- A local compatibility command performs binary discovery, version/help/schema
  probes, auth-status classification when safely available, sandbox capability
  checks, and a no-model-turn transport initialization.
- Paid live gates stay opt-in with a conspicuous consent flag and disposable Git
  repository. The broad implementation request does not silently authorize
  model usage; each live gate reports its planned number of provider turns.
- Each user-visible increment passes type checking, all offline tests, current
  platform bundle/standalone builds, Linux x86_64 cross-compilation, clean
  checkout installation, and terminal restoration smoke checks.

## 8. Delivery order and exit gates

1. TUI activity model, scrolling, responsive layout, help, and error/approval
   presentation.
2. Configuration/model precedence and atomic queue groups.
3. Session store, startup restore confirmation, lane-local reset, and recovery.
4. Two-lens review and explicit scout/architect/builder packets.
5. Isolated worktree lifecycle, evidence, orphan recovery, and integration
   commands.
6. Full fake-CLI matrix, opt-in live gates, packaging regression, and the next
   preview release.

No increment is complete merely because it renders. Its state transitions,
safety refusals, CJK/narrow behavior, provider isolation, and clean packaging
must be verified before commit and push.

## Approval requested

Approval of this document confirms these material choices:

1. JSON paths and strict precedence/validation.
2. Bounded per-provider queues with atomic paired dispatch and no persistence.
3. Metadata-only session restoration with `ask` default and transcripts OFF.
4. Visible but non-automatic role recommendations and user-confirmed handoffs.
5. User-state worktrees with clean-only non-force cleanup and no automatic
   integration.
6. Offline verification by default; paid live gates require separate explicit
   consent.

## Approval record

The user approved the complete proposal on 2026-07-26. Implementation remains
incremental: approval of the contract does not waive per-increment verification
or authorize paid live model turns.

## Implementation checkpoints

### 2026-07-26 — TUI activity and navigation

- Added independent lane scrolling with explicit follow-tail state and stable
  positioning while new output arrives.
- Added a bounded structured activity log for tools, files, approvals, warnings,
  and failures, including expandable details and safety effects.
- Added provider-error classification with actionable guidance, a discoverable
  keyboard-help overlay, and more explicit approval context.
- Verified responsive focused/stacked/column layout behavior, Korean grapheme
  rendering, scrolling, activity expansion, bounded retention, error guidance,
  and terminal alternate-screen restoration.
- Offline validation passed 69 tests plus type checking. No provider model turn
  or credential was used.

### 2026-07-26 — Configuration and atomic queues

- Added strict `config/v1` user and project JSON with exact-key validation,
  documented platform paths, field-level project precedence, provider-local
  model sources, role/UI settings, preview preference, and a queue limit from 1
  through 10.
- Added an explicit busy-lane Queue/Cancel choice, per-provider FIFO capacity,
  atomic `both` groups, immutable prompt/model/authority snapshots, removable
  queue entries, and `NEEDS_CONFIRMATION` after writer authority changes.
- Added visible queue and configuration overlays. No queued request retargets,
  dispatches partially, inherits a new writer lease, or survives application
  shutdown.
- Credential-free tests cover precedence, invalid paths and keys, model source,
  queue bounds, paired-lane atomicity, frozen models, authority reconfirmation,
  removal, rendering, and shutdown cleanup. Type checking, 74 offline tests,
  macOS/Linux builds, and terminal restoration passed; no provider model turn
  was started.

### 2026-07-26 — Session metadata and restoration

- Added atomic `session-state/v1` records under the user state directory with a
  SHA-256 project identity, provider/model/version metadata, clean/interrupted
  state, and restrictive file permissions. Transcripts remain disabled.
- Added startup Restore, Start new, and Inspect metadata choices, provider-local
  compatibility failures, direct Claude session and Codex `thread/resume`
  restoration, and a confirmed focused-lane reset.
- Restoring never replays prompts or restores workflow mode, writer authority,
  approvals, queues, or running turns. Reset removes Splitlane metadata only.
- Type checking, 77 offline tests, macOS/Linux standalone builds, the locally
  generated Codex resume schema, reset-modal rendering, and terminal restoration
  passed without credentials or a model turn.

### 2026-07-26 — Two-lens review and role handoff

- Added an explicit two-lens start that revokes the writer lease, freezes one
  objective/criteria/Git diff identity, and runs Claude and Codex read-only with
  independent status, cancellation, parser errors, and attributed findings.
- Added lens switching without merging, deduplicating, grading, or claiming
  agreement. A selected finding relay comes from one visible lens only.
- Added bounded scout → architect → builder packets with objective, constraints,
  files, questions, acceptance criteria, source provider/session, and Git
  fingerprint. Confirmation prepares the editor but never changes routing or
  starts a turn.
- Type checking and 80 offline tests cover same-diff identity, independent
  completion/failure/cancellation, provider-attributed findings, single-lens
  relay, bounded Korean handoff rendering, and zero implicit dispatch.
