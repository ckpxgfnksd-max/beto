#!/usr/bin/env bash
# SwiftBar plugin: ambient menubar for AI agent sessions.
#
# Install:
#   1. brew install --cask swiftbar
#   2. Set SwiftBar's plugin folder (default: ~/.config/swiftbar)
#   3. Symlink this file (or copy it) into that folder:
#        ln -s "$(which beto)/../../share/beto/bin/beto.30s.sh" \
#              ~/.config/swiftbar/beto.30s.sh
#      ...or just download this file and chmod +x it.
#   4. SwiftBar refreshes every 30s; rename to beto.10s.sh for tighter
#      cadence, or beto.5m.sh for relaxed.
#
# Override the beto binary path with $BETO_PATH if it's not on PATH.

# <swiftbar.title>beto</swiftbar.title>
# <swiftbar.version>0.7.0</swiftbar.version>
# <swiftbar.author>Chase Wang</swiftbar.author>
# <swiftbar.author.github>ckpxgfnksd-max</swiftbar.author.github>
# <swiftbar.desc>Universal sidebar for AI agent sessions — Claude Code, Codex, Hermes, Goose, and any harness with a beto manifest.</swiftbar.desc>
# <swiftbar.image></swiftbar.image>
# <swiftbar.dependencies>beto</swiftbar.dependencies>
# <swiftbar.abouturl>https://github.com/ckpxgfnksd-max/beto</swiftbar.abouturl>

# Ensure the shell can find beto. SwiftBar runs plugins with a minimal
# PATH (no shell rc files), so we explicitly prepend common install
# locations before calling.
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

BETO="${BETO_PATH:-beto}"

if ! command -v "$BETO" >/dev/null 2>&1; then
  echo "beto · install needed | color=red"
  echo "---"
  echo "beto not on PATH. Install: bun add -g beto or set BETO_PATH"
  echo "Source | href=https://github.com/ckpxgfnksd-max/beto"
  exit 0
fi

"$BETO" bar
