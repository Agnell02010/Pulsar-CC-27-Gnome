#!/usr/bin/env bash
#
# Pulsar CC 27 - installer for the MacOS-style Control Center
# Copyright (C) 2026 Agnell02010
# License: GPL-2.0-or-later
#
set -euo pipefail

UUID="macos-control-centre-lg@pulsar.local"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_SRC="$SRC_DIR/$UUID"
EXT_DST="$HOME/.local/share/gnome-shell/extensions/$UUID"
LG_PATH="/org/gnome/shell/extensions/liquid-glass/"

# --- colors ---
if [ -t 1 ]; then
  B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'
else
  B=""; G=""; Y=""; R=""; C=""; N=""
fi
ok()   { echo "${G}  ok${N}  $*"; }
warn() { echo "${Y}  !!${N}  $*"; }
err()  { echo "${R}  xx${N}  $*" >&2; }
info() { echo "${C}  ..${N}  $*"; }

echo
echo "${B}Pulsar CC 27 — MacOS-style Control Center${N}"
echo "-----------------------------------------------"
echo

# ---------------------------------------------------------------- checks
if ! command -v gnome-extensions >/dev/null 2>&1; then
  err "'gnome-extensions' not found: this does not look like GNOME Shell."
  exit 1
fi

SHELL_VER="$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)"
if [ -n "${SHELL_VER:-}" ]; then
  info "GNOME Shell detected: version $SHELL_VER"
  if [ "$SHELL_VER" -lt 45 ] 2>/dev/null; then
    warn "This extension targets GNOME Shell 50 or 51: on $SHELL_VER it may not work."
  fi
else
  warn "Could not determine the GNOME Shell version."
fi

if [ ! -d "$EXT_SRC" ]; then
  err "Extension folder not found: $EXT_SRC"
  err "Run this script from the project folder."
  exit 1
fi

# ------------------------------------------------------- copy extension
echo
info "Copying the extension to ${B}$EXT_DST${N}"
mkdir -p "$(dirname "$EXT_DST")"
rm -rf "$EXT_DST"
cp -r "$EXT_SRC" "$EXT_DST"
ok "Extension copied ($(find "$EXT_DST" -type f | wc -l) files)"

# ------------------------------------------------------------- enabling
if gnome-extensions enable "$UUID" 2>/dev/null; then
  ok "Extension enabled"
else
  warn "Could not enable it automatically."
  warn "Do it by hand:  gnome-extensions enable $UUID"
fi

# ---------------------------------------------------------- Liquid Glass
echo
if gnome-extensions list 2>/dev/null | grep -q '^liquid-glass@'; then
  ok "Liquid Glass extension found"
  echo
  read -r -p "  Apply a Liquid Glass profile to the Control Center? [Y/n] " RISPOSTA || RISPOSTA="y"
  RISPOSTA="${RISPOSTA:-y}"
  case "$RISPOSTA" in
    n|N)
      info "Profile not applied. You can do it later with:"
      info "  ./liquid-glass/applica-profilo.sh no-blur"
      ;;
    *)
      PROFILE="$SRC_DIR/liquid-glass/liquid_glass_settings(NO_BLUR).txt"
      if [ -f "$PROFILE" ]; then
        dconf load "$LG_PATH" < "$PROFILE"
        ok "NO_BLUR profile applied (glass without blur)"
      else
        warn "Profile file not found: $PROFILE"
      fi
      ;;
  esac
else
  warn "Liquid Glass extension NOT found."
  warn "Without it the Control Center still works, just without the glass look."
  warn "Install Liquid Glass and then apply a profile with:"
  warn "  ./liquid-glass/applica-profilo.sh no-blur"
fi

# --------------------------------------------------------------- finish
echo
echo "-----------------------------------------------"
echo "${G}${B}Installation completed!${N}"
echo
echo "  ${B}Now log out and back in (logout/login).${N}"
echo "  On Wayland this is required for GNOME to load the extension."
echo
echo "  After login press  ${B}Super+S${N}  to open the Control Center."
echo
echo "  More info in README.md"
echo
