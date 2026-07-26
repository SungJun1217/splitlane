# Splitlane

Splitlane is a local terminal UI that keeps Claude Code and Codex in separate
lanes. It starts in read-only `compare` mode. The M2 increment adds an explicit
single-writer `build` mode with temporary approvals; there is still no automatic
routing, grading, merging, or session persistence.

## Install the M2 preview

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
lane-local cancellation, `Ctrl+I` for the read-only Git inspector, and `Ctrl+Q`
to close provider transports and exit.

Build mode never changes the prompt target automatically. When the target is
`both`, the selected writer receives workspace-write access while the peer gets
the same prompt read-only. Approval choices are limited to allow once, deny, and
cancel turn; network access and persistent permission rules remain disabled.

## Verify without credentials or model cost

```sh
bun run typecheck
bun test
bun run build
bun run build:compile
```

See [the M1 architecture](docs/M1_ARCHITECTURE.md) and [the approved M2
decisions](docs/M2_SINGLE_WRITER_DECISIONS.md) for the safety behavior.
