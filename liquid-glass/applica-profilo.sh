#!/usr/bin/env bash
#
# Pulsar CC 27 - apply a blur level to the Liquid Glass extension
# Copyright (C) 2026 Agnell02010
# License: GPL-2.0-or-later
#
# Usage:
#   ./applica-profilo.sh 0           no blur (crisp glass)
#   ./applica-profilo.sh 1           light blur   <- clean middle ground
#   ./applica-profilo.sh 2           medium blur
#   ./applica-profilo.sh 3           strong blur
#   ./applica-profilo.sh salva       save the current settings to a file
#   ./applica-profilo.sh save        same as "salva"
#
# The old names still work: "no-blur" = 0, "blur" = 3.
#
# Every level file is a full dump of the live settings, so it also carries the
# dock glass profile (dock-glass-shape-n / max-z / displacement and the shared
# profile). Applying a level therefore does NOT revert the dock tuning.
#
set -euo pipefail

LG_PATH="/org/gnome/shell/extensions/liquid-glass/"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="$HOME/.config/pulsar-cc/lg-backup"

if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else B=""; G=""; Y=""; R=""; N=""; fi

MODO="${1:-1}"

case "$MODO" in
  0|no-blur|nob|no)
    FILE="$DIR/liquid_glass_settings(NO_BLUR).txt"
    NOME="0 — no blur (crisp)"
    ;;
  1|1-LEGGERO|leggero|light|l)
    FILE="$DIR/liquid_glass_settings(BLUR-1-LEGGERO).txt"
    NOME="1 — light blur"
    ;;
  2|2-MEDIO|medio|medium|m)
    FILE="$DIR/liquid_glass_settings(BLUR-2-MEDIO).txt"
    NOME="2 — medium blur"
    ;;
  3|3-FORTE|forte|strong|blur|b)
    FILE="$DIR/liquid_glass_settings(BLUR-3-FORTE).txt"
    NOME="3 — strong blur"
    ;;
  salva|save)
    mkdir -p "$BACKUP_DIR"
    OUT="$BACKUP_DIR/liquid_glass_$(date +%Y%m%d-%H%M%S).txt"
    dconf dump "$LG_PATH" > "$OUT"
    echo "${G}  ok${N}  Settings saved to: $OUT"
    exit 0
    ;;
  *)
    echo "Usage: $0 [0|1|2|3|salva]" >&2
    echo "  0 = no blur, 1 = light, 2 = medium, 3 = strong" >&2
    exit 2
    ;;
esac

if ! command -v dconf >/dev/null 2>&1; then
  echo "${R}  xx${N}  Command 'dconf' not found." >&2
  exit 1
fi

if [ ! -f "$FILE" ]; then
  echo "${R}  xx${N}  Profile file not found: $FILE" >&2
  echo "       Regenerate the profiles with:  python3 gen_profiles.py" >&2
  exit 1
fi

# Guard: refuse to apply a profile that lost the dock glass keys. This is what
# made the dock lose its edge lens the first time.
if ! grep -q '^dock-glass-shape-n=' "$FILE" || ! grep -q '^enable-dock-glass=' "$FILE"; then
  echo "${R}  xx${N}  This profile has no dock glass keys: $FILE"
  echo "       It is an old file. Regenerate the profiles with:"
  echo "         python3 gen_profiles.py" >&2
  exit 1
fi

# backup of the current settings
mkdir -p "$BACKUP_DIR"
dconf dump "$LG_PATH" > "$BACKUP_DIR/liquid_glass_$(date +%Y%m%d-%H%M%S).txt" || true

# apply
dconf load "$LG_PATH" < "$FILE"

echo "${G}  ok${N}  Blur level applied: ${B}$NOME${N}"
echo
echo "  Dock glass keys kept: $(grep -c '^dock-glass-' "$FILE")"
echo
echo "  If the Control Center is already open, close and reopen it"
echo "  (the glass effect is recalculated when the panel opens)."
echo
