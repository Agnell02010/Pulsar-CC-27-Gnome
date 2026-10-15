import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import Soup from 'gi://Soup?version=3.0';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

const NONE = Gio.DBusCallFlags.NONE;

// Folder with the MacOS-style icons (set in enable())
let ICON_DIR = '';
function symbol(name) {
    return Gio.icon_new_for_string(`${ICON_DIR}/${name}-symbolic.svg`);
}

// --- Laptop backlight: reads /sys and writes through logind
const BL_DIR = '/sys/class/backlight';
function findBacklight() {
    try {
        const en = Gio.File.new_for_path(BL_DIR).enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
        const names = [];
        let info;
        while ((info = en.next_file(null)))
            names.push(info.get_name());
        en.close(null);
        return names[0] ?? null;
    } catch (e) {
        return null;
    }
}
function readInt(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return parseInt(new TextDecoder().decode(bytes).trim());
    } catch (e) {
        return null;
    }
}
function setBacklight(name, value) {
    Gio.DBus.system.call('org.freedesktop.login1', '/org/freedesktop/login1/session/auto',
        'org.freedesktop.login1.Session', 'SetBrightness',
        new GLib.Variant('(ssu)', ['backlight', name, value]), null,
        Gio.DBusCallFlags.NONE, -1, null, (c, r) => {
            try {
                c.call_finish(r);
            } catch (e) {
                console.warn(`macos-cc: brightness not set: ${e}`);
            }
        });
}

function later(ms, fn) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        fn();
        return GLib.SOURCE_REMOVE;
    });
}

// If the panel still sticks out on the right, increase this value (pixels).
const SHIFT_LEFT = 34;

/* ---------- D-Bus helpers ---------- */
function propGet(bus, name, path, iface, prop, cb) {
    bus.call(name, path, 'org.freedesktop.DBus.Properties', 'Get',
        new GLib.Variant('(ss)', [iface, prop]), GLib.VariantType.new('(v)'),
        NONE, -1, null, (c, r) => {
            try {
                cb(c.call_finish(r).get_child_value(0).get_variant().unpack());
            } catch (e) {
                cb(null);
            }
        });
}

function propSet(bus, name, path, iface, prop, variant) {
    bus.call(name, path, 'org.freedesktop.DBus.Properties', 'Set',
        new GLib.Variant('(ssv)', [iface, prop, variant]), null,
        NONE, -1, null, (c, r) => {
            try {
                c.call_finish(r);
            } catch (e) {
                console.warn(`macos-cc: Set ${prop} failed: ${e}`);
            }
        });
}

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

function findPlayer(cb) {
    Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
        'org.freedesktop.DBus', 'ListNames', null, GLib.VariantType.new('(as)'),
        NONE, -1, null, (c, r) => {
            try {
                const names = c.call_finish(r).deepUnpack()[0];
                cb(names.find(n => n.startsWith(MPRIS_PREFIX)) ?? null);
            } catch (e) {
                cb(null);
            }
        });
}

/* ---------- widget builders ---------- */
function icon(name, cls = '') {
    const props = {
        style_class: `mac-icon ${cls}`,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    };
    if (name.startsWith('mc:'))
        props.gicon = symbol(name.slice(3));
    else
        props.icon_name = name;
    return new St.Icon(props);
}

/* ---- Integration with the "Liquid Glass" extension ----
 * Liquid Glass (Toggles mode) only paints the glass on the GNOME widgets that
 * carry the `.quick-toggle` class. Our tiles are our own widgets
 * (mac-tile / mac-slider-tile) which do not exist for it, so they were never
 * "glassed". Here we tag the tiles with `quick-toggle` so that it recognises
 * them and spreads the glass over each one, keeping the look identical.
 *
 * Separate switches, so you can try or revert each group on its own
 * (set to false to go back to the no-glass behaviour). */
const LIQUID_GLASS_TOGGLES = true;   // wide tiles (Wi-Fi, Bluetooth, Night Light, Do Not Disturb)
const LIQUID_GLASS_SLIDERS = true;   // tiles with the sliders (Display, Sound)
const LIQUID_GLASS_MEDIA   = true;   // media player box
const LIQUID_GLASS_CIRCLES = true;   // the 4 round buttons (Stage, Mirror, Dark Mode, Screenshot)
function asGlassToggle(widget) {
    if (LIQUID_GLASS_TOGGLES)
        widget.add_style_class_name('quick-toggle');
    return widget;
}
function asGlassSlider(widget) {
    if (LIQUID_GLASS_SLIDERS)
        widget.add_style_class_name('quick-toggle');
    return widget;
}
function asGlassMedia(widget) {
    if (LIQUID_GLASS_MEDIA)
        widget.add_style_class_name('quick-toggle');
    return widget;
}
function asGlassCircle(widget) {
    if (LIQUID_GLASS_CIRCLES)
        widget.add_style_class_name('quick-toggle');
    return widget;
}

// String with which Liquid Glass clears the background of the widgets it
// recognises. It must match EXACTLY: when a widget already carries it in its
// own style, Liquid Glass skips it entirely (it never registers it, so it can
// no longer accidentally restore an old style on it). This protects the player
// album art, which would otherwise snap back to the previous track every time
// the colours are resampled.
const LG_OVERRIDE = 'background-color: transparent !important;';

/* ---------- language of the Control Center ----------
 * The visible texts follow the language of the PC: we read the session locale
 * (LC_ALL / LC_MESSAGES / LANG, as GNOME exposes it) and pick the translation
 * from the table below. When a language - or a single key - is missing, the
 * English text is used, so something is always shown.
 * No .po/.mo files to compile: the package stays a plain "install.sh". */
