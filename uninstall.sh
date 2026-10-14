#!/usr/bin/env bash
#
# Pulsar CC 27 - disinstallazione
# Copyright (C) 2026 Agnell02010
# Licenza: GPL-2.0-or-later
#
set -euo pipefail

UUID="macos-control-centre-lg@pulsar.local"
EXT_DST="$HOME/.local/share/gnome-shell/extensions/$UUID"

if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; N=$'\e[0m'; else B=""; G=""; Y=""; N=""; fi

echo
echo "${B}Pulsar CC 27 — disinstallazione${N}"
echo "-----------------------------------------------"
echo

if [ ! -d "$EXT_DST" ]; then
  echo "  L'estensione non risulta installata in: $EXT_DST"
  exit 0
fi

command -v gnome-extensions >/dev/null 2>&1 && \
  gnome-extensions disable "$UUID" 2>/dev/null || true

rm -rf "$EXT_DST"
echo "${G}  ok${N}  Estensione rimossa"

if [ -d "$HOME/.local/share/gnome-shell/extensions/$UUID.bak" ]; then
  echo "${Y}  !!${N}  Esisteva un backup: $UUID.bak (lasciato intatto)"
fi

echo
echo "  Le impostazioni di Liquid Glass NON sono state toccate."
echo "  ${B}Esci e rientra${N} perché la rimozione abbia effetto."
echo
