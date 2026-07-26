# M0 Protocol and Safety Spike

Status: live protocol validation complete; architecture decision pending

Last updated: 2026-07-26

## Scope

The default spike validates the installed official Claude Code and Codex CLIs
without sending a model prompt. Separate consent-gated commands capture live
compatibility evidence. The spike is deliberately separate from the production
TUI and does not decide the final renderer, package format, approval UX, or
persistence policy.

The checked-in probe must:

- discover each CLI from the current environment;
- record versions and supported command surfaces without storing credentials;
- initialize Codex app-server over stdio without starting a model turn;
- derive capabilities from command help and the installed Codex protocol schema;
- label unproved behavior as blocked or unavailable rather than inferring it;
- terminate the complete process group on cancellation, escalating when a child
  ignores graceful termination;
- emit a redacted runtime capability manifest suitable for architecture review;
- validate atomic broadcast reservation, isolated provider failure, lane-local
  cancellation, and legal lane state transitions with fake lanes.

## Safety rules

- The default probe never calls `claude -p`, `codex exec`, `turn/start`, or any
  other operation that can consume model usage.
- It never passes a permission or sandbox bypass flag.
- It never modifies provider-owned configuration.
- Authentication probes retain only a boolean login state and a coarse method;
  email, organization, tokens, home directories, and other account details are
  discarded before output.
- Live turn, resume, approval, and interruption capture remains a separate,
  explicit opt-in step because it may consume subscription usage.

## Current local evidence

The first validation host has Claude Code 2.1.220, Codex CLI 0.145.0, Node
26.3.0, and Bun 1.3.14. Go is not installed. This favors a TypeScript-oriented
transport spike because Codex can generate version-matched TypeScript and JSON
Schema bindings, but it is not yet the production stack decision.

Codex app-server advertises typed thread, turn, interrupt, model, and approval
methods. A live read-only persistent thread completed, resumed through a new
app-server process with the same thread ID and exact model, and returned an
`interrupted` completion after `turn/interrupt`. A command approval request was
received and answered with `cancel`; the requested file was not created. The
persistent proof thread was archived and the approval thread was ephemeral.

Claude Code print-mode stream JSON completed and resumed with the same session
ID. Cancelling an active stream did not exit within the spike's 500 ms SIGTERM
grace period and therefore escalated to SIGKILL on the validation host. Public
CLI stream input did not expose a usable documented
approval round trip. The official Claude Agent SDK 0.3.220 did invoke
`canUseTool`; a `deny` result was accepted and the requested file was not
created. This makes the official SDK the supported Claude build-mode transport
candidate rather than a private CLI control protocol. Claude Code also advertises
model selection, plan permission mode, partial messages, hook events, and
forwarded subagent text. The CLI-only approval path remains unavailable, while
the version-matched SDK approval capability is now marked available.

## Commands

```text
npm test
npm run probe
npm run probe:live:claude
npm run probe:live:claude-sdk
npm run probe:live:codex
```

Each probe writes JSON to stdout. The three `probe:live:*` commands refuse to run
unless their explicit consent flag is present in the package script. Live probes
use temporary workspaces; the Codex persistence proof archives its completed
thread, while Claude retains the provider session required to prove resume.

## Remaining M0 gates

- Native action observation/cancellation proof using real turns.
- Repository-local role-profile evaluation set and recorded results.
- User approval of the production stack recommendation and Claude SDK transport.

## Architecture recommendation

Use TypeScript for the production adapters and orchestrator, with Bun retained
as the packaging/runtime candidate pending a clean-checkout binary validation.
Codex generates version-matched TypeScript protocol bindings, and Claude's
supported interactive approval path is its official TypeScript Agent SDK. Keep
Codex on app-server and Claude on the Agent SDK; do not combine them behind one
lowest-common-denominator transport. This recommendation is not final until the
user approves the technology decision from the product plan.

## Verified foundation

The automated suite currently covers capability gating, manifest/schema shape,
redaction and terminal-control sanitization, JSONL request handling, malformed
diagnostics, request timeout, full process-group escalation, atomic broadcast
reservation, immutable shared prompt envelopes, uncoupled provider startup
failure, lane-local cancellation, and legal lane transitions. All tests use fake
processes or non-model protocol initialization and require no provider
credentials.
