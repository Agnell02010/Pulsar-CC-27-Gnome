# Pulsar CC 27 — MacOS Control Center for GNOME

<img width="365" height="569" alt="Pulsar-CC-27 (No Blur)" src="https://github.com/user-attachments/assets/7f6a8b61-5f11-4396-bf21-215335e58393" />
<img width="365" height="569" alt="Pulsar-CC-27 (Blur)" src="https://github.com/user-attachments/assets/d8cdb1a2-f7f4-44fe-b011-78ec8b58b342" />

A **macOS-style Control Center** for GNOME Shell 50 and 51, featuring a **Liquid Glass** effect. Tiles, four circular elements, the media player, and sliders are all marked as `"toggle"` elements, allowing the *Liquid Glass* extension to apply the glass effect to **every element**, not just the buttons.

Created by **[Agnell02010](https://github.com/Agnell02010)**.

![GNOME Shell 50 | 51](https://img.shields.io/badge/GNOME%20Shell-50%20%7C%2051-blue)
![License GPL-2.0](https://img.shields.io/badge/license-GPL--2.0--or--later-green)

---

## ✨ Features

| Element | Description |
|---|---|
| **Tiles** | Wi-Fi/Bluetooth (pill-shaped), Airplane Mode, Do Not Disturb, Power Saver, Dark Mode, Screenshot, Screen Recording, and Contrast |
| **4 Circles** | Perfect macOS-style circles with a glass effect |
| **Media Player** | Track title, artist, rounded album artwork, and centered rewind / play-pause / forward controls |
| **Sliders** | Aligned volume and brightness controls with slim macOS-style bars |
| **Icons** | SF Symbols-inspired icon set, normalized to match macOS proportions |
| **Font** | San Francisco (`SF UI Text`) |
| **Liquid Glass** | Glass effect applied to every element of the panel |
| **Animations** | cascading open, press feedback, crossfade play/pause — tunable without logging out |

---

## 📋 Requirements

1. **GNOME Shell 50 or 51** (supports both Wayland and X11).
2. **The Pulsar Liquid Glass extension** installed and enabled
   (`liquid-glass@thinkingcoding1231.gmail.com`):

   ```bash
   git clone https://github.com/Agnell02010/Pulsar-Liquid-Glass.git
   cd Pulsar-Liquid-Glass && ./install.sh && cd ..
   ```

   This is a fork of [Liquid Glass](https://extensions.gnome.org/extension/7344/liquid-glass/)
   by Ryosuke Watanabe (MIT). Install the fork rather than the upstream
   release: Pulsar adds the edge lens that produces the macOS refraction, and
   the blur profiles in this repository are tuned against it.

   *Without any Liquid Glass the Control Center still works, just without the
   glass look.*

3. *(Recommended)* The **MacTahoe-Dark** GNOME Shell theme for a closer macOS-like appearance.

   The extension also protects its layout against themes that reposition tile children, keeping the media player centered even when using other themes.

4. *(Recommended)* The **User Themes** GNOME extension to apply custom Shell themes.
5. *(For the media player)* Any MPRIS-compatible media player, such as Spotify or Firefox.

---

## 🚀 Installation

Clone the repository and run the installer:

```bash
git clone https://github.com/Agnell02010/Pulsar-CC-27-Gnome.git
cd Pulsar-CC-27-Gnome
./install.sh
```

The installer:

1. Copies the extension into `~/.local/share/gnome-shell/extensions/`.
2. Enables the extension.
3. Asks which **Liquid Glass** blur level to apply (recommended: `1`, light).
4. Writes four launchers to `~/.local/share/applications`, for switching level later.
5. Explains how to complete the installation by logging out and back in.

### Manual Installation

If you prefer to install it manually:

```bash
# 1. Install the extension
mkdir -p ~/.local/share/gnome-shell/extensions
cp -r macos-control-centre-lg@pulsar.local ~/.local/share/gnome-shell/extensions/
gnome-extensions enable macos-control-centre-lg@pulsar.local

# 2. Apply the recommended Liquid Glass profile (light blur)
dconf load /org/gnome/shell/extensions/liquid-glass/ \
    < "liquid-glass/liquid_glass_settings(BLUR-1-LEGGERO).txt"

# 3. Log out and back in (required on Wayland)
```

> Skip `install.sh` and you also skip the desktop launchers; use
> `./liquid-glass/scegli-blur.sh` from the terminal instead.

> ⚠️ **Wayland:** New extensions require a logout/login to be loaded. On X11, you can usually restart GNOME Shell using `Alt+F2`, then `r`.

### After Logging In

Press **`Super+S`** to open the Control Center, or click the system icon in the top-right corner.

---

## 🎛️ Liquid Glass Blur Levels

The `liquid-glass/` directory contains four blur levels, macOS-style:

| Level | File | Effect |
|---|---|---|
| **0** | `liquid_glass_settings(NO_BLUR).txt` | No blur, crisp glass — lightest |
| **1** | `liquid_glass_settings(BLUR-1-LEGGERO).txt` | **Light blur — the clean middle ground** |
| **2** | `liquid_glass_settings(BLUR-2-MEDIO).txt` | Medium blur |
| **3** | `liquid_glass_settings(BLUR-3-FORTE).txt` | Strong blur |

`liquid_glass_settings(BLUR).txt` is an alias of **level 3**, so older
instructions keep working.

### Switching level

`scegli-blur.sh` is the single entry point:

```bash
./liquid-glass/scegli-blur.sh          # interactive picker (0-3)
./liquid-glass/scegli-blur.sh 1        # light blur (recommended)
./liquid-glass/scegli-blur.sh 0        # no blur
./liquid-glass/scegli-blur.sh 2        # medium
./liquid-glass/scegli-blur.sh 3        # strong
./liquid-glass/scegli-blur.sh --fix    # reload the extension, keep the level
```

`--fix` is the remedy when the glass looks wrong. It disables and re-enables
Liquid Glass, which resets the blur pipeline, and leaves the current level
untouched.

`applica-profilo.sh` does the same work without the picker, and can also save
the live settings:

```bash
./liquid-glass/applica-profilo.sh 1      # light blur (recommended)
./liquid-glass/applica-profilo.sh salva  # save the live settings to a file
```

Applying a level directly with `dconf` still works:

```bash
dconf load /org/gnome/shell/extensions/liquid-glass/ \
    < "liquid-glass/liquid_glass_settings(BLUR-1-LEGGERO).txt"
```

### Desktop launchers

`install.sh` writes four launchers to `~/.local/share/applications`, so the
levels are also reachable from the app grid. Their `Exec` paths are computed
from wherever the repository was cloned — never hard-coded — so they work on
any machine:

| Launcher | Runs |
|---|---|
| **Liquid Glass: livello blur** | `scegli-blur.sh` (interactive) |
| **Liquid Glass: profilo BLUR** | `applica-profilo.sh 3` |
| **Liquid Glass: profilo NO BLUR** | `applica-profilo.sh 0` |
| **Liquid Glass: salva profilo** | `applica-profilo.sh salva` |

If you move the clone, re-run `./install.sh`: the launchers are rewritten to
the new location.

> Every level is a full dump of the live settings, so it also carries the dock
> glass profile. Switching levels **does not revert the dock tuning**, and
> `applica-profilo.sh` refuses to load a profile that is missing those keys.
> Regenerate the levels from the live state with
> `python3 liquid-glass/gen_profiles.py`.

### Key Settings

```ini
quick-settings-apply-to=1                # "Toggles" mode (glass on all elements)
quick-settings-toggle-corner-radius=30.0 # Tile corner radius (matching the glass effect)
quick-settings-glass-expand=0            # Prevents the glass from extending beyond the panel
```

---

## 🎬 Animations (and how to tune them without logging out)

The extension reproduces MacOS-style animations:

| Animation | What it does |
|---|---|
| **Cascading open** | when the panel opens, the tiles arrive one after another from left to right: they start slightly smaller, overshoot the final size a little and then settle (liquid effect) |
| **Press** | tiles, circles, player buttons and AirPlay compress **the moment you press them** (not on release) and come back with a soft bounce, plus a slight vertical squash |
| **Activation spring** | on click the whole pill (bubble included) or the circle rises in one continuous motion, right at the moment you release, and then settles. Off by default: enable it with `popScale: 1.12` |
| **Play/Pause** | the glyph changes with a crossfade |
| **Slider** | the volume/brightness tile lifts slightly while you drag the slider (as before) |

> 💡 The bubbles inside the pills **never** bounce on their own: they move
> together with the pill, as if they were a single piece (no double bounce).
> The optional activation spring (`"popScale": 1.12`) moves the whole pill, in
> a single motion that starts at the click — never at the base size in between.

> ⚠️ GNOME (St) **does not support CSS animations**, so they are written in
> JavaScript. The first time you install this version you need **one logout**
> (once only).

**Tuning them needs NO logout.** On first run the extension creates this file:

```
~/.config/pulsar-cc/animazione.json
```

It is **re-read every time** the Control Center opens: change a number, reopen
the panel and you see the effect right away. If the file is missing or contains
an error, the defaults are used (nothing can break).

```jsonc
{
    "enabled": true,          // false = no animation at all

    "enterBase": 20,          // initial delay of the cascade (ms)
    "enterStep": 20,          // delay between two tiles (ms)  <- the "rhythm"
    "enterDuration": 280,     // arrival duration (ms)
    "enterSettle": 150,       // final settle duration (ms)
    "enterScale": 0.90,       // starting scale (1 = fade only)
    "enterRise": 8,           // how many px they drop from (0 = none)
    "enterOvershoot": 1.02,   // how far it overshoots before settling

    "pressScale": 0.94,       // how much it squashes on press
    "pressSquash": 0.03,      // extra vertical squash (0 = uniform)
    "pressDown": 90,          // time to squash (ms)
    "pressUp": 260,           // time to come back, with bounce (ms)
    "pressOvershoot": 1.02,   // comes back slightly past the final size

    "popScale": 1.0,          // 1.0 = off; 1.12 = activation spring on click
    "popDown": 110,
    "popUp": 230,

    "iconOut": 80,            // play→pause: glyph out (ms)
    "iconIn": 200,            // play→pause: glyph in (ms)

    "sliderLift": 1.02,       // how much the tile lifts while dragging
    "sliderUp": 140,
    "sliderDown": 240
}
```

Quick examples:

- slower, "deluxe" cascade: `enterStep: 30`, `enterDuration: 320`
- crisper/instant (MacOS style): `enterStep: 12`, `enterDuration: 180`
- **even more "liquid"**: `enterOvershoot: 1.04`, `pressSquash: 0.05`
- **no bounce** (crisp movement): `pressUp: 120`, `pressOvershoot: 1.0`, `enterOvershoot: 1.0`
- **no squash** (uniform compression): `pressSquash: 0`
- **MacOS-like activation spring**: `popScale: 1.12` (one single motion, starting at the click)
- everything off: `enabled: false`

A copy of the file is also in [`animazione-esempio.json`](animazione-esempio.json).

---

## 🗑️ Uninstallation

Run:

```bash
./uninstall.sh
```

This removes the extension while leaving your Liquid Glass settings untouched.

Log out and back in to complete the process.

---

## 🔧 Project Structure

```text
.
├── macos-control-centre-lg@pulsar.local/   # GNOME Shell extension
│   ├── extension.js                        # Logic: panel, MPRIS, brightness, etc.
│   ├── stylesheet.css                      # Styling: tiles, circles, sliders
│   ├── metadata.json
│   ├── icons/                              # SF Symbols-inspired SVG icons
│   └── *.png                               # Background bubbles / circles
├── liquid-glass/                           # Liquid Glass blur levels
│   ├── liquid_glass_settings(NO_BLUR).txt          # level 0
│   ├── liquid_glass_settings(BLUR-1-LEGGERO).txt   # level 1 (light)
│   ├── liquid_glass_settings(BLUR-2-MEDIO).txt     # level 2 (medium)
│   ├── liquid_glass_settings(BLUR-3-FORTE).txt     # level 3 (strong)
│   ├── liquid_glass_settings(BLUR).txt             # alias of level 3
│   ├── scegli-blur.sh                    # level picker (0-3), plus --fix to reload
│   ├── applica-profilo.sh                # applies a level, saves, guards dock keys
│   └── gen_profiles.py                    # regenerates the levels from live settings
├── install.sh                            # also writes the desktop launchers
├── uninstall.sh
├── animazione-esempio.json                 # example of the animation parameters
├── LICENSE
└── README.md
```

> The folder keeps the spelling `centre` because that is the extension UUID —
> it cannot be changed. Everywhere else this project uses "Control Center".

---

## ❓ Frequently Asked Questions

**The extension does not appear after installation.**

On Wayland, log out and back in. You can verify that the extension is enabled with:

```bash
gnome-extensions list --enabled | grep macos
```

**The glass effect extends beyond the panel.**

Apply the `NO_BLUR` profile. It sets `quick-settings-glass-expand=0` and `quick-settings-toggle-corner-radius=30.0`. If necessary, reduce the corner radius further.

**There is a black background behind the glass.**

The extension removes the default background using `.quick-settings { background: none }`. If a custom theme reintroduces it, check the theme's stylesheet.

**The media player is shifted to the right.**

The extension neutralizes padding injected into tile children by certain themes, including MacTahoe. If the issue persists with another theme, please [open an issue](https://github.com/Agnell02010/Pulsar-CC-27-Gnome/issues).

**The glass looks wrong after switching blur level.**

The settings were applied but the extension kept its previous blur state. Reload
it — this resets the blur pipeline and keeps your level:

```bash
./liquid-glass/scegli-blur.sh --fix
```

**Which GNOME versions are supported?**

The extension targets **GNOME Shell 50 and 51**. Other versions may require modifications.

---

## 🌍 Languages

The texts shown inside the Control Center follow the language of your PC
(detected from the session locale). English is the fallback, so something is
always shown. Included: English, Italian, French, German, Spanish, Portuguese
(Portugal and Brazil), Dutch, Polish, Russian, Turkish, Ukrainian, Czech,
Hungarian, Romanian, Greek, Swedish, Danish, Norwegian, Finnish, Japanese,
Chinese (Simplified), Korean, Indonesian and Vietnamese.

Translations for other languages are welcome: the table lives at the top of
`macos-control-centre-lg@pulsar.local/extension.js` (the `STRINGS` object).

---

## 📜 License

Licensed under **GPL-2.0-or-later**. See [LICENSE](LICENSE) for details.

Prefer another license, such as MIT or GPL-3.0? Feel free to open an issue to discuss it.
