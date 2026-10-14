#!/usr/bin/env bash
#
# Pulsar CC 27 - applica un profilo all'estensione Liquid Glass
# Copyright (C) 2026 Agnell02010
# Licenza: GPL-2.0-or-later
#
# Uso:
#   ./applica-profilo.sh no-blur     vetro senza sfocatura (consigliato)
#   ./applica-profilo.sh blur        vetro con sfocatura
#   ./applica-profilo.sh salva       salva le impostazioni attuali in un file
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
    NOME="NO_BLUR (senza sfocatura)"
    ;;
  blur|b)
    FILE="$DIR/liquid_glass_settings(BLUR).txt"
    NOME="BLUR (con sfocatura)"
    ;;
  salva|save)
    mkdir -p "$BACKUP_DIR"
    OUT="$BACKUP_DIR/liquid_glass_$(date +%Y%m%d-%H%M%S).txt"
    dconf dump "$LG_PATH" > "$OUT"
    echo "${G}  ok${N}  Impostazioni salvate in: $OUT"
    exit 0
    ;;
  *)
    echo "Uso: $0 [no-blur|blur|salva]" >&2
    exit 2
    ;;
esac

if ! command -v dconf >/dev/null 2>&1; then
  echo "${R}  xx${N}  Comando 'dconf' non trovato." >&2
  exit 1
fi

if [ ! -f "$FILE" ]; then
  echo "${R}  xx${N}  File profilo non trovato: $FILE" >&2
  exit 1
fi

# backup delle impostazioni attuali
mkdir -p "$BACKUP_DIR"
dconf dump "$LG_PATH" > "$BACKUP_DIR/liquid_glass_$(date +%Y%m%d-%H%M%S).txt" || true

# applica
dconf load "$LG_PATH" < "$FILE"

echo "${G}  ok${N}  Profilo applicato: ${B}$NOME${N}"
echo
echo "  Se il Centro di controllo è già aperto, richiudilo e riaprilo"
echo "  (l'effetto vetro viene ricalcolato all'apertura)."
echo
