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

// Cartella delle icone in stile macOS (impostata in enable())
let ICON_DIR = '';
function symbol(name) {
    return Gio.icon_new_for_string(`${ICON_DIR}/${name}-symbolic.svg`);
}

// --- Retroilluminazione del portatile: legge /sys e scrive tramite logind
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
                console.warn(`macos-cc: luminosita' non impostata: ${e}`);
            }
        });
}

function later(ms, fn) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        fn();
        return GLib.SOURCE_REMOVE;
    });
}

// Se il pannello esce ancora a destra, aumenta questo valore (pixel).
const SHIFT_LEFT = 34;

/* ---------- utilita' D-Bus ---------- */
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
                console.warn(`macos-cc: Set ${prop} fallito: ${e}`);
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

/* ---------- costruttori di widget ---------- */
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

/* ---- Integrazione con l'estensione "Liquid Glass" ----
 * Liquid Glass (modalità Toggles) disegna il vetro solo sui widget GNOME che
 * portano la classe `.quick-toggle`. Le nostre tile sono widget nostri
 * (mac-tile / mac-slider-tile) e per lei non esistono, quindi non venivano
 * mai "glassate". Qui marchiamo le tile con `quick-toggle` così le riconosce
 * e stende il vetro su ciascuna, mantenendo identica la grafica.
 *
 * Interruttori separati, così puoi provare/annullare ogni gruppo
 * indipendentemente (metti false per tornare al comportamento senza vetro). */
const LIQUID_GLASS_TOGGLES = true;   // tessere larghe (Wi-Fi, Bluetooth, Luce notturna, Non disturbare)
const LIQUID_GLASS_SLIDERS = true;   // tessere con gli slider (Schermo, Audio)
const LIQUID_GLASS_MEDIA   = true;   // riquadro del lettore musicale
const LIQUID_GLASS_CIRCLES = true;   // i 4 pulsanti circolari (Stage, Mirror, Tema scuro, Screenshot)
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

// Stringa con cui Liquid Glass azzera lo sfondo degli elementi riconosciuti.
// Deve combaciare ESATTAMENTE: se un widget la porta già nel proprio stile,
// Liquid Glass lo salta del tutto (non lo registra, quindi non può più
// "ripristinargli" per errore uno stile vecchio). Serve a proteggere la
// copertina del lettore, che altrimenti tornerebbe alla traccia precedente
// a ogni ricampionamento dei colori.
const LG_OVERRIDE = 'background-color: transparent !important;';

// Tessera larga con cerchio-icona (toggle) e area testo (menù)
function wideTile(iconName, title, subtitle, extraClass, onToggle, onMenu) {
    const btn = new St.BoxLayout({
        style_class: `mac-tile ${extraClass}`,
        reactive: true,
        can_focus: true,
    });
    const row = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER, style_class: 'mac-tile-row', x_expand: true});
    
    // Il cerchio ora è un bottone indipendente (per attivare/disattivare)
    const bubble = new St.Button({
        style_class: 'mac-bubble',
        y_align: Clutter.ActorAlign.CENTER,
        can_focus: true,
        reactive: true,
        child: icon(iconName),
    });
    bubble.connect('clicked', () => onToggle?.());

    // La parte col testo apre il menù delle impostazioni
    const textBtn = new St.Button({
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
        can_focus: true,
        reactive: true,
        style_class: 'mac-tile-text-btn'
    });
    const texts = new St.BoxLayout({vertical: true, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
    const t = new St.Label({text: title, style_class: 'mac-title'});
    const s = new St.Label({text: subtitle, style_class: 'mac-sub'});
    for (const l of [t, s])
        l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    texts.add_child(t);
    texts.add_child(s);
    textBtn.set_child(texts);
    textBtn.connect('clicked', () => onMenu?.());

    row.add_child(bubble);
    row.add_child(textBtn);
    btn.add_child(row);
    
    btn._sub = s;
    btn._bubble = bubble;
    return asGlassToggle(btn);
}

function circleButton(iconName, extraClass, onClick) {
    const btn = new St.Button({
        style_class: `mac-circle ${extraClass}`,
        can_focus: true,
        reactive: true,
        child: icon(iconName),
    });
    btn.connect('clicked', () => onClick?.());
    return asGlassCircle(btn);
}

function setOn(widget, on) {
    if (on)
        widget.add_style_pseudo_class('checked');
    else
        widget.remove_style_pseudo_class('checked');
}

function launch(cmd) {
    try {
        Gio.AppInfo.create_from_commandline(cmd, null, Gio.AppInfoCreateFlags.NONE).launch([], null);
    } catch (e) {
        console.warn(`macos-cc: impossibile avviare ${cmd}: ${e}`);
    }
}

function sliderTile(title, lowIcon, highIcon, onTrail) {
    const box = new St.BoxLayout({vertical: true, style_class: 'mac-slider-tile'});
    box.add_child(new St.Label({text: title, style_class: 'mac-title'}));
    const row = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER, style_class: 'mac-slider-row'});
    const slider = new Slider(0.5);
    slider.x_expand = true;
    slider.y_align = Clutter.ActorAlign.CENTER;
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
        trail.connect('clicked', () => onTrail());
        row.add_child(trail);
    }
    box.add_child(row);
    box.slider = slider;
    return asGlassSlider(box);
}

