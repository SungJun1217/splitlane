# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read first

`AGENTS.md` is the governing product contract for this repo (identity, v0.1 non-goals, safety invariants, workflow modes, pending decisions). Read it before changing behavior. This file covers only commands and architecture.

Design documents in `docs/` are the decision record; `docs/PRODUCT_PLAN.md` and `docs/V01_COMPLETION_DECISIONS.md` are the current source of truth for approved behavior, and `docs/ADAPTER_CONTRACT.md` defines the provider-adapter boundary. When a behavior is ambiguous, update the plan doc and surface the decision rather than deciding it in code.

## Commands

Runtime is Bun (TypeScript/TSX run directly, no build step for dev). Node 22+ is required for the spike tests.

```sh
bun install
bun run dev /path/to/project      # run the TUI from source
bun run typecheck                 # tsc --noEmit
bun test                          # both suites (offline, no credentials)
bun run build                     # bundle to dist/
bun run build:compile             # standalone executable to dist/splitlane
bun run gui:build                 # bundle the Electron mirror to dist/gui
bun run gui:dev                   # bundle, then open the read-only mirror window
```

Two separate test suites:

- `bun run test:production` → `bun test src` — the real app. Nearly everything lives in `src/production.test.tsx` (one big file, `describe` blocks per subsystem) plus `src/update/updater.test.ts`.
  Single test: `bun test src -t "substring of the test name"`.
- `bun run test:spike` → `node --test test/*.test.mjs` — tests the `spike/` prototype and the JSON schemas.
  Single file: `node --test test/sanitize.test.mjs`.
- `bun run test:gui` → `bun test gui` — the Electron mirror's view, rendered with `react-dom/server`. No Electron process and no DOM are involved.

CLI surface: `splitlane [project] [--mirror]`, `splitlane doctor [project] [--json]`, `splitlane update`.

`spike/probe*.mjs` and `spike/live-*.mjs` start **real, paid provider turns** and are gated behind explicit `--i-understand-this-starts-model-turns` flags. Never run them, and never add tests that invoke real model turns — the offline suite uses redacted fixtures in `test/fixtures/` and fake provider executables (`test/fixtures/fake-*.mjs`).

Release is tag-driven: pushing `vX.Y.Z` runs `.github/workflows/release.yml`, which typechecks, tests, compiles per-platform binaries, and publishes them with `SHA256SUMS`. `scripts/install.sh` and `src/update/updater.ts` verify those checksums.

## Architecture

Strict one-way dependency: **Ink TUI → orchestrator → provider adapters**, with a read-only Git observer beside the orchestrator. Provider JSON shapes, CLI flags, and SDK message types must never leak past an adapter.

- `bin/splitlane.tsx` → `src/cli.tsx` — argv parsing, `doctor`/`update` subcommands, config load, orchestrator construction, `render(<App/>)`.
- `src/domain.ts` — the whole shared vocabulary: `NormalizedEvent`/`EventKind`, `ProviderAdapter`, `AppSnapshot` and every nested snapshot type. Changing a contract almost always starts here.
- `src/core/orchestrator.ts` (`CompareOrchestrator`) — the center of gravity (~1.8k lines). Owns the single immutable `AppSnapshot`, publishes it to subscribers, and holds routing, queueing, cancellation, writer promotion/revocation, review lifecycle, worktree lifecycle, approvals, and session persistence. UI mutations go through its methods; the UI never mutates state directly.
- `src/providers/claude.ts` — wraps the official `@anthropic-ai/claude-agent-sdk` `query()`. `src/providers/codex.ts` + `codex-rpc.ts` — the Codex app-server JSONL RPC protocol. Both normalize into `NormalizedEvent` and enforce that `workspace_write` requires an authentic writer lease.
- `src/ui/interaction.ts` — the renderer-agnostic interaction state machine: every overlay, draft, and authority gate (`writerConfirm`, `armedApproval`, `destructiveConfirm`, `isolatedDiscardConfirm`). `reduce(state, intent, snapshot, context)` is pure and returns the next state plus **commands** the host runs on the orchestrator; async results come back as intents. Add interaction behavior here, not in a renderer. `src/ui/keymap.ts` maps one keystroke to one intent — the only place that decodes `Ctrl+<letter>`, which Ink reports as a bare letter.
- `src/ui/app.tsx` — `App` subscribes to the orchestrator and hosts the state machine (key events in, commands out); `SplitlaneView` is a pure snapshot→JSX renderer (this is why rendering can be tested with `renderToString` and no live terminal). Only viewport state that needs terminal geometry — scroll offsets and the both/focused view — stays local. `src/ui/layout.ts` and `src/ui/text.ts` handle responsive panel sizing, scroll windows, and grapheme/CJK-safe truncation.
- `src/mirror/*` — `MirrorPublisher` publishes the `AppSnapshot` of a live session over a local socket, one direction only, behind `--mirror`. `gui/` is the Electron read-only renderer that attaches to it: `main.ts` (socket client, bundled to CJS), `preload.ts` (observe-only bridge), `mirror-view.tsx` (pure view), `renderer.tsx` (mount). The GUI holds no session and has no command channel — see `docs/GUI_TRANSITION_DECISIONS.md` for the staged plan and the gate before it may gain one.
- Supporting modules, each a boundary named in `AGENTS.md`: `git/observer.ts` (read-only, pager/external-diff disabled), `workspace/guard.ts` (writer leases, path containment), `worktree/manager.ts`, `session/store.ts` (metadata only, in the platform state dir), `meta/session.ts` (`SharedMetaSession` — bounded, redacted peer-context relay), `config/config.ts`, `compat/doctor.ts`, `review/*`, `terminal/sanitize.ts`, `process/child.ts` (process-group termination).

`spike/` is the disposable M0 protocol prototype (`.mjs`). It is not production code and is not imported by `src/`; treat it as reference for provider stream shapes only.

## Constraints that bite in practice

- **Snapshot discipline.** State changes are `#patch`/`#patchLane` producing a new `AppSnapshot`; anything the UI needs must be on the snapshot.
- **Lane isolation.** A failure, block, or cancel in one lane must never affect the other. There are existing tests asserting exactly this — keep them passing.
- **Fail-closed authority.** Compare is read-only, at most one writer lease on a shared tree, approvals outside the workspace or requesting network are denied without reaching the inbox, and pending approvals at close revoke the lease.
- **Sanitize before state.** All provider text goes through `sanitizeTerminalText`/`appendBounded` before it reaches the snapshot or a log.
- **Terminal control-byte collisions.** `Ctrl+I`/`Ctrl+M`/`Ctrl+H` are Tab/Enter/Backspace; those actions use `Option/Alt+I`, `Option/Alt+M`, `Option/Alt+H`. Add new shortcuts to the `Ctrl+G` help overlay and the README keyboard map in the same change.
- **Narrow and CJK rendering.** Layouts must fit 80 columns and stay correct with wide characters; use `string-width`, and add a `renderToString` test for new layout work.
- **Config is strict.** Unknown keys and invalid values throw with the exact config path. `updates` is user-scope only — a project config containing it is a startup error.
- Commit messages follow `type: imperative summary` (`feat:`, `fix:`, `docs:`, `chore:`).
