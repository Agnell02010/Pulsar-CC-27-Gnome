#!/usr/bin/env bash
#
# Pulsar CC 27 - apply a blur level to the Liquid Glass extension
# Copyright (C) 2026 Agnell02010
# License: GPL-2.0-or-later
#
# Usage:
#   ./applica-profilo.sh 0           no blur (crisp glass)
#   ./applica-profilo.sh 0.5         barely there, half of level 1
#   ./applica-profilo.sh 1           light blur   <- clean middle ground
#   ./applica-profilo.sh 2           medium blur
#   ./applica-profilo.sh 3           strong blur
#   ./applica-profilo.sh salva       save the current settings to a file
#   ./applica-profilo.sh save        same as "salva"
#
#   ./applica-profilo.sh N --pieno   load the whole profile, optics included
#
# The old names still work: "no-blur" = 0, "blur" = 3.
#
# By default only the seven blur radii are written. The level files are full
# dumps, but a level change must never touch the optics: loading a whole
# profile reverted every edge, corner and dock tuning, so switching level
# silently threw the tuning away. --pieno restores everything, which is what a
# fresh machine wants and what install.sh uses when there is nothing yet.
#
set -euo pipefail

LG_PATH="/org/gnome/shell/extensions/liquid-glass/"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="$HOME/.config/pulsar-cc/lg-backup"

if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else B=""; G=""; Y=""; R=""; N=""; fi

PIENO=0
MODO=""
for a in "$@"; do
  case "$a" in
    --pieno|--full|--restore) PIENO=1 ;;
    *)
      if [ -z "$MODO" ]; then MODO="$a"; fi
      ;;
  esac
done
MODO="${MODO:-1}"

case "$MODO" in
  0|no-blur|nob|no)
    FILE="$DIR/liquid_glass_settings(NO_BLUR).txt"
    NOME="0 — no blur (crisp)"
    ;;
  0.5|05|0,5|half|minimo|pochissimo)
    FILE="$DIR/liquid_glass_settings(BLUR-05-MINIMO).txt"
    NOME="0.5 — barely there"
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
    echo "Usage: $0 [0|0.5|1|2|3|salva]" >&2
    echo "  0 = no blur, 0.5 = barely there, 1 = light, 2 = medium, 3 = strong" >&2
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

if [ "$PIENO" = 1 ]; then
  # Full restore: what a fresh machine wants, and what install.sh uses when
  # Liquid Glass has no settings yet.
  dconf load "$LG_PATH" < "$FILE"
  echo "${G}  ok${N}  Whole profile applied: ${B}$NOME${N}"
  echo
  echo "  Optics included, so any edge/corner/dock tuning is replaced."
else
  # The seven surfaces the levels actually differ on. Writing just these leaves
  # the optics, the dock glass profile and every other key exactly as they are.
  BLUR_KEYS="menu-blur-radius panel-menu-blur-radius quick-settings-blur-radius
             osd-blur-radius application-blur-radius notification-blur-radius
             dock-blur-radius"
  SCRITTI=0
  MANCATI=""
  for key in $BLUR_KEYS; do
    VALORE="$(grep -E "^${key}=" "$FILE" | head -n1 | cut -d= -f2- || true)"
    if [ -n "$VALORE" ]; then
      dconf write "$LG_PATH${key}" "$VALORE"
      SCRITTI=$((SCRITTI + 1))
    else
      MANCATI="$MANCATI $key"
    fi
  done

  if [ -n "$MANCATI" ]; then
    echo "${Y}  !!${N}  Missing from the profile:$MANCATI"
    echo "       Regenerate the profiles with:  python3 gen_profiles.py"
  fi

  echo "${G}  ok${N}  Blur level applied: ${B}$NOME${N}  ($SCRITTI radii)"
  echo
  echo "  Only the blur radii changed: optics, dock glass profile and every"
  echo "  other key were left untouched."
fi

echo
echo "  If the Control Center is already open, close and reopen it"
echo "  (the glass effect is recalculated when the panel opens)."
echo