const STRINGS = {
    // key:  night       dnd                 display     sound     notPlaying              on        off
    en: {night: 'Night Shift', dnd: 'Do Not Disturb', display: 'Display', sound: 'Sound',
         notPlaying: 'Not Playing', on: 'On', off: 'Off'},
    it: {night: 'Luce notturna', dnd: 'Non disturbare', display: 'Schermo', sound: 'Audio',
         notPlaying: 'Non in riproduzione', on: 'Attivo', off: 'Non attivo',
         onF: 'Attiva', offF: 'Non attiva'},          // "Luce notturna" is feminine
    fr: {night: 'Lumière nocturne', dnd: 'Ne pas déranger', display: 'Écran', sound: 'Son',
         notPlaying: 'Aucune lecture', on: 'Activé', off: 'Désactivé',
         onF: 'Activée', offF: 'Désactivée'},
    de: {night: 'Nachtlicht', dnd: 'Nicht stören', display: 'Bildschirm', sound: 'Ton',
         notPlaying: 'Keine Wiedergabe', on: 'Ein', off: 'Aus'},
    es: {night: 'Modo nocturno', dnd: 'No molestar', display: 'Pantalla', sound: 'Sonido',
         notPlaying: 'Sin reproducción', on: 'Activado', off: 'Desactivado'},
    pt: {night: 'Modo noturno', dnd: 'Não incomodar', display: 'Ecrã', sound: 'Som',
         notPlaying: 'Nada em reprodução', on: 'Ativado', off: 'Desativado'},
    'pt-br': {night: 'Modo noturno', dnd: 'Não incomodar', display: 'Tela', sound: 'Som',
         notPlaying: 'Nada em reprodução', on: 'Ativado', off: 'Desativado'},
    nl: {night: 'Nachtlicht', dnd: 'Niet storen', display: 'Scherm', sound: 'Geluid',
         notPlaying: 'Niets wordt afgespeeld', on: 'Aan', off: 'Uit'},
    pl: {night: 'Nocne światło', dnd: 'Nie przeszkadzać', display: 'Ekran', sound: 'Dźwięk',
         notPlaying: 'Nic nie jest odtwarzane', on: 'Włączone', off: 'Wyłączone'},
    ru: {night: 'Ночная подсветка', dnd: 'Не беспокоить', display: 'Экран', sound: 'Звук',
         notPlaying: 'Ничего не воспроизводится', on: 'Вкл.', off: 'Выкл.'},
    tr: {night: 'Gece ışığı', dnd: 'Rahatsız etmeyin', display: 'Ekran', sound: 'Ses',
         notPlaying: 'Çalınmıyor', on: 'Açık', off: 'Kapalı'},
    uk: {night: 'Нічне світло', dnd: 'Не турбувати', display: 'Екран', sound: 'Звук',
         notPlaying: 'Немає відтворення', on: 'Увімкнено', off: 'Вимкнено'},
    cs: {night: 'Noční osvětlení', dnd: 'Nerušit', display: 'Obrazovka', sound: 'Zvuk',
         notPlaying: 'Nic se nepřehrává', on: 'Zapnuto', off: 'Vypnuto'},
    hu: {night: 'Éjszakai fény', dnd: 'Ne zavarjanak', display: 'Képernyő', sound: 'Hang',
         notPlaying: 'Nincs lejátszás', on: 'Bekapcsolva', off: 'Kikapcsolva'},
    ro: {night: 'Lumina de noapte', dnd: 'Nu deranja', display: 'Ecran', sound: 'Sunet',
         notPlaying: 'Nicio redare', on: 'Pornit', off: 'Oprit',
         onF: 'Pornită', offF: 'Oprită'},
    el: {night: 'Νυχτερινή λειτουργία', dnd: 'Μην ενοχλείτε', display: 'Οθόνη', sound: 'Ήχος',
         notPlaying: 'Δεν αναπαράγεται', on: 'Ενεργό', off: 'Ανενεργό',
         onF: 'Ενεργή', offF: 'Ανενεργή'},
    sv: {night: 'Nattbelysning', dnd: 'Stör inte', display: 'Skärm', sound: 'Ljud',
         notPlaying: 'Spelas inte upp', on: 'På', off: 'Av'},
    da: {night: 'Nattlys', dnd: 'Forstyr ikke', display: 'Skærm', sound: 'Lyd',
         notPlaying: 'Afspilles ikke', on: 'Tændt', off: 'Slukket'},
    nb: {night: 'Nattlys', dnd: 'Ikke forstyrr', display: 'Skjerm', sound: 'Lyd',
         notPlaying: 'Spilles ikke', on: 'På', off: 'Av'},
    fi: {night: 'Yövalo', dnd: 'Älä häiritse', display: 'Näyttö', sound: 'Ääni',
         notPlaying: 'Ei toisteta', on: 'Päällä', off: 'Pois'},
    ja: {night: '夜間モード', dnd: 'おやすみモード', display: 'ディスプレイ', sound: 'サウンド',
         notPlaying: '再生していません', on: 'オン', off: 'オフ'},
    zh: {night: '夜览', dnd: '勿扰模式', display: '显示器', sound: '声音',
         notPlaying: '未在播放', on: '开', off: '关'},   // simplified (zh_TW included too)
    ko: {night: '야간 모드', dnd: '방해 금지', display: '디스플레이', sound: '사운드',
         notPlaying: '재생 중이 아님', on: '켬', off: '끔'},
    id: {night: 'Mode Malam', dnd: 'Jangan Ganggu', display: 'Layar', sound: 'Suara',
         notPlaying: 'Tidak Diputar', on: 'Aktif', off: 'Nonaktif'},
    vi: {night: 'Chế độ ban đêm', dnd: 'Không làm phiền', display: 'Màn hình', sound: 'Âm thanh',
         notPlaying: 'Không phát', on: 'Bật', off: 'Tắt'},
};

