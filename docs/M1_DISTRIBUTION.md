# M1 GitHub Distribution

Status: approved implementation increment

Last updated: 2026-07-27

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

Linux ARM64/musl, macOS x64, Windows, notarization, Homebrew, and shell
completions remain future distribution work and require platform validation.

## Approved standalone update contract

The user approved Claude Code-style automatic updates on 2026-07-27. The
standalone `splitlane` executable installed from GitHub Releases uses this
contract:

- `auto` is the user-level default. TUI startup checks the public Splitlane
  GitHub latest release at most once per 24 hours and performs no telemetry.
- Checks run in the background. A successful update replaces only the current
  standalone executable and takes effect on the next launch; it never restarts
  the active TUI or provider processes.
- The updater accepts stable SemVer tags only, selects the exact supported
  platform asset, bounds every download, verifies the published SHA-256, checks
  the downloaded executable version, then uses an adjacent temporary file and
  atomic rename. Any failure preserves the current executable.
- Symlinks, source/Bun runs, unsupported platforms, package-managed paths,
  unwritable install directories, and non-regular executable paths are never
  auto-modified. The installer writes a non-secret adjacent ownership marker;
  the updater refuses any executable without that exact marker. Skipped paths
  receive an actionable notification or remain silent during background checks.
- `splitlane update` bypasses the periodic interval for an explicit immediate
  check. User config supports `updates.mode` values `auto`, `notify`, and `off`.
  Project config cannot enable or control executable updates.
- `SPLITLANE_DISABLE_AUTOUPDATE=1` disables background checks while retaining
  the explicit `splitlane update` command.

## Verification checkpoint

On 2026-07-26, the Linux artifact cross-compiled successfully and was identified
as an ELF 64-bit x86-64 executable. It launched in an emulated `linux/amd64`
Debian container, rendered the TUI, reported the intentionally absent provider
binaries as unavailable, restored the terminal, and exited with status 0 through
`Ctrl+Q`. This smoke test started no provider turn. Native Ubuntu build and test
remain mandatory in the release workflow before publication.
