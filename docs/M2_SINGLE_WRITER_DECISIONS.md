# M2 Single-writer Decisions

Status: approved for implementation on 2026-07-26

Last updated: 2026-07-26

## Scope

M2 adds an explicit `build` mode, one in-memory writer lease, provider-native
approval requests, and Git baseline/change evidence. It does not add reviewer
handoff, automatic merging, persistent sessions, worktrees, queues, network
access, or simultaneous writers.

The proposal keeps the M1 adapter split. Claude Code uses the official Agent
SDK permission callback; Codex uses app-server server requests. Their decisions
are presented with provider attribution and are not described as identical
features.

## Approved behavior

### 1. Entering and leaving build mode

- `Ctrl+B` opens a two-step modal: select `Claude` or `Codex` as writer, then
  confirm the project root, effective model, current dirty files, and
  `workspace-write / network-off` effect.
- Merely focusing a lane, changing a role, or targeting a provider never grants
  write access.
- Entering build does not silently change the prompt target. The target remains
  visible and must be changed explicitly with the existing target control.
- A `both` target is permitted: the writer receives workspace-write and the
  peer receives the same immutable prompt read-only. Atomic busy-lane refusal
  remains unchanged.
- `Ctrl+W` revokes the writer. If its turn is active, Splitlane first requests
  lane-local cancellation and revokes only after the turn reaches a terminal
  state. Restart always returns to `compare` with no writer.

### 2. Writer lease and workspace boundary

- The orchestrator owns one non-persistent lease containing project root,
  provider, lease ID, grant time, and Git baseline fingerprint.
- A provider adapter cannot request workspace-write without a matching lease.
  The other provider is always read-only.
- The writer is restricted to the repository root with network access off.
  Splitlane never selects danger-full-access or a hidden permission-bypass mode.
- A dirty working tree is allowed only after explicit confirmation. Pre-existing
  files are recorded separately from files changed after the lease was granted.
- Approval, cancellation, adapter failure, transport exit, and application exit
  all fail closed. No lease or approval cache is restored on restart.
- The Git baseline belongs to the build cycle, not to the lease. Revoking a lease
  — including the automatic revocation after a cancelled or failed writer turn —
  surrenders write authority but keeps the baseline, and re-promoting a writer
  reuses it instead of capturing a new one. Capturing a fresh baseline on every
  promotion silently re-classified the edits the earlier turn had already made as
  `pre-existing`, so they dropped out of the review diff and the user could not
  cancel and re-prompt a writer within one build session without losing evidence.
  The baseline is cleared only where the cycle genuinely ends: review accepted or
  exited, and entering isolated mode (where a primary-tree baseline can no longer
  describe anything). Returning findings keeps it, because the fix round is a
  continuation of the same work and the follow-up review must still cover all of
  it. Decided 2026-07-28 in response to the review of this behavior; the
  fail-closed lease rules above are unchanged.

### 3. Approval inbox

- M2 exposes only `Allow once`, `Deny`, and `Cancel turn`.
- Session-wide allows, persistent exec-policy amendments, persistent network
  rules, and unstable grant-root behavior are not exposed in M2.
- The modal displays provider, command or tool, working directory, affected
  path when available, reason, network effect, and whether the request exceeds
  the workspace boundary. Unknown fields remain available in bounded sanitized
  diagnostics.
- `Deny` lets the provider continue when its native contract supports that;
  `Cancel turn` rejects and interrupts that lane only.
- Unexpected approval requests from the read-only peer are automatically
  denied and remain visible as safety events. Closing Splitlane resolves all
  pending requests with the provider-native deny/cancel result.
- Requests stay visibly `BLOCKED` until the user acts; there is no silent
  approval and no timer that changes the decision.

Provider mapping for the approved UI choices:

| UI choice | Claude Agent SDK | Codex app-server |
|---|---|---|
| Allow once | `behavior: allow`, `user_temporary` | `decision: accept` |
| Deny | `behavior: deny`, `user_reject` | `decision: decline` |
| Cancel turn | deny with interrupt, then close/abort | `decision: cancel` |

Claude build turns use `permissionMode: default` with `canUseTool`; no
`updatedPermissions` are returned in M2. Codex build turns use
`sandboxPolicy: workspaceWrite` with network disabled and
`approvalPolicy: untrusted`. `on-request` represents requests to cross the
sandbox boundary, so M2 deliberately does not use it for workspace-only build
turns. Runtime-generated schemas remain version-gated;
unsupported fields fail provider-locally without fallback.

### 4. Git evidence and write attribution

- Granting a lease captures HEAD/unborn state, index entries, porcelain status,
  and content hashes for current project files without writing Git objects.
- The evidence inspector distinguishes `pre-existing`, `writer-hinted`, and
  `unknown/external` changes. Git observation is evidence, not proof that the
  selected provider authored a change.
- File-change provider events are hints that trigger a debounced read-only Git
  refresh. They never expand the writable boundary.
- M2 does not stage, commit, discard, restore, or merge user files.

## Provider evidence

The locally installed Codex schema exposes stable command and file-change
approval requests. Command decisions include `accept`, `acceptForSession`,
policy amendments, `decline`, and `cancel`; this proposal deliberately exposes
only the least-persistent subset. The current Claude Agent SDK exposes an
abort-aware `canUseTool` callback with allow/deny results, decision
classification, optional permission updates, and explicit query close. M2 uses
temporary decisions only.

Codex app-server remains visibly `preview` in Splitlane even though its current
non-experimental approval messages are available. Experimental API opt-in stays
off.

## Verification gate

- Fake-provider tests prove that no state transition can create two writers.
- Adapter tests cover allow-once, deny, cancel, malformed requests, transport
  exit, and a request arriving from the read-only peer.
- Dirty-tree fixtures prove pre-existing changes are never labeled as writer
  changes and are never overwritten by Splitlane.
- Cancellation and close resolve every pending approval and remove all child
  processes.
- A live test is opt-in and runs only in a disposable repository after separate
  consent because it starts provider turns and intentionally creates files.
- The M2 exit gate is no path to two shared-tree writers and no un-attributed
  permission escalation.

## Approval record

The user approved these three material choices together on 2026-07-26:

1. Two-step writer promotion with dirty-tree acknowledgement.
2. `both` remains available in build with exactly one writer and one read-only
   peer; target never changes automatically.
3. M2 offers allow-once/deny/cancel only, with network off and no persistent
   permission rules.

## Implementation checkpoint

The offline M2 gate passed on 2026-07-26: type checking, 56 credential-free
tests, bundle and standalone compilation, Linux x86_64 cross-compilation, and a
local TUI promote/revoke smoke test all succeeded. The tests cover concurrent
promotion, dirty-tree acknowledgement, writer/peer access separation,
allow/deny/cancel mappings, outside-root and network denial, provider failure,
concurrent approvals, pending-approval shutdown, and Git evidence labels. No
paid provider turn was started. The disposable-repository live approval test
remains opt-in and needs separate consent.
