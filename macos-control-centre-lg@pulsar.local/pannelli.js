import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

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
        warn('theme logout prompt suppressed');
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
const MOON_REST = 1.0;                   // where the moon sits, above the horizon
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

    const g = {kind, actor: box, set: () => {}, pulse: () => {}};

    if (kind === 'wifi') {
        const arcs = GLYPH_LAYERS.wifi.map(n => part(n));
        for (const a of arcs)
            a.set_pivot_point(WIFI_PIVOT[0], WIFI_PIVOT[1]);
        const OFF = 110;   // wifi off: the arcs stay, just dimmed
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

    function tr(k, fb) { try { return (h.tr && h.tr(k)) || fb; } catch (e) { return fb; } }
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

    function tileGlyph(key, tile, kind, size, cls = 'mac-icon') {
        const bub = tile && tile._bubble;
        if (!bub)
            return null;
        const g = makeGlyph(kind, size, h, cls);
        const old = bub.get_child && bub.get_child();
        try { bub.set_child(g.actor); } catch (e) { return null; }
        if (old) old.destroy();
        tiles[key] = g;
        tileState[key] = () => {
            try { return bub.has_style_pseudo_class('checked'); } catch (e) { return false; }
        };
        g.set(tileState[key](), false);
        bub.connect('clicked', () => settle(key));
        return g;
    }

    let decorated = false;
    function decorateTiles() {
        if (decorated)
            return;
        decorated = true;
        try {
            const wifiG = tileGlyph('wifi', ext._wifi, 'wifi', 23);
            tileGlyph('sun', ext._night, 'sun', 23);
            const dndG = tileGlyph('moon', ext._dnd, 'moon', 23);

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
            const dark = ext._dark;
            if (dark) {
                const g = makeGlyph('contrast', 30, h, 'mac-icon');
                const old = dark.get_child && dark.get_child();
                dark.set_child(g.actor);
                if (old) old.destroy();
                tiles.dark = g;
                tileState.dark = () => {
                    try { return dark.has_style_pseudo_class('checked'); } catch (e) { return false; }
                };
                g.set(tileState.dark(), false);
                dark.connect('clicked', () => {
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
            const row = snd && snd.get_children && snd.get_children()[1];
            if (row && snd.slider) {
                const ic = row.get_children().filter(c => c instanceof St.Icon).pop();
                if (ic) {
                    const g = makeGlyph('speaker', 18, h, 'mac-small');
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

    // A state may also change from outside (GNOME Settings, another toggle):
    // snap the icons to it when the panel opens, then settle for wifi.
    let menuId = 0;
    try {
        menuId = ext._qs.menu.connect('open-state-changed', (_m, open) => {
            if (!open)
                return;
            muteThemePrompt();
            for (const k of ['wifi', 'sun', 'moon', 'dark'])
                syncTile(k, false);
            settle('wifi');
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
        detailCont = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        detailRoot.add_child(detailCont);
        mainKids = host.get_children().filter(c => c !== detailRoot);
        warn(`detail pod built as child of _panel (${mainKids.length} main kids)`);
        return detailRoot;
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
            try {
                warn('guard: _removed = ' + rem.map(p => {
                    let cn = ''; try { cn = (p[0].constructor && p[0].constructor.name) || '?'; } catch (e) {}
                    let nm = ''; try { nm = (p[0].get_name && p[0].get_name()) || ''; } catch (e) {}
                    return `${nm}/${cn}`;
                }).join(', '));
            } catch (e) {}
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
        warn('detail shown');
        // Hide the main tiles but keep `.mac-cc` itself visible: the detail
        // sheet is one of its children now (a sibling of the tiles), so it is
        // treated by Liquid Glass exactly like them.
        if (mainKids) for (const k of mainKids) { try { k.hide(); } catch (e) {} }
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
        if (mainKids) for (const k of mainKids) { try { k.show(); } catch (e) {} }
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
                if (mainKids) for (const k of mainKids) {
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
        if (mainKids) for (const k of mainKids) { try { k.show(); } catch (e) {} }
        try { anchor = null; } catch (e) {}
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => { closing = false; return GLib.SOURCE_REMOVE; });
    }

    function destroy() {
        gen++;
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

    // The tiles are built by extension.js right after crea() returns, so
    // decorate them once the panel exists (this idle callback runs when
    // enable() has finished).
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        decorateTiles();
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
