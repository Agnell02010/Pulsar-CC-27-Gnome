import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Cairo from 'gi://cairo';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const NONE = Gio.DBusCallFlags.NONE;
const EASE = Clutter.AnimationMode.EASE_OUT_QUAD;

function warn(msg) {
    try { console.warn(`macos-cc: ${msg}`); } catch (e) {}
}
function fail(e, where) {
    try { console.error(`macos-cc: ${where}: ${e && (e.message || e)}`); } catch (e2) {}
}

/* ---------- keep the theme logout prompt out of the way ----------
 * pulsaros-global-menu answers every colour-scheme change with a modal that
 * logs the session out after six seconds ("Se cerrará la sesión en 6
 * segundos"). Toggling dark mode from the Control Centre would then both hide
 * the icon animation behind that modal and, six seconds later, actually log
 * the user out. The modal is created only from the interactive path of its
 * theme sync, so that path is made non-interactive (its own non-interactive
 * calls are untouched) while this extension is enabled. Reloading the shell
 * restores the original behaviour.
 *
 * Nothing else of that extension is disabled: the sync itself still runs, so
 * the MacTahoe themes keep following the colour scheme — just without the
 * countdown. */
const THEME_UUID = 'pulsaros-global-menu@inled.es';

function themeExtension() {
    try {
        const info = Main.extensionManager.lookup(THEME_UUID);
        const ext = info && (info.stateObj || info.extension);
        if (ext && typeof ext._syncThemes === 'function' && ext._ifaceSettings)
            return ext;
    } catch (e) {}
    return null;
}

// Any dialog left behind (e.g. a prompt opened before this ran) is cancelled.
function closeThemePrompt(ext) {
    const p = ext && ext._activeThemePrompt;
    if (!p)
        return;
    try { p._cleanup(); } catch (e) {}
    try { p.close(); } catch (e) {}
    try { ext._activeThemePrompt = null; } catch (e) {}
}

function muteThemePrompt() {
    try {
        const ext = themeExtension();
        if (!ext)
            return;
        closeThemePrompt(ext);
        if (ext._syncThemes.__ccQuiet)
            return;
        const orig = ext._syncThemes;
        // Their sync reloads the shell theme and can fail (a third party may
        // be broken while the theme changes); contain that so it never escapes
        // into the colour-scheme signal.
        const quiet = (_interactive = false) => {
            try {
                orig(false);
            } catch (e) {
                fail(e, 'theme sync');
            }
        };
        quiet.__ccQuiet = true;
        ext._syncThemes = quiet;
    } catch (e) {
        fail(e, 'muteThemePrompt');
    }
}

function delay(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

function dbusCall(bus, name, path, iface, method, params) {
    return new Promise((resolve, reject) => {
        bus.call(name, path, iface, method, params || null, null, NONE, -1, null, (c, res) => {
            try { resolve(c.call_finish(res)); } catch (e) { reject(e); }
        });
    });
}

// Read a single D-Bus property. The reply is of type '(v)' and GLib's
// deepUnpack() leaves the inner variant wrapped, so unwrap it explicitly.
function propGet(bus, name, path, iface, prop) {
    return dbusCall(bus, name, path, 'org.freedesktop.DBus.Properties', 'Get',
        new GLib.Variant('(ss)', [iface, prop]))
        .then(v => v.get_child_value(0).get_variant().unpack());
}

function decodeSs(ssid) {
    if (ssid == null) return '';
    if (typeof ssid === 'string') return ssid;
    // D-Bus 'ay' (a byte array) arrives as a plain Array or a Uint8Array,
    // depending on how the variant was unpacked. SSIDs are UTF-8.
    if (Array.isArray(ssid) || ArrayBuffer.isView(ssid)) {
        try { return new TextDecoder('utf-8', {fatal: false}).decode(ssid); } catch (e) {}
        let s = '';
        for (let i = 0; i < ssid.length; i++) s += String.fromCharCode(ssid[i]);
        return s;
    }
    return String(ssid);
}

// GLib.Variant.unpack() only unwraps ONE level: a D-Bus reply like '(ao)' or
// '(a{sv})' comes back as [GLib.Variant], and the values inside an 'a{sv}'
// dictionary stay Variants too. 'deepUnpack' resolves the outer containers but
// still leaves each dictionary VALUE as a Variant, so a small helper is needed
// to read a single property out of a property dictionary.
function pget(dict, key, fallback) {
    if (!dict) return fallback;
    const v = dict[key];
    if (v == null) return fallback;
    try {
        if (typeof v.deepUnpack === 'function') return v.deepUnpack();
        if (typeof v.unpack === 'function') return v.unpack();
    } catch (e) {}
    return v;
}

function mkRow(iconName, label, right, chipClass, glyph) {
    const row = new St.BoxLayout({style_class: 'mac-panel-row', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    if (glyph || iconName) {
        try {
            // An animated glyph (see makeGlyph) replaces the plain St.Icon when
            // the row has a micro-animation of its own.
            const ic = glyph ? glyph.actor
                : new St.Icon({icon_name: iconName, style_class: 'mac-panel-icon', y_align: Clutter.ActorAlign.CENTER});
            if (chipClass) {
                const chip = new St.Bin({style_class: 'mac-panel-chip ' + chipClass, child: ic,
                    x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
                row.add_child(chip);
            } else {
                row.add_child(ic);
            }
        } catch (e) {}
    }
    const lab = new St.Label({text: String(label ?? ''), style_class: 'mac-panel-label', x_expand: true, reactive: false, can_focus: false});
    try { lab.clutter_text.ellipsize = Pango.EllipsizeMode.END; } catch (e) {}
    row.add_child(lab);
    if (right) {
        if (right instanceof St.Widget) row.add_child(right);
        else row.add_child(new St.Label({text: String(right), style_class: 'mac-panel-sub'}));
    }
    return row;
}

/* macOS-style switch: a pill track plus a knob child that slides on toggle.
 * (St.Switch does not exist in this GNOME 50 build, so we build it by hand.) */
const SWITCH_W = 40, SWITCH_KNOB = 18, SWITCH_PAD = 2;
function mkSwitch(on, onChange) {
    const track = new St.Button({
        toggle_mode: true, checked: !!on, style_class: 'mac-switch',
        x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER, can_focus: true,
    });
    const knob = new St.Widget({
        style_class: 'mac-switch-knob', y: SWITCH_PAD,
        x: on ? (SWITCH_W - SWITCH_KNOB - SWITCH_PAD) : SWITCH_PAD,
    });
    track.add_child(knob);
    const place = (animate) => {
        const tx = track.checked ? (SWITCH_W - SWITCH_KNOB - SWITCH_PAD) : SWITCH_PAD;
        if (animate) knob.ease({x: tx, duration: 160, mode: EASE});
        else knob.x = tx;
    };
    track.connect('notify::checked', () => {
        place(true);
        try { onChange && onChange(track.checked); } catch (e) {}
    });
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { place(false); return GLib.SOURCE_REMOVE; });
    return track;
}

/* ==================== icon micro-animations (glyphs) ====================
 * A glyph is a stack of St.Icon layers split out of ONE SVG. The split files
 * live in the icons folder (wifi-1..3, sun-dome/sun-rays/sun-line,
 * speaker-body/speaker-wave1..3) and, stacked at the same position, redraw the
 * original artwork pixel for pixel — what changes is that the single parts can
 * now move on their own: the sun sinks behind its horizon, the wifi arcs light
 * up one after the other, the speaker waves ripple, the moon tilts, the
 * contrast knob spins.
 *
 * Layers are anchored with a FixedLayout at 0,0 (a BinLayout re-centres
 * fixed-size children on some Clutter versions, which would move every part),
 * so they overlay exactly whatever the instance size is.
 *
 * Only paint-only properties are animated (opacity / translation / scale /
 * rotation): nothing is ever re-allocated, so St never runs a layout pass and
 * Liquid Glass never rebuilds the glass of the tile underneath — which is what
 * made the panel animations stutter before.
 */
const GLYPH_LAYERS = {
    wifi:     ['wifi-1', 'wifi-2', 'wifi-3'],       // inner arc -> outer arc
    sun:      ['sun-dome', 'sun-rays', 'sun-line'], // the half sun, its rays, the horizon
    speaker:  ['speaker-body', 'speaker-wave1', 'speaker-wave2', 'speaker-wave3'],
    moon:     ['moon'],
    contrast: ['contrast'],
};

// Position of the parts inside the original 24x24 viewBox (measured on the
// SVGs), in viewBox units so a glyph can be built at any size.
const WIFI_PIVOT = [12 / 24, 19.5 / 24]; // the wifi arcs radiate from the bottom centre
const SUN_CLIP = 17.66 / 24;             // top edge of the horizon bar
const SUN_SINK = 7.6;                    // how far the sun sinks, in viewBox units
// Where the moon comes to rest above the horizon. Its ink, at MOON_SCALE, is
// 5.7..16.3px tall in a 22px box while the clipping horizon sits at 16.2px: at
// +1.0 the bottom of the crescent fell INTO the clip and the horizon bar drew
// over it, so night light ON showed a moon with a chopped, flat bottom (the
// "broken circle" seen when the sunset animation settles). Resting it 1.5px
// higher keeps the whole crescent above the line.
const MOON_REST = -1.7;                  // where the moon sits, above the horizon
const MOON_SINK = 11.0;                  // where the moon waits, below the horizon
const MOON_SCALE = 0.56;                 // the moon artwork is bigger than the sun
const A_OUT = Clutter.AnimationMode.EASE_OUT_QUAD;
const A_SOFT = Clutter.AnimationMode.EASE_OUT_SINE;
const A_BACK = Clutter.AnimationMode.EASE_OUT_BACK;
const A_IN = Clutter.AnimationMode.EASE_IN_QUAD;

// `set(state, animate)` never re-plays when the state has not really changed,
// so the many `_refresh()` calls of extension.js are harmless.
function makeGlyph(kind, size, h, cls = 'mac-icon') {
    const anims = () => {
        try { return !!(h.getAnim && h.getAnim().enabled); } catch (e) { return false; }
    };
    const u = n => n * size / 24;   // viewBox units -> px

    const box = new St.Widget({
        name: `mac-glyph-${kind}`,   // findable in the tree while debugging
        style_class: cls,
        layout_manager: new Clutter.FixedLayout(),
        width: size,
        height: size,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        reactive: false,
        can_focus: false,
    });
    const part = (name, parent = box) => {
        const ic = new St.Icon({name: `layer-${name}`, gicon: h.symbol(name), icon_size: size, reactive: false, can_focus: false});
        ic.set_position(0, 0);
        ic.set_pivot_point(0.5, 0.5);
        parent.add_child(ic);
        return ic;
    };

    /* Settling guard.
     * The glyphs are animated with Clutter transitions. A transition that is
     * replaced (rapid toggles, menu closing while the sunset plays, a state
     * change coming back from D-Bus) used to be able to leave a layer at a
     * half-way opacity/offset: the sun stayed sunk, the moon sat inside the
     * horizon clip (a visibly "broken" crescent), the wifi arcs stayed dim.
     * Every animated branch now schedules an exact snap to its final state
     * `after(duration, ...)`; a newer animation cancels the pending snap, and
     * the snap itself only runs for the state that is still current.
     */
    let pending = 0;
    const after = (ms, fn) => {
        if (pending) {
            try { GLib.source_remove(pending); } catch (e) {}
            pending = 0;
        }
        pending = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            pending = 0;
            try { fn(); } catch (e) {}
            return GLib.SOURCE_REMOVE;
        });
    };

    const g = {kind, actor: box, set: () => {}, pulse: () => {}};

    if (kind === 'wifi') {
        const arcs = GLYPH_LAYERS.wifi.map(n => part(n));
        for (const a of arcs)
            a.set_pivot_point(WIFI_PIVOT[0], WIFI_PIVOT[1]);
        const OFF = 110;   // wifi off: the arcs stay, just dimmed
        const snap = state => {
            for (const a of arcs) {
                a.remove_all_transitions();
                a.scale_x = 1;
                a.scale_y = 1;
                a.opacity = state ? 255 : OFF;
            }
        };
        let on = null;
        g.set = (state, animate) => {
            state = !!state;
            if (state === on)
                return;
            on = state;
            // Lighting up: inner arc, then the middle, then the outer one (and
            // the other way round when switching off) — the signal "fills in".
            const seq = state ? arcs : [arcs[2], arcs[1], arcs[0]];
            const live = animate && anims();
            seq.forEach((a, i) => {
                a.remove_all_transitions();
                a.scale_x = 1;
                a.scale_y = 1;
                if (!live) {
                    a.opacity = state ? 255 : OFF;
                    return;
                }
                if (state) {
                    a.opacity = 110;
                    a.scale_x = a.scale_y = 0.55;   // it grows out of the antenna
                    // Opacity and scale want different curves: an overshoot mode
                    // on the opacity dips through 0, so it stays linear-ish.
                    a.ease({opacity: 255, duration: 240, delay: i * 85, mode: A_OUT});
                    a.ease({scale_x: 1, scale_y: 1, duration: 300, delay: i * 85, mode: A_BACK});
                } else {
                    a.ease({opacity: OFF, duration: 220, delay: i * 85, mode: A_SOFT});
                }
            });
            if (live)
                after(300 + (arcs.length - 1) * 85, () => snap(state));
        };
    } else if (kind === 'sun') {
        // The sun (and the moon taking its place) is clipped at the horizon, so
        // it really disappears behind it instead of fading on top of it.
        const clip = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            width: size,
            height: Math.max(1, Math.round(u(17.66))),
            reactive: false,
        });
        try {
            clip.set_clip_to_allocation(true);
        } catch (e) {
            try { clip.clip_to_allocation = true; } catch (e2) {}
        }
        box.add_child(clip);
        const dome = part('sun-dome', clip);
        const moon = part('moon', clip);
        moon.scale_x = moon.scale_y = MOON_SCALE;
        const rays = part('sun-rays');
        const line = part('sun-line');

        // Night light off -> the sun is up; on -> the sun has set, moon up.
        const rest = state => {
            for (const a of [dome, rays, line, moon])
                a.remove_all_transitions();
            moon.scale_x = moon.scale_y = MOON_SCALE;
            dome.translation_y = state ? u(SUN_SINK) : 0;
            dome.opacity = state ? 0 : 255;
            rays.opacity = state ? 0 : 255;
            line.opacity = 255;
            moon.translation_y = u(state ? MOON_REST : MOON_SINK);
            moon.opacity = state ? 255 : 0;
        };

        let on = null;
        g.set = (state, animate) => {
            state = !!state;
            if (state === on)
                return;
            const first = on === null;
            on = state;
            if (!animate || first || !anims()) {
                rest(state);
                return;
            }
            for (const a of [dome, rays, line]) {
                a.remove_all_transitions();
                a.scale_x = 1;
                a.scale_y = 1;
            }
            moon.remove_all_transitions();
            if (state) {
                // sunset: the sun sinks behind the horizon while the moon rises
                dome.translation_y = 0;
                dome.opacity = 255;
                dome.ease({translation_y: u(SUN_SINK), duration: 640, mode: A_OUT});
                dome.ease({opacity: 0, delay: 400, duration: 240, mode: A_SOFT});
                rays.ease({opacity: 0, delay: 60, duration: 320, mode: A_SOFT});
                moon.translation_y = u(MOON_SINK);
                moon.opacity = 0;
                moon.ease({translation_y: u(MOON_REST), opacity: 255,
                    duration: 460, delay: 240, mode: A_OUT});
            } else {
                // sunrise: the sun climbs back up and the moon sets
                dome.translation_y = u(SUN_SINK);
                dome.opacity = 0;
                dome.ease({translation_y: 0, duration: 640, mode: A_OUT});
                dome.ease({opacity: 255, duration: 220, mode: A_SOFT});
                rays.ease({opacity: 255, delay: 320, duration: 300, mode: A_SOFT});
                moon.translation_y = u(MOON_REST);
                moon.opacity = 255;
                moon.ease({translation_y: u(MOON_SINK), duration: 460, mode: A_IN});
                moon.ease({opacity: 0, duration: 240, mode: A_SOFT});
            }
            // The sunset/sunrise is the longest animation of the panel: snap
            // everything once it is over instead of trusting the easings.
            after(900, () => rest(state));
        };
    } else if (kind === 'speaker') {
        const body = part('speaker-body');
        const waves = [part('speaker-wave1'), part('speaker-wave2'), part('speaker-wave3')];
        let on = null;
        let lastPulse = 0;
        g.set = (state, animate) => {
            state = !!state;
            if (state === on)
                return;
            on = state;
            const live = animate && anims();
            waves.forEach((w, i) => {
                w.remove_all_transitions();
                w.scale_x = w.scale_y = 1;
                if (live)
                    w.ease({opacity: state ? 255 : 0, duration: 240, delay: i * 70, mode: A_SOFT});
                else
                    w.opacity = state ? 255 : 0;
            });
        };
        // One wave runs through the arcs, from the speaker outwards.
        g.pulse = () => {
            const now = Date.now();
            if (now - lastPulse < 140)   // the slider fires a lot while dragging
                return;
            lastPulse = now;
            const base = on === false ? 0 : 255;
            if (!anims())
                return;
            body.remove_all_transitions();
            body.ease({scale_x: 1.05, scale_y: 1.05, duration: 150, mode: A_OUT,
                onComplete: () => {
                    try { body.ease({scale_x: 1, scale_y: 1, duration: 220, mode: A_SOFT}); } catch (e) {}
                }});
            waves.forEach((w, i) => {
                w.remove_all_transitions();
                w.ease({
                    opacity: 255, scale_x: 1.12, scale_y: 1.12,
                    duration: 170, delay: i * 85, mode: A_OUT,
                    onComplete: () => {
                        try {
                            w.ease({scale_x: 1, scale_y: 1, opacity: base, duration: 240, mode: A_SOFT});
                        } catch (e) {}
                    },
                });
            });
            after(760, () => {
                const rest = on === false ? 0 : 255;
                body.remove_all_transitions();
                body.scale_x = body.scale_y = 1;
                for (const w of waves) {
                    w.remove_all_transitions();
                    w.scale_x = w.scale_y = 1;
                    w.opacity = rest;
                }
            });
        };
    } else if (kind === 'moon') {
        const m = part('moon');
        const TILT = -16;
        let on = null;
        g.set = (state, animate) => {
            state = !!state;
            if (state === on)
                return;
            const first = on === null;
            on = state;
            m.remove_all_transitions();
            m.scale_x = m.scale_y = 1;
            if (!animate || first || !anims()) {
                m.rotation_angle_z = state ? TILT : 0;
                return;
            }
            m.rotation_angle_z = state ? 0 : TILT;   // from the other resting angle
            m.ease({rotation_angle_z: state ? TILT : 0, duration: 480, mode: A_BACK});
            m.ease({scale_x: 1.10, scale_y: 1.10, duration: 160, mode: A_OUT,
                onComplete: () => {
                    try { m.ease({scale_x: 1, scale_y: 1, duration: 320, mode: A_BACK}); } catch (e) {}
                }});
            after(560, () => {
                m.remove_all_transitions();
                m.rotation_angle_z = state ? TILT : 0;
                m.scale_x = m.scale_y = 1;
            });
        };
    } else if (kind === 'contrast') {
        const c = part('contrast');
        let on = null;
        let angle = 0;
        g.set = (state, animate) => {
            state = !!state;
            if (state === on)
                return;
            const first = on === null;
            on = state;
            c.remove_all_transitions();
            if (!animate || first || !anims()) {
                angle = state ? 180 : 0;
                c.rotation_angle_z = angle;
                return;
            }
            angle += 180;   // always spins the same way, like a knob
            c.ease({rotation_angle_z: angle, duration: 520, mode: A_BACK});
            after(640, () => {
                c.remove_all_transitions();
                c.rotation_angle_z = angle;
            });
        };
    }

    return g;
}