/* ---------- estensione ---------- */
export default class MacControlCentre extends Extension {
    enable() {
        ICON_DIR = `${this.path}/icons`;
        this._qs = Main.panel.statusArea.quickSettings;
        this._ids = [];
        this._artUrl = null;
        this._building = false;

        this._ifaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._notifSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        try {
            this._colorSettings = new Gio.Settings({schema_id: 'org.gnome.settings-daemon.plugins.color'});
        } catch (e) {
            this._colorSettings = null;
        }

        this._buildPanel();

        // Toglie il contenuto originale delle Impostazioni rapide dal menu
        const box = this._qs.menu.box;
        this._removed = [];
        box.get_children().forEach((child, i) => {
            if (child === this._panel)
                return;
            this._removed.push([child, i]);
            box.remove_child(child);
        });

        try {
            this._qs.menu.actor.translation_x = -SHIFT_LEFT;
        } catch (e) {
            console.warn(`macos-cc: spostamento non riuscito: ${e}`);
        }

        this._ids.push([this._qs.menu, this._qs.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._refresh();
        })]);
        // Aggiorna play/pausa e titolo appena il lettore cambia stato
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
        for (const id of this._subs ?? [])
            Gio.DBus.session.signal_unsubscribe(id);
        this._subs = [];
        for (const [obj, id] of this._ids ?? [])
            obj.disconnect(id);
        this._ids = [];
        this._panel?.destroy();
        this._panel = null;
        try {
            this._qs.menu.actor.translation_x = 0;
        } catch (e) { /* ignora */ }
        for (const [child, i] of this._removed ?? [])
            this._qs.menu.box.insert_child_at_index(child, i);
        this._removed = [];
        this._ifaceSettings = this._notifSettings = this._colorSettings = null;
        this._mixer = null;
    }

    _buildPanel() {
        const panel = new St.BoxLayout({vertical: true, style_class: 'mac-cc'});
        this._panel = panel;

        /* Colonne sinistra / destra */
        const top = new St.BoxLayout({style_class: 'mac-row'});
        const left = new St.BoxLayout({vertical: true, style_class: 'mac-col'});
        const right = new St.BoxLayout({vertical: true, style_class: 'mac-col'});

        this._wifi = wideTile('mc:wifi', 'Wi-Fi', '', '', 
            () => this._toggleWifi(), 
            () => { this._qs.menu.close(); launch('gnome-control-center wifi'); }
        );
        this._bt = wideTile('mc:bluetooth', 'Bluetooth', '', '', 
            () => this._toggleBt(), 
            () => { this._qs.menu.close(); launch('gnome-control-center bluetooth'); }
        );
        this._night = wideTile('mc:sun-horizon', 'Luce notturna', '', '', 
            () => this._toggleNight(), 
            () => { this._qs.menu.close(); launch('gnome-control-center display'); }
        );
        left.add_child(this._wifi);
        left.add_child(this._bt);
        left.add_child(this._night);

        right.add_child(this._buildMedia());
        const pair = new St.BoxLayout({style_class: 'mac-row'});
        pair.add_child(circleButton('mc:stage', '', () => {
            this._qs.menu.close();
            Main.overview.toggle();
        }));
        pair.add_child(circleButton('mc:mirror', '', () => {
            this._qs.menu.close();
            launch('gnome-control-center display');
        }));
        right.add_child(pair);

        top.add_child(left);
        top.add_child(right);
        panel.add_child(top);

        /* Riga: modalita' scura, screenshot, Non disturbare */
        const row4 = new St.BoxLayout({style_class: 'mac-row'});
        const circles = new St.BoxLayout({style_class: 'mac-row'});
        
        // Tolto mac-blue fisso, userà :checked
        this._dark = circleButton('mc:contrast', '', () => this._toggleDark());
        circles.add_child(this._dark);
        circles.add_child(circleButton('mc:screenshot', '', () => {
            this._qs.menu.close();
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                Main.screenshotUI.open();
                return GLib.SOURCE_REMOVE;
            });
        }));
        this._dnd = wideTile('mc:moon', 'Non disturbare', '', '', 
            () => this._toggleDnd(), 
            () => { this._qs.menu.close(); launch('gnome-control-center notifications'); }
        );
        row4.add_child(circles);
        row4.add_child(this._dnd);
        panel.add_child(row4);

        /* Slider */
        this._display = sliderTile('Schermo', 'mc:sun-min', 'mc:sun-max');
        this._sound = sliderTile('Audio', 'mc:speaker-low', 'mc:speaker-high', () => {
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

        this._qs.menu.box.add_child(panel);
    }

    _buildMedia() {
        const tile = asGlassMedia(new St.BoxLayout({
            vertical: true,
            style_class: 'mac-media',
            x_expand: true,
        }));

        // Copertina nell'angolo in alto a sinistra.
        // Porta già LG_OVERRIDE nello stile (vedi il commento su LG_OVERRIDE):
        // così Liquid Glass la ignora del tutto e la copertina non viene toccata.
        this._art = new St.Widget({
            style_class: 'mac-media-art',
            style: LG_OVERRIDE,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });

        this._mediaTitle = new St.Label({
            text: 'Non in riproduzione',
            style_class: 'mac-title mac-media-title',
            x_align: Clutter.ActorAlign.START,
        });
        this._mediaTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        // I tasti vengono centrati con due spaziatori elastici ai lati: il
        // riquadro occupa tutta la larghezza e i due spaziatori si dividono lo
        // spazio avanzato in parti uguali. (x_align da solo non bastava: il
        // layout della tessera allargava comunque il riquadro e i tasti
        // finivano spostati verso destra.)
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
            b.connect('clicked', () => findPlayer(p => {
                if (!p)
                    return;
                Gio.DBus.session.call(p, MPRIS_PATH, PLAYER_IFACE, method, null, null,
                    NONE, -1, null, () => later(150, () => this._refreshMedia()));
            }));
            return b;
        };

        this._playBtn = mk('play', 'PlayPause');
        controls.add_child(spacer());
        controls.add_child(mk('rewind', 'Previous'));
        controls.add_child(this._playBtn);
        controls.add_child(mk('forward', 'Next'));
        controls.add_child(spacer());

        tile.add_child(this._art);
        tile.add_child(this._mediaTitle);
        tile.add_child(controls);
        return tile;
    }

    // Mostra la copertina (file locale o immagine scaricata da internet)
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
            // background-size = dimensione esatta del riquadro (46x46, vedi CSS):
            // così l'immagine riempie il riquadro e il suo border-radius (11px)
            // può ritagliarla con gli angoli tondi (se fosse più piccola gli
            // spigoli interni dell'immagine resterebbero quadrati).
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
                        console.warn(`macos-cc: copertina non scaricata: ${e}`);
                    }
                });
            } catch (e) {
                console.warn(`macos-cc: copertina: ${e}`);
            }
        }
    }

    /* ---------- azioni ---------- */
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

    /* ---------- sincronizzazione stato ---------- */
    _refresh() {
        this._building = true;

        propGet(Gio.DBus.system, 'org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager',
            'org.freedesktop.NetworkManager', 'WirelessEnabled', on => {
                setOn(this._wifi._bubble, !!on); // Usa _bubble invece del tile intero!
                this._wifi._sub.text = on ? 'Attivo' : 'Non attivo';
            });
        propGet(Gio.DBus.system, 'org.bluez', '/org/bluez/hci0', 'org.bluez.Adapter1', 'Powered', on => {
            setOn(this._bt._bubble, !!on);
            this._bt._sub.text = on ? 'Attivo' : 'Non attivo';
        });

        const night = this._colorSettings?.get_boolean('night-light-enabled') ?? false;
        setOn(this._night._bubble, night);
        this._night._sub.text = night ? 'Attiva' : 'Non attiva';

        const dnd = !this._notifSettings.get_boolean('show-banners');
        setOn(this._dnd._bubble, dnd);
        this._dnd._sub.text = dnd ? 'Attivo' : 'Non attivo';
        
        // Sincronizza stato modalità scura
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
            console.warn(`macos-cc: mixer non disponibile: ${e}`);
        }

        this._building = false;
        this._refreshMedia();
    }

    _refreshMedia() {
        findPlayer(name => {
            if (!this._panel)
                return;
            if (!name) {
                this._mediaTitle.text = 'Non in riproduzione';
                this._playBtn.child.gicon = symbol('play');
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
                this._playBtn.child.gicon = symbol(playing ? 'pause' : 'play');
                try {
                    const m = md.deepUnpack();
                    this._mediaTitle.text = m['xesam:title']?.deepUnpack() || 'Non in riproduzione';
                    this._setArt(m['mpris:artUrl']?.deepUnpack() ?? null);
                } catch (e) {
                    this._mediaTitle.text = 'Non in riproduzione';
                    this._setArt(null);
                }
            });
        });
    }
}
