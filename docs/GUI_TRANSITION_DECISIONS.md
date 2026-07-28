# GUI Transition Decisions

Status: approved for implementation on 2026-07-29

Last updated: 2026-07-29

## Purpose

Splitlane has shipped as a terminal-only product. This document records the
decision to add a desktop graphical renderer, the staged path for getting there,
and the invariants that path must not break. It exists because the change touches
the product identity in `AGENTS.md` (“a local TUI”) and the warning in
`docs/PRODUCT_PLAN.md` §2.1 against turning the TUI into a desktop platform.
Neither is being reversed wholesale; both are being scoped.

The three decisions taken with the user on 2026-07-29:

1. **Shell:** Electron. The main process runs on Node 22, which the core already
   supports — production code under `src/` uses no Bun-specific API, so the
   orchestrator, adapters, and observers run unchanged.
2. **Renderer status:** the TUI and the GUI are both first-class. The TUI is not
   deprecated, is not frozen, and keeps receiving features.
3. **First increment:** a read-only mirror. The GUI renders state and sends no
   commands at all.

## What “read-only mirror” means, and why the GUI does not own a session

A GUI that constructs its own `CompareOrchestrator` while refusing to send
commands would be inert: no prompt could ever be dispatched, so nothing would
ever appear in it. A read-only increment is therefore only meaningful if the GUI
observes a session someone else drives.

So in this increment the **TUI process owns the session** and publishes its
snapshots; the Electron app attaches to that stream and draws it. The GUI is a
second view of one live session, not a second session.

This is a deliberate deviation from hosting the orchestrator inside the Electron
main process. Hosting moves in when commands move in (stage 4 below) — and even
then, only one process may own a session, because two orchestrators over one
working tree would violate the single-writer invariant.

## Approved architecture

```text
splitlane /repo --mirror                     ← owns the session
  CompareOrchestrator
    ├── Ink TUI            keyboard, modals, authority gates
    └── MirrorPublisher    local socket, snapshots out only
                              │
                              ▼
  Electron main (Node 22)  connects, forwards frames
    └── renderer (React)   read-only panels, no intent channel
```

- **Transport:** a Unix domain socket (Windows: a named pipe) inside the platform
  state directory, mode `0600`, one endpoint per project. No TCP port, no
  loopback listener, nothing reachable from another machine. Remote access
  remains an `AGENTS.md` non-goal.
- **Direction:** frames flow one way. The publisher destroys any connection that
  sends a byte, so the read-only property is enforced by the transport rather
  than by renderer discipline.
- **Payload:** `AppSnapshot` as JSON. It is already plain, already sanitized
  (`sanitizeTerminalText`/`appendBounded` run before state), and carries no
  provider-native shapes, so the adapter boundary holds without a second
  normalization layer.
- **Opt-in:** publishing requires `--mirror`. A session started without it has no
  endpoint and no extra surface.
- **Coalescing:** only the newest snapshot is ever in flight. A slow reader drops
  intermediate frames instead of growing an unbounded queue.

## Staged path

| Stage | Content | Status |
|---|---|---|
| 0 | This document; `AGENTS.md` identity and boundary amendments | done |
| 1 | `MirrorPublisher`, frame protocol, `--mirror`, offline tests | this increment |
| 2 | Electron shell rendering the mirrored snapshot, read-only | this increment |
| 3 | Extract the interaction state machine out of `src/ui/app.tsx` into a renderer-agnostic module | **gate for stage 4** |
| 4 | Intent frames: the GUI drives the session through the shared state machine | not started |
| 5 | Packaging: `electron-builder`, signing, release workflow | not started |

Stage 3 is a hard prerequisite for stage 4, not a cleanup. Every authority gate
— `writerConfirm`, `armedApproval`, `destructiveConfirm`,
`isolatedDiscardConfirm`, and the overlay machine — currently lives in
`useState` inside `src/ui/app.tsx`. The 2026-07-28 audit and code review found
four separate defects in exactly those gates. A second renderer that
re-implements them re-implements that defect class. The gates must be shared
before either renderer can grant authority.

## Invariants the GUI adds

These extend, and do not replace, the `AGENTS.md` product invariants.

1. **The mirror carries no authority.** It cannot promote a writer, resolve an
   approval, start a turn, or delete a worktree. In stage 1–2 it has no channel
   in which to try.
2. **The mirror is never a network service.** Local socket only, `0600`, inside
   the user state directory.
3. **A mirrored session is visibly mirrored.** The GUI states which project it is
   attached to, and states plainly when the session is gone rather than
   presenting a stale snapshot as live.
4. **One session, one owner.** The GUI never constructs a second orchestrator
   over a working tree that another process already drives.
5. **Sanitize before transport.** Only snapshot text that already went through
   the sanitizer is published; the GUI adds no unsanitized rendering path.

## Explicitly out of scope

Unchanged from `docs/PRODUCT_PLAN.md` §4: no built-in editor, no built-in
browser, no Kanban, no PR creation, no remote control, and no editing inside the
evidence inspector. A graphical renderer does not reopen any of these.

Also out of scope here: replacing the TUI, packaging or signing the desktop app,
publishing it in the release workflow, and mirroring more than one project in one
window.

## v0.1 relationship

This work does not enter the v0.1 scope defined by
`docs/V01_COMPLETION_DECISIONS.md`. v0.1 remains a terminal release, and the
release workflow keeps building only the standalone `splitlane` binary. The GUI
develops alongside it behind `--mirror` and a separate `gui:dev` script until
stage 5 is designed.
