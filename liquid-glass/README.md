# Liquid Glass blur levels

This folder contains the ready-made **blur levels** for the
**Liquid Glass** extension (`liquid-glass@thinkingcoding1231.gmail.com`).

## Levels

| Level | File | Look |
|---|---|---|
| **0** | `liquid_glass_settings(NO_BLUR).txt` | No blur, crisp glass |
| **1** | `liquid_glass_settings(BLUR-1-LEGGERO).txt` | **Light blur — clean middle ground** |
| **2** | `liquid_glass_settings(BLUR-2-MEDIO).txt` | Medium blur |
| **3** | `liquid_glass_settings(BLUR-3-FORTE).txt` | Strong blur |

`liquid_glass_settings(BLUR).txt` is kept as an alias of **level 3**, so older
instructions keep working.

Blur radius per surface:

| Surface | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| menu, panel-menu, quick-settings, osd, application | 0 | 4 | 8 | 12 |
| notification | 0 | 5 | 11 | 16 |
| dock | 0 | 3 | 7 | 10 |

Level 3 is not a fixed set of numbers: `gen_profiles.py` reads it from the live
settings, so level 3 always reproduces exactly what is running, and 0/1/2 are
derived from it by scaling. Only these seven surfaces belong to the matrix.
`top-bar`, `launcher`, `glass-clock`, `desktop-menu` and `desktop-widget` are
left untouched, so cycling levels never disturbs them.

## Applying a level

```bash
./scegli-blur.sh              # asks "Livello blur? (0-3)" and applies it
./scegli-blur.sh 2            # same, without asking (for launchers)

./applica-profilo.sh 1        # light blur (recommended)
./applica-profilo.sh 0        # no blur
./applica-profilo.sh 2        # medium
./applica-profilo.sh 3        # strong
./applica-profilo.sh salva    # save the current settings
```

`scegli-blur.sh` shows the level that is currently active, accepts `0`-`3`,
rejects anything else, and keeps the current level when you just press Enter.

## Dock glass safety

Every level file is a **full dump of the live settings**, so it also carries the
dock glass profile:

```
enable-dock-glass=true
dock-glass-shape-n=11.0
dock-glass-max-z=29.0
dock-glass-displacement=330.0
glass-profile-shape-n=16.0
glass-displacement-scale=105.0
glass-max-z=11.5
```

Applying a level therefore **does not revert the dock tuning**. `applica-profilo.sh`
refuses to load a file that is missing these keys, so an old profile cannot make
the dock lose its edge lens again.

## Regenerating the profiles

The levels are generated from the **live** settings, so they always match what
is actually running:

```bash
python3 gen_profiles.py
```

It aborts if the dock glass keys are missing from the live state, rather than
writing a profile that would break the dock.
