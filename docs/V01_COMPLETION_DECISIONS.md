# v0.1 Completion Decisions

Status: approved for implementation on 2026-07-26

Last updated: 2026-07-27

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

### 2026-07-27 interactive TUI audit addendum

An interactive 140-column and 80-column PTY audit found three usability defects
that are approved for correction without changing product authority or routing:

- `Ctrl+I`, `Ctrl+M`, and `Ctrl+H` collide with terminal Tab, Enter, and
  Backspace control bytes. Evidence toggle, model selection, and role handoff
  therefore move to `Option+I`, `Option+M`, and `Option+H`. The help overlay and
  documentation must show the same bindings.
- The narrow layout must reserve the actual four-row compact header, editor,
  optional notice, and one-row footer before dividing the remaining viewport.
  Lane, inspector, and inter-panel gaps must never exceed the declared terminal
  height. The hidden lane remains visible as a compact independent status. In
  medium and wide layouts, the terminal lanes retain two thirds of the width so
  long evidence paths cannot make the read-only inspector become primary.
- While a modal owns input, the shared prompt editor is hidden and the footer
  identifies modal state. Startup restore metadata opens on the first render,
  avoiding a misleading frame where the normal editor briefly appears.

The capability screen is a read-only runtime reference, not a command palette.
It uses human-readable action names and keeps provider-specific stability
labels visible. Model source and peer-context status use user-facing wording
while preserving their existing underlying values.

### 2026-07-27 view and send separation

The user clarified that `BOTH` primarily describes seeing both terminal lanes,
not an implicit instruction to send every composer submission twice. The UI
therefore separates these concepts:

- The default view is `BOTH`: Claude is above Codex, with the read-only evidence
  inspector to their right when width permits. A narrow terminal keeps both
  lanes stacked and temporarily hides the inspector rather than hiding a lane.
- `Option/Alt+0` explicitly switches between both-lane and focused-lane views.
  `Option/Alt+1` and `Option/Alt+2` only focus a lane. They never change the
  composer mode or send route.
- The default send route is Codex, matching the initial builder focus. The route is
  always printed as `send CLAUDE`, `send CODEX`, or `send BROADCAST` in both the
  header and composer. Only the explicit `BROADCAST` route starts both harnesses.
- `Ctrl+R` cycles send routes independently of view. Broadcast remains atomic
  and retains every existing queue, session, and workspace safety rule.

The lane hierarchy is invariant at wide and ultra-wide sizes: Claude stays
above Codex on the left and the evidence inspector stays on the right. Extra
width must not turn the three regions into equal peer columns. The status line
must describe the active composer mode; direct mode cannot be labeled as an
active guided flow.

The default composer mode is the human-gated `TASK FLOW`. Enter first opens a
two-step confirmation that grants Codex the existing single-writer lease and
dispatches only the confirmed task. After Codex completes, Splitlane prepares
the existing frozen-diff review dialog for Claude but does not start the Claude
turn until the user confirms it. Findings never return automatically: the user
selects them and explicitly requests a Codex revision. `Option/Alt+D` switches
to `DIRECT`, where the existing Claude, Codex, and Broadcast routes behave as
before. This adds no automatic debate or unbounded loop.

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

### 2026-07-27 approved revision — shared meta conversation

- One visible `meta-session/v1` owns both provider-native child sessions. Claude
  session IDs and Codex thread IDs remain independent implementation details;
  Splitlane never claims they are one provider session.
- Ordinary user prompts and bounded provider text results form one in-memory
  turn ledger. A provider's next requested turn receives every ledger entry it
  has not seen, including peer results and provider-only turns. No hidden model
  turn is started solely to synchronize an inactive lane.
- Parallel results join the shared ledger only after each result arrives, so
  same-turn agents do not see one another. Both receive those peer results on a
  subsequent turn. The UI displays pending-entry counts and injected byte size.
- Peer results are delimited as untrusted quoted context, not system or tool
  instructions. Tool calls, approvals, raw provider events, credentials, and
  workspace authority are never copied into the relay.
- The shared text window is sanitized, per-entry bounded, globally bounded, and
  memory-only. Session metadata may persist only the opaque meta-session ID and
  a synchronization epoch; no prompt or provider output is persisted.
- Restoration groups matching child sessions under the prior meta-session ID
  but starts a visible new synchronization epoch. Splitlane does not replay
  unavailable transcript text or pretend that an undelivered pre-shutdown delta
  was synchronized.

The user explicitly approved this revision on 2026-07-27 after clarifying that
Splitlane must behave as one shared meta conversation rather than two merely
adjacent conversations.

### 2026-07-27 approved revision — preview stabilization

- An ambiguous Codex `turn/start` or failed `turn/interrupt` must fail closed by
  terminating that provider transport. Splitlane must not revoke the visible
  writer lease while an untracked Codex turn may still be running.
- Model changes are refused while that provider lane is active. Requested and
  effective models remain distinct, and a provider-confirmed effective model is
  never fabricated before a new session starts.
