#!/usr/bin/env bash
# beto installer.
#
# Usage:
#   curl -fsSL https://github.com/ckpxgfnksd-max/beto/raw/main/scripts/install.sh | sh
#
# What it does:
#   1. Detects your OS + arch.
#   2. Downloads the matching binary from the latest GitHub Release.
#   3. Verifies the SHA-256 against the published SHA256SUMS.
#   4. Installs to /usr/local/bin/beto (or ~/.local/bin/beto if the
#      former is not writable).
#
# What it does NOT do:
#   - Modify any harness directory (~/.claude/, ~/.codex/, ...). Run
#     `beto doctor` after install to verify.
#   - Add to PATH automatically. If ~/.local/bin is not on your PATH,
#     the installer prints the line you need.
#
# Override hooks:
#   BETO_INSTALL_DIR=/custom/path  override the install directory
#   BETO_VERSION=v0.8.0            install a specific version (default: latest)
#   BETO_NO_VERIFY=1               skip the SHA-256 check (not recommended)

set -euo pipefail

REPO="ckpxgfnksd-max/beto"
VERSION="${BETO_VERSION:-latest}"
INSTALL_DIR="${BETO_INSTALL_DIR:-}"

# ─── 1. Detect platform ───────────────────────────────────────────────

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)

case "$os-$arch" in
  darwin-arm64)            asset="beto-darwin-arm64" ;;
  darwin-x86_64)           asset="beto-darwin-x64" ;;
  linux-x86_64 | linux-amd64) asset="beto-linux-x64" ;;
  *)
    echo "beto: unsupported platform $os-$arch" >&2
    echo "    Supported: macOS arm64 / macOS x64 / Linux x64" >&2
    echo "    Open an issue at https://github.com/$REPO/issues if you need another." >&2
    exit 1
    ;;
esac

# ─── 2. Resolve install dir ───────────────────────────────────────────

if [ -z "$INSTALL_DIR" ]; then
  if [ -w "/usr/local/bin" ] || ([ -d "/usr/local/bin" ] && [ "$(id -u)" = "0" ]); then
    INSTALL_DIR="/usr/local/bin"
  else
    INSTALL_DIR="$HOME/.local/bin"
    mkdir -p "$INSTALL_DIR"
  fi
fi

# ─── 3. Resolve version ───────────────────────────────────────────────

if [ "$VERSION" = "latest" ]; then
  # The /latest endpoint redirects to the latest tagged release.
  VERSION=$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
    "https://github.com/$REPO/releases/latest" \
    | sed -e 's|.*/||')
  if [ -z "$VERSION" ] || [ "$VERSION" = "releases" ]; then
    echo "beto: failed to resolve latest release tag" >&2
    exit 1
  fi
fi

base_url="https://github.com/$REPO/releases/download/$VERSION"
binary_url="$base_url/$asset"
sums_url="$base_url/SHA256SUMS"

echo "beto: installing $VERSION ($asset) → $INSTALL_DIR/beto"

# ─── 4. Download + verify ─────────────────────────────────────────────

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

curl -fsSL "$binary_url" -o "$tmp/$asset"

if [ -z "${BETO_NO_VERIFY:-}" ]; then
  if ! curl -fsSL "$sums_url" -o "$tmp/SHA256SUMS" 2>/dev/null; then
    echo "beto: warning — SHA256SUMS not found for $VERSION; skipping verification" >&2
  else
    # Use shasum on macOS, sha256sum on Linux. Verify only the line for our asset.
    (cd "$tmp" && grep " $asset\$" SHA256SUMS > expected.txt)
    if [ -s "$tmp/expected.txt" ]; then
      if command -v sha256sum >/dev/null 2>&1; then
        (cd "$tmp" && sha256sum -c expected.txt) >/dev/null
      elif command -v shasum >/dev/null 2>&1; then
        (cd "$tmp" && shasum -a 256 -c expected.txt) >/dev/null
      else
        echo "beto: neither sha256sum nor shasum found; skipping verification" >&2
      fi
    else
      echo "beto: warning — $asset not listed in SHA256SUMS; skipping verification" >&2
    fi
  fi
fi

# ─── 5. Install ───────────────────────────────────────────────────────

chmod +x "$tmp/$asset"
mv "$tmp/$asset" "$INSTALL_DIR/beto"

echo "beto: installed to $INSTALL_DIR/beto"

# Hint if install dir isn't on PATH.
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo
    echo "  $INSTALL_DIR is not on your PATH. Add this to your shell rc:"
    echo "    export PATH=\"$INSTALL_DIR:\$PATH\""
    echo
    ;;
esac

echo "  Try:  beto doctor"
