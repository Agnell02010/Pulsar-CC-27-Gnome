#!/usr/bin/env python3
"""Regenerate the Liquid Glass blur-level profiles from the LIVE dconf dump.

Level 3 is defined as "whatever the live settings are right now": the level-3
radii are read from the dump instead of being hardcoded. Levels 0/1/2 are
derived from it by scaling, so the four files can only ever differ in their
blur-radius lines and level 3 always reproduces the current look exactly.

The old profiles were stale snapshots that carried an entire older surface
tuning (shape-n, displacement, rim, sheen, tint strengths), so applying one
reverted the glass optics and not just the blur. Deriving everything from the
live dump removes that failure mode for good.

Only the seven macOS surfaces belong to the level matrix. The remaining blur
keys (top-bar, launcher, glass-clock, desktop-menu, desktop-widget) are not
part of the macOS blur levels and are left untouched, so cycling levels can
never disturb them.

Also rewrites the two profiles used by blur-on.sh / blur-off.sh as aliases of
level 3 and level 0, keeping those scripts in sync with the repo profiles.

Usage:  python3 gen_profiles.py
"""
import os
import re
import subprocess
import sys

LG_DBUS = "/org/gnome/shell/extensions/liquid-glass/"
LG_SCHEMA = "org.gnome.shell.extensions.liquid-glass@thinkingcoding1231.gmail.com"
OUT = os.path.expanduser("~/Pulsar-CC-27-Gnome/liquid-glass")

# The macOS blur-level matrix: exactly the surfaces macOS scales between its
# own low / medium / high translucency settings.
SURFACES = ("menu", "panel-menu", "quick-settings", "notification",
            "osd", "application", "dock")

# Level 3 = live look, level 0 = no blur. 1 and 2 split the range evenly.
RATIOS = {0: 0.0, 1: 1.0 / 3.0, 2: 2.0 / 3.0, 3: 1.0}
NAMES = {0: "NO_BLUR", 1: "BLUR-1-LEGGERO",
         2: "BLUR-2-MEDIO", 3: "BLUR-3-FORTE"}

BLUR_RE = re.compile(r"^([a-z0-9-]+-blur-radius)=")

# Runtime state the extension re-detects on its own. Baking it in only adds
# churn (a tray icon appearing changes the list) and on another machine it
# would be somebody else's menus. dconf load leaves a key absent from the file
# untouched, so dropping it is also the safer behaviour.
DROP = {"detected-extra-menus"}

# Keys that must be present, otherwise the live state is not the tuned one and
# we would bake a broken profile.
MUST = ("enable-dock-glass", "dock-glass-shape-n", "dock-glass-max-z",
        "dock-glass-displacement", "glass-profile-shape-n",
        "glass-displacement-scale", "glass-max-z", "dock-corner-radius")


def schema_default(key):
    out = subprocess.run(["gsettings", "get", LG_SCHEMA, key],
                         capture_output=True, text=True, check=True)
    return int(out.stdout.strip())


dump = subprocess.run(["dconf", "dump", LG_DBUS],
                      capture_output=True, text=True, check=True).stdout

if not dump.lstrip().startswith("["):
    sys.exit("ABORT: dconf dump has no group header, refusing to write profiles")
for key in MUST:
    if f"{key}=" not in dump:
        sys.exit(f"ABORT: '{key}' missing from live settings, "
                 "refusing to write profiles")

# Level 3 = the live look. Fall back to the schema default when a surface has
# never been explicitly set (dconf dump omits those).
base = {}
for surface in SURFACES:
    key = f"{surface}-blur-radius"
    m = re.search(rf"^{key}=(\d+)$", dump, re.M)
    base[surface] = int(m.group(1)) if m else schema_default(key)

levels = {}
for lvl, ratio in RATIOS.items():
    levels[lvl] = {s: int(round(base[s] * ratio)) for s in SURFACES}
    # keep the endpoints exact so level 3 matches live and level 0 is off
    if lvl == 3:
        levels[lvl] = dict(base)
    elif lvl == 0:
        levels[lvl] = {s: 0 for s in SURFACES}

os.makedirs(OUT, exist_ok=True)

written = {}
for lvl, name in NAMES.items():
    vals = levels[lvl]
    wanted = {f"{s}-blur-radius": str(v) for s, v in vals.items()}
    seen, lines = set(), []

    for line in dump.splitlines():
        m = BLUR_RE.match(line)
        if m and m.group(1) in wanted:
            seen.add(m.group(1))
            lines.append(f"{m.group(1)}={wanted[m.group(1)]}")
        elif line.split("=", 1)[0] in DROP:
            continue
        else:
            lines.append(line)

    # Append the blur keys `dconf dump` omitted (still at their default).
    missing = sorted(set(wanted) - seen)
    if missing:
        lines.append("")
        for key in missing:
            lines.append(f"{key}={wanted[key]}")

    text = "\n".join(lines) + "\n"
    path = os.path.join(OUT, f"liquid_glass_settings({name}).txt")
    with open(path, "w") as f:
        f.write(text)
    written[lvl] = text
    print(f"  level {lvl} -> liquid_glass_settings({name}).txt")

# The legacy names must stay aliases, generated rather than hand-maintained, so
# they can never become a stale optics snapshot again. blur-on.sh / blur-off.sh
# read the two under $HOME; the repo copies are documented in the README.
aliases = {
    os.path.expanduser("~/liquid_glass_settings(NO_BLUR).txt"): 0,
    os.path.expanduser("~/liquid_glass_settings(BLUR).txt"): 3,
    os.path.join(OUT, "liquid_glass_settings(NO_BLUR).txt"): 0,
    os.path.join(OUT, "liquid_glass_settings(BLUR).txt"): 3,
}
for path, lvl in aliases.items():
    with open(path, "w") as f:
        f.write(written[lvl])
    print(f"  alias  -> {path}  (= level {lvl})")

# Self-check: every level must differ from level 3 only in blur radii, and the
# five out-of-matrix surfaces must be byte-identical across levels.
out_of_matrix = ("top-bar", "launcher", "glass-clock",
                 "desktop-menu", "desktop-widget")
bad = False
for lvl in (0, 1, 2):
    for a, b in zip(written[lvl].splitlines(), written[3].splitlines()):
        if a == b:
            continue
        if not (BLUR_RE.match(a) and BLUR_RE.match(b)):
            print(f"  !! level {lvl} differs from level 3 outside blur radii:")
            print(f"       {a!r}  vs  {b!r}")
            bad = True

for surface in out_of_matrix:
    vals = {re.search(rf"^{surface}-blur-radius=(.*)$", written[lvl], re.M)
            for lvl in (0, 1, 2, 3)}
    if len({v.group(1) if v else None for v in vals}) > 1:
        print(f"  !! {surface}-blur-radius is not constant across levels")
        bad = True

print("\nLive look (level 3):")
for surface in SURFACES:
    print(f"  {surface:16s} = {base[surface]}")
print("\n" + ("ABORTED: profiles not consistent" if bad else
               "OK: only blur radii differ between levels"))
sys.exit(1 if bad else 0)
