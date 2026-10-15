#!/usr/bin/env bash
#
# Pulsar CC 27 - apply a profile to the Liquid Glass extension
# Copyright (C) 2026 Agnell02010
# License: GPL-2.0-or-later
#
# Usage:
#   ./applica-profilo.sh no-blur     glass without blur (recommended)
#   ./applica-profilo.sh blur        glass with blur
#   ./applica-profilo.sh salva       save the current settings to a file
#   ./applica-profilo.sh save        same as "salva"
#
set -euo pipefail

LG_PATH="/org/gnome/shell/extensions/liquid-glass/"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="$HOME/.config/pulsar-cc/lg-backup"

if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else B=""; G=""; Y=""; R=""; N=""; fi

MODO="${1:-no-blur}"

case "$MODO" in
  no-blur|nob|no)
    FILE="$DIR/liquid_glass_settings(NO_BLUR).txt"
    NOME="NO_BLUR (without blur)"
    ;;
  blur|b)
    FILE="$DIR/liquid_glass_settings(BLUR).txt"
    NOME="BLUR (with blur)"
    ;;
  salva|save)
    mkdir -p "$BACKUP_DIR"
    OUT="$BACKUP_DIR/liquid_glass_$(date +%Y%m%d-%H%M%S).txt"
    dconf dump "$LG_PATH" > "$OUT"
    echo "${G}  ok${N}  Settings saved to: $OUT"
    exit 0
    ;;
  *)
    echo "Usage: $0 [no-blur|blur|salva]" >&2
    exit 2
    ;;
esac

if ! command -v dconf >/dev/null 2>&1; then
  echo "${R}  xx${N}  Command 'dconf' not found." >&2
  exit 1
fi

if [ ! -f "$FILE" ]; then
  echo "${R}  xx${N}  Profile file not found: $FILE" >&2
  exit 1
fi

# backup of the current settings
mkdir -p "$BACKUP_DIR"
dconf dump "$LG_PATH" > "$BACKUP_DIR/liquid_glass_$(date +%Y%m%d-%H%M%S).txt" || true

# apply
dconf load "$LG_PATH" < "$FILE"

echo "${G}  ok${N}  Profile applied: ${B}$NOME${N}"
echo
echo "  If the Control Center is already open, close and reopen it"
echo "  (the glass effect is recalculated when the panel opens)."
echo