// 'it_IT.UTF-8' -> 'it'; Portuguese keeps its own entry for Brazil.
function detectLang() {
    try {
        const raw = (GLib.get_language_names()[0] || 'en').toLowerCase();
        if (raw.startsWith('pt_br') || raw.startsWith('pt-br'))
            return 'pt-br';
        const base = raw.split(/[._-]/)[0];       // it_IT.UTF-8 -> it
        if (STRINGS[base])
            return base;
        const two = base.slice(0, 2);             // zh_CN -> zh
        return STRINGS[two] ? two : 'en';
    } catch (e) {
        return 'en';
    }
}
const UI_LANG = detectLang();


// Helpers bridge for pannelli.js (view-swap panels)
const HELPERS = {
    global: {St, Clutter, Gio, GLib, Main},
    icon,
    symbol,
    pivot,
    bindPress,
    pressDown,
    pressUp,
    pop,
    animOn,
    launch,
    getAnim: () => _anim,
    loadAnim,
    ensureAnimFile,
    asGlassToggle,
    asGlassCircle,
    asGlassSlider,
    setOn,
    wideTile,
    circleButton,
    sliderTile,
    STRINGS,
    tr,
    UI_LANG,
};
// Text in the language of the PC. Gendered variants (onF/offF) fall back to
// on/off, and any missing key falls back to English.
function tr(key) {
    const dict = STRINGS[UI_LANG] || STRINGS.en;
    const base = key.endsWith('F') ? key.slice(0, -1) : key;
    return dict[key] ?? dict[base] ?? STRINGS.en[key] ?? STRINGS.en[base] ?? key;
}

/* ---------- animations (MacOS / Liquid Glass style) ----------
 * NOTE: St (the GNOME CSS engine) does NOT support CSS transitions
 * (I verified this in st-theme-node.c: neither "transition" nor "animation"
 * exist), so every animation has to be written in JS with actor.ease().
 *
 * Durations and strengths live in ~/.config/pulsar-cc/animazione.json, which is
 * RE-READ every time the Control Center opens: to tweak a number just edit that
 * file and reopen the panel, NO logout needed.
 * The file is created automatically on first run. */
const ANIM_PATH = GLib.build_filenamev([
    GLib.get_user_config_dir(), 'pulsar-cc', 'animazione.json']);

const ANIM_DEFAULT = {
    enabled: true,

    // Open: the tiles arrive in a cascade when you open the panel.
    // The arrival has two phases: first they overshoot the final
    // size a little (enterOvershoot), then they settle -> "liquid" effect.
    enterBase: 20,        // initial delay (ms)
    enterStep: 20,        // delay between two consecutive tiles (ms)
    enterDuration: 280,   // arrival duration (ms)
    enterSettle: 150,     // final settle duration (ms)
    enterScale: 0.90,     // starting scale (1 = fade only)
    enterRise: 8,         // how many px they rise from (0 = none)
    enterOvershoot: 1.02, // how much they overshoot before settling

    // Press: it compresses the MOMENT you press (not on release) and comes
    // back up with a soft bounce.
    pressScale: 0.94,     // how much it compresses
    pressSquash: 0.03,    // extra vertical squash (0 = uniform)
    pressDown: 90,        // time to compress (ms)
    pressUp: 260,         // time to come back up (ms)
    pressOvershoot: 1.02, // comes back slightly past the final size

    // Extra "activation" spring, right on the click: the widget rises to
    // popScale and settles back. 1.0 = off. On the pills the spring moves the
    // WHOLE pill: the bubble is never animated on its own (no double bounce).
    popScale: 1.0,
    popDown: 110,
    popUp: 230,

    // Play/pause: crossfade of the glyph
    iconOut: 80,
    iconIn: 200,

    // Sliders: they lift slightly while you drag them
    sliderLift: 1.02,
    sliderUp: 140,
    sliderDown: 240,
};

let _anim = {...ANIM_DEFAULT};

// (Re)reads the parameters from the file. Called every time the panel opens.
function loadAnim() {
    _anim = {...ANIM_DEFAULT};
    try {
        const [, bytes] = GLib.file_get_contents(ANIM_PATH);
        const json = JSON.parse(new TextDecoder().decode(bytes));
        for (const k of Object.keys(ANIM_DEFAULT)) {
            // Only values of the same type are accepted: a typo cannot break anything.
            if (typeof json[k] === typeof ANIM_DEFAULT[k])
                _anim[k] = json[k];
        }
    } catch (e) {
        // missing or malformed file: the defaults stay in place
    }
    return _anim;
}

// Creates the config file if it does not exist (never overwrites your changes).
function ensureAnimFile() {
    try {
        if (GLib.file_test(ANIM_PATH, GLib.FileTest.EXISTS))
            return;
        GLib.mkdir_with_parents(GLib.path_get_dirname(ANIM_PATH), 0o755);
        const body = Object.entries(ANIM_DEFAULT)
            .map(([k, v]) => `    "${k}": ${JSON.stringify(v)}`)
            .join(',\n');
        GLib.file_set_contents(ANIM_PATH, `{\n${body}\n}\n`);
    } catch (e) {
        console.warn(`macos-cc: cannot create ${ANIM_PATH}: ${e}`);
    }
}

// Centre of rotation for a scale (without it, scaling starts from the top
// left corner). It is set once, when the widget is built.
function pivot(a) {
    try {
        a.set_pivot_point(0.5, 0.5);
    } catch (e) { /* ignore */ }
}