- Two-lens review uses independent review sessions without discarding the
  original provider session handles. Returning to compare preserves the prior
  native-session continuity.
- Runtime capability status, Git/project readiness, and unavailable preview
  actions must be reported honestly. Static reference copy is not sufficient
  evidence that a native action is available.
- The evidence inspector, Git status parser, help copy, and recovery diagnostics
  are hardened to match the documented v0.1 behavior before the preview is
  treated as complete.

The user approved this stabilization work on 2026-07-27 after reviewing the
repository analysis and reproduced failures. The change does not add automatic
routing, merging, provider turns, or broader write authority.

### 2026-07-27 approved revision — standalone automatic updates

- GitHub Release standalone installs default to background `auto` checks on TUI
  startup, limited to once per 24 hours. Checks contact only the public
  Splitlane release endpoint and send no telemetry.
- Installation happens beside the current regular, non-symlink executable.
  Stable SemVer, platform asset name, bounded download, published SHA-256, and
  downloaded `--version` must all match before an atomic rename. Failure leaves
  the running and on-disk current version intact.
- An installed update never restarts the TUI or either provider. It becomes
  active on the next Splitlane launch and produces a visible restart notice.
- `splitlane update` performs an explicit immediate check. The user config key
  `updates.mode` accepts `auto`, `notify`, or `off`; project config cannot
  control executable updates. `SPLITLANE_DISABLE_AUTOUPDATE=1` disables only
  background auto-checks.
- Source runs, package-managed/symlink paths, unsupported platforms, and
  unwritable destinations are not modified automatically.

The user explicitly approved automatic updates on 2026-07-27, asking for
Claude Code-like behavior after the `v0.0.4` standalone release.

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

### 2026-07-26 — Isolated worktree lifecycle

- Added an explicit no-write preview followed by one user-state worktree,
  collision-checked branch, workspace guard, and writer lease per provider. The
  primary tree remains observational and provider sessions restart independently
  in their own roots.
- Added atomic `isolated-run/v1` manifests, startup recovery, per-lane
  status/head evidence, explicit inspect/retain/cleanup actions, and manual
  diff/log/merge/cherry-pick command hints without executing integration.
- Cleanup never uses force and refuses active processes, queued frozen authority,
  dirty/unreadable worktrees, and commits not reachable from the primary branch.
  Worktree branches are retained even after clean directory removal.
- Offline tests cover preview immutability, separate roots and leases, primary
  tree isolation, provider-local approvals, dirty and unintegrated retention,
  restart recovery, clean cleanup, branch preservation, and dirty-primary
  refusal. No provider model turn or network access was used.

### 2026-07-26 — Compatibility doctor and packaging gate

- Added `splitlane doctor [project] [--json]` with a versioned `doctor/v1`
  report for binary/help discovery, coarse auth classification, local Codex
  schema generation, sandbox contract checks, and app-server initialization.
- Doctor starts no Claude query, Codex thread, or provider turn; it uses no
  bypass flag, never prints raw auth output, and writes neither provider config
  nor credentials. Provider failures remain separately attributed.
- Fake-provider tests prove successful initialization, zero thread/turn calls,
  missing-binary failures, and secret-free human/JSON output. The installed
  Claude Code 2.1.220 and Codex CLI 0.145.0 probe passes required transports;
  native Codex review remains a visible local capability warning.

### 2026-07-27 — Shared meta conversation

- Grouped the independent Claude Code and Codex native sessions under one
  visible `meta-session/v1` identity. Ordinary prompts and attributed text
  results are relayed into the other requested lane on its next real turn.
- Provider-only turns use lazy synchronization, and parallel results become
  peer context on the following turn. Splitlane does not start hidden paid
  turns or claim that the two provider-native session identifiers are equal.
- Peer output is bounded, terminal-sanitized, credential-redacted, and clearly
  marked as untrusted quoted evidence. If one provider falls too far behind,
  dispatch refuses with a visible catch-up instruction instead of dropping
  unseen context.
- Shared transcript text remains memory-only. Session state persists only the
  opaque meta ID and epoch; restoration starts a visible new epoch without
  replaying or fabricating conversation history.
- Offline fake-provider coverage verifies bidirectional relay, lazy single-lane
  catch-up, independent failure attribution, child-session reset resync,
  metadata-only restoration, credential redaction, UTF-8-safe bounds, and
  narrow Korean rendering. No provider model turn or credential is used.

### 2026-07-27 — Standalone automatic updates

- Added background daily release checks only for regular standalone executables
  bearing the exact non-secret `install.sh` ownership marker. Source runs,
  unmanaged files, symlinks, and unsupported targets perform no network call.
- Added bounded GitHub release metadata, checksum, and binary downloads with
  stable SemVer, trusted asset URL, SHA-256, and downloaded `--version`
  verification before an adjacent atomic rename. The active process is never
  restarted and all failures preserve the prior executable.
