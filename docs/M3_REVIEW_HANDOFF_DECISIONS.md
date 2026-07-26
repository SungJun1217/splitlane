# M3 Reviewer Handoff Decisions

Status: approved for implementation on 2026-07-26

Last updated: 2026-07-26

## Scope

M3 adds one explicit handoff from an idle writer to one read-only reviewer, a
frozen review envelope, structured findings, and a user-confirmed path for
returning selected findings. It does not add an automatic fix/review loop,
automatic finding acceptance, persistent transcripts, simultaneous reviewers,
or a second writer.

The first M3 slice establishes the safety boundary and provider-neutral review
contract. Two-lens review and scout/architect handoff reuse that contract but
remain separate follow-up increments so their routing choices are not silently
made by this implementation.

## Proposed behavior

### 1. Entering review

- `Ctrl+V` opens a review handoff modal only while Splitlane is in `build`, the
  writer lane is idle, and no approval is pending.
- The modal shows the original writer, proposed reviewer, provider mechanism,
  branch and base revision, changed files, diff byte size, and diff hash.
- The default reviewer is the provider other than the writer. The user may
  cancel, but M3 does not silently substitute the writer or another mechanism.
- Confirming the handoff atomically revokes the writer lease before the review
  turn starts. The workflow becomes `review`, global writer authority becomes
  `none`, and the original writer remains visibly identified as `PAUSED` in the
  handoff metadata.
- A busy or unavailable reviewer, active writer turn, pending approval, missing
  Git repository, empty diff, or oversized review packet causes a clear refusal
  without changing the current writer lease.
- Every review turn passes `read_only`, a null writer lease, and a deny-only
  approval callback. Any reviewer permission request is rejected and recorded.

### 2. Frozen review envelope

The confirmation step creates an in-memory, versioned `review-envelope/v1`:

```text
id and creation time
original writer and selected reviewer
review mechanism and stability label
objective and acceptance criteria
project root, branch, HEAD/unborn marker, and writer baseline fingerprint
changed-file list and pre-existing/writer-hinted/unknown labels
exact bounded unified diff, byte size, SHA-256, and truncation state
```

- The objective defaults to the most recent prompt delivered to the writer.
  Before dispatch, the user confirms or edits the objective and supplies the
  acceptance criteria; Splitlane does not invent missing criteria.
- The patch includes staged and unstaged tracked changes plus bounded patches
  for untracked regular files. Symlinks and binary files are represented with
  explicit metadata rather than followed or decoded.
- The packet limit is 200 KiB after UTF-8 encoding. M3 refuses to start a review
  when the exact packet would exceed the limit; it never silently truncates a
  patch and presents it as complete.
- The reviewer receives the frozen patch in the prompt. It may read the
  workspace for context, but the findings remain tied to the envelope hash.
- Git is fingerprinted again when the review ends. If the workspace changed,
  the result is visibly `STALE`; file/line navigation remains available but
  findings cannot be returned without an explicit stale-result acknowledgement.

### 3. Provider mechanism and structured findings

- The confirmation modal names the exact mechanism: `Codex native review`,
  `Codex generic read-only turn`, or `Claude generic read-only turn`.
- Codex native review is offered only when the local runtime probe confirms its
  required flags and a credential-free fake-CLI test validates read-only
  invocation. It is never selected by silent fallback.
- If native review is unavailable, the user may explicitly choose the generic
  Codex read-only mechanism. Claude uses a generic read-only Agent SDK turn in
  this slice; it is not presented as equivalent to a provider-native review.
- All mechanisms receive `review-findings/v1`, a strict data contract with:
  finding ID, provider, severity (`blocker`, `high`, `medium`, `low`, or
  `info`), title, exact review text, optional file and line range, and optional
  verification suggestion.
- Model output is untrusted. A bounded parser accepts only schema-valid JSON
  inside explicit Splitlane sentinels, sanitizes every string, rejects paths
  outside the project, and retains malformed output only in the ordinary lane
  output and diagnostics. Splitlane never fabricates findings from prose.
- Findings always display provider, mechanism, envelope hash, and stale state.
  Agreement between providers is not represented as proof.

### 4. Completing review

The user explicitly selects one of three actions:

- `Accept`: leave review for `compare`, keep the in-memory findings visible,
  and grant no writer lease. This does not commit, stage, or push.
- `Return selected findings`: preview a lossless relay containing provider,
  severity, file/line, and exact finding text. After confirmation, return to the
  existing two-step writer promotion for the original writer and place the
  relay in the shared prompt editor. M3 does not send it automatically.
- `Exit without action`: return to `compare` with no writer and no provider
  dispatch. Findings remain in memory until replaced or the application exits.

No action starts another review or build turn automatically. Re-entering build
captures a new Git baseline and requires a new writer lease.

### 5. Inspector navigation

- The inspector gains `DIFF` and `FINDINGS` tabs but remains read-only.
- Selecting a finding chooses its file and line range when valid. It does not
  open an editor, alter focus, execute a command, or mutate Git state.
- Missing, renamed, binary, outside-root, or stale locations show an actionable
  explanation instead of guessing a replacement path.
- Narrow terminals keep the terminal lane primary; the findings list may
  collapse to severity, file, line, and title.

## Verification gate

- State-machine tests prove that review cannot coexist with a writer lease and
  that a reviewer always receives read-only options.
- Fake providers cover unavailable/busy reviewers, permission requests,
  malformed findings, cancellation, provider failure, and independent writer
  session preservation.
- Git fixtures cover staged, unstaged, untracked, binary, symlink, oversized,
  outside-root, renamed, and externally changed review inputs.
- Relay tests prove that only user-selected findings are included, attribution
  and exact text are retained, and no prompt is sent before confirmation.
- Rendering tests cover Korean/wide characters, narrow terminals, stale
  findings, and invalid file locations.
- No automated test starts a real model turn. A disposable-repository live
  review remains separately opt-in.

## Approval record

The user approved these three material choices together on 2026-07-26:

1. Review confirmation revokes the writer lease first; the original writer is
   paused metadata only, and every reviewer mechanism is read-only.
2. Reviews use an exact in-memory patch capped at 200 KiB and refuse rather than
   silently truncate; later workspace drift marks the result stale.
3. The first slice supports one explicitly chosen reviewer mechanism and a
   user-confirmed findings relay. Native Codex review is capability-gated,
   generic fallback is explicit, and two-lens/scout handoffs remain later M3
   increments.

## Implementation checkpoint

The first offline M3 slice passed on 2026-07-26. The implementation freezes
tracked and untracked changes into a SHA-256-addressed packet, refuses packets
over 200 KiB, revokes the writer lease before review dispatch, denies reviewer
permission requests, validates bounded structured findings, detects workspace
drift, previews valid file/line locations read-only, and returns only selected
findings through a user-controlled relay.

Sixty-four credential-free tests, type checking, bundle compilation, and
standalone compilation pass without a provider model turn. Codex native
`review/start` remains unavailable in the UI until its structured event and
cancellation contract is covered by a version-matched fake app-server fixture.
Two-lens and scout/architect handoffs remain later M3 increments, so the overall
M3 milestone is not yet marked complete.