// General rule: no animations when they are switched off.
function animOn(a) {
    return !!a && _anim.enabled;
}

/* Press. Every sequence ALWAYS ends at scale 1: so even if two animations
 * overlap, the final result is always correct. */

function pressDown(a) {
    if (!animOn(a))
        return;
    a._macPressed = true;
    a._macPopSyncPending = false;   // new interaction: the next click may spring
    try {
        a.ease({
            scale_x: _anim.pressScale,
            // A touch more squashed vertically: that is what makes the
            // press feel "liquid" rather than a plain resize.
            scale_y: _anim.pressScale - _anim.pressSquash,
            duration: _anim.pressDown,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    } catch (e) { /* actor already destroyed */ }
}

function pressUp(a) {
    if (!animOn(a))
        return;
    a._macPressed = false;
    const half = Math.max(1, Math.round(_anim.pressUp / 2));
    try {
        a.ease({
            scale_x: _anim.pressOvershoot,
            scale_y: _anim.pressOvershoot,
            duration: half,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => a.ease({
                scale_x: 1,
                scale_y: 1,
                duration: Math.max(1, _anim.pressUp - half),
                mode: Clutter.AnimationMode.EASE_OUT_SINE,
            }),
        });
    } catch (e) { /* actor already destroyed */ }
}

// Wires a button: it compresses the MOMENT you press it and comes back when
// you release. St.Button exposes the "pressed" property (driven by a
// ClutterPressGesture, so it also covers touch and keyboard) and notifies when
// it changes: that is exactly the instant of the press, not the release.
// "w" receives the press, "target" is the one that animates (for the pills:
// you press the bubble, the whole pill compresses).
function bindPress(w, target = w) {
    if (!(w instanceof St.Button))
        return;
    w.connect('notify::pressed', () => {
        if (w.pressed)
            pressDown(target);
        else
            pressUp(target);
    });
}

// "Activation" spring of a widget. It starts from wherever the actor currently
// is (usually the pressed size), rises up to popScale and settles back to 1.0:
// ONE continuous motion, with no stop at the base size in between.
// It is started by the CLICK, so it begins exactly at the release instant, and
// the state sync that follows (the D-Bus answer) is recognised as its "echo"
// thanks to _macPopSyncPending: that way the spring never plays twice.
function pop(a) {
    // popScale 1 = off
    if (_anim.popScale === 1 || !animOn(a))
        return;
    if (a._macEntering)   // do not fight the entrance cascade
        return;
    try {
        a.ease({
            scale_x: _anim.popScale,
            scale_y: _anim.popScale,
            duration: _anim.popDown,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => a.ease({
                scale_x: 1,
                scale_y: 1,
                duration: _anim.popUp,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            }),
        });
    } catch (e) { /* actor already destroyed */ }
}

// Wide tile with an icon circle (toggle) and a text area (menu)
function wideTile(iconName, title, subtitle, extraClass, onToggle, onMenu) {
    const btn = new St.BoxLayout({
        style_class: `mac-tile ${extraClass}`,
        reactive: true,
        can_focus: true,
    });
    const row = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER, style_class: 'mac-tile-row', x_expand: true});
    
    // The circle is now an independent button (to switch it on/off)
    const bubble = new St.Button({
        style_class: 'mac-bubble',
        y_align: Clutter.ActorAlign.CENTER,
        can_focus: true,
        reactive: true,
        child: icon(iconName),
    });
    // Compresses as soon as you press it (bubble or text), not on release.
    bindPress(bubble, btn);
    // On activation the WHOLE pill springs: bubble and pill move as one piece.
    bubble.connect('clicked', () => {
        btn._macPopSyncPending = true;   // the following sync is the echo
        pop(btn);
        onToggle?.();
    });

    // The text part opens the settings menu
    const textBtn = new St.Button({
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
        can_focus: true,
        reactive: true,
        style_class: 'mac-tile-text-btn'
    });
    const texts = new St.BoxLayout({vertical: true, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
    const t = new St.Label({text: title, style_class: 'mac-title', reactive: false, can_focus: false});
    const s = new St.Label({text: subtitle, style_class: 'mac-sub', reactive: false, can_focus: false});
    for (const l of [t, s])
        l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    texts.add_child(t);
    texts.add_child(s);
    textBtn.set_child(texts);
    bindPress(textBtn, btn);
    textBtn.connect('clicked', () => {
        // Hand the whole pill to the callback so pannelli.js can expand the
        // detail sheet out of the tile that was actually clicked.
        onMenu?.(btn);
    });

    row.add_child(bubble);
    row.add_child(textBtn);
    btn.add_child(row);
    
    btn._sub = s;
    btn._bubble = bubble;
    pivot(btn);
    return asGlassToggle(btn);
}

function circleButton(iconName, extraClass, onClick) {
    const btn = new St.Button({
        style_class: `mac-circle ${extraClass}`,
        can_focus: true,
        reactive: true,
        child: icon(iconName),
    });
    bindPress(btn);
    // The activation spring starts right at the release instant, instead of
    // waiting for the D-Bus state sync to come back.
    btn.connect('clicked', () => {
        btn._macPopSyncPending = true;   // the following sync is the echo
        pop(btn);
        onClick?.();
    });
    pivot(btn);
    return asGlassCircle(btn);
}

function setOn(widget, on, popTarget = widget) {
    const was = widget.has_style_pseudo_class('checked');
    if (on)
        widget.add_style_pseudo_class('checked');
    else
        widget.remove_style_pseudo_class('checked');
    // Only when the state REALLY changed: no pop on every sync. popTarget is
    // the whole pill on the wide tiles (the bubble is only its indicator).
    if (was === on)
        return;
    if (popTarget._macPopSyncPending) {
        popTarget._macPopSyncPending = false;   // echo of the click: already sprung
        return;
    }
    pop(popTarget);
}

function launch(cmd) {
    try {
        Gio.AppInfo.create_from_commandline(cmd, null, Gio.AppInfoCreateFlags.NONE).launch([], null);
    } catch (e) {
        console.warn(`macos-cc: cannot start ${cmd}: ${e}`);
    }
}

function sliderTile(title, lowIcon, highIcon, onTrail) {
    const box = new St.BoxLayout({vertical: true, style_class: 'mac-slider-tile'});
    pivot(box);
    box.add_child(new St.Label({text: title, style_class: 'mac-title'}));
    const row = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER, style_class: 'mac-slider-row'});
    const slider = new Slider(0.5);
    slider.x_expand = true;
    slider.y_align = Clutter.ActorAlign.CENTER;
    // While you drag, the tile "lifts" a little and settles back on
    // release. (The slider handle is drawn in Cairo by BarLevel and is not a
    // separate actor: scaling it during the drag would also shift the value
    // mapping, so we do not do that.)
    slider.connect('drag-begin', () => {
        if (!animOn(box))
            return;
        box.ease({
            scale_x: _anim.sliderLift,
            scale_y: _anim.sliderLift,
            duration: _anim.sliderUp,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    });
    slider.connect('drag-end', () => {
        if (!_anim.enabled)
            return;
        box.ease({
            scale_x: 1,
            scale_y: 1,
            duration: _anim.sliderDown,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    });
    row.add_child(icon(lowIcon, 'mac-small'));
    row.add_child(slider);
    row.add_child(icon(highIcon, 'mac-small'));
    if (onTrail) {
        const trail = new St.Button({
            style_class: 'mac-airplay',
            can_focus: true,
            reactive: true,
            child: icon('mc:airplay', 'mac-small'),
        });
        bindPress(trail);
        trail.connect('clicked', () => onTrail());
        row.add_child(trail);
    }
    box.add_child(row);
    box.slider = slider;
    return asGlassSlider(box);
}

/* ---------- extension ---------- */
export default class MacControlCentre extends Extension {
    async enable() {
        ICON_DIR = `${this.path}/icons`;
        this._qs = Main.panel.statusArea.quickSettings;
        this._ids = [];
        this._artUrl = null;
        this._building = false;
        this._openGen = 0;      // invalidates the pending animation timers
        this._enterActors = [];
        ensureAnimFile();       // creates ~/.config/pulsar-cc/animazione.json
        this._pan = null;
        try {
            const dir = this.path;
            const uri = Gio.File.new_for_path(GLib.build_filenamev([dir, 'pannelli.js'])).get_uri();
            const mod = await import(`${uri}?v=${Date.now()}`);
            this._pan = mod.crea(this, HELPERS);
        } catch (e) {
            console.warn(`macos-cc: pannelli.js not loaded: ${e}`);
            this._pan = null;
        }

        this._ifaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._notifSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        try {
            this._colorSettings = new Gio.Settings({schema_id: 'org.gnome.settings-daemon.plugins.color'});
        } catch (e) {
            this._colorSettings = null;
        }

        this._buildPanel();

        // Removes the original Quick Settings content from the menu.
        // IMPORTANT: Liquid Glass keeps a private glass host actor inside this
        // very box (name 'liquid-glass-toggle-host') and re-asserts it as the
        // bottom-most child every frame. If we remove it, that actor's parent no
        // longer matches the box and the extension spams
        // `clutter_actor_set_child_below_sibling` assertion failures, which kills
        // the glass for the WHOLE menu. So we must leave that one alone.
        const box = this._qs.menu.box;
        this._removed = [];
        const kids = box.get_children();
        kids.forEach((child, i) => {
            if (child === this._panel)
                return;
            let cname = '';
            try { cname = (child.get_name && child.get_name()) || child.name || ''; } catch (e) {}
            let cctor = '';
            try { cctor = (child.constructor && child.constructor.name) || ''; } catch (e) {}
            if (cname === 'liquid-glass-toggle-host' || cctor === 'LayoutOpaqueActor')
                return;
            this._removed.push([child, i]);
            box.remove_child(child);
        });

        try {
            this._qs.menu.actor.translation_x = -SHIFT_LEFT;
        } catch (e) {
            console.warn(`macos-cc: shift failed: ${e}`);
        }

        this._ids.push([this._qs.menu, this._qs.menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                // First the cascading entrance, then the sync: so the state
                // "pop"s never overlap the opening animation.
                this._startEntrance();
                this._refresh();
            } else {
                this._pan?.close();
            }
        })]);
        // Refreshes play/pause and the title as soon as the player changes state
        this._subs = [
            Gio.DBus.session.signal_subscribe(null, 'org.freedesktop.DBus.Properties',
                'PropertiesChanged', MPRIS_PATH, null, Gio.DBusSignalFlags.NONE,
                () => this._refreshMedia()),
            Gio.DBus.session.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus',
                'NameOwnerChanged', null, null, Gio.DBusSignalFlags.NONE,
                () => later(200, () => this._refreshMedia())),
        ];
        this._refresh();
    }

    disable() {
        this._openGen = (this._openGen ?? 0) + 1;   // stops the pending timers
        for (const id of this._subs ?? [])
            Gio.DBus.session.signal_unsubscribe(id);
        this._subs = [];
        for (const [obj, id] of this._ids ?? [])
            obj.disconnect(id);
        this._ids = [];
        this._pan?.destroy();
        this._pan = null;
        this._panel?.destroy();
        this._panel = null;
        try {
            this._qs.menu.actor.translation_x = 0;
        } catch (e) { /* ignore */ }
        for (const [child, i] of this._removed ?? [])
            this._qs.menu.box.insert_child_at_index(child, i);
        this._removed = [];
        this._ifaceSettings = this._notifSettings = this._colorSettings = null;
        this._mixer = null;
    }

    /* Cascading entrance of the tiles when the panel opens.
     * The container (the "box pointer") already runs its own 150 ms animation
     * (fade + scale 0.96), so we do NOT touch it here: we only add the cascade
     * of the individual widgets, which is what MacOS does. */

    _openPanel(kind, anchor) {
        if (this._pan?.open(kind, anchor))
            return true;
        const fallback = {
            wifi: 'gnome-control-center wifi',
            bluetooth: 'gnome-control-center bluetooth',
            sound: 'gnome-control-center sound',
            display: 'gnome-control-center display',
            focus: 'gnome-control-center notifications',
        }[kind];
        this._qs.menu.close();
        if (fallback) launch(fallback);
        return false;
    }

    _startEntrance() {
        loadAnim();
        const gen = ++this._openGen;
        const list = this._enterActors ?? [];

        if (!_anim.enabled) {
            for (const a of list) {
                if (!a)
                    continue;
                a._macEntering = false;
                a._macPressed = false;
                try {
                    a.remove_all_transitions();
                    a.opacity = 255;
                    a.scale_x = 1;
                    a.scale_y = 1;
                    a.translation_y = 0;
                } catch (e) { /* ignore */ }
            }
            return;
        }

        list.forEach((a, i) => {
            if (!a)
                return;
            a._macEntering = true;
            a._macPressed = false;   // the panel was closed while it was pressed
            try {
                a.remove_all_transitions();
                a.opacity = 0;
                a.scale_x = _anim.enterScale;
                a.scale_y = _anim.enterScale;
                a.translation_y = -_anim.enterRise;
            } catch (e) {
                a._macEntering = false;
                return;
            }
            later(_anim.enterBase + i * _anim.enterStep, () => {
                if (this._openGen !== gen || !this._panel)
                    return;
                a.ease({
                    // "opacity" first: the onComplete is bound to the first
                    // property, and opacity is the only one that no other
                    // animation touches, so _macEntering is always cleared
                    // (even if you press a tile in the meantime).
                    opacity: 255,
                    scale_x: _anim.enterOvershoot,
                    scale_y: _anim.enterOvershoot,
                    translation_y: 0,
                    duration: _anim.enterDuration,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        a._macEntering = false;
                        // Second phase: soft settle (the little "bounce" of the
                        // arrival). Skipped if you are pressing at the same
                        // time: then the press takes over, and it ends at
                        // scale 1 anyway.
                        if (a._macPressed)
                            return;
                        a.ease({
                            scale_x: 1,
                            scale_y: 1,
                            duration: _anim.enterSettle,
                            mode: Clutter.AnimationMode.EASE_OUT_SINE,
                        });
                    },
                });
            });
        });
    }

    _buildPanel() {
        const panel = new St.BoxLayout({vertical: true, style_class: 'mac-cc'});
        this._panel = panel;

        /* Left / right columns */
        const top = new St.BoxLayout({style_class: 'mac-row'});
        const left = new St.BoxLayout({vertical: true, style_class: 'mac-col'});
        const right = new St.BoxLayout({vertical: true, style_class: 'mac-col'});

        this._wifi = wideTile('mc:wifi', 'Wi-Fi', '', '', 
            () => this._toggleWifi(), 
            (anchor) => this._openPanel('wifi', anchor)
        );
        this._bt = wideTile('mc:bluetooth', 'Bluetooth', '', '', 
            () => this._toggleBt(), 
            (anchor) => this._openPanel('bluetooth', anchor)
        );
        this._night = wideTile('mc:sun-horizon', tr('night'), '', '', 
            () => this._toggleNight(), 
            (anchor) => this._openPanel('display', anchor)
        );
        left.add_child(this._wifi);
        left.add_child(this._bt);
        left.add_child(this._night);

        this._mediaTile = this._buildMedia();
        right.add_child(this._mediaTile);
        const pair = new St.BoxLayout({style_class: 'mac-row'});
        this._stage = circleButton('mc:stage', '', () => {
            this._qs.menu.close();
            Main.overview.toggle();
        });
        pair.add_child(this._stage);
        this._mirror = circleButton('mc:mirror', '', () => {
            this._qs.menu.close();
            launch('gnome-control-center display');
        });
        pair.add_child(this._mirror);
        right.add_child(pair);

        top.add_child(left);
        top.add_child(right);
        panel.add_child(top);

        /* Row: dark mode, screenshot, Do Not Disturb */
        const row4 = new St.BoxLayout({style_class: 'mac-row'});
        const circles = new St.BoxLayout({style_class: 'mac-row'});
        
        // Fixed mac-blue removed, :checked is used instead
        this._dark = circleButton('mc:contrast', '', () => this._toggleDark());
        circles.add_child(this._dark);
        this._shot = circleButton('mc:screenshot', '', () => {
            this._qs.menu.close();
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                Main.screenshotUI.open();
                return GLib.SOURCE_REMOVE;
            });
        });
        circles.add_child(this._shot);
        this._dnd = wideTile('mc:moon', tr('dnd'), '', '', 
            () => this._toggleDnd(), 
            (anchor) => this._openPanel('focus', anchor)
        );
        row4.add_child(circles);
        row4.add_child(this._dnd);
        panel.add_child(row4);

        /* Sliders */
        this._display = sliderTile(tr('display'), 'mc:sun-min', 'mc:sun-max');
        this._sound = sliderTile(tr('sound'), 'mc:speaker-low', 'mc:speaker-high', () => {
            this._qs.menu.close();
            launch('gnome-control-center sound');
        });
        panel.add_child(this._display);
        panel.add_child(this._sound);

        this._display.slider.connect('notify::value', () => {
            if (this._building)
                return;
            const v = this._display.slider.value;
            const bl = findBacklight();
            const max = bl ? readInt(`${BL_DIR}/${bl}/max_brightness`) : null;
            if (bl && max) {
                setBacklight(bl, Math.max(1, Math.round(v * max)));
                return;
            }
            propSet(Gio.DBus.session, 'org.gnome.SettingsDaemon.Power',
                '/org/gnome/SettingsDaemon/Power',
                'org.gnome.SettingsDaemon.Power.Screen', 'Brightness',
                new GLib.Variant('i', Math.round(v * 100)));
        });
        this._sound.slider.connect('notify::value', () => {
            if (this._building)
                return;
            try {
                const sink = this._mixer.get_default_sink();
                sink.volume = this._sound.slider.value * this._mixer.get_vol_max_norm();
                sink.push_volume();
            } catch (e) {
                console.warn(`macos-cc: volume: ${e}`);
            }
        });

        // Order in which the widgets enter when you open the panel: left to
        // right, top to bottom (like MacOS does).
        this._enterActors = [
            this._wifi, this._bt, this._night,
            this._mediaTile, this._stage, this._mirror,
            this._dark, this._shot, this._dnd,
            this._display, this._sound,
        ];
        for (const a of this._enterActors)
            pivot(a);

        this._qs.menu.box.add_child(panel);
    }

    _buildMedia() {
        const tile = asGlassMedia(new St.BoxLayout({
            vertical: true,
            style_class: 'mac-media',
            x_expand: true,
        }));

        // Album art in the top-left corner.
        // It already carries LG_OVERRIDE in its style (see the comment above):
        // Liquid Glass then ignores it entirely and the album art is untouched.
        this._art = new St.Widget({
            style_class: 'mac-media-art',
            style: LG_OVERRIDE,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });

        this._mediaTitle = new St.Label({
            text: tr('notPlaying'),
            style_class: 'mac-title mac-media-title',
            x_align: Clutter.ActorAlign.START,
        });
        this._mediaTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        // The buttons are centred with two elastic spacers on each side: the
        // box takes the full width and the two spacers split the leftover
        // space in equal parts. (x_align alone was not enough: the tile layout
        // expanded the box anyway and the buttons ended up shifted right.)
        const controls = new St.BoxLayout({
            style_class: 'mac-media-controls',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.END,
        });
        const spacer = () => new St.Widget({ x_expand: true });

        const mk = (name, method) => {
            const b = new St.Button({
                style_class: 'mac-media-button',
                child: new St.Icon({gicon: symbol(name), style_class: 'mac-media-icon'}),
                can_focus: true,
            });
            pivot(b);
            bindPress(b);
            b.connect('clicked', () => {
                findPlayer(p => {
                    if (!p)
                        return;
                    Gio.DBus.session.call(p, MPRIS_PATH, PLAYER_IFACE, method, null, null,
                        NONE, -1, null, () => later(150, () => this._refreshMedia()));
                });
            });
            return b;
        };

        this._playBtn = mk('play', 'PlayPause');
        pivot(this._playBtn.child);   // the glyph rotates/scales from its own centre
        controls.add_child(spacer());
        controls.add_child(mk('rewind', 'Previous'));
        controls.add_child(this._playBtn);
        controls.add_child(mk('forward', 'Next'));
        controls.add_child(spacer());

        tile.add_child(this._art);
        tile.add_child(this._mediaTitle);
        tile.add_child(controls);
        pivot(tile);
        return tile;
    }

    // Shows the album art (local file or image downloaded from the internet)
    _setArt(url) {
        if (url === this._artUrl)
            return;
        this._artUrl = url;
        if (!url) {
            this._art.set_style(LG_OVERRIDE);
            return;
        }
        const apply = path => {
            if (this._artUrl !== url || !this._panel)
                return;
            // background-size = exact size of the box (46x46, see CSS): this way
            // the image fills the box and its border-radius (11px) can crop it
            // with rounded corners (if it were any smaller the inner corners of
            // the image would stay square).
            this._art.set_style(`${LG_OVERRIDE} background-image: url("file://${path}"); background-size: 46px 46px;`);
        };
        if (url.startsWith('file://')) {
            apply(decodeURIComponent(url.slice(7)));
        } else if (url.startsWith('http')) {
            const sum = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, url, -1);
            const cache = GLib.build_filenamev([GLib.get_user_cache_dir(), `macos-cc-${sum}.jpg`]);
            if (GLib.file_test(cache, GLib.FileTest.EXISTS)) {
                apply(cache);
                return;
            }
            try {
                const session = new Soup.Session();
                const msg = Soup.Message.new('GET', url);
                session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
                    try {
                        const bytes = sess.send_and_read_finish(res);
                        if (msg.get_status() === Soup.Status.OK) {
                            GLib.file_set_contents(cache, bytes.get_data());
                            apply(cache);
                        }
                    } catch (e) {
                        console.warn(`macos-cc: album art not downloaded: ${e}`);
                    }
                });
            } catch (e) {
                console.warn(`macos-cc: album art: ${e}`);
            }
        }
    }

    /* ---------- actions ---------- */
    _toggleWifi() {
        propGet(Gio.DBus.system, 'org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager',
            'org.freedesktop.NetworkManager', 'WirelessEnabled', v => {
                if (v === null)
                    return;
                propSet(Gio.DBus.system, 'org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager',
                    'org.freedesktop.NetworkManager', 'WirelessEnabled', new GLib.Variant('b', !v));
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
                    this._refresh();
                    return GLib.SOURCE_REMOVE;
                });
            });
    }

    _toggleBt() {
        const args = ['org.bluez', '/org/bluez/hci0', 'org.bluez.Adapter1', 'Powered'];
        propGet(Gio.DBus.system, ...args.slice(0, 3), args[3], v => {
            if (v === null)
                return;
            propSet(Gio.DBus.system, ...args, new GLib.Variant('b', !v));
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                this._refresh();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _toggleNight() {
        if (!this._colorSettings)
            return;
        this._colorSettings.set_boolean('night-light-enabled',
            !this._colorSettings.get_boolean('night-light-enabled'));
        this._refresh();
    }

    _toggleDark() {
        const dark = this._ifaceSettings.get_string('color-scheme') === 'prefer-dark';
        this._ifaceSettings.set_string('color-scheme', dark ? 'default' : 'prefer-dark');
        this._refresh();
    }

    _toggleDnd() {
        this._notifSettings.set_boolean('show-banners', !this._notifSettings.get_boolean('show-banners'));
        this._refresh();
    }

    /* ---------- state sync ---------- */
    _refresh() {
        this._building = true;

        propGet(Gio.DBus.system, 'org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager',
            'org.freedesktop.NetworkManager', 'WirelessEnabled', on => {
                setOn(this._wifi._bubble, !!on, this._wifi); // Uses _bubble instead of the whole tile!
                this._wifi._sub.text = on ? tr('on') : tr('off');
            });
        propGet(Gio.DBus.system, 'org.bluez', '/org/bluez/hci0', 'org.bluez.Adapter1', 'Powered', on => {
            setOn(this._bt._bubble, !!on, this._bt);
            this._bt._sub.text = on ? tr('on') : tr('off');
        });

        const night = this._colorSettings?.get_boolean('night-light-enabled') ?? false;
        setOn(this._night._bubble, night, this._night);
        this._night._sub.text = night ? tr('onF') : tr('offF');

        const dnd = !this._notifSettings.get_boolean('show-banners');
        setOn(this._dnd._bubble, dnd, this._dnd);
        this._dnd._sub.text = dnd ? tr('on') : tr('off');
        
        // Syncs the dark mode state
        const dark = this._ifaceSettings.get_string('color-scheme') === 'prefer-dark';
        setOn(this._dark, dark);

        const bl = findBacklight();
        const blMax = bl ? readInt(`${BL_DIR}/${bl}/max_brightness`) : null;
        const blCur = bl ? readInt(`${BL_DIR}/${bl}/brightness`) : null;
        if (bl && blMax && blCur !== null) {
            this._display.slider.value = Math.min(1, blCur / blMax);
        } else {
            propGet(Gio.DBus.session, 'org.gnome.SettingsDaemon.Power', '/org/gnome/SettingsDaemon/Power',
                'org.gnome.SettingsDaemon.Power.Screen', 'Brightness', b => {
                    this._building = true;
                    if (b !== null && b >= 0)
                        this._display.slider.value = b / 100;
                    this._building = false;
                });
        }

        try {
            this._mixer ??= Volume.getMixerControl();
            const sink = this._mixer.get_default_sink();
            if (sink)
                this._sound.slider.value = Math.min(1, sink.volume / this._mixer.get_vol_max_norm());
        } catch (e) {
            console.warn(`macos-cc: mixer unavailable: ${e}`);
        }

        this._building = false;
        this._refreshMedia();
    }

    // Changes the play/pause glyph. With animations enabled it uses a
    // crossfade (the glyph shrinks and fades, then the new one appears with a
    // bounce). The comparison against _macGlyph avoids replaying the animation
    // on every sync (which arrives very often).
    _setPlayGlyph(name) {
        const ic = this._playBtn?.child;
        if (!ic || ic._macGlyph === name)
            return;
        const first = ic._macGlyph === undefined;   // first time: no animation
        ic._macGlyph = name;
        if (first || !_anim.enabled) {
            ic.gicon = symbol(name);
            return;
        }
        ic.ease({
            opacity: 0,   // first: it binds the onComplete for us
            scale_x: 0.7,
            scale_y: 0.7,
            duration: _anim.iconOut,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                ic.gicon = symbol(name);
                ic.ease({
                    opacity: 255,
                    scale_x: 1,
                    scale_y: 1,
                    duration: _anim.iconIn,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK,
                });
            },
        });
    }

    _refreshMedia() {
        findPlayer(name => {
            if (!this._panel)
                return;
            if (!name) {
                this._mediaTitle.text = tr('notPlaying');
                this._setPlayGlyph('play');
                this._setArt(null);
                return;
            }
            const get = prop => new Promise(res => Gio.DBus.session.call(
                name, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', [PLAYER_IFACE, prop]), GLib.VariantType.new('(v)'),
                NONE, -1, null, (c, r) => {
                    try {
                        res(c.call_finish(r).get_child_value(0).get_variant());
                    } catch (e) {
                        res(null);
                    }
                }));
            Promise.all([get('PlaybackStatus'), get('Metadata')]).then(([st, md]) => {
                if (!this._panel)
                    return;
                const playing = st?.get_string()[0] === 'Playing';
                this._setPlayGlyph(playing ? 'pause' : 'play');
                try {
                    const m = md.deepUnpack();
                    this._mediaTitle.text = m['xesam:title']?.deepUnpack() || tr('notPlaying');
                    this._setArt(m['mpris:artUrl']?.deepUnpack() ?? null);
                } catch (e) {
                    this._mediaTitle.text = tr('notPlaying');
                    this._setArt(null);
                }
            });
        });
    }
}