- Added `splitlane update`, user-only `updates.mode` (`auto`, `notify`, `off`),
  `SPLITLANE_DISABLE_AUTOUPDATE=1`, visible restart/failure notices, a persisted
  non-secret daily check timestamp, and shutdown cancellation.
- Offline tests cover successful replacement, notification-only behavior,
  checksum and version mismatch preservation, unmanaged/symlink refusal, daily
  cadence, forced manual checks, cancellation, config boundaries, UI reporting,
  and installer marker creation. The complete suite passes 104 tests without a
  provider model turn or release-network request.

### 2026-07-27 — Interactive UX and guided task flow

- Separated both-lane/focused viewing from direct Codex, Claude, and Broadcast
  routing. The default 80-column view keeps both lanes visible; normal-width
  terminals keep Claude above Codex with the read-only code/evidence inspector
  on the right.
- Added the human-gated Task Flow: two confirmations grant Codex the existing
  single-writer lease and start one build. Completion prepares the existing
  frozen-diff Claude challenge dialog, but Claude does not start until the user
  confirms. Selected findings return only through the existing explicit revise
  action; no automatic debate or unbounded retry was added.
- Reworked visual hierarchy, compact status, composer modes, modal focus,
  terminal-safe Option/Alt shortcuts, model/context labels, and evidence line
  fitting. Interactive 80×24 and 140×40 PTY checks exercised restore, both and
  focused views, flow confirmation, direct mode, model selection, and clean
  shutdown without starting a provider model turn. The complete offline suite
  passes 106 tests, including guided single-writer routing and responsive CJK
  rendering checks.

### 2026-07-27 — Ultra-wide hierarchy correction

- A user-captured ultra-wide terminal exposed an incorrect three-peer-column
  breakpoint. Removed that breakpoint: Claude now remains above Codex in the
  left workspace and the evidence inspector remains on the right at every
  inspector-capable width.
- Lane focus and direct routing are fully separated. `Option/Alt+1` and
  `Option/Alt+2` only move visual focus; they cannot switch to direct mode or
  retarget a prompt. `Ctrl+R` remains the explicit direct-route control.
- Flow and direct status copy now reflects the active composer mode. A 240×60
  PTY check verified stable hierarchy, focus-only `Option/Alt+1`, direct Codex
  routing after the focus change, and clean shutdown without a model turn.

### 2026-07-27 — Small-terminal and modal visibility audit

A scripted PTY sweep across 80 and 140 columns at 10–30 rows, plus scenario runs
driven by fake adapters, found six defects. All are corrected without changing
routing, authority, or any safety invariant.

- **Height contract.** Below 18 rows (80 columns) and 19 rows (140 columns) the
  declared panel heights exceeded the terminal: lane text overprinted borders and
  at 80×12 the mode and writer header scrolled off screen. `contentHeight` no
  longer floors at 5 rows and lane output no longer floors at 2, `layout.ts` now
  publishes `laneChrome`, `minimumRows`, `fitsTerminal`, and `laneOutputRows`, and
  the root and lane boxes carry an explicit height with `overflow: hidden`. Header,
  footer, notice, composer, and lane rows truncate instead of wrapping, so no
  string length can inflate the row budget. Below the minimum the TUI renders a
  `TERMINAL TOO SMALL` screen that still shows workspace mode, writer, both lane
  states, the required size, and `Ctrl+Q`.
- **Approval visibility.** A dispatch can raise an approval before its own promise
  resolves, and the unconditional `setOverlay(null)` in the guided-build, writer,
  and review handlers dismissed the approval inbox the effect had just opened,
  leaving the writer lane `BLOCKED` with no modal. Those handlers now close only
  the overlay they opened.
- **Refusal visibility.** `snapshot.notice` rendered only when no modal was open,
  so every refusal raised by a modal action was invisible — the guided flow could
  reach the writer confirmation with an unavailable provider and then do nothing.
  Notices now render under modals as well.
- **Running lanes under a modal.** A modal blanked the whole workspace. One
  truncated status row per lane now stays visible whenever the terminal has room
  for it.
- **Unavailable providers.** `promoteWriter` reported an unavailable lane as
  "active"; it now names discovery, and the guided-flow confirmation marks
  unavailable lanes before the final gate.
- **Findings, shortcuts, and stale notices.** The findings overlay lists all
  findings with a cursor, count, and position instead of one at a time. `Ctrl+D`
  and `Ctrl+K` are documented in the help overlay and README, with a test that
  asserts every bound `Ctrl` key is documented in both. Notices expire after 12
  seconds so a past refusal stops reading as current state, and doctor separates a
  missing project path from an unreadable repository.

Verification: `tsc --noEmit`, 95 offline production tests plus the spike suite,
Bun bundle and standalone compilation, a 24-size PTY sweep with zero overprinted
border rows, and scenario runs covering broadcast streaming, lane-local
cancellation, atomic queue refusal, writer grant with an approval inbox, and
two-finding review. No run started a provider model turn.
