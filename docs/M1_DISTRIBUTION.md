# M1 GitHub Distribution

Status: approved implementation increment

Last updated: 2026-07-26

## Decision

The first installable Splitlane preview is distributed as standalone macOS
ARM64 and Linux x86_64 executables attached to a GitHub Release. Users do not
need Node.js, Bun, or a source checkout at runtime. The separately installed
and authenticated official `claude` and `codex` CLIs remain prerequisites.

This pulls a narrow distribution slice forward from M6 without claiming that
the full v0.1 release gate is complete. Initial release tags use stable
pre-1.0 versions such as `v0.0.1`, so GitHub's latest-release download URL can
remain deterministic.

## Release flow

- Pushing a SemVer tag runs platform-native build jobs on GitHub's macOS ARM64
  and Ubuntu x86_64 runners.
- Frozen dependency installation, type checking, and all offline tests must pass
  before packaging.
- Bun compiles `bin/splitlane.tsx` to `splitlane-darwin-arm64` and the
  baseline-CPU `splitlane-linux-x64` glibc executable.
- The workflow ad-hoc signs the macOS executable, verifies both architectures,
  produces one `SHA256SUMS`, and only then creates the GitHub Release.
- The publishing job receives only `contents: write`; the build job is
  read-only.

## Installer behavior

`scripts/install.sh` supports macOS ARM64 and glibc-based Linux x86_64 for this
increment. It selects the matching asset, downloads it and the checksum from the
public GitHub Release, verifies SHA-256 before installation, and writes
`splitlane` to `${HOME}/.local/bin` by default. It does not install providers,
alter provider configuration, request `sudo`, or start a model turn.

Linux ARM64/musl, macOS x64, Windows, notarization, Homebrew, shell completions,
and update automation remain future distribution work and require platform
validation.

## Verification checkpoint

On 2026-07-26, the Linux artifact cross-compiled successfully and was identified
as an ELF 64-bit x86-64 executable. It launched in an emulated `linux/amd64`
Debian container, rendered the TUI, reported the intentionally absent provider
binaries as unavailable, restored the terminal, and exited with status 0 through
`Ctrl+Q`. This smoke test started no provider turn. Native Ubuntu build and test
remain mandatory in the release workflow before publication.
