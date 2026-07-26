# Splitlane

Splitlane is a local terminal UI that keeps Claude Code and Codex in separate
lanes. It starts in read-only `compare` mode. The current M3 preview adds an
explicit single-writer `build` mode and a human-confirmed handoff to one
read-only reviewer; there is still no automatic routing, grading, merging,
review/fix loop, or session persistence.

## Install the M3 preview

The first GitHub distribution targets are macOS on Apple Silicon and glibc-based
Linux on x86_64. After a public release is published, install the matching
standalone executable without cloning the repository or installing Bun:

```sh
curl -fsSL https://raw.githubusercontent.com/SungJun1217/splitlane/main/scripts/install.sh | sh
```

The installer verifies the release SHA-256 checksum and writes to
`~/.local/bin/splitlane`. Override the location with
`SPLITLANE_INSTALL_DIR=/your/bin`. Splitlane does not install or configure the
provider CLIs.

Then start it for a project:

```sh
splitlane /path/to/project
```

The separately installed and authenticated official `claude` and `codex` CLIs
remain prerequisites. Linux ARM64/musl, Intel macOS, and Windows binaries are
not yet validated or published.

## Run from source

Prerequisites are Bun, Node 22 or newer, and the user's separately installed and
authenticated official `claude` and `codex` CLIs.

```sh
bun install
bun run dev /path/to/project
```

Starting Splitlane probes local CLI versions but does not start a model turn.
Pressing Enter with a prompt does start a turn for the selected target.

The footer lists every keyboard action. Important controls are `Ctrl+R` for the
target, `Alt+1`/`Alt+2` for lane focus, `Ctrl+B` for two-step writer promotion,
`Ctrl+W` to revoke the writer, `Ctrl+A` for pending approvals, `Ctrl+X` for
lane-local cancellation, `Ctrl+V` to prepare a review handoff, `Ctrl+F` for
review findings, `Ctrl+I` for the read-only Git inspector, and `Ctrl+Q` to close
provider transports and exit.

Each lane has an independent line viewport. `Page Up` and `Page Down` scroll the
focused lane, `Home` jumps to its oldest retained output, and `End` resumes
follow-tail mode. New output preserves a manually scrolled position. `Ctrl+T`
opens the focused lane's bounded activity log, where tool, file, approval,
warning, and failure entries can be selected and expanded with `Space`.
`Ctrl+G` opens the in-product keyboard help.

Build mode never changes the prompt target automatically. When the target is
`both`, the selected writer receives workspace-write access while the peer gets
the same prompt read-only. Approval choices are limited to allow once, deny, and
cancel turn; network access and persistent permission rules remain disabled.

Review starts only from an idle build writer after an implementation turn. The
confirmation requires acceptance criteria, freezes an exact patch up to 200
KiB, and revokes the writer lease before dispatching to the other provider in
read-only mode. Findings retain provider attribution and file/line locations.
Returning selected findings prepares the shared prompt and reopens normal writer
promotion; it never sends a fix prompt automatically. When the installed Codex
app-server schema exposes the required `review/start` contract, Splitlane offers
that mechanism as a visible `preview` and keeps the generic read-only turn as an
explicit alternative. Press `Tab` in the confirmation modal to switch. If the
runtime probe fails, only the generic mechanism is shown; Splitlane never starts
a model turn while probing and never silently substitutes one mechanism after
confirmation.

## Verify without credentials or model cost

```sh
bun run typecheck
bun test
bun run build
bun run build:compile
```

See [the M1 architecture](docs/M1_ARCHITECTURE.md), [the approved M2
decisions](docs/M2_SINGLE_WRITER_DECISIONS.md), and [the approved M3 handoff
decisions](docs/M3_REVIEW_HANDOFF_DECISIONS.md) for the safety behavior.
