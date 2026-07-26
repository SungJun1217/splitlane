# M1 Read-only Compare Architecture

Status: approved implementation increment

Last updated: 2026-07-26

## Decision

M1 is a TypeScript/Bun application with four dependency directions:

```text
Ink TUI -> orchestrator -> provider adapter interface
                  \----> read-only Git observer

Claude adapter -> official Claude Agent SDK
Codex adapter  -> official app-server JSONL protocol
```

Provider JSON, CLI flags, and SDK message types stay inside adapters. The Ink
renderer consumes immutable application snapshots and normalized events only.

Ink 7 is selected for M1 because its current release includes alternate-screen,
window-size, focus/input, and CJK-width fixes. OpenTUI is not selected because
its Zig/FFI packaging would add a second native build decision before the Bun
binary gate is proven. The TUI boundary permits replacing Ink without changing
the orchestrator or adapters.

## M1 behavior

- Startup mode is always `compare`; both providers are technically read-only.
- `default` model sends no override. Exact model strings are provider-local and
  apply to the next request.
- Broadcast reserves both lanes before either provider receives the immutable
  prompt envelope. A busy lane causes a visible refusal and no partial send.
- Each lane owns its session, output buffer, status, error, and cancellation.
- Claude uses `permissionMode: plan`; unexpected approval callbacks are denied
  and surfaced as blocked events.
- Codex uses an ephemeral app-server thread with `sandbox: read-only` and
  `approvalPolicy: untrusted`; server approval requests are cancelled and
  surfaced. Ephemeral threads preserve continuity only while the app-server is
  alive, which matches M1's no-persistence scope.
- Provider output is sanitized and bounded before it reaches application state.
- The Git observer disables pagers, external diff, and text conversion. It never
  writes the index or working tree.
- No queue, writer promotion, persistence, review automation, or native action
  execution is added in M1.
- The displayed M1 role profile is explicitly a preview hypothesis. It does not
  resolve the pending v0.1 default-profile or first-run recommendation decision,
  and changing a role never changes prompt targeting.

## UI controls

Every shortcut is displayed in the footer or its overlay:

- `Enter`: dispatch current prompt to the visible target.
- `Ctrl+R`: cycle target `BOTH -> CLAUDE -> CODEX`.
- `Alt+1` / `Alt+2`: focus a lane.
- `Ctrl+X`: cancel only the focused lane.
- `Ctrl+I`: collapse or reveal the evidence inspector.
- `Ctrl+M`: provider-specific model picker.
- `Ctrl+P`: namespaced action palette and capability status.
- `Ctrl+O`: role-profile override. Overrides never route a prompt automatically.
- `Ctrl+D`: bounded, sanitized adapter diagnostics.
- `Ctrl+Q`: exit after closing both provider transports.

## Verification gate

- Unit tests cover state transitions, event normalization, sanitization,
  prompt-envelope atomicity, model handling, layout selection, and CJK width.
- Fake provider integration covers interleaved deltas, isolated failure,
  lane-local cancellation, approval blocking, and ignored SIGTERM cleanup.
- Ordinary tests start no provider model turns and require no credentials.
- A Bun build and non-interactive renderer smoke test must pass from the current
  checkout before the increment is considered complete.

## Implementation checkpoint

The M1 code increment was implemented on 2026-07-26. Type checking, 37 offline
tests, Bun bundling, Bun executable compilation, narrow Korean rendering, and an
interactive PTY open/exit smoke test pass. Ordinary verification starts no
provider model turns.

The product-plan live exit gate passed on 2026-07-26. A staged clean checkout
also passed frozen dependency installation, all offline tests, and Bun
single-executable compilation on macOS arm64 before the M1 implementation
commit.

On 2026-07-26 an explicitly approved live gate run completed all ten compare
pairs (20 provider turns) with stable independent sessions, every expected
marker observed, no cross-provider rejection, and no workspace change. The
initial shutdown detector found a Claude SDK child still present at its 500 ms
cutoff; a follow-up process audit confirmed it had exited. The adapter now calls
the SDK's `Query.close()` explicitly on completion, interruption, and shutdown,
and the gate harness allows up to 10 seconds while checking PID plus command
identity. A second explicitly approved run of ten compare pairs then passed:
all 20 provider turns completed, both sessions stayed stable, every expected
marker was observed, the workspace fingerprint stayed unchanged, no
cross-provider event was rejected, and no child process remained after close.