export function crea(ext, h) {
    let detailRoot = null;
    let detailCont = null;
    let mainKids = null;   // _panel's own children (hidden while a detail is open)
    let gen = 0;
    let currentKind = null;
    let closing = false;
    let anchor = null;     // actor that triggered opening the detail (used to pivot from it)

    /* extension.js falls back to the KEY when it does not know one ("done",
     * "addBlock"), and that string is truthy: the fallback here was therefore
     * never used and the editor showed raw keys instead of the Italian text.
     * A translation wins only when it is really a different string. */
    function tr(k, fb) {
        try {
            const s = h.tr ? h.tr(k) : null;
            if (s && s !== k)
                return s;
        } catch (e) {}
        return fb;
    }
    function launch(cmd) { try { h.launch(cmd); } catch (e) { fail(e, 'launch ' + cmd); } }
    // The main tiles (`.mac-cc` Wi-Fi/Bluetooth/… pills) draw their "On/Off"
    // subtitle and bubble colour from extension.js's `_refresh()`, which only
    // runs when the menu opens or when a tile itself is toggled. Changing the
    // state from a detail panel therefore left the tile stale until the menu
    // was closed and reopened — refresh it explicitly after every such change.
    function syncMainTiles() {
        const doIt = () => {
            try { ext._refresh && ext._refresh(); } catch (e) { warn(`main refresh failed: ${e && (e.message || e)}`); }
        };
        doIt();
        // BlueZ applies `Powered` synchronously, but NetworkManager can settle a
        // beat later, so refresh once more to be sure the tile is never stale.
        delay(450).then(doIt);
    }

    /* ---------- animated icons of the main tiles ----------
     * extension.js builds the tiles right after crea() returns, so they are
     * decorated on an idle callback (and again on every re-enable: the module is
     * re-imported while the tiles are new). The glyphs live here because the
     * shell caches extension.js — a change there needs a login, this file only a
     * disable/enable.
     *
     * The state is read straight from the tile (the '.checked' pseudo-class that
     * extension.js flips in _refresh) instead of being guessed from the click, so
     * the icon always ends up agreeing with its tile. NetworkManager only answers
     * a moment after the click, hence the settle() re-reads. */
    const tiles = {};      // tile key -> glyph
    const tileState = {};  // tile key -> () => bool

    /* ---------- accent colour of the glyphs ----------
     * The colour of a glyph lives in the STYLESHEET, never in an inline style
     * written from JS. That is how the first versions did it (`:checked {
     * color: black }`) and it is the only way that cannot flicker: Liquid Glass
     * keeps a copy of the inline style of every actor inside a pod and writes it
     * back when the pod changes state, so a colour set with set_style() can be
     * replaced by the previous one for a few frames — the white blink of the
     * symbol on the white disc. CSS rules are never rewritten that way.
     *
     * The accent chosen in Settings becomes ONE class on the panel; the sheet
     * has a rule per palette colour (`.mac-accent-blue ... { color: #007aff }`),
     * so a colour change is a single class swap and every glyph follows it:
     * enabled = accent, disabled = white, like in the reference.
     */
    const ACCENT_FILE = GLib.build_filenamev([
        GLib.get_user_config_dir(), 'pulsaros', 'accent-color']);
    const GNOME_ACCENTS = {
        blue: '#007aff', teal: '#30b0c7', green: '#34c759', yellow: '#ffcc00',
        orange: '#ff9500', red: '#ff3b30', pink: '#ff2d55', purple: '#af52de',
        slate: '#8e8e93',
    };
    let accentHex = GNOME_ACCENTS.blue;
    let accentMon = null;
    let accentClass = null;

    function readAccentHex() {
        let hex = null;
        try {
            const [ok, bytes] = GLib.file_get_contents(ACCENT_FILE);
            if (ok) {
                const m = /^#?([0-9a-f]{6})$/i.exec(new TextDecoder().decode(bytes).trim());
                if (m) hex = `#${m[1].toLowerCase()}`;
            }
        } catch (e) { /* not created yet */ }
        if (!hex) {
            try {
                const s = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
                hex = GNOME_ACCENTS[s.get_string('accent-color')] || null;
            } catch (e) { /* older shell */ }
        }
        accentHex = hex || GNOME_ACCENTS.blue;
    }

    // The sheet has one rule per palette colour: an arbitrary hex coming from
    // Settings lands on the closest one.
    function accentName(hex = accentHex) {
        const rgb = value => [1, 3, 5].map(i => parseInt(value.substr(i, 2), 16));
        const [r, g, b] = rgb(hex.startsWith('#') ? hex : `#${hex}`);
        let best = 'blue', bestD = Infinity;
        for (const [name, value] of Object.entries(GNOME_ACCENTS)) {
            const [r2, g2, b2] = rgb(value);
            const d = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;
            if (d < bestD) {
                bestD = d;
                best = name;
            }
        }
        return best;
    }

    function applyAccent() {
        const root = ext._panel;
        if (!root || root.is_destroyed)
            return;
        const want = `mac-accent-${accentName()}`;
        if (accentClass === want)
            return;
        for (const name of Object.keys(GNOME_ACCENTS)) {
            try { root.remove_style_class_name(`mac-accent-${name}`); } catch (e) {}
        }
        try { root.add_style_class_name(want); } catch (e) { return; }
        accentClass = want;
    }

    /* The glass under every pod is ONE shape drawn by Liquid Glass with a single
     * corner radius (`quick-settings-toggle-corner-radius`). Our pods have to
     * use exactly that radius, otherwise the two curves part near the corners
     * and a second contour shows up inside the pod. Keeping the setting in sync
     * from here means the geometry cannot drift (stylesheet.css uses the same
     * value on the tiles, the sliders, the media box and the detail sheet).
     *
     * 26px comes from an edge outline traced on the reference photo: every pod
     * there (the 153px wifi pill, the 128px sliders, the 273px player) uses the
     * same 44px corner at 2x, i.e. ~25px in our pixels, independent of size.
     * 22 read too square and 30 too round. The only piece macOS shapes
     * differently is the round button (a true circle), which one shared glass
     * radius cannot reproduce. */
    const POD_RADIUS = 34;
    /* 16 is the Cupertino-squircle setting: with the shader's cornerShape()
       formula, min(half side)/16 >= 2 hits the cap k = 2, so the corner spans
       the whole half-height with exponent ~4.4 (long straight sides, Apple-like
       continuous curve; radius 242 on a 200px pill clamps to the same place).
       Our pods use the very same curve (pod-*.png, baked with 16), so the glass
       radius must stay equal to POD_RADIUS. */
    let lg = null;
    try {
        lg = new Gio.Settings({
            schema_id: 'org.gnome.shell.extensions.liquid-glass@thinkingcoding1231.gmail.com'});
        if (Math.abs(lg.get_double('quick-settings-toggle-corner-radius') - POD_RADIUS) > 0.01)
            lg.set_double('quick-settings-toggle-corner-radius', POD_RADIUS);
    } catch (e) { lg = null; /* Liquid Glass not installed */ }

    /* ---------- glass tone and adaptive text ----------
     * Both belong to the surface that actually frosts the pods, the notification
     * centre and the panel menus, i.e. Liquid Glass: keeping them in one place
     * per surface is what makes the circles and the pills read as the same
     * material. Nothing is painted by us here, so there is no second tint that
     * can drift.
     *
     * Tone: the pods carry the widgets' own tint — that is what put the circles
     * and the pills on the same tone as the desktop widgets — plus a veil, which
     * is what gives the glass a body of its own instead of leaving it empty. The
     * veil used to be a grey at 0.45 and made the pods look dirtier than the
     * widgets; it is back at roughly a third of that strength and in the theme's
     * own ink: white in the light theme, charcoal in the dark one. Liquid Glass
     * takes ONE colour/strength pair per surface, so the two layers live in that
     * single value: the veil's colour with the widget tone's strength as its
     * floor. VEIL is the only place to tune it.
     *
     * Text: `*-enable-adaptive-text-color` measures what is behind each surface
     * and paints its labels light on dark, dark on light — but what is behind is
     * the wallpaper, not the tinted glass. Once the pods have a tone of their
     * own the sample and the surface disagree (a dark tint on a bright wallpaper
     * kept dark text), so adaptive text is switched off here and the text follows
     * the same theme signal as the tone: stylesheet.css paints our own labels
     * dark under `.mac-light`, and GNOME's notifications and menus keep the
     * shell theme's colour, which is the one matching that tone. */
    const WIDGET_TINT = {color: '#000000', strength: 0.10};
    const GLASS_SURFACES = ['quick-settings', 'notification', 'menu', 'panel-menu'];
    const LG_UUID = 'liquid-glass@thinkingcoding1231.gmail.com';
    const VEIL = {
        light: {color: '#f6f5f4', strength: 0.08},   // was 0.45: far too strong
        dark: {color: '#101012', strength: 0.08},
    };

    /* The tone the desktop widgets are drawn with: the veil is added on top of
     * it, never under, so the pods keep following widgets if someone changes
     * that in Liquid Glass' own preferences. */
    function widgetTone() {
        try {
            return {
                color: lg.get_string('desktop-widget-tint-color') || WIDGET_TINT.color,
                strength: lg.get_double('desktop-widget-tint-strength'),
            };
        } catch (e) {
            return WIDGET_TINT;
        }
    }

    /* Widget tone + veil, folded into the one pair Liquid Glass accepts: the
     * strength is the widget's plus the veil's (so the veil is always a little
     * more than the widgets), the colour is the veil's (that is the ink the
     * theme wants on the glass). */
    function glassTone(light) {
        const base = widgetTone();
        const veil = light ? VEIL.light : VEIL.dark;
        return {
            color: veil.color,
            strength: Math.min(0.4, Math.round((base.strength + veil.strength) * 100) / 100),
        };
    }
    let iface = null;
    let schemeId = 0;
    let themeId = 0;

    function interfaceSettings() {
        if (!iface) {
            try {
                iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
            } catch (e) { iface = null; }
        }
        return iface;
    }

    /* prefer-light / prefer-dark, and for "default" the gtk theme's own name is
     * the best hint the shell gives us. */
    function lightTheme() {
        const s = interfaceSettings();
        if (!s)
            return false;
        try {
            const scheme = s.get_string('color-scheme');
            if (scheme === 'prefer-light')
                return true;
            if (scheme === 'prefer-dark')
                return false;
            return !/dark/i.test(s.get_string('gtk-theme'));
        } catch (e) {
            return false;
        }
    }

    function applyGlassTone() {
        const light = lightTheme();
        if (lg) {
            const tone = glassTone(light);
            for (const surface of GLASS_SURFACES) {
                try {
                    if (lg.get_string(`${surface}-tint-color`) !== tone.color)
                        lg.set_string(`${surface}-tint-color`, tone.color);
                    if (Math.abs(lg.get_double(`${surface}-tint-strength`) - tone.strength) > 0.01)
                        lg.set_double(`${surface}-tint-strength`, tone.strength);
                } catch (e) { /* that surface has no tint on this build */ }
            }
            // Text and tone have to come from the same signal, or the pods turn
            // dark while the labels stay dark too (see the note above TONE).
            for (const surface of GLASS_SURFACES) {
                try {
                    if (lg.get_boolean(`${surface}-enable-adaptive-text-color`))
                        lg.set_boolean(`${surface}-enable-adaptive-text-color`, false);
                } catch (e) { /* that surface has no adaptive text on this build */ }
            }
        }
        stampTheme(light);
        scrubTextColors();
    }

    /* Liquid Glass paints its sampled colour inline on every label and icon of
     * the menu, and only takes those styles back when the whole effect is
     * rebuilt — not when a menu closes. With adaptive text off our stylesheet is
     * what colours the pods, so a colour left over from an earlier open would sit
     * on top of it and the text would keep the old theme's ink. Drop the inline
     * `color` declarations inside the panel here; nothing else of the style is
     * touched (the album art keeps its background-image).
     *
     * Cleaning the actor is not enough on its own. A stylesheet rule loses
     * against ANY inline declaration, and Liquid Glass keeps its own copy of the
     * inline style of every sub-actor of a pod (`styledSubs[].origStyle` in
     * toggleStyles.js) which it writes back on every re-sample: a `color`
     * sampled while the light theme was on therefore came back a frame after
     * this had removed it, and the labels stayed black on the dark glass. Those
     * copies — and the managers' `_styledActors` maps, the same bookkeeping kept
     * by the adaptive-text pass — are cleaned here too, so there is no dark ink
     * left anywhere for Liquid Glass to restore. */
    const COLOR_RULE = /^(-st-icon-foreground-)?color\s*:/i;

    // The same style with its colour declarations removed. null = nothing to do.
    function withoutColor(style) {
        if (!style || !style.split(';').some(r => COLOR_RULE.test(r.trim())))
            return null;
        const kept = style.split(';').map(s => s.trim()).filter(Boolean)
            .filter(rule => !COLOR_RULE.test(rule));
        return kept.length ? `${kept.join('; ')};` : '';
    }

    function cleanGlassTextCaches() {
        try {
            const state = Main.extensionManager?.lookup?.(LG_UUID)?.stateObj ?? null;
            const regs = state?._quickSettingsManager?._toggleStyles?._toggleRegions;
            if (regs instanceof Map) {
                for (const entry of regs.values()) {
                    for (const rec of (entry && entry.styledSubs) || []) {
                        const clean = withoutColor(rec.origStyle);
                        if (clean !== null)
                            rec.origStyle = clean;
                    }
                }
            }
            for (const mgr of [state?._quickSettingsManager, state?._notificationCenterGlass,
                               state?._notificationManager]) {
                const map = mgr?._styledActors;
                if (!(map instanceof Map))
                    continue;
                for (const [actor, orig] of [...map.entries()]) {
                    const clean = withoutColor(orig);
                    if (clean !== null)
                        map.set(actor, clean);
                    // The actor may still be carrying the last sampled colour:
                    // those maps cover the notification drawer and the menus
                    // too, so the same dark ink is removed where it is shown.
                    try {
                        const live = withoutColor(actor.get_style && actor.get_style());
                        if (live !== null)
                            actor.set_style(live || null);
                    } catch (e) { /* actor gone */ }
                }
            }
        } catch (e) { /* no Liquid Glass, or a build with other internals */ }
    }

    function scrubTextColors() {
        const strip = (a) => {
            try {
                if (a instanceof St.Widget) {
                    const clean = withoutColor(a.get_style());
                    if (clean !== null)
                        a.set_style(clean || null);
                }
                for (const child of a.get_children())
                    strip(child);
            } catch (e) { /* an actor already gone */ }
        };
        try { if (ext._panel) strip(ext._panel); } catch (e) {}
        cleanGlassTextCaches();
    }
    /* The CSS half of the tone: `.mac-light` on the panel turns our own white
     * labels, icons and controls dark (end of stylesheet.css), so the text
     * follows the glass instead of the wallpaper behind it. */
    function stampTheme(light = lightTheme()) {
        try {
            const panel = ext._panel;
            if (!panel || panel.is_destroyed)
                return;
            const has = panel.has_style_class_name('mac-light');
            if (light && !has) {
                panel.add_style_class_name('mac-light');
            } else if (!light && has) {
                panel.remove_style_class_name('mac-light');
            }
        } catch (e) { /* panel not built yet */ }
    }

    applyGlassTone();
    try {
        const s = interfaceSettings();
        if (s) {
            schemeId = s.connect('changed::color-scheme', () => applyGlassTone());
            themeId = s.connect('changed::gtk-theme', () => applyGlassTone());
        }
    } catch (e) { /* not fatal */ }

    // Every button that can change a glyph's state. The bubble and the text
    // area are two separate St.Buttons inside the same pill, so both must be
    // listened to (the bubble alone was not enough: clicking the label left
    // the glyph stale, e.g. Do Not Disturb stayed an empty white disc).
    function textButtonOf(tile) {
        if (!tile)
            return null;
        if (tile._textBtn)
            return tile._textBtn;
        // extension.js is cached by the shell and the running copy predates
        // `_textBtn`, so fall back to walking the pill once.
        try {
            const row = tile.get_first_child ? tile.get_first_child() : null;
            for (const c of (row ? row.get_children() : [])) {
                if (c.has_style_class_name && c.has_style_class_name('mac-tile-text-btn'))
                    return c;
            }
        } catch (e) {}
        return null;
    }

    try {
        readAccentHex();
        accentMon = Gio.File.new_for_path(ACCENT_FILE)
            .monitor_file(Gio.FileMonitorFlags.NONE, null);
        accentMon.connect('changed', () => {
            readAccentHex();
            applyAccent();
        });
    } catch (e) { warn(`accent monitor: ${e && (e.message || e)}`); }

    delay(0).then(() => {
        applyAccent();
        // The GNOME accent is the fallback when the Settings file is missing,
        // and it can be changed from Settings while the panel is built.
        try {
            const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
            iface.connect('changed::accent-color', () => {
                readAccentHex();
                applyAccent();
            });
        } catch (e) {}
    });

    /* Keep the tiles in sync with their real state while the menu is open.
     * The state changes asynchronously (D-Bus), and can also change from
     * outside this module; without this poll a tile toggled from its label
     * could keep a glyph stuck in the previous state until the next open. */
    /* ---------- the album cover ----------
     * St would not paint the cover straight from the player's own file:// URL
     * (the box stayed empty), while the covers the original extension laid down
     * in the shell's cache always worked. So the artwork is copied once into
     * ~/.cache/macos-cc-art/<md5>.jpg — the same cache-then-reference approach
     * the GitHub version uses for downloaded covers — and the actor is pointed
     * at that copy. It is re-applied whenever extension.js writes the original
     * URL back (track change, refresh), and it fixes the box size too: 40px now,
     * while extension.js still writes the 38 it was built with. */
    const ART_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'macos-cc-art']);
    const ART_OVERRIDE = 'background-color: transparent !important; ';
    let artApplied = null;

    function copyArt(url) {
        try {
            const path = decodeURIComponent(url.replace(/^file:\/\//, ''));
            const sum = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, url, -1);
            GLib.mkdir_with_parents(ART_DIR, 0o755);
            const dest = GLib.build_filenamev([ART_DIR, `${sum}.jpg`]);
            if (!GLib.file_test(dest, GLib.FileTest.EXISTS)) {
                Gio.File.new_for_path(path).copy(Gio.File.new_for_path(dest),
                    Gio.FileCopyFlags.NONE, null, null);
            }
            return GLib.file_test(dest, GLib.FileTest.EXISTS) ? dest : null;
        } catch (e) {
            return null;
        }
    }

    function syncArt() {
        try {
            const art = ext._art;
            if (!art || !art.get_style)
                return;
            const style = art.get_style() || '';
            const m = /background-image:\s*url\("file:\/\/(.*?)"\)/.exec(style);
            if (!m) {
                artApplied = null;
                return;
            }
            const url = `file://${m[1]}`;
            if (artApplied === url && style.includes('background-size: 40px'))
                return;   // already our copy, at the right size
            const local = copyArt(url);
            if (!local)
                return;
            artApplied = url;
            art.set_style(`${ART_OVERRIDE}background-image: url("file://${local}"); background-size: 40px 40px;`);
        } catch (e) { /* no player yet */ }
    }

    let tilePollId = 0;
    function startTilePoll() {
        if (tilePollId)
            return;
        tilePollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            for (const k of Object.keys(tileState))
                syncTile(k, false);
            // The track can change while the menu is open.
            syncArt();
            return GLib.SOURCE_CONTINUE;
        });
    }
    function stopTilePoll() {
        if (!tilePollId)
            return;
        try { GLib.source_remove(tilePollId); } catch (e) {}
        tilePollId = 0;
    }

    function syncTile(key, animate, forced) {
        const g = tiles[key], st = tileState[key];
        if (!g)
            return;
        try { g.set(forced === undefined ? (st ? st() : false) : !!forced, animate); } catch (e) {}
    }

    // Re-read a few times: the wifi state only lands after the round trip.
    function settle(key, times = [60, 320, 700, 1200]) {
        for (const ms of times)
            delay(ms).then(() => syncTile(key, true));
    }

    /* Only the symbols get smaller, never what carries them: the glyphs are
     * built at a fixed pixel size (their layers are sized in the constructor),
     * so the one knob for all of them is a scale on the glyph actor itself.
     * The discs, the circles and their hit areas keep their size. */
    const SYMBOL_SCALE = 0.92;
    function shrinkGlyph(g) {
        try {
            g.actor.set_pivot_point(0.5, 0.5);
            g.actor.scale_x = g.actor.scale_y = SYMBOL_SCALE;
        } catch (e) { /* no actor */ }
        return g;
    }

    function tileGlyph(key, tile, kind, size, cls = 'mac-icon') {
        const bub = tile && tile._bubble;
        if (!bub)
            return null;
        const g = shrinkGlyph(makeGlyph(kind, size, h, cls));
        const old = bub.get_child && bub.get_child();
        try { bub.set_child(g.actor); } catch (e) { return null; }
        if (old) old.destroy();
        tiles[key] = g;
        tileState[key] = () => {
            try { return bub.has_style_pseudo_class('checked'); } catch (e) { return false; }
        };
        g.set(tileState[key](), false);
        // Both halves of the pill are buttons: follow either one, or the glyph
        // keeps the old state when the label is used instead of the bubble.
        const onClick = () => settle(key);
        try { bub.connect('clicked', onClick); } catch (e) {}
        const tb = textButtonOf(tile);
        if (tb) {
            try { tb.connect('clicked', onClick); } catch (e) {}
        }
        return g;
    }

    let decorated = false;

    /* The shell caches extension.js, so the column widths that the running
     * copy was built with are still the old ones. The classes are inert until
     * the stylesheet defines them, so adding them here retunes the layout on
     * the next disable/enable instead of waiting for a login. */
    /* ---------- the two rows with the round buttons ----------
     * These two rows hold three pods where the others hold two, so their widths
     * have to add up to the same 318px grid: 153 (pill) + 12 + 70 + 13 + 70.
     * With the circles at 73 the pair came to 158 and either the pair or the
     * pill beside it had to be pushed off the grid, which is what made the gap
     * next to the circles smaller than all the others. Nothing is translated
     * any more — the numbers themselves fit — this only clears a shift left by
     * an earlier pass and reports what it sees. */
    function alignCircleRows() {
        if (grid)
            return;   // the grid places every pod itself
        try {
            for (const c of [ext._stage, ext._dark]) {
                const group = c && c.get_parent();
                const row = group && group.get_parent();
                if (!group || !row || !row.get_children)
                    continue;
                group.translation_x = 0;
                for (const k of row.get_children())
                    if (k !== group)
                        k.translation_x = 0;
            }
        } catch (e) { /* rows not built yet */ }
    }

    function retuneLayout() {
        const mark = (actor, cls) => {
            try { actor && actor.add_style_class_name(cls); } catch (e) {}
        };
        mark(ext._wifi && ext._wifi.get_parent(), 'mac-left-col');
        mark(ext._mediaTile && ext._mediaTile.get_parent(), 'mac-right-col');
        mark(ext._stage && ext._stage.get_parent(), 'mac-row-circles');
        mark(ext._dark && ext._dark.get_parent(), 'mac-row-circles');
        // The four round buttons are circles in the reference, while the pods
        // there share one small corner. One glass radius cannot be both, so
        // each button hands Liquid Glass its own radius (the patch reads
        // `_macPodRadius` in the region builder; 0/absent keeps POD_RADIUS).
        // 34 = half of the 67px button: the glass then reads as a true circle
        // instead of the 26px squircle it would inherit from the shared radius.
        // 70 is what makes a pill plus two circles fill the row exactly:
        // 153 + 12 + 70 + 13 + 70 = 318. At 73 the pair was 5px wider than the
        // grid, so the gap on the inside of the circles stopped matching the
        // 12px everywhere else (it read as the pair hanging off the grid).
        const CIRCLE = 70;
        for (const c of [ext._stage, ext._mirror, ext._dark, ext._shot]) {
            try {
                if (!c)
                    continue;
                if (!c._macCircleFit) {
                    c.set_size(CIRCLE, CIRCLE);
                    c.shape?.set_size(CIRCLE, CIRCLE);
                    c.button?.set_size(CIRCLE, CIRCLE);
                    c._macCircleFit = true;
                }
                // Half of the 70px button: a true circle, not a squircle.
                c._macPodRadius = CIRCLE / 2;
            } catch (e) {}
        }
        alignCircleRows();
        // Every pill hands Liquid Glass the same outline controlCenter.js
        // paints in Cairo: radius = half the height (34 on the 89px pod) and
        // Apple's exponents (2.88 across, 1.9 down). The glass takes the very
        // same numbers from the region builder, so its edge lands on the
        // painted one instead of drawing a second, slightly different curve.
        const pill = (actor, half) => {
            try {
                if (!actor)
                    return;
                actor._macPodRadius = half;
                actor._macPodRadiusX = half;
                actor._macPodExpX = 2.88;
                actor._macPodExpY = 1.9;
            } catch (e) {}
        };
        pill(ext._wifi, 36);
        pill(ext._bt, 36);
        pill(ext._night, 36);
        pill(ext._dnd, 36);
        // A little less round than the pills: at 62px tall a capsule read as a
        // lozenge, while the reference keeps a softer, boxier rounded rect.
        pill(ext._display, 26);
        pill(ext._sound, 26);
        /* The option disc inside every pill was a 38% white sheen, which over
         * the dark glass read as a grey circle instead of glass. The fill is
         * painted by controlCenter.js, which the shell caches until a login, so
         * the draw is replaced here on the live shape, same geometry (disc at
         * cx 33, r 19) and much less white. */
        for (const t of [ext._wifi, ext._bt, ext._night, ext._dnd])
            transparentDisc(t);
        /* The whole panel is scaled up by GROW ~5% from the geometry
         * controlCenter.js was built with (146x68 pills, 303x62 sliders,
         * 147x147 player, 68px circles, 11px gaps). Everything inside a pod is
         * positioned from its top-left corner in the same coordinate system, so
         * each block below is the old measurement times GROW: proportions and
         * positions are kept, the text is drawn at a bigger size instead of
         * being stretched, and the panel grows with its content.
         *
         * This has to happen here: the shell caches controlCenter.js (it bakes
         * PILL_H, MEDIA, SLIDER_H...) until a login, while this module is
         * re-imported on every enable. The stylesheet carries the same numbers,
         * so a pod's own CSS box and the pod cannot disagree. */
        const GROW = 1.05;
        for (const t of [ext._wifi, ext._bt, ext._night, ext._dnd]) {
            try {
                if (!t || t._macTall)
                    continue;
                const W = 153, H = 73;
                t.set_size(W, H);
                t.shape?.set_size(W, H);
                if (t.textBtn) {
                    t.textBtn.set_size(W - 65, H);      // text width 88
                    t.textBtn.set_position(62, 0);      // was 59
                }
                if (t.textBox)
                    t.textBox.set_size(W - 65, H);
                for (const l of [t.titleLabel, t.subLabel])
                    l && (l.width = W - 65);
                t._macTall = true;
            } catch (e) { /* not there yet */ }
        }
        /* The player's buttons are packed from the left edge of their 147px row
         * (three 30px buttons plus a 6px margin on each side = 126px), so the
         * group sat 21px left of centre. Two elastic spacers centre it in the
         * row whatever the number of buttons; the row declares spacing 0 (see
         * `.mac-media-controls`), so they add no gap of their own. */
        try {
            const row = ext._mediaTile && ext._mediaTile.controls;
            if (row && !row._macCentred) {
                row.insert_child_at_index(new St.Widget({x_expand: true}), 0);
                row.add_child(new St.Widget({x_expand: true}));
                row._macCentred = true;
            }
        } catch (e) { /* no player yet */ }
        /* Taller pills make that first row 4px taller. The player square and the
         * round buttons keep their own size and centre in the row instead of
         * being stretched by it (a stretched pod would no longer be a square, and
         * a stretched circle is no circle). */
        try {
            if (ext._mediaTile && !ext._mediaTile._macFitted)
                ext._mediaTile.y_align = Clutter.ActorAlign.CENTER;
        } catch (e) {}
        for (const c of [ext._stage, ext._mirror, ext._dark, ext._shot]) {
            try {
                if (c && !c._macFitted)
                    c.y_align = Clutter.ActorAlign.CENTER;
            } catch (e) {}
        }
        // The two pills that share a row with the round buttons keep their own
        // height instead of being stretched: a stretched pill would no longer
        // match its own drawn outline.
        for (const t of [ext._night, ext._dnd]) {
            try {
                if (t && !t._macFitted)
                    t.y_align = Clutter.ActorAlign.CENTER;
            } catch (e) {}
        }
        /* The option disc of every pill: a touch smaller and a touch further
         * right than the constants controlCenter.js was built with (r 19 at
         * cx 33): 36px across means r 18, so 1px right keeps the disc's right
         * edge exactly where the text block starts. Done here, on the
         * live pods, because controlCenter.js is cached by the shell until a
         * login; the hit area and the glyph follow the disc. */
        for (const t of [ext._wifi, ext._bt, ext._night, ext._dnd]) {
            try {
                const sh = t && t.shape;
                if (!sh || sh._macDiscFit)
                    continue;
                const W = sh.width || 153, H = sh.height || 73;
                sh.set_pivot_point(33 / W, 0.5);          // about the disc itself
                sh.scale_x = sh.scale_y = 1;
                sh.translation_x = 3;                     // cx 33 -> 36
                if (t.bubble) {
                    t.bubble.set_size(38, 38);
                    t.bubble.set_position(17, Math.round((H - 38) / 2));
                }
                sh._macDiscFit = true;
            } catch (e) { /* a pod that is not there yet */ }
        }
        // The square player pod is an Apple squircle (the reference's is a
        // squircle too, not a pill), so it keeps the drawn image and asks the
        // glass for a smaller corner: R = 2r = 36 on 146px, exponent 4.38.
        // The player square uses the same drawn outline (34 corner and
        // straight sides), so it needs the exponents as well.
        try {
            const m = ext._mediaTile;
            if (m) {
                if (!m._macSquareFit) {
                    // 153 and not 154: the column it lives in is 153 wide, so a
                    // 154 square was squeezed by 1px and stopped being square.
                    m.set_size(153, 153);
                    m.shape?.set_size(153, 153);
                    if (m.art) {
                        m.art.set_size(40, 40);
                        m.art.set_position(15, 15);
                    }
                    for (const l of [m.titleLabel, m.subLabel])
                        l && (l.width = 153 - 30);
                    m.titleLabel?.set_position(15, 70);
                    m.subLabel?.set_position(15, 89);
                    if (m.controls) {
                        m.controls.set_size(153, 30);
                        m.controls.set_position(0, 102);
                    }
                    m._macSquareFit = true;
                }
                m._macPodRadius = 36;
                m._macPodRadiusX = 36;
                m._macPodExpX = 2.88;
                m._macPodExpY = 1.9;
            }
        } catch (e) {}
    }

    /* Less white on the option disc: the sheen is what makes the circle read as
     * a grey blob on the pod, while macOS keeps it as glass. Quantities are the
     * ones controlCenter.js paints (BUBBLE_CX 33, BUBBLE 38, height/2), only
     * the alpha changes. */
    const DISC_SHEEN = 0.16;
    function transparentDisc(t) {
        const sh = t && t.shape;
        if (!sh || sh._macDiscPaint)
            return;
        sh._macDiscPaint = true;
        sh._draw = function () {
            const cr = this.get_context();
            const [w, h] = this.get_surface_size();
            if (w < 8 || h < 8) {
                cr.$dispose();
                return;
            }
            cr.save();
            if (this._macSq) {
                // A shrunk pill is a round block: off is the glass itself (no
                // little white disc floating in the middle), on is the solid
                // white circle the four round buttons paint.
                if (this._on) {
                    cr.newPath();
                    cr.arc(w / 2, h / 2, Math.min(w, h) / 2, 0, 2 * Math.PI);
                    cr.setSourceRGBA(1, 1, 1, 1);
                    cr.fill();
                }
                cr.restore();
                cr.$dispose();
                return;
            }
            const cx = 33;
            const cy = h / 2;
            const r = 19;
            if (this._on) {
                cr.newPath();
                cr.arc(cx, cy, r, 0, 2 * Math.PI);
                cr.setSourceRGBA(1, 1, 1, 1);
                cr.fill();
            } else {
                cr.newPath();
                cr.arc(cx, cy, r, 0, 2 * Math.PI);
                const light = new Cairo.LinearGradient(0, cy - r, 0, cy + r);
                light.addColorStopRGBA(0.00, 1, 1, 1, DISC_SHEEN);
                light.addColorStopRGBA(0.55, 1, 1, 1, DISC_SHEEN * 0.62);
                light.addColorStopRGBA(1.00, 1, 1, 1, DISC_SHEEN * 0.78);
                cr.setSource(light);
                cr.fill();
            }
            cr.restore();
            cr.$dispose();
        };
        try { sh.queue_repaint(); } catch (e) {}
    }

    /* The two slider bars: 303x62 -> 318x65, with the title and the row of
     * controls moved by the same factor (they are positioned in the pod's own
     * coordinates by controlCenter.js). */
    function fitSliders() {
        for (const b of [ext._display, ext._sound]) {
            try {
                if (!b || b._macSliderFit)
                    continue;
                // A little taller than before (65 -> 72): the brightness and
                // volume pods were the two that read as squeezed.
                b.set_size(318, SLIDER_H);
                b.shape?.set_size(318, SLIDER_H);
                b.titleLabel?.set_position(19, 12);
                if (b.row) {
                    // Full width again: the pod is taller, and a 250px row made
                    // the bar and its two symbols look shrunken.
                    b.row.set_size(284, 28);
                    b.row.set_position(17, 34);
                }
                b._macSliderFit = true;
            } catch (e) { /* not there yet */ }
        }
    }

    function decorateTiles() {
        if (decorated)
            return;
        decorated = true;
        retuneLayout();
        fitSliders();
        setupEditor();
        try {
            const wifiG = tileGlyph('wifi', ext._wifi, 'wifi', 26);
            tileGlyph('sun', ext._night, 'sun', 26);
            const dndG = tileGlyph('moon', ext._dnd, 'moon', 26);

            // NetworkManager applies the change at once, but extension.js only
            // repaints the tile after its own deferred refresh: read the real
            // value so the arcs fill without that wait.
            if (wifiG && ext._wifi && ext._wifi._bubble) {
                ext._wifi._bubble.connect('clicked', () => {
                    for (const ms of [90, 350, 800]) {
                        delay(ms).then(() => {
                            try {
                                propGet(Gio.DBus.system, 'org.freedesktop.NetworkManager',
                                    '/org/freedesktop/NetworkManager', 'org.freedesktop.NetworkManager',
                                    'WirelessEnabled')
                                    .then(v => syncTile('wifi', true, v)).catch(() => {});
                            } catch (e) {}
                        });
                    }
                });
            }

            // Dark mode is a round button with no bubble: its state lives on the
            // button itself (extension.js: _toggleDark -> _refresh -> setOn).
            // The tile is now a CircleTile wrapper, so the icon lives on the
            // inner St.Button (dark.button); fall back to the tile itself.
            const dark = ext._dark;
            if (dark) {
                const host = (dark.set_child && dark) || dark.button || dark;
                const g = shrinkGlyph(makeGlyph('contrast', 32, h, 'mac-icon'));
                const old = host.get_child && host.get_child();
                host.set_child(g.actor);
                if (old) old.destroy();
                tiles.dark = g;
                tileState.dark = () => {
                    try { return dark.has_style_pseudo_class('checked'); } catch (e) { return false; }
                };
                g.set(tileState.dark(), false);
                (dark.button ?? dark).connect('clicked', () => {
                    // extension.js has already switched the scheme by now, so a
                    // prompt raised before the theme sync was quieted is closed
                    // here as well; the countdown cannot log anyone out.
                    muteThemePrompt();
                    closeThemePrompt(themeExtension());
                    settle('dark');
                });
            }

            // Sound slider: the speaker waves ripple while the volume changes.
            const snd = ext._sound;
            const row = (snd && snd.row) || (snd && snd.get_children && snd.get_children()[1]);
            if (row && snd.slider) {
                const ic = row.get_children().filter(c => c instanceof St.Icon).pop();
                if (ic) {
                    const g = makeGlyph('speaker', 22, h, 'mac-small');
                    row.replace_child(ic, g.actor);
                    ic.destroy();
                    tiles.speaker = g;
                    snd.slider.connect('notify::value', () => g.pulse());
                }
            }

            if (dndG && !('rotation_angle_z' in dndG.actor))
                warn('glyphs: rotation_angle_z unavailable, the tilt is off');

            // The other extension may have been re-enabled since the last time,
            // which would have replaced the quieted theme sync.
            muteThemePrompt();
        } catch (e) {
            warn(`tile glyphs failed: ${e && (e.message || e)}`);
        }
    }


    /* ================= the editable Control Center =================
     * A free-positioning grid inside `.mac-cc` holds the real pods, so the
     * panel can be edited: blocks move, they can be removed and put back, and
     * the toggle pills can shrink to a round block and grow again. The list
     * survives a close, a logout and a reboot because it is a GSettings key
     * (`schemas/cc-layout.gschema.xml`), written on every change.
     *
     * Geometry: the four grid columns are 70px wide with 38/3 = 12.667px
     * between them, so 4 cells + 3 gaps = 318 — the width the panel already
     * has; two cells are 153 (the current pill), one row is 73 and the rows are
     * 12 apart. Nothing about the tuned look changes when the default layout is
     * in place: wifi and bluetooth stack in the first column, the player spans
     * the second, and the two rows of round blocks pack exactly as before.
     *
     * The list lives in its own schema on purpose: the shell caches the
     * extension's main schema in-process, so a key added there would only be
     * visible after a login. This one is loaded through its own schema source,
     * which is re-read every time the module is.
     */
    const GRID_SCHEMA_ID = 'org.gnome.shell.extensions.macos-control-centre-lg.layout';
    const GRID_COLS = 4;
    const CELL_W = 70;
    const GAP_X = 38 / 3;
    const ROW_H = 73;
    const GAP_Y = 12;
    const SLIDER_H = 72;
    const MEDIA_S = 153;
    const MEDIA_H = ROW_H * 2 + GAP_Y;   // 158, the player spans two rows

    let grid = null;               // St.Widget with a FixedLayout inside .mac-cc
    let gridLayout = [];           // [{id, span, col, row}] — explicit cells
    let layoutSettings = null;     // Gio.Settings, or false when unavailable
    let editMode = false;
    let editLabel = null;          // the "Edit Controls" St.Label
    let editLabelText = '';
    let drawer = null;
    const badges = new Map();      // pod actor -> overlay (edit mode only)
    const geometry = new Map();    // pod id -> {x, y, w, h}
    /* Blocks that the drawer has just put back into the grid: they appear at
     * their own size and are never resized in front of you. */
    const freshPods = new Set();
    const droppedRows = [];

    const colX = (c) => Math.round(c * (CELL_W + GAP_X));
    const spanW = (n) => Math.round(n * CELL_W + (n - 1) * GAP_X);

    function layoutDefs() {
        return {
            wifi: {kind: 'toggle', span: 2, actor: ext._wifi, name: 'Wi-Fi'},
            media: {kind: 'media', span: 2, actor: ext._mediaTile, name: tr('media', 'Lettore')},
            bluetooth: {kind: 'toggle', span: 2, actor: ext._bt, name: 'Bluetooth'},
            night: {kind: 'toggle', span: 2, actor: ext._night, name: tr('night', 'Luce notturna')},
            stage: {kind: 'circle', span: 1, actor: ext._stage, name: 'Stage Manager'},
            mirror: {kind: 'circle', span: 1, actor: ext._mirror, name: 'Mirroring'},
            dark: {kind: 'circle', span: 1, actor: ext._dark, name: tr('dark', 'Modalità scura')},
            shot: {kind: 'circle', span: 1, actor: ext._shot, name: 'Screenshot'},
            focus: {kind: 'toggle', span: 2, actor: ext._dnd, name: tr('focus', 'Focus')},
            display: {kind: 'slider', span: 4, actor: ext._display, name: tr('display', 'Display')},
            sound: {kind: 'slider', span: 4, actor: ext._sound, name: tr('sound', 'Suono')},
        };
    }
    // The panel exactly as it ships: every block has its own cell, so a drag
    // can drop a pod where the pointer left it instead of everything reflowing
    // through a first-fit packing (which is what made "move" look broken: the
    // block jumped back to a computed slot as soon as it was released).
    const DEFAULT_LAYOUT = [
        {id: 'wifi', span: 2, col: 0, row: 0},
        {id: 'media', span: 2, col: 2, row: 0},
        {id: 'bluetooth', span: 2, col: 0, row: 1},
        {id: 'night', span: 2, col: 0, row: 2},
        {id: 'stage', span: 1, col: 2, row: 2},
        {id: 'mirror', span: 1, col: 3, row: 2},
        {id: 'dark', span: 1, col: 0, row: 3},
        {id: 'shot', span: 1, col: 1, row: 3},
        {id: 'focus', span: 2, col: 2, row: 3},
        {id: 'display', span: 4, col: 0, row: 4},
        {id: 'sound', span: 4, col: 0, row: 5},
    ];

    /* Footprint of a block in cells. */
    function spanOf(def, it) {
        const sx = def.kind === 'slider' ? GRID_COLS
            : def.kind === 'media' ? 2
                : def.kind === 'toggle' ? (it.span === 1 ? 1 : 2) : 1;
        const sy = def.kind === 'media' ? 2 : 1;
        return {sx, sy};
    }

    /* Which cells the other blocks already own (`skipId` leaves one out, which
     * is what a drag needs: a block does not collide with its own old place). */
    function occupancy(skipId = null) {
        const defs = layoutDefs();
        const occ = [];
        for (const it of gridLayout) {
            if (it.id === skipId)
                continue;
            const def = defs[it.id];
            if (!def || !def.actor || !Number.isInteger(it.col) || !Number.isInteger(it.row))
                continue;
            const {sx, sy} = spanOf(def, it);
            for (let dy = 0; dy < sy; dy++) {
                if (!occ[it.row + dy])
                    occ[it.row + dy] = [];
                for (let dx = 0; dx < sx; dx++)
                    occ[it.row + dy][it.col + dx] = it.id;
            }
        }
        return occ;
    }

    function isFree(occ, r, c, sx, sy) {
        if (c < 0 || r < 0 || c + sx > GRID_COLS)
            return false;
        for (let dy = 0; dy < sy; dy++)
            for (let dx = 0; dx < sx; dx++)
                if (occ[r + dy] && occ[r + dy][c + dx])
                    return false;
        return true;
    }

    function firstFree(occ, sx, sy) {
        for (let r = 0; r < 200; r++)
            for (let c = 0; c + sx <= GRID_COLS; c++)
                if (isFree(occ, r, c, sx, sy))
                    return {row: r, col: c};
        return {row: 0, col: 0};
    }

    /* The layout is an ORDER, not a bag of cells: the blocks are packed in
     * reading order into the first slot each one fits. That is what keeps the
     * panel compact — a hole closes by itself, and the player (two rows tall)
     * can never be dumped at the bottom while a place higher up is empty. */
    function packOrder(order) {
        const defs = layoutDefs();
        const occ = [];
        const cells = new Map();
        for (const id of order) {
            const def = defs[id];
            const it = gridLayout.find((e) => e.id === id);
            if (!def || !it)
                continue;
            const {sx, sy} = spanOf(def, it);
            const slot = firstFree(occ, sx, sy);
            for (let dy = 0; dy < sy; dy++) {
                if (!occ[slot.row + dy])
                    occ[slot.row + dy] = [];
                for (let dx = 0; dx < sx; dx++)
                    occ[slot.row + dy][slot.col + dx] = id;
            }
            cells.set(id, {col: slot.col, row: slot.row});
        }
        return cells;
    }

    /* Reading order of the saved cells; `skipId` leaves one block out. */
    function readingOrder(skipId = null) {
        const defs = layoutDefs();
        return gridLayout
            .filter((it) => it.id !== skipId && defs[it.id] && defs[it.id].actor)
            .slice()
            .sort((a, b) => ((a.row ?? 0) - (b.row ?? 0)) || ((a.col ?? 0) - (b.col ?? 0)))
            .map((it) => it.id);
    }

    /* Packed placement, written back so what you see is what is saved. */
    function packGrid() {
        const order = readingOrder();
        const cells = packOrder(order);
        const defs = layoutDefs();
        const out = [];
        for (const id of order) {
            const it = gridLayout.find((e) => e.id === id);
            const def = defs[id];
            const c = cells.get(id);
            if (!it || !def || !c)
                continue;
            it.col = c.col;
            it.row = c.row;
            const {sx, sy} = spanOf(def, it);
            out.push({id, def, spanX: sx, spanY: sy, col: c.col, row: c.row});
        }
        return out;
    }

    /* A pill and a round block are the same pod seen at two sizes: at span 1 the
     * text block is hidden and the whole pod becomes the target, like the four
     * round buttons (`.mac-tile-sq` in the CSS gives it the 70px box the
     * stylesheet otherwise forces to 153). Switching between the two is one
     * single motion of the same glass — it shrinks, the disc grows into it and
     * the two lines of text fade — instead of the pod snapping to the new size
     * while everything around it slides. */
    const MORPH_MS = 240;
    const MORPH_EASE = Clutter.AnimationMode.EASE_OUT_CUBIC;
    /* How far the two lines travel while they dissolve (and come back from). */
    const TEXT_SLIDE = 16;
    function fitToggle(t, span, animate = false) {
        try {
            const sq = span === 1;
            const w = sq ? CELL_W : spanW(2);
            const h = sq ? CELL_W : ROW_H;
            /* Only a real switch animates: the first layout, or a pod that is
             * already the right shape, is placed at once. */
            const morph = animate && t._macSqSpan !== undefined &&
                t._macSqSpan !== span && !!(t.get_stage && t.get_stage());
            t._macSqSpan = span;
            const size = (a, aw, ah) => {
                if (!a)
                    return;
                if (morph) {
                    try {
                        a.ease({width: aw, height: ah, duration: MORPH_MS, mode: MORPH_EASE});
                        return;
                    } catch (e) { /* no transition on this actor: set it */ }
                }
                a.set_size(aw, ah);
            };
            const pos = (a, ax, ay) => {
                if (!a)
                    return;
                if (morph) {
                    try {
                        a.ease({x: ax, y: ay, duration: MORPH_MS, mode: MORPH_EASE});
                        return;
                    } catch (e) { /* no transition on this actor: set it */ }
                }
                a.set_position(ax, ay);
            };
            size(t, w, h);
            size(t.shape, w, h);
            if (sq)
                t.add_style_class_name('mac-tile-sq');
            else
                t.remove_style_class_name('mac-tile-sq');
            if (t.textBtn) {
                const btn = t.textBtn;
                if (morph) {
                    btn.remove_all_transitions();
                    if (sq) {
                        // The two lines slide out towards their own side while
                        // they dissolve, so the text leaves the closing pill
                        // instead of blinking off in place.
                        btn.ease({
                            opacity: 0,
                            translation_x: TEXT_SLIDE,
                            duration: MORPH_MS - 40,
                            mode: MORPH_EASE,
                            onComplete: () => {
                                if (t._macSqSpan !== 1)
                                    return;
                                btn.visible = false;
                                btn.translation_x = 0;
                            },
                        });
                    } else {
                        btn.visible = true;
                        btn.opacity = 0;
                        btn.translation_x = TEXT_SLIDE;
                        btn.ease({
                            opacity: 255,
                            translation_x: 0,
                            duration: MORPH_MS - 40,
                            delay: 40,
                            mode: MORPH_EASE,
                        });
                    }
                } else {
                    btn.visible = !sq;
                    btn.opacity = 255;
                    btn.translation_x = 0;
                }
            }
            if (sq) {
                // The disc IS the pod here: the whole circle toggles, as on
                // the round buttons, instead of a 38px dot in the middle.
                size(t.bubble, w, h);
                pos(t.bubble, 0, 0);
                if (t.shape) {
                    t.shape.translation_x = 0;
                    t.shape.scale_x = 1;
                    t.shape.scale_y = 1;
                }
                sqGlyph(t, true, morph);
                t._macPodRadius = 35;
                t._macPodRadiusX = 35;
            } else {
                if (t.textBtn) {
                    t.textBtn.set_size(w - 65, h);
                    t.textBtn.set_position(62, 0);
                }
                if (t.textBox)
                    t.textBox.set_size(w - 65, h);
                for (const l of [t.titleLabel, t.subLabel])
                    l && (l.width = w - 65);
                size(t.bubble, 38, 38);
                pos(t.bubble, 17, Math.round((h - 38) / 2));
                if (t.shape)
                    t.shape.translation_x = 3;
                sqGlyph(t, false, morph);
                t._macPodRadius = 36;
                t._macPodRadiusX = 36;
            }
            t._macPodExpX = 2.88;
            t._macPodExpY = 1.9;
        } catch (e) { fail(e, 'fit toggle'); }
    }

    /* The symbol of a shrunk pill has to be the symbol of a round block: the
     * circles carry their icon at 30px (`.mac-circle .mac-icon`), while the
     * animated glyphs of the pills are drawn at 26px and scaled 0.92. Same size
     * here, same animations (the glyph actor is the very same one), and the
     * shape is told to paint the circle state instead of the little disc. */
    const SQ_GLYPH = 30 / 26;
    function sqGlyph(t, sq, animate = false) {
        try {
            const g = t && t.bubble && t.bubble.get_child && t.bubble.get_child();
            if (g) {
                g.set_pivot_point(0.5, 0.5);
                const s = sq ? SQ_GLYPH : SYMBOL_SCALE;
                if (animate) {
                    try {
                        g.ease({scale_x: s, scale_y: s, duration: MORPH_MS, mode: MORPH_EASE});
                    } catch (e) { g.scale_x = g.scale_y = s; }
                } else {
                    g.scale_x = g.scale_y = s;
                }
            }
            if (t && t.shape) {
                t.shape._macSq = sq;
                t.shape.queue_repaint?.();
            }
        } catch (e) { /* no glyph yet */ }
    }

    const itemHeight = (p) => p.def.kind === 'media' ? MEDIA_H
        : p.def.kind === 'slider' ? SLIDER_H
            : (p.def.kind === 'circle' || p.spanX === 1) ? CELL_W : ROW_H;

    /* Rows are as tall as their content, not always 73: a slider is 65 and used
     * to sit 12px under the row above, so the vertical rhythm has to come from
     * the real heights or the sliders end up 8px further apart. */
    function rowMetrics(placed) {
        const heights = [];
        // The row list has to reach the LAST row in use, not the last non-empty
        // one: a block dropped in a row of its own (an empty row above it) used
        // to land at y=0, on top of everything.
        let maxRow = -1;
        for (const p of placed) {
            maxRow = Math.max(maxRow, p.row + (p.spanY > 1 ? p.spanY - 1 : 0));
            // A block that spans rows already covers them: two 73px rows are
            // exactly the player's 158, so counting it again would add a row.
            if (p.spanY > 1)
                continue;
            heights[p.row] = Math.max(heights[p.row] || 0, itemHeight(p));
        }
        const tops = [];
        let acc = 0;
        for (let r = 0; r <= maxRow; r++) {
            tops[r] = acc;
            acc += (heights[r] || ROW_H) + GAP_Y;
        }
        return {heights, tops};
    }

    function applyGrid(animate = false) {
        if (!grid)
            return;
        try {
            geometry.clear();
            const placed = packGrid();
            const {heights, tops} = rowMetrics(placed);
            let bottom = 0;
            for (const p of placed) {
                const a = p.def.actor;
                if (!a)
                    continue;
                let w = spanW(p.spanX);
                let h = ROW_H;
                if (p.def.kind === 'media') {
                    w = MEDIA_S;
                    h = MEDIA_S;
                } else if (p.def.kind === 'slider') {
                    w = spanW(GRID_COLS);
                    h = SLIDER_H;
                } else if (p.def.kind === 'circle' || p.spanX === 1) {
                    w = CELL_W;
                    h = CELL_W;
                }
                // A block that spans rows (the player) is centred in the rows
                // it covers, not in the first one: centring a 153px square in a
                // 73px row put it at -40, i.e. 40px above the panel, where it
                // was clipped by the glass. The rows it spans are exactly 158
                // (73 + 12 + 73), so it lands 2px inside them.
                const top = tops[p.row] || 0;
                let slotH = heights[p.row] || ROW_H;
                if (p.spanY > 1) {
                    const last = p.row + p.spanY - 1;
                    slotH = tops[last] !== undefined
                        ? tops[last] + (heights[last] || ROW_H) - top
                        : MEDIA_H;
                }
                const y = top + Math.max(0, Math.round((slotH - h) / 2));
                if (a.get_parent() !== grid) {
                    a.get_parent()?.remove_child(a);
                    grid.add_child(a);
                }
                if (p.def.kind === 'toggle')
                    fitToggle(a, p.spanX, animate && !freshPods.has(p.id));
                else if (p.def.kind === 'circle') {
                    a.set_size(CELL_W, CELL_W);
                    a.shape?.set_size(CELL_W, CELL_W);
                    a.button?.set_size(CELL_W, CELL_W);
                } else if (p.def.kind === 'media') {
                    a.set_size(MEDIA_S, MEDIA_S);
                    a.shape?.set_size(MEDIA_S, MEDIA_S);
                } else if (p.def.kind === 'slider') {
                    a.set_size(w, h);
                    a.shape?.set_size(w, h);
                }
                const x = colX(p.col);
                a.translation_x = 0;
                a.translation_y = 0;
                if (animate && !badges.has(a))
                    a.ease({x, y, duration: 190, mode: EASE});
                else
                    a.set_position(x, y);
                geometry.set(p.id, {x, y, w, h});
                bottom = Math.max(bottom, y + h);
            }
            // A block that is not in the list leaves the grid entirely, so no
            // stale glass region is left behind.
            for (const [id, def] of Object.entries(layoutDefs())) {
                const a = def.actor;
                if (!a || placed.some((p) => p.id === id))
                    continue;
                if (a.get_parent() === grid)
                    grid.remove_child(a);
            }
            freshPods.clear();
            grid.height = bottom;
            if (editMode)
                rebuildBadges();
        } catch (e) { fail(e, 'apply grid'); }
    }

    function layoutStore() {
        if (layoutSettings !== null)
            return layoutSettings || null;
        try {
            const file = GLib.filename_from_uri(import.meta.url)[0];
            const dir = GLib.build_filenamev([GLib.path_get_dirname(file), 'schemas']);
            const src = Gio.SettingsSchemaSource.new_from_directory(
                dir, Gio.SettingsSchemaSource.get_default(), false);
            const schema = src && src.lookup(GRID_SCHEMA_ID, true);
            layoutSettings = schema ? new Gio.Settings({settings_schema: schema}) : false;
            if (!schema)
                warn('layout schema missing, using the json fallback');
        } catch (e) {
            fail(e, 'layout schema');
            layoutSettings = false;
        }
        return layoutSettings || null;
    }
    const layoutFile = () => GLib.build_filenamev([GLib.get_user_config_dir(), 'macos-cc-layout.json']);

    function readLayout() {
        let raw = '';
        try {
            const s = layoutStore();
            if (s)
                raw = s.get_string('layout');
            else if (GLib.file_test(layoutFile(), GLib.FileTest.EXISTS))
                raw = String(GLib.file_get_contents(layoutFile())[1]);
        } catch (e) { raw = ''; }
        try {
            const parsed = JSON.parse(raw || '[]');
            const defs = layoutDefs();
            const seen = new Set();
            const out = [];
            if (Array.isArray(parsed)) {
                for (const it of parsed) {
                    if (!it || !defs[it.id] || seen.has(it.id))
                        continue;
                    seen.add(it.id);
                    const want = Number(it.span) >= 1 && Number(it.span) <= 4
                        ? Math.round(Number(it.span)) : defs[it.id].span;
                    // A layout written before cells existed has no col/row: -1
                    // means "put it in the first free slot", as it used to.
                    const col = Number.isInteger(it.col) && it.col >= 0 && it.col < GRID_COLS
                        ? it.col : -1;
                    const row = Number.isInteger(it.row) && it.row >= 0 && it.row < 200
                        ? it.row : -1;
                    out.push({id: it.id, span: want, col, row});
                }
            }
            if (out.length)
                return out;
        } catch (e) { warn(`layout parse: ${e && (e.message || e)}`); }
        return DEFAULT_LAYOUT.map((it) => ({...it}));
    }

    function writeLayout() {
        const raw = JSON.stringify(gridLayout);
        try {
            const s = layoutStore();
            if (s)
                s.set_string('layout', raw);
            else
                GLib.file_set_contents(layoutFile(), raw);
        } catch (e) { fail(e, 'layout save'); }
    }

    function applyGridEdit() {
        writeLayout();
        applyGrid(true);
        /* The drawer is rebuilt, not just refreshed, and one of its own buttons
         * is usually the actor that started this call: destroying it inside its
         * click handler left the shell with a detached actor mid-signal. The
         * rebuild waits for the next iteration, once the click is over. */
        if (editMode)
            delay(0).then(() => { if (editMode) buildDrawer(true); });
        else
            buildDrawer(false);
    }

    function addItem(id) {
        if (gridLayout.some((it) => it.id === id))
            return;
        const def = layoutDefs()[id];
        if (!def || !def.actor)
            return;
        /* The block comes in from the piece that was pressed: it is put on the
         * grid at that very point and then slides into its cell, so adding a
         * block reads as moving that piece up into the Control Center. */
        let from = null;
        const piece = previewAt.get(id);
        if (piece && grid) {
            try {
                const [px, py] = piece.get_transformed_position();
                const [gx, gy] = grid.get_transformed_position();
                from = {x: Math.round(px - gx), y: Math.round(py - gy)};
            } catch (e) { from = null; }
        }
        freshPods.add(id);
        const it = {id, span: def.kind === 'toggle' ? 2 : 1, col: -1, row: -1};
        const {sx, sy} = spanOf(def, it);
        const slot = firstFree(occupancy(), sx, sy);
        it.col = slot.col;
        it.row = slot.row;
        gridLayout.push(it);
        if (from) {
            try {
                def.actor.set_position(from.x, from.y);
                def.actor.opacity = 0;
                applyGridEdit();
                def.actor.ease({opacity: 255, duration: 200, mode: EASE});
                if (editMode)
                    mutePods(true);
                return;
            } catch (e) { /* placed without the slide */ }
        }
        applyGridEdit();
        if (editMode)
            mutePods(true);
    }

    function removeItem(id) {
        const i = gridLayout.findIndex((it) => it.id === id);
        if (i < 0)
            return;
        gridLayout.splice(i, 1);
        applyGridEdit();
    }

    function toggleSpan(id) {
        const it = gridLayout.find((e) => e.id === id);
        if (!it)
            return;
        it.span = it.span === 1 ? 2 : 1;
        applyGridEdit();
    }

    /* Back to the panel Apple ships: every block present, in its original
     * place. Written at once, so it survives a close and a reboot like any
     * other edit. */
    function resetLayout() {
        gridLayout = DEFAULT_LAYOUT.map((it) => ({...it}));
        applyGridEdit();
    }

    /* The cells a drop would produce, without touching the saved layout: the
     * dragged block is inserted at that point of the reading order and the
     * whole list is packed again, so the neighbours shift by one and nothing is
     * left behind in a hole. Used for the live preview and for the commit, so
     * what you see during the drag is exactly what you get. */
    function previewCells(id, targetCol, targetRow) {
        if (!gridLayout.some((e) => e.id === id) || !layoutDefs()[id])
            return null;
        const others = readingOrder(id);
        const defs = layoutDefs();
        const draggedIt = gridLayout.find((e) => e.id === id) || {};
        const ds = spanOf(defs[id], draggedIt);
        const dragArea = ds.sx * ds.sy;
        let idx = others.length;
        for (let i = 0; i < others.length; i++) {
            const it = gridLayout.find((e) => e.id === others[i]) || {};
            const s = spanOf(defs[others[i]], it);
            const r = it.row ?? 0;
            const c = it.col ?? 0;
            // Dropped on a block: the two swap places. A block at least as big
            // as the target slides in front of it (it takes that place); a
            // smaller one goes behind it, otherwise the big one would be the
            // one that moves and the drop would look like nothing happened.
            const covers = targetRow >= r && targetRow < r + s.sy &&
                targetCol >= c && targetCol < c + s.sx;
            if (covers) {
                idx = dragArea >= s.sx * s.sy ? i : i + 1;
                break;
            }
            if (r > targetRow || (r === targetRow && c > targetCol)) {
                idx = i;
                break;
            }
        }
        others.splice(idx, 0, id);
        return packOrder(others);
    }

    /* Pixel position of every block for a set of cells: same maths as
     * applyGrid, used to move the neighbours during the drag. */
    function cellPositions(cells) {
        const defs = layoutDefs();
        const placed = [];
        for (const it of gridLayout) {
            const def = defs[it.id];
            const c = cells.get(it.id);
            if (!def || !def.actor || !c)
                continue;
            const {sx, sy} = spanOf(def, it);
            placed.push({id: it.id, def, spanX: sx, spanY: sy, col: c.col, row: c.row});
        }
        const {heights, tops} = rowMetrics(placed);
        const out = new Map();
        for (const p of placed) {
            const h = p.def.kind === 'media' ? MEDIA_S
                : p.def.kind === 'slider' ? SLIDER_H
                    : p.spanX === 1 ? CELL_W : ROW_H;
            const top = tops[p.row] || 0;
            let slotH = heights[p.row] || ROW_H;
            if (p.spanY > 1) {
                const last = p.row + p.spanY - 1;
                slotH = tops[last] !== undefined
                    ? tops[last] + (heights[last] || ROW_H) - top
                    : MEDIA_H;
            }
            out.set(p.id, {x: colX(p.col), y: top + Math.max(0, Math.round((slotH - h) / 2))});
        }
        return out;
    }

    /* Live reorder: everyone except the block in your hand slides to the cell
     * the drop would give them. */
    function showPreview(cells, skipActor) {
        const pos = cellPositions(cells);
        for (const [id, p] of pos) {
            const def = layoutDefs()[id];
            const a = def && def.actor;
            if (!a || a === skipActor)
                continue;
            if (Math.round(a.x) === p.x && Math.round(a.y) === p.y)
                continue;
            try {
                a.ease({x: p.x, y: p.y, duration: 150, mode: EASE});
                const ov = badges.get(a);
                if (ov) {
                    ov.remove_all_transitions();
                    ov.ease({x: p.x, y: p.y, duration: 150, mode: EASE});
                }
            } catch (e) {}
        }
    }

    /* The cell under the centre of the block being dragged. */
    function targetCell(actor) {
        const cx = actor.x + actor.width / 2;
        const cy = actor.y + actor.height / 2;
        const placed = packGrid();
        const {heights, tops} = rowMetrics(placed);
        const rows = Math.max(1, heights.length);
        const rowTop = (r) => tops[r] !== undefined
            ? tops[r]
            : (tops[rows - 1] || 0) + (heights[rows - 1] || ROW_H) + GAP_Y * (r - rows + 1);
        let row = 0;
        let bestDy = Infinity;
        for (let r = 0; r <= rows + 1; r++) {
            const dy = Math.abs(cy - (rowTop(r) + (heights[r] || ROW_H) / 2));
            if (dy < bestDy) {
                bestDy = dy;
                row = r;
            }
        }
        const col = Math.round((cx - CELL_W / 2) / (CELL_W + GAP_X));
        return {col: Math.max(0, Math.min(GRID_COLS - 1, col)), row};
    }

    function updateTarget() {
        if (!drag)
            return;
        const t = targetCell(drag.actor);
        if (drag.target && drag.target.col === t.col && drag.target.row === t.row)
            return;
        drag.target = t;
        const cells = previewCells(drag.id, t.col, t.row);
        if (cells) {
            drag.preview = cells;
            showPreview(cells, drag.actor);
        }
    }

    /* Drop a block on a cell. If that cell is taken, the nearest free one is
     * used: the block lands where the hand left it instead of jumping to a
     * computed packing slot, and nothing else moves. */
    function editOverlay(id, def) {
        const g = geometry.get(id) || {w: 70, h: 70};
        const ov = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            width: g.w,
            height: g.h,
        });
        const del = new St.Button({
            label: '−',
            style_class: 'mac-edit-badge',
            can_focus: false,
            reactive: true,
        });
        del.set_position(4, 4);
        // Handled on press and stopped there: no 'clicked', so the pod below
        // never sees the press either.
        del.connect('button-press-event', () => { removeItem(id); return Clutter.EVENT_STOP; });
        ov.add_child(del);
        if (def.kind === 'toggle') {
            const rz = new St.Button({
                label: '⇥',
                style_class: 'mac-edit-resize',
                can_focus: false,
                reactive: true,
            });
            rz.set_position(Math.max(0, g.w - 26), Math.max(0, g.h - 26));
            rz.connect('button-press-event', () => { toggleSpan(id); return Clutter.EVENT_STOP; });
            ov.add_child(rz);
        }
        return ov;
    }

    /* Dragging is tracked by hand: Clutter's DragAction is gone from the Clutter
     * this shell ships ("DragAction is not a constructor"). A drag starts either
     * from the stage press handler or, more reliably, from the pointer watch that
     * runs while the panel is in edit mode. */
    let drag = null;   // {id, actor, sx, sy, ox, oy, moved, stageId}

    function startDragAt(pod, x, y) {
        try {
            drag = {
                id: pod._macPodId, actor: pod, sx: x, sy: y,
                ox: pod.x, oy: pod.y, moved: false, stageId: 0, watchId: 0,
                target: null, preview: null,
            };
            grid.set_child_above_sibling(pod, null);
            const ov = badges.get(pod);
            if (ov)
                grid.set_child_above_sibling(ov, null);
            /* If the release never arrives (the pointer left the shell, the menu
             * was closed mid-drag, a grab ate the event), the drag used to stay
             * armed forever and every later press was swallowed. */
            drag.watchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15000, () => {
                if (drag && drag.watchId) {
                    drag.watchId = 0;
                    endDrag();
                }
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) { fail(e, 'drag start'); }
    }

    function beginDrag(id, actor, ev) {
        const [x, y] = ev.get_coords();
        actor._macPodId = actor._macPodId || id;
        startDragAt(actor, x, y);
        return Clutter.EVENT_STOP;
    }
    /* The actual movement, shared by the event path and the pointer poll. */
    function dragTo(x, y) {
        if (!drag)
            return;
        const dx = x - drag.sx;
        const dy = y - drag.sy;
        if (!drag.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3))
            drag.moved = true;
        if (!drag.moved)
            return;
        drag.actor.set_position(drag.ox + Math.round(dx), drag.oy + Math.round(dy));
        const ov = badges.get(drag.actor);
        if (ov)
            ov.set_position(drag.actor.x, drag.actor.y);
        // Live reorder: the neighbours slide out of the way as you move.
        updateTarget();
    }

    function dragEvent(ev) {
        const type = ev.type();
        if (type === Clutter.EventType.MOTION || type === Clutter.EventType.TOUCH_UPDATE) {
            const [x, y] = ev.get_coords();
            dragTo(x, y);
            return drag.moved ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        }
        if (type === Clutter.EventType.BUTTON_RELEASE || type === Clutter.EventType.TOUCH_END) {
            endDrag();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    function endDrag() {
        const d = drag;
        drag = null;
        if (!d)
            return;
        try {
            if (d.stageId)
                global.stage.disconnect(d.stageId);
        } catch (e) {}
        try {
            if (d.watchId)
                GLib.source_remove(d.watchId);
        } catch (e) {}

        if (!d.moved) {
            applyGrid(false);   // put it back where it was
            return;
        }
        /* The drop commits the preview that was already on screen: the dragged
         * block takes the cell under its centre and the blocks that made room
         * stay where they slid to. The last few pixels are animated, so the pod
         * settles into its cell instead of snapping. */
        const t = targetCell(d.actor);
        const cells = previewCells(d.id, t.col, t.row) || d.preview;
        if (!cells) {
            applyGrid(true);
            return;
        }
        const commit = () => {
            for (const it of gridLayout) {
                const c = cells.get(it.id);
                if (c) {
                    it.col = c.col;
                    it.row = c.row;
                }
            }
            applyGridEdit();
        };
        const mine = cellPositions(cells).get(d.id);
        let eased = false;
        if (mine) {
            try {
                d.actor.ease({x: mine.x, y: mine.y, duration: 140, mode: EASE,
                    onComplete: commit});
                const ov = badges.get(d.actor);
                if (ov)
                    ov.ease({x: mine.x, y: mine.y, duration: 140, mode: EASE});
                eased = true;
            } catch (e) { eased = false; }
        }
        if (!eased)
            commit();
    }

    /* Which pod is under the pointer? The press is taken once, on the stage,
     * and resolved here: a pod is built from St.Buttons (the option disc, the
     * text area, the slider) and those children own the press, so hooking each
     * pod separately kept missing it. Picking is the same call the shell uses
     * to decide who gets the click, so this cannot disagree with the pointer. */
    let editStageId = 0;

    function podUnder(actor) {
        for (let a = actor; a; a = a.get_parent()) {
            try {
                if (a._macPodId)
                    return a;
            } catch (e) {}
            if (a === grid)
                break;
        }
        return null;
    }

    function onEditPress(_stage, ev) {
        if (!editMode)
            return Clutter.EVENT_PROPAGATE;
        const t = ev.type();
        if (t !== Clutter.EventType.BUTTON_PRESS && t !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;
        if (drag)
            endDrag();   // a release that never arrived
        let target = null;
        try {
            const [x, y] = ev.get_coords();
            target = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        } catch (e) {
            return Clutter.EVENT_PROPAGATE;
        }
        const pod = podUnder(target);
        if (!pod)
            return Clutter.EVENT_PROPAGATE;   // a handle, the drawer, the button…
        return beginDrag(pod._macPodId, pod, ev);
    }

    function attachDrag(id, actor) {
        try { actor._macPodId = id; } catch (e) { fail(e, 'drag hook'); }
    }

    function detachDrag(actor) {
        try { actor._macPodId = null; } catch (e) {}
    }

    function rebuildBadges() {
        clearBadges();
        if (!editMode)
            return;
        for (const p of packGrid()) {
            const a = p.def.actor;
            if (!a || a.get_parent() !== grid)
                continue;
            const ov = editOverlay(p.id, p.def);
            const g = geometry.get(p.id);
            if (g)
                ov.set_position(g.x, g.y);
            grid.add_child(ov);
            badges.set(a, ov);
            attachDrag(p.id, a);
        }
    }

    function clearBadges() {
        if (drag) {
            // Leaving edit mode / closing: put everything back where it is saved
            // instead of committing a preview that was never dropped.
            const d = drag;
            drag = null;
            try {
                if (d.stageId)
                    global.stage.disconnect(d.stageId);
            } catch (e) {}
            try {
                if (d.watchId)
                    GLib.source_remove(d.watchId);
            } catch (e) {}
        }
        for (const p of packGrid())
            if (p.def.actor)
                detachDrag(p.def.actor);
        for (const [a, ov] of badges) {
            try {
                if (drag && drag.actor === a)
                    drag = null;
                a.translation_x = 0;
                a.translation_y = 0;
            } catch (e) {}
            try { ov.destroy(); } catch (e) {}
        }
        badges.clear();
    }

    /* A block as the drawer offers it: the very silhouette it will have in the
     * grid, at thumbnail size, with its name underneath so nothing has to be
     * guessed from the shape alone. */
    /* The drawer is not a shelf of miniatures: it holds the blocks themselves,
     * at the size they have in the grid, stacked under it. Pressing one is
     * pressing the block. */
    const DRAWER_W = spanW(GRID_COLS);
    const DRAWER_GAP = 12;
    const previewAt = new Map();   // block id -> the piece it is pressed on
    const previewShape = (def) => def.kind === 'circle' ? 'circle'
        : def.kind === 'media' ? 'square'
            : def.kind === 'slider' ? 'bar' : 'pill';
    /* Takes the SHAPE name previewShape() returns (circle, square, bar, pill),
     * not the block kind: comparing against 'media'/'slider' here sent the
     * player and both sliders into the pill's 153x73 cell, which is what left
     * the big pieces cropped and out of place. */
    const previewMetric = (shape) => shape === 'circle' ? {w: CELL_W, h: CELL_W}
        : shape === 'square' ? {w: MEDIA_S, h: MEDIA_S}
            : shape === 'bar' ? {w: DRAWER_W, h: SLIDER_H}
                : {w: spanW(2), h: ROW_H};
    /* The pieces in the drawer ARE the blocks: the very actors that were taken
     * out of the grid, put back on the panel one floor down. Nothing is redrawn
     * or scaled — only the parent changes — so a piece looks exactly like the
     * block it becomes, text and state included. */
    function drawerPiece(id, def) {
        const a = def.actor;
        if (!a)
            return null;
        /* A pod taken out of the grid can still be running the ease that was
         * placing it: left alone it would go on moving inside this cell (the
         * 318px sliders ended up half out of the drawer that way). Every
         * transition is stopped before it is put down here. */
        try { a.remove_all_transitions(); } catch (e) {}
        if (def.kind === 'toggle')
            fitToggle(a, 2, false);      // the shape addItem gives it back
        const {w: pw, h: ph} = previewMetric(previewShape(def));
        const cell = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            width: pw,
            height: ph,
            x_align: Clutter.ActorAlign.CENTER,
            /* Next to the 153px player a circle is shorter than the row: it
             * stays on the row's centre line instead of hanging from the top. */
            y_align: Clutter.ActorAlign.CENTER,
        });
        try {
            const par = a.get_parent();
            if (par && par !== cell)
                par.remove_child(a);
            a._macPodId = null;          // it is not a block of the grid now
            a.translation_x = 0;
            a.translation_y = 0;
            a.scale_x = 1;
            a.scale_y = 1;
            a.opacity = 255;
            a.set_position(0, 0);
            cell.add_child(a);
        } catch (e) { fail(e, 'drawer piece'); }
        /* In edit mode the pods are muted (their own buttons are switched off),
         * so the press is taken by a transparent button laid exactly on top. */
        const hit = new St.Button({
            style_class: 'mac-add-hit',
            width: pw,
            height: ph,
            reactive: true,
            can_focus: false,
        });
        hit.set_position(0, 0);
        hit.connect('clicked', () => addItem(id));
        cell.add_child(hit);
        previewAt.set(id, a);
        return cell;
    }

    function buildDrawer(on) {
        try {
            if (drawer) {
                /* The pieces in the drawer are the blocks themselves: take them
                 * out first, or they would be destroyed with the box. */
                for (const a of previewAt.values()) {
                    try {
                        const par = a.get_parent();
                        if (par && par !== grid)
                            par.remove_child(a);
                    } catch (e) {}
                }
                drawer.get_parent()?.remove_child(drawer);
                drawer.destroy();
                drawer = null;
            }
            previewAt.clear();
            if (!on || !grid)
                return;
            const defs = layoutDefs();
            const present = new Set(gridLayout.map((it) => it.id));
            const missing = Object.entries(defs).filter(([id, d]) => d.actor && !present.has(id));
            const box = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'mac-edit-drawer',
                x_align: Clutter.ActorAlign.CENTER,
            });
            /* A space of its own under the panel, like the gallery iOS gives
             * the controls that are not on the grid: a pane with its own tone
             * and its own title, so nothing reads as half-removed. */
            const shelf = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'mac-add-shelf',
                x_align: Clutter.ActorAlign.CENTER,
            });
            /* The pieces are the blocks at their own size, so they are packed
             * the way the grid packs them: a row as wide as the panel, circles
             * waiting side by side, a slider taking a row of its own. */
            if (missing.length) {
                shelf.add_child(new St.Label({
                    text: tr('shelf', 'Disponibili'),
                    style_class: 'mac-edit-drawer-label',
                    x_align: Clutter.ActorAlign.CENTER,
                }));
                let row = null;
                let used = 0;
                for (const [id, def] of missing) {
                    const m = previewMetric(previewShape(def));
                    if (!row || used + DRAWER_GAP + m.w > DRAWER_W) {
                        row = new St.BoxLayout({style_class: 'mac-add-row'});
                        shelf.add_child(row);
                        used = 0;
                    }
                    const piece = drawerPiece(id, def);
                    if (piece) {
                        row.add_child(piece);
                        used += (used ? DRAWER_GAP : 0) + m.w;
                    }
                }
                box.add_child(shelf);
            } else {
                box.add_child(new St.Label({
                    text: tr('allBlocks', 'Tutti i blocchi sono nel pannello'),
                    style_class: 'mac-edit-drawer-label',
                    x_align: Clutter.ActorAlign.CENTER,
                }));
            }
            const reset = new St.Button({
                label: tr('reset', 'Ripristina'),
                style_class: 'mac-edit-drawer-item mac-edit-reset',
                can_focus: false,
                x_align: Clutter.ActorAlign.CENTER,
            });
            reset.connect('clicked', () => resetLayout());
            box.add_child(reset);
            drawer = box;
            const panel = grid.get_parent();
            const host = editLabel && editLabel.get_parent() && editLabel.get_parent().get_parent();
            const idx = host && panel ? panel.get_children().indexOf(host) : -1;
            if (panel && idx >= 0)
                panel.insert_child_at_index(box, idx);
            else if (panel)
                panel.add_child(box);
        } catch (e) { fail(e, 'edit drawer'); }
    }

    /* In edit mode a pod is a thing to move, not a button: its buttons and
     * sliders are made non-reactive, so no click can ever reach them — no menu
     * opening, no Wi-Fi toggling under your finger while you drag. The original
     * values are kept and put back when edit mode ends. */
    const mutedInputs = new Map();
    function mutePods(on) {
        const walk = (a) => {
            let kids = [];
            try { kids = a.get_children(); } catch (e) { return; }
            for (const c of kids) {
                // The slider is ui.slider.Slider, not St.Slider: it is found by
                // the style class the stylesheet gives it.
                const isSlider = c.has_style_class_name &&
                    c.has_style_class_name('slider');
                if (c instanceof St.Button || isSlider) {
                    try {
                        if (on) {
                            if (!mutedInputs.has(c))
                                mutedInputs.set(c, {reactive: c.reactive, can_focus: c.can_focus});
                            c.reactive = false;
                            c.can_focus = false;
                        } else if (mutedInputs.has(c)) {
                            const was = mutedInputs.get(c);
                            c.reactive = was.reactive;
                            c.can_focus = was.can_focus;
                            mutedInputs.delete(c);
                        }
                    } catch (e) {}
                }
                walk(c);
            }
        };
        try {
            if (on) {
                for (const p of packGrid())
                    if (p.def.actor)
                        walk(p.def.actor);
            } else {
                for (const [c, was] of mutedInputs) {
                    try {
                        c.reactive = was.reactive;
                        c.can_focus = was.can_focus;
                    } catch (e) {}
                }
                mutedInputs.clear();
            }
        } catch (e) { fail(e, 'mute pods'); }
    }

    /* While the panel is being edited the pointer is watched directly (position
     * and button state, 60 times a second). That is what actually starts and
     * finishes a drag: no synthetic press/motion/release has to travel through
     * the menu's modal grab, which is where the real mouse kept getting lost. */
    let pointerWatchId = 0;
    let pointerWasDown = false;

    function startPointerWatch() {
        if (pointerWatchId)
            return;
        pointerWasDown = false;
        try {
            pointerWatchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
                if (!editMode) {
                    pointerWatchId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                let ptr = null;
                try {
                    ptr = global.get_pointer();
                } catch (e) {
                    pointerWatchId = 0;   // no pointer access: event path only
                    return GLib.SOURCE_REMOVE;
                }
                if (!ptr || ptr.length < 3) {
                    pointerWatchId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                const [x, y, mods] = ptr;
                const down = !!(mods & Clutter.ModifierType.BUTTON1_MASK);
                if (down && !pointerWasDown && !drag) {
                    let target = null;
                    try {
                        target = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE,
                            Math.round(x), Math.round(y));
                    } catch (e) {}
                    const pod = podUnder(target);
                    if (pod)
                        startDragAt(pod, x, y);
                }
                if (drag) {
                    if (down)
                        dragTo(x, y);
                    else
                        endDrag();
                }
                pointerWasDown = down;
                return GLib.SOURCE_CONTINUE;
            });
        } catch (e) { fail(e, 'pointer watch'); }
    }

    function stopPointerWatch() {
        if (pointerWatchId) {
            try { GLib.source_remove(pointerWatchId); } catch (e) {}
            pointerWatchId = 0;
        }
        pointerWasDown = false;
    }

    function setEditMode(on) {
        if (!grid || editMode === on)
            return;
        editMode = on;
        try {
            if (editLabel)
                editLabel.text = on ? tr('done', 'Fatto') : editLabelText;
        } catch (e) {}
        if (on) {
            rebuildBadges();
            mutePods(true);
            if (!editStageId)
                editStageId = global.stage.connect('captured-event', onEditPress);
            startPointerWatch();
        } else {
            stopPointerWatch();
            if (editStageId) {
                try { global.stage.disconnect(editStageId); } catch (e) {}
                editStageId = 0;
            }
            mutePods(false);
            clearBadges();
            // A drag cancelled by leaving edit mode leaves the neighbours at
            // their preview positions: put every block back on its saved cell.
            applyGrid(false);
        }
        buildDrawer(on);
    }

    function findEditButton() {
        const found = [];
        const walk = (a, depth) => {
            if (!a || depth > 6 || found.length)
                return;
            try {
                if (a.visible && a.has_style_class_name && a.has_style_class_name('mac-edit-controls')) {
                    found.push(a);
                    return;
                }
                for (const c of a.get_children())
                    walk(c, depth + 1);
            } catch (e) {}
        };
        try { walk(ext._panel, 0); } catch (e) {}
        return found[0] || null;
    }

    /* The panel's own button launches gnome-control-center from a handler that
     * was connected before this module ever runs, so the press cannot be
     * intercepted in front of it. The button is therefore left in place but
     * hidden, and an identical one takes its slot. */
    function hookEditButton() {
        const btn = findEditButton();
        if (!btn || btn._macEditHooked)
            return;
        btn._macEditHooked = true;
        try {
            let labelText = '';
            for (const c of btn.get_children())
                if (c instanceof St.Label)
                    labelText = c.text;
            const host = btn.get_parent();
            /* `quick-toggle` is what makes Liquid Glass paint a pod behind an
             * actor: the capsule is real frosted glass instead of a CSS
             * imitation of it. The corner radius is handed to the region
             * builder the same way the pods do, and the CSS keeps the small
             * capsule geometry so the theme's toggle padding does not inflate
             * it. */
            const mine = new St.Button({
                style_class: 'mac-edit-controls quick-toggle',
                can_focus: true,
                reactive: true,
                child: new St.Label({text: labelText, style_class: 'mac-edit-label'}),
            });
            mine._macEditHooked = true;
            mine._macPodRadius = 14;
            mine.connect('clicked', () => setEditMode(!editMode));
            if (host) {
                const idx = host.get_children().indexOf(btn);
                host.insert_child_at_index(mine, idx >= 0 ? idx + 1 : -1);
            }
            btn.visible = false;
            editLabel = mine.get_child();
            editLabelText = labelText;
        } catch (e) { fail(e, 'edit button'); }
    }

    /* The opening cascade follows the screen, not the order the tiles were
     * built in: the list is sorted by where every block really sits (top to
     * bottom, then left to right) each time the panel opens, so a slider moved
     * above the rest now arrives first. The shell caches extension.js, so the
     * sort wraps the live _startEntrance instead of editing it. */
    function enterOrder(actors) {
        const defs = layoutDefs();
        const at = new Map();
        for (const [id, def] of Object.entries(defs)) {
            const g = def.actor && geometry.get(id);
            if (g && Number.isFinite(g.x) && Number.isFinite(g.y))
                at.set(def.actor, g);
        }
        const list = (Array.isArray(actors) ? actors : [])
            .map((a, i) => {
                const g = at.get(a);
                // The keys are copied once, so the comparisons below only ever
                // read numbers: two actors with no place in the grid (the Edit
                // button and a pod that was removed) used to compare undefined
                // y's, and the throw killed the whole entrance.
                return g ? {a, i, g, y: g.y, x: g.x}
                    : {a, i, g: null, y: 0, x: 0};
            })
            // No place in the grid: last, in the order they were built.
            .sort((p, q) => {
                if (!p.g || !q.g) {
                    if (!p.g !== !q.g)
                        return p.g ? -1 : 1;
                    return p.i - q.i;
                }
                return (p.y - q.y) || (p.x - q.x) || (p.i - q.i);
            });
        /* A row is not a y: the blocks of one row are centred in it, so a
         * 70px circle sits 1-2px lower than the 73px pill beside it. Grouping
         * by y would make the pill of a row enter before the circles on its
         * left; a half row of tolerance puts them back in their row. */
        const rows = [];
        for (const o of list) {
            const last = rows[rows.length - 1];
            if (o.g && last && last.y !== null && Math.abs(o.y - last.y) <= ROW_H / 2)
                last.items.push(o);
            else
                rows.push({y: o.g ? o.y : null, items: [o]});
        }
        return rows
            .map((r) => r.items.slice().sort((p, q) => (p.x - q.x) || (p.i - q.i)))
            .flat()
            .map((o) => o.a);
    }

    /* The shell keeps ONE extension object and only calls enable()/disable()
     * again, so a "already installed" flag on it stayed true forever and a
     * reload kept the wrapper of an older module. The wrapper is therefore
     * rebuilt from the class method on every enable, and it always calls the
     * enterOrder() of the module that is running now. */
    function installEnterOrder() {
        const proto = ext && ext.constructor && ext.constructor.prototype;
        const orig = proto && proto._startEntrance;
        if (typeof orig !== 'function')
            return;
        ext._startEntrance = function () {
            const saved = this._enterActors;
            let ordered = saved;
            try {
                ordered = enterOrder(saved);
            } catch (e) {
                // The order is a nicety: if it ever fails, the entrance must
                // still run, in the order the tiles were built in.
                fail(e, 'enter order');
            }
            try {
                this._enterActors = ordered;
                return orig.call(this);
            } finally {
                this._enterActors = saved;
            }
        };
    }

    function setupEditor() {
        if (grid)
            return;
        try {
            const panel = ext._panel;
            if (!panel)
                return;
            const defs = layoutDefs();
            const pods = Object.values(defs).map((d) => d.actor).filter((a) => a);
            if (pods.length < Object.keys(defs).length) {
                delay(600).then(setupEditor);
                return;
            }
            grid = new St.Widget({
                layout_manager: new Clutter.FixedLayout(),
                style_class: 'mac-grid',
                width: spanW(GRID_COLS),
                height: 420,
            });
            panel.insert_child_at_index(grid, 0);
            for (const a of pods) {
                const par = a.get_parent();
                if (par)
                    par.remove_child(a);
                grid.add_child(a);
            }
            /* The rows and columns that used to hold the pods are empty now.
             * They are taken out of the panel instead of hidden: the detail
             * sheet remembers the panel's children and restores them, and an
             * empty row would come back as a 12px gap. */
            const keep = new Set([grid]);
            /* The detail sheet is one of the panel's children too (buildRoot
             * adds it at start-up). Removing it here detached the Wi-Fi /
             * Bluetooth panel from the stage: pressing a pill hid the grid and
             * left an empty box, i.e. the Control Center "went invisible". */
            if (detailRoot)
                keep.add(detailRoot);
            const btn = findEditButton();
            if (btn && btn.get_parent())
                keep.add(btn.get_parent());
            for (const kid of [...panel.get_children()]) {
                if (keep.has(kid))
                    continue;
                panel.remove_child(kid);
                droppedRows.push(kid);
            }
            gridLayout = readLayout();
            applyGrid(false);
            installEnterOrder();
            hookEditButton();
            const s = layoutStore();
            if (s) {
                const id = s.connect('changed::layout', () => {
                    const parsed = readLayout();
                    if (JSON.stringify(parsed) === JSON.stringify(gridLayout))
                        return;
                    gridLayout = parsed;
                    applyGrid(true);
                });
                panel.connect('destroy', () => {
                    try { s.disconnect(id); } catch (e) {}
                });
            }
        } catch (e) { fail(e, 'editor setup'); }
    }

    // A state may also change from outside (GNOME Settings, another toggle):
    // snap the icons to it when the panel opens, then settle for wifi.
    let menuId = 0;
    try {
        menuId = ext._qs.menu.connect('open-state-changed', (_m, open) => {
            if (!open) {
                stopTilePoll();
                setEditMode(false);
                return;
            }
            muteThemePrompt();
            readAccentHex();
            applyAccent();
            scrubTextColors();
            syncArt();
            alignCircleRows();
            applyGrid(false);
            // Liquid Glass samples and re-writes the text colours while the menu
            // opens (and again on each re-sample), so sweep a few times instead
            // of trusting the single pass above.
            for (const ms of [40, 120, 260, 520, 900])
                delay(ms).then(() => scrubTextColors());
            for (const k of ['wifi', 'bt', 'sun', 'moon', 'dark'])
                syncTile(k, false);
            settle('wifi');
            startTilePoll();
        });
    } catch (e) {}

    /* BlueZ is reached over the SYSTEM bus. Its adapter object is discovered
     * lazily (and cached) so both the Powered switch and the device list agree
     * on the same path. */
    let btAdapter = null;
    function findBtAdapter() {
        if (btAdapter) return Promise.resolve(btAdapter);
        return dbusCall(Gio.DBus.system, 'org.bluez', '/', 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects')
            .then((res) => {
                const objs = res?.deepUnpack()[0] || {};
                for (const p of Object.keys(objs)) {
                    if (objs[p] && objs[p]['org.bluez.Adapter1']) { btAdapter = p; break; }
                }
                return btAdapter;
            }).catch(() => null);
    }
    // Ask the adapter to look for nearby devices. Without this BlueZ only
    // reports already-known (paired) devices, so the panel looked empty.
    function startBtDiscovery() {
        findBtAdapter().then((p) => {
            if (p) return dbusCall(Gio.DBus.system, 'org.bluez', p, 'org.bluez.Adapter1', 'StartDiscovery');
        }).catch(() => {});
    }
    function stopBtDiscovery() {
        if (btAdapter)
            dbusCall(Gio.DBus.system, 'org.bluez', btAdapter, 'org.bluez.Adapter1', 'StopDiscovery').catch(() => {});
    }

    // The detail sheet is built as a CHILD of the main panel (`.mac-cc`), exactly
    // like the tiles. That nesting matters: Liquid Glass paints one frosted glass
    // region per element carrying the `quick-toggle` class, and it is happy with
    // pods nested inside the panel — the tiles themselves are pods there — but a
    // pod added as a DIRECT child of `menu.box` breaks its per-frame layout pass
    // (`set_child_below_sibling` assertions spam forever and all the glass dies).
    // We also build it before the menu is ever opened so it exists from the start.
    function buildRoot() {
        if (detailRoot) return detailRoot;
        const host = ext._panel;
        if (!host) return null;
        detailRoot = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL, style_class: 'mac-cc-detail',
            visible: false, opacity: 0, x_expand: true,
        });
        // Tag as a Liquid Glass pod, same as the tiles (see asGlassToggle).
        try { h.asGlassToggle && h.asGlassToggle(detailRoot); } catch (e) {}
        host.add_child(detailRoot);
        detailCont = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        detailRoot.add_child(detailCont);
        refreshMainKids();
        return detailRoot;
    }
    /* The list of the panel's children cannot be cached: the editor replaces the
     * old rows with the free grid, so the cached copy hid eight detached rows
     * while the grid (and every pod in it) stayed visible on top of the sheet.
     * That is why the Wi-Fi/Bluetooth panels seemed not to open at all. It is
     * read again at every show/hide, where it is actually used. */
    function refreshMainKids() {
        const host = ext._panel;
        mainKids = host
            ? host.get_children().filter((c) => c !== detailRoot)
            : null;
        return mainKids;
    }
    function ensureRoot() { return detailRoot || buildRoot(); }

    // COEXISTENCE GUARD with the Liquid Glass extension. Its glass is drawn by a
    // private host actor (a LayoutOpaqueActor named 'liquid-glass-toggle-host')
    // that it keeps pinned inside `menu.box`. Our extension empties that box on
    // enable to hide the stock Quick Settings, and if it manages to remove this
    // host too, Liquid Glass then spams `set_child_below_sibling` assertion
    // failures every frame and ALL the glass disappears. extension.js now skips
    // that host (permanent fix), but extension.js is cached by the shell and only
    // reloads on login, so here — in the hot-reloadable module — we put it back
    // if we find it sitting in `ext._removed`. Detecting it by its GType name
    // avoids relying on the actor name, which St-18 does not expose as `.name`.
    function restoreGlassHost() {
        try {
            const box = ext._qs && ext._qs.menu && ext._qs.menu.box;
            const rem = ext._removed;
            if (!box || !Array.isArray(rem))
                return;
            for (let k = 0; k < rem.length; k++) {
                const child = rem[k] && rem[k][0];
                if (!child)
                    continue;
                let cn = '';
                try { cn = (child.constructor && child.constructor.name) || ''; } catch (e) {}
                let nm = '';
                try { nm = (child.get_name && child.get_name()) || ''; } catch (e) {}
                if (cn === 'LayoutOpaqueActor' || nm === 'liquid-glass-toggle-host') {
                    try { box.add_child(child); } catch (e) { try { box.insert_child_at_index(child, 0); } catch (e2) {} }
                    rem.splice(k, 1);
                    warn('coexistence guard: put the Liquid Glass host back into menu.box');
                    return;
                }
            }
        } catch (e) { warn('restoreGlassHost: ' + e); }
    }

    // Build it right after the extension finishes enabling (idle), while the
    // menu is still closed.
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        try { buildRoot(); } catch (e) { fail(e, 'buildRoot'); }
        restoreGlassHost();
        return GLib.SOURCE_REMOVE;
    });

    

    function clear() {
        while (detailCont && detailCont.get_n_children() > 0) {
            const c = detailCont.get_last_child();
            if (!c) break;
            detailCont.remove_child(c);
            try { c.destroy(); } catch (e) {}
        }
    }

    function sep() { return new St.Widget({style_class: 'mac-panel-sep', height: 1, x_expand: true}); }
    function section(t) { return new St.Label({text: String(t), style_class: 'mac-panel-section', x_expand: true}); }

    function backRow() {
        const b = new St.Button({style_class: 'mac-panel-back mac-panel-item', x_expand: true,
            child: mkRow('go-previous-symbolic', tr('back', 'Back'))});
        b.connect('clicked', () => back());
        return b;
    }
    function headerRow(title, sw) {
        const r = new St.BoxLayout({style_class: 'mac-panel-header', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const lab = new St.Label({text: String(title), style_class: 'mac-panel-title', x_expand: true});
        try { lab.clutter_text.ellipsize = Pango.EllipsizeMode.END; } catch (e) {}
        r.add_child(lab);
        if (sw) r.add_child(sw);
        return r;
    }

    function settingsRow(cmd, label, chipClass) {
        const b = new St.Button({style_class: 'mac-panel-item', x_expand: true,
            child: mkRow('emblem-system-symbolic', label, null, chipClass || 'mac-chip-gray')});
        b.connect('clicked', () => { launch(cmd); try { ext._qs.menu.close(); } catch (e) {} });
        return b;
    }

    function infoRow(text) {
        const l = new St.Label({text: String(text), style_class: 'mac-panel-info', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        try { l.clutter_text.ellipsize = Pango.EllipsizeMode.END; l.clutter_text.set_alignment(Pango.Alignment.CENTER, 0.5); } catch (e) {}
        return l;
    }

    // A non-clickable row: leading chip icon, label, and a switch on the right.
    function switchRow(iconName, chipClass, label, sw, glyph) {
        return mkRow(iconName, label, sw, chipClass, glyph);
    }

    function skeletonWifi() {
        let quiet = true;
        const list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, name: 'wifi-list'});
        const refreshList = () => {
            if (currentKind !== 'wifi' || !detailRoot || !detailRoot.visible) return;
            populateWifi(list, gen, false).catch(() => {});
        };
        const sw = mkSwitch(true, (on) => {
            if (quiet) return;
            dbusCall(Gio.DBus.system, 'org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager',
                'org.freedesktop.DBus.Properties', 'Set',
                new GLib.Variant('(ssv)', ['org.freedesktop.NetworkManager', 'WirelessEnabled',
                    new GLib.Variant('b', on)]))
                .then(() => { refreshList(); syncMainTiles(); })
                .catch(e => warn(`WirelessEnabled set failed: ${e}`));
        });
        // Mirror the real radio state (the switch starts ON only until this lands;
        // the quiet flag keeps that first sync from firing a Set back at NM).
        propGet(Gio.DBus.system, 'org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager',
            'org.freedesktop.NetworkManager', 'WirelessEnabled')
            .then((on) => { sw.checked = !!on; }).catch(() => {}).then(() => { quiet = false; });
        detailCont.add_child(backRow());
        detailCont.add_child(headerRow('Wi-Fi', sw));
        detailCont.add_child(section(tr('networks', 'Networks')));
        detailCont.add_child(scrollList(list));
        detailCont.add_child(sep());
        detailCont.add_child(settingsRow('gnome-control-center wifi', 'Wi-Fi Settings…', 'mac-chip-blue'));
        return list;
    }

    function skeletonBluetooth() {
        // BlueZ lives on the SYSTEM bus (not the session bus) and its state is
        // a property of the Adapter1 object, so resolve the adapter path first.
        let quiet = true;
        const list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, name: 'bt-list'});
        const refreshList = () => {
            if (currentKind !== 'bluetooth' || !detailRoot || !detailRoot.visible) return;
            populateBluetooth(list, gen, false).catch(() => {});
        };
        const sw = mkSwitch(true, (on) => {
            if (quiet) return;
            findBtAdapter().then((p) => {
                if (!p) return null;
                return dbusCall(Gio.DBus.system, 'org.bluez', p, 'org.freedesktop.DBus.Properties', 'Set',
                    new GLib.Variant('(ssv)', ['org.bluez.Adapter1', 'Powered', new GLib.Variant('b', on)]));
            }).then(() => {
                // Re-arm the scan and re-read, otherwise the list keeps showing
                // the pre-toggle (or empty) state. Also refresh the main tiles so
                // the Bluetooth pill stops claiming the old state.
                syncMainTiles();
                if (on) {
                    startBtDiscovery();
                    [1500, 3500, 7000].forEach(t =>
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, t, () => { refreshList(); return GLib.SOURCE_REMOVE; }));
                } else {
                    stopBtDiscovery();
                    refreshList();
                }
            }).catch(e => warn(`BlueZ Powered set failed: ${e && (e.message || e)}`));
        });
        findBtAdapter().then((p) => {
            if (!p) return null;
            return propGet(Gio.DBus.system, 'org.bluez', p, 'org.bluez.Adapter1', 'Powered');
        }).then((on) => {
            if (on !== null && on !== undefined) sw.checked = !!on;
        }).catch(() => {}).then(() => { quiet = false; });
        detailCont.add_child(backRow());
        detailCont.add_child(headerRow('Bluetooth', sw));
        detailCont.add_child(section(tr('devices', 'Devices')));
        detailCont.add_child(scrollList(list));
        detailCont.add_child(sep());
        detailCont.add_child(settingsRow('gnome-control-center bluetooth', 'Bluetooth Settings…', 'mac-chip-blue'));
        return list;
    }

    function skeletonSimple(title, extra) {
        detailCont.add_child(backRow());
        detailCont.add_child(sep());
        detailCont.add_child(headerRow(title, null));
        detailCont.add_child(sep());
        if (extra) extra();
    }

    async function populateWifi(list, myGen, animate) {
        const NM = 'org.freedesktop.NetworkManager';
        try {
            const devs = await dbusCall(Gio.DBus.system, NM, '/org/freedesktop/NetworkManager', NM, 'GetDevices');
            const paths = devs?.deepUnpack()[0] || [];
            let wifiDev = null;
            for (const p of paths) {
                try {
                    const d = (await dbusCall(Gio.DBus.system, NM, p, 'org.freedesktop.DBus.Properties', 'GetAll',
                        new GLib.Variant('(s)', ['org.freedesktop.NetworkManager.Device'])))?.deepUnpack()[0] || {};
                    if (pget(d, 'DeviceType') === 2) { wifiDev = p; break; }
                } catch (e) {}
            }
            if (gen !== myGen) return;
            if (!wifiDev) { clearChildren(list); list.add_child(infoRow(tr('noWifiDev', 'No Wi-Fi device found.'))); return; }
            const w = (await dbusCall(Gio.DBus.system, NM, wifiDev, 'org.freedesktop.DBus.Properties', 'GetAll',
                new GLib.Variant('(s)', ['org.freedesktop.NetworkManager.Device.Wireless'])))?.deepUnpack()[0] || {};
            const aps = pget(w, 'AccessPoints', []) || [];
            const active = pget(w, 'ActiveAccessPoint', '/');
            const rows = [];
            for (const ap of aps) {
                try {
                    const a = (await dbusCall(Gio.DBus.system, NM, ap, 'org.freedesktop.DBus.Properties', 'GetAll',
                        new GLib.Variant('(s)', ['org.freedesktop.NetworkManager.AccessPoint'])))?.deepUnpack()[0] || {};
                    rows.push({path: ap, ssid: decodeSs(pget(a, 'Ssid', '')) || '?', strength: pget(a, 'Strength', 0)});
                } catch (e) {}
            }
            rows.sort((x, y) => (y.strength - x.strength) || x.ssid.localeCompare(y.ssid));
            if (gen !== myGen) return;
            if (!rows.length) { clearChildren(list); list.add_child(infoRow(tr('noNetworks', 'No networks found.'))); return; }
            // Clear right before repopulating (synchronously) so a refresh never
            // leaves the list momentarily empty/flickering.
            clearChildren(list);
            let ri = 0;   // position in the list, for the arrival stagger
            for (const r of rows) {
                const isActive = r.path === active;
                const sigIcon = r.strength > 70 ? 'network-wireless-signal-good-symbolic'
                    : r.strength > 40 ? 'network-wireless-signal-medium-symbolic'
                    : 'network-wireless-signal-weak-symbolic';
                const row = mkRow(sigIcon, r.ssid, isActive ? tr('connected', 'Connected') : null, 'mac-chip-blue');
                const b = new St.Button({style_class: 'mac-panel-item', x_expand: true, child: row});
                b.connect('clicked', () => {
                    dbusCall(Gio.DBus.system, NM, '/org/freedesktop/NetworkManager', NM, 'ActivateConnection',
                        new GLib.Variant('(ooo)', ['/', wifiDev, r.path]))
                        .then(syncMainTiles)
                        .catch(e => warn(`Wi-Fi activation failed: ${e && (e.message || e)}`));
                    back();
                });
                addRowStaggered(list, b, ri++, myGen, animate);
            }
        } catch (e) {
            if (gen !== myGen) return;
            warn(`populate Wi-Fi failed (NetworkManager absent?): ${e && (e.message || e)}`);
            clearChildren(list);
            list.add_child(infoRow(tr('noNM', 'NetworkManager not available.')));
        }
    }

    async function populateBluetooth(list, myGen, animate) {
        try {
            const res = await dbusCall(Gio.DBus.system, 'org.bluez', '/', 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects');
            const objs = res?.deepUnpack()[0] || {};
            if (gen !== myGen) return;
            const devices = [];
            for (const path of Object.keys(objs)) {
                const d = objs[path];
                if (d && d['org.bluez.Device1']) {
                    const p = d['org.bluez.Device1'];
                    devices.push({
                        path,
                        name: pget(p, 'Alias', null) || pget(p, 'Name', null) || path.split('/').pop(),
                        connected: !!pget(p, 'Connected', false),
                        paired: !!pget(p, 'Paired', false),
                        icon: pget(p, 'Icon', 'bluetooth-symbolic'),
                    });
                }
            }
            // Paired/connected devices first, then the rest by name.
            devices.sort((x, y) => (y.connected - x.connected) || (y.paired - x.paired) || x.name.localeCompare(y.name));
            if (gen !== myGen) return;
            if (!devices.length) { clearChildren(list); list.add_child(infoRow(tr('noBt', 'No Bluetooth devices.'))); return; }
            // Clear right before repopulating (synchronously) to avoid a flash of
            // an empty list while a refresh is in flight.
            clearChildren(list);
            let ri = 0;   // position in the list, for the arrival stagger
            for (const dev of devices) {
                const right = new St.Label({
                    text: dev.connected ? tr('connected', 'Connected') : (dev.paired ? tr('paired', 'Paired') : ''),
                    style_class: 'mac-panel-sub',
                });
                const row = mkRow(dev.icon, dev.name, right, 'mac-chip-blue');
                const b = new St.Button({style_class: 'mac-panel-item', x_expand: true, child: row});
                b.connect('clicked', () => {
                    dbusCall(Gio.DBus.system, 'org.bluez', dev.path, 'org.bluez.Device1',
                        dev.connected ? 'Disconnect' : 'Connect', null)
                        .then(() => {
                            syncMainTiles();
                            // Reflect the new "Connected/Paired" state in the list.
                            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                                if (gen === myGen) populateBluetooth(list, myGen, false).catch(() => {});
                                return GLib.SOURCE_REMOVE;
                            });
                        })
                        .catch(e => warn(`Bluetooth ${dev.connected ? 'disconnect' : 'connect'} failed: ${e && (e.message || e)}`));
                });
                addRowStaggered(list, b, ri++, myGen, animate);
            }
        } catch (e) {
            if (gen !== myGen) return;
            warn(`populate Bluetooth failed (BlueZ absent?): ${e && (e.message || e)}`);
            clearChildren(list);
            list.add_child(infoRow(tr('noBlueZ', 'BlueZ not available.')));
        }
    }

    function clearChildren(box) {
        if (!box) return;
        while (box.get_n_children() > 0) {
            const c = box.get_last_child();
            if (!c) break;
            box.remove_child(c);
            try { c.destroy(); } catch (e) {}
        }
    }

    // Wi-Fi can list a dozen networks and Bluetooth a house full of devices. The
    // list used to be built entire at the end of the reveal, which made the sheet
    // jump ~250px in a single frame and every row appear at once — "it snaps open
    // and the whole list is just there". Rows now arrive one after another and
    // fade in, so the sheet grows with them and the list reads as filling in.
    // Refresh passes animate=false: re-staggering the list every few seconds while
    // the adapter rescans would only make it blink.
    const ROW_STEP = 35;      // ms between one row and the next
    const ROW_MAX_WAIT = 420; // cap, so a very long list does not crawl for seconds
    function addRowStaggered(list, row, i, myGen, animate) {
        const put = () => {
            if (gen !== myGen) return;
            try {
                if (animate) {
                    row.opacity = 0;
                    row.translation_y = 6;
                }
                list.add_child(row);
                if (animate)
                    row.ease({opacity: 255, translation_y: 0, duration: 200, mode: EASE});
            } catch (e) { warn(`row add failed: ${e && (e.message || e)}`); }
        };
        if (!animate) { put(); return; }
        const d = Math.min(i * ROW_STEP, ROW_MAX_WAIT);
        if (d <= 0) { put(); return; }
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, d, () => { put(); return GLib.SOURCE_REMOVE; });
    }

    // Wi-Fi can find a dozen networks and Bluetooth a house full of devices: put
    // the rows in a scroll view capped at a sensible height so the sheet keeps a
    // normal size and the extra entries scroll, exactly like macOS does.
    function scrollList(list) {
        return new St.ScrollView({
            style_class: 'mac-panel-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            child: list,
        });
    }

    /* Where the detail sheet grows from and how big it starts. The sheet keeps
     * the centre of the pill that opened it as its pivot, and begins at the
     * pill's own scale (anchor size / sheet size) so it appears to pour out of
     * that icon and stretch into the full panel — the macOS reveal — instead of
     * scaling up in place from its middle. */
    function anchorTransform() {
        let px = 0.5, py = 0.0, sx = 0.9, sy = 0.85;
        try {
            const a = anchor;
            if (!a || !detailRoot)
                return {px, py, sx, sy};
            const [ax, ay] = a.get_transformed_position();
            const [aw, ah] = a.get_transformed_size();
            let [rx, ry] = detailRoot.get_transformed_position();
            let [rw, rh] = detailRoot.get_transformed_size();
            if (!(rw > 0) || !(rh > 0)) {
                // First open: the sheet has no allocation of its own yet, so
                // derive its box from the host panel minus the panel padding
                // (the sheet is the panel's only visible child).
                const host = ext._panel;
                if (host) {
                    const [hx, hy] = host.get_transformed_position();
                    const [hw, hh] = host.get_transformed_size();
                    let padL = 22, padT = 22;
                    try {
                        const tn = host.get_theme_node();
                        if (tn) { padL = tn.get_padding(St.Side.LEFT); padT = tn.get_padding(St.Side.TOP); }
                    } catch (e) {}
                    rx = hx + padL; ry = hy + padT;
                    rw = hw - padL * 2; rh = hh - padT * 2;
                }
            }
            if (rw > 0 && rh > 0) {
                px = Math.max(0, Math.min(1, (ax + aw / 2 - rx) / rw));
                py = Math.max(0, Math.min(1, (ay + ah / 2 - ry) / rh));
                sx = Math.max(0.10, Math.min(1, aw / rw));
                sy = Math.max(0.10, Math.min(1, ah / rh));
            }
        } catch (e) {}
        return {px, py, sx, sy};
    }

    function swapIn(onDone) {
        if (!detailRoot) {
            try { onDone && onDone(); } catch (e) {}
            return;
        }
        // Hide the main tiles but keep `.mac-cc` itself visible: the detail
        // sheet is one of its children now (a sibling of the tiles), so it is
        // treated by Liquid Glass exactly like them.
        for (const k of (refreshMainKids() || [])) { try { k.hide(); } catch (e) {} }
        detailRoot.visible = true;
        detailRoot.opacity = 0;
        const t = anchorTransform();
        detailRoot.set_pivot_point(t.px, t.py);
        detailRoot.scale_x = t.sx;
        detailRoot.scale_y = t.sy;
        // Grow out of the pill. The ease stays monotonic (no overshoot past 1.0):
        // Liquid Glass rebuilds the pod's blur region every time its size changes,
        // so an overshoot would make it grow, shrink and rebuild again — and that
        // stutter is what made the reveal feel choppy.
        //
        // A pod's own opacity does not touch its Liquid Glass (only its content),
        // so the fade here is the *text* arriving. It starts almost immediately
        // and runs for most of the (now slower) stretch, so the text comes in
        // together with the glass instead of popping in once the sheet is already
        // open: the opening reads as one long, calm motion.
        //
        // onDone is still called when the reveal ends, for anything that must wait
        // for it; the row lists no longer use it — they start earlier and trickle
        // in (see addRowStaggered) so the sheet fills while it is still growing.
        detailRoot.ease({opacity: 255, delay: 60, duration: 280, mode: EASE});
        detailRoot.ease({
            scale_x: 1,
            scale_y: 1,
            duration: 340,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => { try { onDone && onDone(); } catch (e) {} },
        });
    }

    function resetMainInstant() {
        if (detailRoot) {
            try {
                detailRoot.hide();
                detailRoot.opacity = 0;
                detailRoot.scale_x = 1; detailRoot.scale_y = 1;
            } catch (e) {}
        }
        for (const k of (refreshMainKids() || [])) { try { k.show(); } catch (e) {} }
    }

    function open(kind, a) {
        try {
            if (closing) return true;
            if (a) anchor = a;
            if (currentKind === kind && detailRoot && detailRoot.visible) { back(); return true; }
            gen++;
            const myGen = gen;
            if (!ensureRoot()) { resetMainInstant(); return false; }
            clear();
            // Lift the tile glass BEFORE the sheet starts to grow: with the
            // stripes mid-flight the pod pieces snap off during the motion
            // (that read as a different animation). Up front, the change of
            // scenery is one whole and the reveal motion stays the one motion.
            togGLassen(false);
            if (kind !== 'bluetooth') stopBtDiscovery();
            currentKind = kind;

            let list = null;
            if (kind === 'wifi') list = skeletonWifi();
            else if (kind === 'bluetooth') list = skeletonBluetooth();
            else if (kind === 'sound') skeletonSimple(tr('sound', 'Sound'), () => {
                detailCont.add_child(section(tr('output', 'Output Devices')));
                // The speaker waves ripple when the output is toggled.
                const spk = makeGlyph('speaker', 16, h, 'mac-panel-icon');
                spk.set(true, false);
                spk.pulse();
                const out = mkSwitch(true, (on) => {
                    spk.set(on, true);
                    if (on) {
                        spk.pulse();
                        if (tiles.speaker) tiles.speaker.pulse();
                    }
                });
                detailCont.add_child(switchRow('audio-volume-high-symbolic', 'mac-chip-purple', tr('output', 'Output'), out, spk));
                detailCont.add_child(sep());
                detailCont.add_child(settingsRow('gnome-control-center sound', 'Sound Settings…', 'mac-chip-purple'));
            });
            else if (kind === 'display') skeletonSimple(tr('display', 'Display'), () => {
                const nightOn = !!(ext._colorSettings && ext._colorSettings.get_boolean('night-light-enabled'));
                // The sun sets (and the moon rises) when night light is enabled.
                const sun = makeGlyph('sun', 16, h, 'mac-panel-icon');
                sun.set(nightOn, false);
                const night = mkSwitch(nightOn, (on) => {
                    try { ext._colorSettings && ext._colorSettings.set_boolean('night-light-enabled', on); } catch (e) {}
                    sun.set(on, true);
                    syncTile('sun', true, on);
                    syncMainTiles();
                });
                detailCont.add_child(switchRow('weather-clear-night-symbolic', 'mac-chip-orange', tr('night', 'Night Shift'), night, sun));
                detailCont.add_child(sep());
                detailCont.add_child(settingsRow('gnome-control-center display', 'Display Settings…', 'mac-chip-orange'));
            });
            else if (kind === 'focus') skeletonSimple(tr('dnd', 'Focus'), () => {
                const dndOn = !!(ext._notifSettings && !ext._notifSettings.get_boolean('show-banners'));
                // The moon tips over when Do Not Disturb is switched on.
                const moong = makeGlyph('moon', 16, h, 'mac-panel-icon');
                moong.set(dndOn, false);
                const sw = mkSwitch(dndOn, (on) => {
                    try { ext._notifSettings && ext._notifSettings.set_boolean('show-banners', !on); } catch (e) {}
                    moong.set(on, true);
                    syncTile('moon', true, on);
                    syncMainTiles();
                });
                detailCont.add_child(switchRow('notifications-disabled-symbolic', 'mac-chip-purple', tr('dndShort', 'Do Not Disturb'), sw, moong));
                detailCont.add_child(sep());
                detailCont.add_child(settingsRow('gnome-control-center notifications', 'Notifications Settings…', 'mac-chip-purple'));
            });
            else { resetMainInstant(); return false; }

            // Kick the data off a beat *after* the stretch starts, instead of when
            // it ends. The old reason to wait — the list was built in one blocking
            // batch that froze the reveal — is gone now that rows trickle in one at
            // a time (addRowStaggered), so the sheet can grow and fill in the same
            // motion. Bluetooth starts scanning right away so devices keep coming.
            if (kind === 'bluetooth') startBtDiscovery();
            swapIn(null);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 140, () => {
                if (gen !== myGen) return GLib.SOURCE_REMOVE;
                if (kind === 'wifi') {
                    populateWifi(list, myGen, true).catch(e => fail(e, 'wifi'));
                } else if (kind === 'bluetooth') {
                    populateBluetooth(list, myGen, true).catch(e => fail(e, 'bluetooth'));
                    // Devices trickle in while the adapter scans, so re-read the
                    // list a few times instead of waiting a single long beat —
                    // otherwise the panel sat on "No Bluetooth devices".
                    for (const t of [1500, 3000, 6000, 10000]) {
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, t, () => {
                            if (gen === myGen && currentKind === 'bluetooth' && detailRoot && detailRoot.visible)
                                populateBluetooth(list, myGen, false).catch(() => {});
                            return GLib.SOURCE_REMOVE;
                        });
                    }
                }
                return GLib.SOURCE_REMOVE;
            });
            return true;
        } catch (e) {
            fail(e, 'open ' + kind);
            try { resetMainInstant(); } catch (e2) {}
            return false;
        }
    }

    function back() {
        gen++;
        currentKind = null;
        stopBtDiscovery();
        if (!detailRoot) {
            anchor = null;
            return;
        }

        const t = anchorTransform();
        detailRoot.remove_all_transitions();
        detailRoot.set_pivot_point(t.px, t.py);

        // The tiles must stay hidden while the sheet contracts back into the
        // pill. They sit *behind* the glass, so revealing them early made the
        // whole tile grid show through the shrinking pod — the "you can see it
        // underneath" the user complained about.
        //
        // Mirror of the reveal: the sheet's content goes first (opacity does not
        // touch the glass), so what contracts is the bare glass, and only then do
        // the tiles come back, growing out of their own centre — the panel
        // shrinking into the pill rather than a panel vanishing and a grid
        // blinking back.
        detailRoot.ease({opacity: 0, duration: 90, mode: EASE});
        detailRoot.ease({
            scale_x: t.sx,
            scale_y: t.sy,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_IN_OUT_CUBIC,
            onComplete: () => {
                try {
                    detailRoot.hide();
                    detailRoot.remove_all_transitions();
                    detailRoot.scale_x = 1;
                    detailRoot.scale_y = 1;
                    detailRoot.opacity = 255;
                } catch (e) {}
                anchor = null;
                // The sheet has fully contracted: the tile glass comes back
                // in step with the tiles growing out of their own centre,
                // not 120 ms later mid-fade like the ticker fallback did.
                togGLassen(true);
                for (const k of (refreshMainKids() || [])) {
                    try {
                        k.remove_all_transitions();
                        k.show();
                        k.set_pivot_point(0.5, 0.5);
                        k.opacity = 0;
                        k.scale_x = 0.96;
                        k.scale_y = 0.96;
                        k.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: 150, mode: EASE});
                    } catch (e) {}
                }
            },
        });
    }

    function close() {
        closing = true;
        gen++;
        currentKind = null;
        stopBtDiscovery();
        if (detailRoot) { try { detailRoot.hide(); detailRoot.opacity = 0; detailRoot.scale_x = 1; detailRoot.scale_y = 1; } catch (e) {} }
        togGLassen(true);
        for (const k of (refreshMainKids() || [])) { try { k.show(); } catch (e) {} }
        try { anchor = null; } catch (e) {}
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => { closing = false; return GLib.SOURCE_REMOVE; });
    }

    function destroy() {
        gen++;
        stopTilePoll();
        if (schemeId && iface) {
            try { iface.disconnect(schemeId); } catch (e) {}
            schemeId = 0;
        }
        if (themeId && iface) {
            try { iface.disconnect(themeId); } catch (e) {}
            themeId = 0;
        }
        try { accentMon?.cancel(); } catch (e) {}
        accentMon = null;
        if (menuId) {
            try { ext._qs.menu.disconnect(menuId); } catch (e) {}
            menuId = 0;
        }
        for (const k of Object.keys(tiles))
            delete tiles[k];
        for (const k of Object.keys(tileState))
            delete tileState[k];
        try { detailRoot && detailRoot.destroy(); } catch (e) {}
        detailRoot = null; detailCont = null; mainKids = null;
    }

    /* ---------- reactivate sliders without any relogin ----------
     * The gliding bars live in extension.js, and the shell caches that module:
     * only pannelli.js reloads on disable/enable. When the running
     * extension.js still lacks the built-in glide (no `_hasGlide` marker, so
     * no logout happened yet), this module takes the system-driven jumps over
     * by itself: a jump pulls the bar back and then glides to the new value.
     * Once extension.js is fresh it carries the marker, and the hook stays
     * off so the two never fight over the same bar. */
    function attaccaGlide(slider) {
        if (!slider || slider._glideHook)
            return;
        slider._glideHook = true;
        let last = Number.isFinite(slider.value) ? slider.value : 0;
        let dragging = false, gid = 0, mine = false;
        slider.connect('drag-begin', () => {
            dragging = true;
            if (gid) { GLib.source_remove(gid); gid = 0; }
        });
        slider.connect('drag-end', () => { dragging = false; });
        slider.connect('notify::value', () => {
            const v = slider.value;
            if (mine) { last = v; return; }
            if (dragging) { last = v; return; }
            if (Math.abs(v - last) < 0.015) { last = v; return; }
            // A jump the user did not make: pull back, then glide there.
            const from = last, to = Math.max(0, Math.min(1, v));
            mine = true;
            slider.value = Math.max(0, Math.min(1, from));
            mine = false;
            if (gid) GLib.source_remove(gid);
            const t0 = GLib.get_monotonic_time() / 1000, DUR = 200;
            gid = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
                gid = 0;
                if (dragging)
                    return GLib.SOURCE_REMOVE;
                const p = Math.min((GLib.get_monotonic_time() / 1000 - t0) / DUR, 1);
                const e = 1 - Math.pow(1 - p, 3);
                mine = true;
                slider.value = from + (to - from) * e;
                mine = false;
                if (p >= 1)
                    return GLib.SOURCE_REMOVE;
                return GLib.SOURCE_CONTINUE;
            });
        });
    }
    function installaGlide() {
        if (ext._hasGlide)
            return;
        let tries = 0;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            let trovati = 0;
            for (const s of [ext._display?.slider, ext._sound?.slider])
                if (s) { trovati++; attaccaGlide(s); }
            // The sliders are built synchronously, so two passes are plenty;
            // keep polling a while for slow machines, then give up quietly.
            return (trovati >= 2 || ++tries > 25) ? GLib.SOURCE_REMOVE : GLib.SOURCE_CONTINUE;
        });
    }

    /* ---------- pod tags follow the sheet ----------
     * The sheet lives inside the menu, where the tiles sit: while it is
     * visible, Liquid Glass keeps treating the tagged pods as its glass
     * regions and paints a dark refraction cap right over the sheet's rows,
     * so every symbol inside looks like it carries a black gradient. While a
     * sheet shows, the `.quick-toggle` tag is lifted from the pods (the clean
     * sheet look stays, LG's own pod glass waits), and the tag is restored
     * when back on the tile grid so the glass returns there. A ticker re-applies
     * whatever state is current, so reopen/refresh paths self-heal. */
    let glassTagged = null;
    /* The AO penumbra (the inner ~7.5px dark band) reads as a second border
     * on every pod: the widget's own CSS border outside, the AO ring inside.
     * LG's own fix pins `ao_intensity` at glass creation, but the cached
     * manager only rebuilds at logout — so the same pin is installed LIVE on
     * every toggles glass found in the CC menu and the notification drawer
     * (its manager shares the class, so one lookup covers both). The rest of
     * the suite keeps the AO from the prefs; the ticker self-heals new glass. */
    let _pinati = new WeakSet();
    let _pinCount = 0;
    /* Keep only the AO pin live: LG's AO penumbra reads as a second border
     * on CC/NC toggles; forcing ao_intensity to 0 removes it without
     * touching region size/radius so the glass stays exactly as before. */
    /* Tiny outward expansion so the glass reaches the widget's CSS border
     * without spilling over it (half-millimetre scale). */
    const GLASS_GROW = 0;
    /* The NC drawer's pieces are small: the edge light of the shader is what
     * gives each of them its shape there, so it is raised a little on that
     * glass only. Every glass owns its own uniforms, so the desktop widgets,
     * the dock, the OSD and the top bar keep exactly the glass they have.
     * `rim_directional_power` keeps that light on the lit (top) edge instead of
     * turning it into a ring all the way round; the bottom gets only what is
     * left. Shipped values: rim 0.55, light colour 0.55, directional 0.0. */
    const NC_RIM = {
        rim_intensity: 0.70,
        rim_light_color_intensity: 0.68,
        rim_directional_power: 1.20,
    };

    function pinnaAO() {
        /* LG's state object owns both toggles managers (the CC menu and the
         * NC drawer share the class), and each manager owns its glass
         * directly — no actor hunting needed. */
        const lg = Main.extensionManager?.lookup?.(LG_UUID)?.stateObj ?? null;
        for (const mgr of [lg?._quickSettingsManager ?? null, lg?._notificationCenterGlass ?? null]) {
            const glass = mgr?.glass ?? null;
            if (!glass || _pinati.has(glass))
                continue;
            const uniforms = glass._renderer?.uniforms;
            if (!uniforms?.set)
                continue;
            try {
                const isNC = mgr === (lg?._notificationCenterGlass ?? null);
                const setUniform = uniforms.set.bind(uniforms);
                uniforms.set = (k, v) => setUniform(k, k === 'ao_intensity' ? 0.0
                    : (isNC && k in NC_RIM) ? NC_RIM[k] : v);
                uniforms.set('ao_intensity', 0.0);
                if (isNC)
                    for (const [k, v] of Object.entries(NC_RIM))
                        uniforms.set(k, v);
                const origRegions = glass.setGlassRegions.bind(glass);
                glass.setGlassRegions = (rs) => origRegions((rs ?? []).map((r) => ({
                    ...r,
                    x: r.x - GLASS_GROW,
                    y: r.y - GLASS_GROW,
                    w: r.w + GLASS_GROW * 2,
                    h: r.h + GLASS_GROW * 2,
                })));
                _pinati.add(glass);
                _pinCount++;
            } catch (e) {}
        }
    }
    function togGLassen(on) {
        try {
            if (on) {
                if (glassTagged)
                    for (const w of glassTagged) {
                        try { if (!w.is_destroyed && !w.has_style_class_name('quick-toggle')) w.add_style_class_name('quick-toggle'); } catch (e) {}
                    }
                glassTagged = null;
                return;
            }
            if (glassTagged)
                return;
            glassTagged = [];
            const walk = (a) => {
                // The sheet keeps its own pod tag: it is what paints the
                // frosted-glass look of the open panel. Only the tiles lift.
                if (a === detailRoot)
                    return;
                if (a instanceof St.Widget && a.has_style_class_name('quick-toggle')) {
                    a.remove_style_class_name('quick-toggle');
                    glassTagged.push(a);
                }
                for (const ch of a.get_children())
                    walk(ch);
            };
            if (ext._panel)
                walk(ext._panel);
        } catch (e) { fail(e, 'togGLassen'); }
    }
    let vetroTick = 0;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
        try {
            // Be patient: _panel exists a moment after crea(); give up only
            // once the instance this ticker belongs to is gone for sure.
            if (ext._panel) {
                const gone = typeof ext._panel.is_destroyed === 'function'
                    ? ext._panel.is_destroyed()
                    : ext._panel.is_destroyed === true;
                if (gone)
                    return GLib.SOURCE_REMOVE;
            } else if (++vetroTick > 60) {
                return GLib.SOURCE_REMOVE;
            }
            pinnaAO();
            const sheetUp = !!(detailRoot?.visible && detailRoot?.mapped);
            togGLassen(!sheetUp);
        } catch (e) { fail(e, 'vetro ticker'); }
        return GLib.SOURCE_CONTINUE;
    });

    // The tiles are built by extension.js right after crea() returns, so
    // decorate them once the panel exists (this idle callback runs when
    // enable() has finished).
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        stampTheme();
        decorateTiles();
        installaGlide();
        return GLib.SOURCE_REMOVE;
    });

    const api = {open, close, destroy, back};
    // `anchor` is a private closure variable. The shell caches extension.js, so
    // an older build can still be running until the next login; that build sets
    // the anchor through `ext._pan._anchor = <tile>` and then calls open(). Expose
    // a property for it so that path works alongside the newer explicit argument.
    Object.defineProperty(api, '_anchor', {
        get() { return anchor; },
        set(v) { anchor = v; },
        configurable: true,
    });
    return api;
}
