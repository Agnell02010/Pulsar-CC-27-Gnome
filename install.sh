#!/usr/bin/env bash
#
# Pulsar CC 27 - installazione del Centro di controllo stile macOS
# Copyright (C) 2026 Agnell02010
# Licenza: GPL-2.0-or-later
#
set -euo pipefail

UUID="macos-control-centre-lg@pulsar.local"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_SRC="$SRC_DIR/$UUID"
EXT_DST="$HOME/.local/share/gnome-shell/extensions/$UUID"
LG_PATH="/org/gnome/shell/extensions/liquid-glass/"

# --- colori ---
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
echo "${B}Pulsar CC 27 — Centro di controllo stile macOS${N}"
echo "-----------------------------------------------"
echo

# ---------------------------------------------------------------- controlli
if ! command -v gnome-extensions >/dev/null 2>&1; then
  err "Comando 'gnome-extensions' non trovato: questo non sembra GNOME Shell."
  exit 1
fi

SHELL_VER="$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)"
if [ -n "${SHELL_VER:-}" ]; then
  info "GNOME Shell rilevato: versione $SHELL_VER"
  if [ "$SHELL_VER" -lt 45 ] 2>/dev/null; then
    warn "L'estensione è pensata per GNOME Shell 50: su $SHELL_VER potrebbe non funzionare."
  fi
else
  warn "Non riesco a determinare la versione di GNOME Shell."
fi

if [ ! -d "$EXT_SRC" ]; then
  err "Cartella dell'estensione non trovata: $EXT_SRC"
  err "Lancia lo script dalla cartella del progetto."
  exit 1
fi

# ------------------------------------------------------- copia estensione
echo
info "Copio l'estensione in ${B}$EXT_DST${N}"
mkdir -p "$(dirname "$EXT_DST")"
rm -rf "$EXT_DST"
cp -r "$EXT_SRC" "$EXT_DST"
ok "Estensione copiata ($(find "$EXT_DST" -type f | wc -l) file)"

# ------------------------------------------------------------- abilitazione
if gnome-extensions enable "$UUID" 2>/dev/null; then
  ok "Estensione abilitata"
else
  warn "Non sono riuscito ad abilitarla automaticamente."
  warn "Fallo a mano:  gnome-extensions enable $UUID"
fi

# ---------------------------------------------------------- Liquid Glass
echo
if gnome-extensions list 2>/dev/null | grep -q '^liquid-glass@'; then
  ok "Estensione Liquid Glass trovata"
  echo
  read -r -p "  Applico un profilo Liquid Glass per il Centro di controllo? [S/n] " RISPOSTA || RISPOSTA="s"
  RISPOSTA="${RISPOSTA:-s}"
  case "$RISPOSTA" in
    n|N)
      info "Profilo non applicato. Puoi farlo dopo con:"
      info "  ./liquid-glass/applica-profilo.sh no-blur"
      ;;
    *)
      PROFILE="$SRC_DIR/liquid-glass/liquid_glass_settings(NO_BLUR).txt"
      if [ -f "$PROFILE" ]; then
        dconf load "$LG_PATH" < "$PROFILE"
        ok "Profilo NO_BLUR applicato (vetro senza sfocatura)"
      else
        warn "File profilo non trovato: $PROFILE"
      fi
      ;;
  esac
else
  warn "Estensione Liquid Glass NON trovata."
  warn "Senza di essa il Centro di controllo funziona ma non ha l'effetto vetro."
  warn "Installa Liquid Glass e poi applica un profilo con:"
  warn "  ./liquid-glass/applica-profilo.sh no-blur"
fi

# --------------------------------------------------------------- finale
echo
echo "-----------------------------------------------"
echo "${G}${B}Installazione completata!${N}"
echo
echo "  ${B}Ora devi uscire e rientrare (logout/login).${N}"
echo "  Su Wayland è obbligatorio perché GNOME carichi l'estensione."
echo
echo "  Dopo il login premi  ${B}Super+S${N}  per aprire il Centro di controllo."
echo
echo "  Ulteriori info nel README.md"
echo
