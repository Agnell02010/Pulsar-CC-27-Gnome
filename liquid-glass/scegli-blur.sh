#!/usr/bin/env bash
#
# Liquid Glass - scegli il livello di blur
#
# Avvia lo script, chiede "Livello blur?" e applica il livello scelto.
# Nessun argomento obbligatorio: 0 = niente blur, 3 = forte (il default).
#
#   ./scegli-blur.sh          chiede il livello
#   ./scegli-blur.sh 2        applica il 2 senza chiedere (per scorciatoie)
#   ./scegli-blur.sh --fix    se l'effetto n/rifrazione e' sparito, ricarica
#                             l'estensione e ripristina il livello attuale
#
# Il cambio di livello scrive SOLO i 7 raggi di blur: ottici, profilo dock e
# tutto il resto restano intatti, quindi cambiare livello non butta via la
# taratura di bordi e angoli. Per il ripristino completo (PC nuovo, recuperare
# un look perso) usa invece:
#   ./applica-profilo.sh N --pieno
#
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLICA="$DIR/applica-profilo.sh"
LG_PATH="/org/gnome/shell/extensions/liquid-glass/"

if [ -t 0 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else B=""; G=""; Y=""; R=""; N=""; fi

# Quale livello e' attivo adesso? Lo deduco dal raggio di blur dei menu.
corrente() {
  local r
  r="$(dconf dump "$LG_PATH" | grep '^menu-blur-radius=' | cut -d= -f2)"
  case "$r" in
    0)  echo 0 ;;
    4)  echo 1 ;;
    8)  echo 2 ;;
    12) echo 3 ;;
    *)  echo "?" ;;
  esac
}

stampa_menu() {
  echo
  echo "  Attuale: livello ${B}${1}${N}"
  echo
  echo "    ${B}0${N}  niente blur      vetro trasparente"
  echo "    ${B}1${N}  blur leggero"
  echo "    ${B}2${N}  blur medio"
  echo "    ${B}3${N}  blur forte       quello predefinito"
  echo
}

# --fix: dopo un passaggio dallo 0 (nessun blur) la pipeline di blur puo' non
# ricostruirsi e l'effetto n/rifrazione sparisce. Ricaricare l'estensione la
# ricrea da capo leggendo di nuovo gli stessi valori. Il livello resta quello.
if [ "${1:-}" = "--fix" ] || [ "${1:-}" = "-f" ]; then
  LG="liquid-glass@thinkingcoding1231.gmail.com"
  L="$(corrente)"
  echo
  echo "  Livello in uso: $L - ricarico l'estensione..."
  gnome-extensions disable "$LG" >/dev/null 2>&1 || true
  sleep 3
  gnome-extensions enable "$LG" >/dev/null 2>&1 || true
  sleep 5
  if gnome-extensions info "$LG" 2>/dev/null | grep -q 'ACTIVE'; then
    echo "  ${G}OK${N}  estensione attiva, livello $L invariato."
  else
    echo "  ${R}xx${N}  non e' tornata attiva: gnome-extensions info $LG"
    exit 1
  fi
  echo
  exit 0
fi

# Un argomento da riga di comando salta la richiesta (per i file .desktop).
if [ -n "${1:-}" ]; then
  LIVELLO="$1"
else
  stampa_menu "$(corrente)"
  while true; do
    printf "  %sLivello blur%s (0-3, invio = %s): " "$B" "$N" "$(corrente)"
    read -r LIVELLO || { echo; exit 0; }
    LIVELLO="${LIVELLO// /}"
    [ -z "$LIVELLO" ] && LIVELLO="$(corrente)"
    case "$LIVELLO" in
      0|1|2|3) break ;;
      *) printf "  %s  inserisci 0, 1, 2 o 3%s\n" "$R" "$N" ;;
    esac
  done
fi

if [ ! -x "$APPLICA" ]; then
  echo "${R}  xx${N}  Non trovo $APPLICA" >&2
  exit 1
fi

echo
"$APPLICA" "$LIVELLO"
echo
echo "  ${G}Fatto.${N} Livello ${B}${LIVELLO}${N} attivo."
