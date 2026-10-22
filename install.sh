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

# ------------------------------------------------- stock control centre
# Pulsar OS still ships an older Control Centre with its own Notification
# Center. Two Control Centres fight for the same Quick Settings, and the old
# drawer is what makes a fresh machine look different: disable it.
STOCK_CC="macos-control-centre@pulsar.local"
if gnome-extensions list 2>/dev/null | grep -qx "$STOCK_CC"; then
  if gnome-extensions disable "$STOCK_CC" 2>/dev/null; then
    ok "Stock Control Centre disabled (it shipped the old Notification Center)"
  else
    warn "Disable the stock Control Centre by hand:"
    warn "  gnome-extensions disable $STOCK_CC"
  fi
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
      info "  ./liquid-glass/applica-profilo.sh 1"
      ;;
    *)
      echo
      info "Liquid Glass blur levels:"
      info "  0 = no blur   0.5 = barely there   1 = light (clean)   2 = medium   3 = strong"
      read -r -p "  Blur level? [0, 0.5, 1-3, default 1] " LIVELLO || LIVELLO="1"
      LIVELLO="${LIVELLO:-1}"
      case "$LIVELLO" in
        0) PROFILE="$SRC_DIR/liquid-glass/liquid_glass_settings(NO_BLUR).txt";          NOME="0 — no blur" ;;
        0.5|05|0,5) PROFILE="$SRC_DIR/liquid-glass/liquid_glass_settings(BLUR-05-MINIMO).txt"; NOME="0.5 — barely there" ;;
        1) PROFILE="$SRC_DIR/liquid-glass/liquid_glass_settings(BLUR-1-LEGGERO).txt";   NOME="1 — light blur" ;;
        2) PROFILE="$SRC_DIR/liquid-glass/liquid_glass_settings(BLUR-2-MEDIO).txt";     NOME="2 — medium blur" ;;
        3) PROFILE="$SRC_DIR/liquid-glass/liquid_glass_settings(BLUR-3-FORTE).txt";     NOME="3 — strong blur" ;;
        *)
          warn "Unknown level '$LIVELLO', using 1 (light)."
          PROFILE="$SRC_DIR/liquid-glass/liquid_glass_settings(BLUR-1-LEGGERO).txt"
          NOME="1 — light blur"
          ;;
      esac
      if [ -f "$PROFILE" ]; then
        # A fresh machine has nothing to preserve, so the whole profile is
        # loaded and the look is established in one go. Re-running this
        # installer on an already tuned machine must not throw that tuning
        # away, so it then writes only the blur radii.
        if dconf dump "$LG_PATH" | grep -q '^glass-profile-shape-n='; then
          if "$SRC_DIR/liquid-glass/applica-profilo.sh" "$LIVELLO"; then
            ok "Blur level applied, optics kept: $NOME"
          else
            warn "Could not apply the level. Do it later with:"
            warn "  ./liquid-glass/applica-profilo.sh $LIVELLO"
          fi
        else
          dconf load "$LG_PATH" < "$PROFILE"
          ok "Profile applied: $NOME"
        fi
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

# --------------------------------------------------- desktop launchers
# Written here, from $SRC_DIR, so a clone on any machine records that machine's
# own paths instead of someone else's home directory. They live in the repo
# (liquid-glass/*.sh), so there is a single source of truth and re-running this
# installer keeps them in sync.
echo
info "Creating the Liquid Glass launchers in ~/.local/share/applications"
APPS_DIR="$HOME/.local/share/applications"
LG_APPLICA="$SRC_DIR/liquid-glass/applica-profilo.sh"
LG_SCEGLI="$SRC_DIR/liquid-glass/scegli-blur.sh"

mkdir -p "$APPS_DIR"

# Args: file, Name, Comment, Icon, Exec (quoted by the caller when needed).
launcher() {
  printf '%s\n' \
    "[Desktop Entry]" \
    "Type=Application" \
    "Name=$2" \
    "Comment=$3" \
    "Exec=$5" \
    "Icon=$4" \
    "Terminal=true" \
    "Categories=Settings;" > "$APPS_DIR/$1"
  ok "$2"
}

if [ -x "$LG_APPLICA" ] && [ -x "$LG_SCEGLI" ]; then
  launcher "Liquid Glass - livello blur.desktop" \
    "Liquid Glass: livello blur" \
    "Choose the Liquid Glass blur level (0-3)" \
    "preferences-system" "\"$LG_SCEGLI\""
  launcher "Liquid Glass - BLUR.desktop" \
    "Liquid Glass: profilo BLUR" \
    "Apply the profile with blur" \
    "preferences-system" "\"$LG_APPLICA\" 3"
  launcher "Liquid Glass - NO BLUR.desktop" \
    "Liquid Glass: profilo NO BLUR" \
    "Apply the profile without blur" \
    "preferences-system" "\"$LG_APPLICA\" 0"
  launcher "Liquid Glass - Salva.desktop" \
    "Liquid Glass: salva profilo" \
    "Save the current settings" \
    "document-save" "\"$LG_APPLICA\" salva"
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$APPS_DIR" 2>/dev/null || true
  fi
else
  warn "liquid-glass/*.sh not found: launchers not created."
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
