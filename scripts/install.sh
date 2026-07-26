#!/bin/sh

set -eu

repository="SungJun1217/splitlane"
version="${SPLITLANE_VERSION:-latest}"
install_dir="${SPLITLANE_INSTALL_DIR:-${HOME:?HOME is required}/.local/bin}"

fail() {
  printf 'splitlane installer: %s\n' "$1" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v install >/dev/null 2>&1 || fail "install is required"

os="$(uname -s)"
arch="$(uname -m)"

case "${os}/${arch}" in
  Darwin/arm64) asset="splitlane-darwin-arm64" ;;
  Linux/x86_64 | Linux/amd64) asset="splitlane-linux-x64" ;;
  *) fail "unsupported platform ${os}/${arch}; supported targets are macOS ARM64 and Linux x86_64" ;;
esac

case "$version" in
  latest) release_path="latest/download" ;;
  v[0-9]*)
    case "$version" in
      *[!A-Za-z0-9._-]*) fail "invalid version: $version" ;;
    esac
    release_path="download/$version"
    ;;
  *) fail "invalid version: $version" ;;
esac

if [ -n "${SPLITLANE_RELEASE_BASE_URL:-}" ]; then
  base_url="${SPLITLANE_RELEASE_BASE_URL%/}"
else
  base_url="https://github.com/${repository}/releases/${release_path}"
fi

temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/splitlane-install.XXXXXX")"
cleanup() {
  rm -rf "$temporary_dir"
}
trap cleanup 0
trap 'exit 1' HUP INT TERM

download() {
  source_url="$1"
  destination="$2"
  if [ -n "${SPLITLANE_RELEASE_BASE_URL:-}" ]; then
    curl --fail --silent --show-error --location --retry 3 \
      --output "$destination" "$source_url"
  else
    curl --fail --silent --show-error --location --retry 3 \
      --proto '=https' --tlsv1.2 --output "$destination" "$source_url"
  fi
}

download "${base_url}/${asset}" "${temporary_dir}/${asset}"
download "${base_url}/SHA256SUMS" "${temporary_dir}/SHA256SUMS"

expected_checksum="$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1; exit }' "${temporary_dir}/SHA256SUMS")"
[ -n "$expected_checksum" ] || fail "release checksum does not include $asset"
printf '%s\n' "$expected_checksum" | grep -Eq '^[0-9a-fA-F]{64}$' || \
  fail "release checksum is malformed"

if command -v sha256sum >/dev/null 2>&1; then
  actual_checksum="$(sha256sum "${temporary_dir}/${asset}" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  actual_checksum="$(shasum -a 256 "${temporary_dir}/${asset}" | awk '{ print $1 }')"
else
  fail "sha256sum or shasum is required"
fi
[ "$actual_checksum" = "$expected_checksum" ] || fail "checksum verification failed"

mkdir -p "$install_dir"
install -m 0755 "${temporary_dir}/${asset}" "${install_dir}/splitlane"
marker="${install_dir}/.splitlane-managed"
printf '%s\n' 'splitlane-managed/v1' "$repository" > "${temporary_dir}/.splitlane-managed"
install -m 0600 "${temporary_dir}/.splitlane-managed" "$marker"

printf 'Installed Splitlane to %s/splitlane\n' "$install_dir"
case ":${PATH:-}:" in
  *":${install_dir}:"*) ;;
  *) printf 'Add %s to PATH before running splitlane.\n' "$install_dir" ;;
esac
