# Splitlane

Splitlane is a local terminal UI that keeps Claude Code and Codex in separate
lanes. The current M1 increment is a read-only comparison build: there is no
active writer and no automatic routing, grading, merging, or session
persistence.

## Run the M1 build

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
