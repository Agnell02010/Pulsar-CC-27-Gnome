#!/usr/bin/env bash
#
# Pulsar CC 27 - uninstaller
# Copyright (C) 2026 Agnell02010
# License: GPL-2.0-or-later
#
set -euo pipefail

UUID="macos-control-centre-lg@pulsar.local"
EXT_DST="$HOME/.local/share/gnome-shell/extensions/$UUID"

if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; N=$'\e[0m'; else B=""; G=""; Y=""; N=""; fi

echo
echo "${B}Pulsar CC 27 — uninstall${N}"
echo "-----------------------------------------------"
echo

if [ ! -d "$EXT_DST" ]; then
  echo "  The extension is not installed in: $EXT_DST"
  exit 0
fi

command -v gnome-extensions >/dev/null 2>&1 && \
  gnome-extensions disable "$UUID" 2>/dev/null || true

rm -rf "$EXT_DST"
echo "${G}  ok${N}  Extension removed"

if [ -d "$HOME/.local/share/gnome-shell/extensions/$UUID.bak" ]; then
  echo "${Y}  !!${N}  A backup existed: $UUID.bak (left untouched)"
fi

echo
echo "  The Liquid Glass settings were NOT touched."
echo "  ${B}Log out and back in${N} for the removal to take effect."
echo
