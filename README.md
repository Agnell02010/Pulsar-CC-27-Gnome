# Pulsar CC 27 — MacOS Control Center for GNOME

<img width="365" height="569" alt="Pulsar-CC-27 (No Blur)" src="https://github.com/user-attachments/assets/7f6a8b61-5f11-4396-bf21-215335e58393" />
<img width="365" height="569" alt="Pulsar-CC-27 (Blur)" src="https://github.com/user-attachments/assets/d8cdb1a2-f7f4-44fe-b011-78ec8b58b342" />

A **macOS-style Control Center** for GNOME Shell 50, featuring a **Liquid Glass** effect. Tiles, four circular elements, the media player, and sliders are all marked as `"toggle"` elements, allowing the *Liquid Glass* extension to apply the glass effect to **every element**, not just the buttons.

Created by **[Agnell02010](https://github.com/Agnell02010)**.

![GNOME Shell 50](https://img.shields.io/badge/GNOME%20Shell-50-blue)
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

---

## 📋 Requirements

1. **GNOME Shell 50** (supports both Wayland and X11).
2. **[Liquid Glass extension](https://extensions.gnome.org/extension/7344/liquid-glass/)** installed and enabled (`liquid-glass@thinkingcoding1231.gmail.com`).

   *Without this extension, the Control Center still works, but the glass effect will not be available.*

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
3. Asks whether to apply the included **Liquid Glass** profile (recommended: `NO_BLUR`).
4. Explains how to complete the installation by logging out and back in.

### Manual Installation

If you prefer to install it manually:

```bash
# 1. Install the extension
mkdir -p ~/.local/share/gnome-shell/extensions
cp -r macos-control-centre-lg@pulsar.local ~/.local/share/gnome-shell/extensions/
gnome-extensions enable macos-control-centre-lg@pulsar.local

# 2. Apply the recommended Liquid Glass profile (no blur)
dconf load /org/gnome/shell/extensions/liquid-glass/ \
    < "liquid-glass/liquid_glass_settings(NO_BLUR).txt"

# 3. Log out and back in (required on Wayland)
```

> ⚠️ **Wayland:** New extensions require a logout/login to be loaded. On X11, you can usually restart GNOME Shell using `Alt+F2`, then `r`.

### After Logging In

Press **`Super+S`** to open the Control Center, or click the system icon in the top-right corner.

---

## 🎛️ Liquid Glass Profiles

The `liquid-glass/` directory contains two ready-to-use profiles:

| Profile | Effect | Recommended Use |
|---|---|---|
| `liquid_glass_settings(NO_BLUR).txt` | Glass without blur | **Recommended** — lighter and less resource-intensive |
| `liquid_glass_settings(BLUR).txt` | Glass with blur | A softer, more translucent appearance |

Apply a profile using `dconf`:

```bash
dconf load /org/gnome/shell/extensions/liquid-glass/ \
    < "liquid-glass/liquid_glass_settings(NO_BLUR).txt"
```

Alternatively, use the included scripts:

```bash
./liquid-glass/applica-profilo.sh no-blur
./liquid-glass/applica-profilo.sh blur
```

### Key Settings

```ini
quick-settings-apply-to=1                # "Toggles" mode (glass on all elements)
quick-settings-toggle-corner-radius=30.0 # Tile corner radius (matching the glass effect)
quick-settings-glass-expand=0            # Prevents the glass from extending beyond the panel
```

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
├── liquid-glass/                           # Liquid Glass configuration profiles
│   ├── liquid_glass_settings(NO_BLUR).txt
│   ├── liquid_glass_settings(BLUR).txt
│   └── applica-profilo.sh
├── install.sh
├── uninstall.sh
├── LICENSE
└── README.md
```

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

**Which GNOME versions are supported?**

The extension targets **GNOME Shell 50**. Other versions may require modifications.

---

## 📜 License

Licensed under **GPL-2.0-or-later**. See [LICENSE](LICENSE) for details.

Prefer another license, such as MIT or GPL-3.0? Feel free to open an issue to discuss it.

---

## English Summary

A **macOS-style Control Center** for GNOME Shell 50 with a **Liquid Glass** effect applied to every element, including tiles, circles, the media player, and sliders.

**Requirements:** GNOME Shell 50 and the [Liquid Glass extension](https://extensions.gnome.org/extension/7344/liquid-glass/) for the glass effect. The MacTahoe-Dark Shell theme is optional but recommended.

**Installation:**

```bash
git clone https://github.com/Agnell02010/Pulsar-CC-27-Gnome.git
cd Pulsar-CC-27-Gnome
./install.sh
```

Log out and back in on Wayland, then press `Super+S` to open the Control Center.

Licensed under **GPL-2.0-or-later**.
