# Pulsar CC 27 — MacOS-style Control Center for GNOME

A **MacOS-style Control Center** for GNOME Shell 50 with a **Liquid Glass**
effect. The tiles, the four circles, the media player and the sliders are all
marked as "toggles" so that the *Liquid Glass* extension applies the glass to
**everything**, not only to the buttons.

Created by **[Agnell02010](https://github.com/Agnell02010)**.

![GNOME Shell 50](https://img.shields.io/badge/GNOME%20Shell-50-blue)
![License GPL-2.0](https://img.shields.io/badge/license-GPL--2.0--or--later-green)

---

## ✨ What's included

| Item | Description |
|---|---|
| **Tiles** | Wi-Fi/Bluetooth (pill shaped), Airplane, Do Not Disturb, Power Saving, Dark Mode, Screenshot, Screen Recording, Contrast |
| **4 circles** | perfect MacOS-style circles (with the glass effect) |
| **Player** | title, artist, rounded album art, centred rewind / play-pause / forward buttons |
| **Sliders** | volume and brightness aligned, thin bar like on MacOS |
| **Icons** | SF Symbol icon set, normalised 1:1 with MacOS |
| **Font** | San Francisco (`SF UI Text`) |
| **Glass** | Liquid Glass applied to every element of the panel |
| **Animations** | cascading open, press feedback, crossfade play/pause — tunable without logging out |

---

## 📋 Requirements

1. **GNOME Shell 50** (works on Wayland and X11).
2. The **[Liquid Glass](https://extensions.gnome.org/extension/7344/liquid-glass/)**
   extension installed and enabled (`liquid-glass@thinkingcoding1231.gmail.com`).
   *Without it the extension still works, just without the glass effect.*
3. *(Recommended)* the **MacTahoe-Dark** GNOME Shell theme for the 1:1 look.
   The extension also protects itself against themes that move the tile
   children: the player stays centred even with other themes.
4. *(Recommended)* the **User Themes** extension, to apply the theme.
5. *(For the player)* any MPRIS player (Spotify, Firefox, …).

---

## 🚀 Installation (for a friend)

```bash
git clone https://github.com/Agnell02010/Pulsar-CC-27-Gnome.git
cd Pulsar-CC-27-Gnome
./install.sh
```

The script:

1. copies the extension to `~/.local/share/gnome-shell/extensions/`;
2. enables it;
3. asks whether to apply the bundled **Liquid Glass** profile (recommended: NO_BLUR);
4. tells you what to do next (logout/login).

### Manual (if you prefer)

```bash
# 1. extension
mkdir -p ~/.local/share/gnome-shell/extensions
cp -r macos-control-centre-lg@pulsar.local ~/.local/share/gnome-shell/extensions/
gnome-extensions enable macos-control-centre-lg@pulsar.local

# 2. Liquid Glass (recommended profile, no blur)
dconf load /org/gnome/shell/extensions/liquid-glass/ \
    < liquid-glass/liquid_glass_settings\(NO_BLUR\).txt

# 3. log out and back in (required on Wayland)
```

> ⚠️ On **Wayland** new extensions need a **logout/login** to be loaded.
> On X11, `Alt+F2` → `r` is enough.

### After logging in

Press **`Super+S`** to open the Control Center (or click the system icon in
the top right corner).

---

## 🎛️ Liquid Glass profiles

The `liquid-glass/` folder contains two ready-made profiles:

| Profile | Effect | Use |
|---|---|---|
| `liquid_glass_settings(NO_BLUR).txt` | glass **without** blur | **recommended**, lighter |
| `liquid_glass_settings(BLUR).txt` | glass **with** blur | "softer" look |

Apply a profile with:

```bash
dconf load /org/gnome/shell/extensions/liquid-glass/ < liquid-glass/liquid_glass_settings\(NO_BLUR\).txt
```

or with the bundled scripts:

```bash
./liquid-glass/applica-profilo.sh no-blur
./liquid-glass/applica-profilo.sh blur
```

The key values for the Control Center are:

```
quick-settings-apply-to=1                # "Toggles" mode (glass on everything)
quick-settings-toggle-corner-radius=30.0 # tile corner radius (glass that lines up)
quick-settings-glass-expand=0            # the glass must NOT overflow the panel
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

```bash
./uninstall.sh
```

Removes the extension (the Liquid Glass settings are left untouched). Then log
out and back in.

---

## 🔧 Project structure

```
.
├── macos-control-centre-lg@pulsar.local/   # the GNOME extension
│   ├── extension.js                        # logic (panel, MPRIS, brightness, animations…)
│   ├── stylesheet.css                      # all the styling (tiles, circles, sliders)
│   ├── metadata.json
│   ├── icons/                              # SF Symbol style SVG icons
│   └── *.png                               # bubble / circle backgrounds
├── liquid-glass/                           # profiles for the Liquid Glass extension
│   ├── liquid_glass_settings(NO_BLUR).txt
│   ├── liquid_glass_settings(BLUR).txt
│   └── applica-profilo.sh
├── install.sh
├── uninstall.sh
├── animazione-esempio.json                 # example of the animation parameters
├── LICENSE
└── README.md
```

> The folder keeps the spelling `centre` because that is the extension UUID —
> it cannot be changed. Everywhere else this project uses "Control Center".

---

## ❓ FAQ

**I don't see the extension after installing.**
On Wayland you need a logout/login. Check with
`gnome-extensions list --enabled | grep macos`.

**The glass overflows the panel.**
Apply the NO_BLUR profile (it has `quick-settings-glass-expand=0` and
`quick-settings-toggle-corner-radius=30.0`) or lower the radius even more.

**The panel has a black background behind the glass.**
The extension removes it by itself with `.quick-settings { background: none }`.
If a custom theme puts it back, check your theme.

**The player is shifted to the right.**
The extension neutralises the padding that themes (e.g. MacTahoe) inject into
the tile children. If you use a different theme, open an issue.

**Which versions does it work on?**
GNOME Shell 50. Other versions may need some adaptation.

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

GPL-2.0-or-later — see [LICENSE](LICENSE).

If you prefer another license (MIT, GPL-3.0, …) open an issue.
