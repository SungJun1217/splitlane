# Splitlane

Splitlane is a local terminal UI that keeps Claude Code and Codex in separate
lanes. The current M1 increment is a read-only comparison build: there is no
active writer and no automatic routing, grading, merging, or session
persistence.

## Install the M1 preview

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
target, `Alt+1`/`Alt+2` for lane focus, `Ctrl+X` for lane-local cancellation,
`Ctrl+I` for the read-only Git inspector, and `Ctrl+Q` to close provider
transports and exit.

## Verify without credentials or model cost

```sh
bun run typecheck
bun test
bun run build
bun run build:compile
```

See [the M1 architecture](docs/M1_ARCHITECTURE.md) for the safety behavior and
remaining live exit gate.
