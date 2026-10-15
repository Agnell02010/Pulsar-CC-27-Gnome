import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

const NONE = Gio.DBusCallFlags.NONE;
const EASE = Clutter.AnimationMode.EASE_OUT_QUAD;

function warn(msg) {
    try { console.warn(`macos-cc: ${msg}`); } catch (e) {}
}
function fail(e, where) {
    try { console.error(`macos-cc: ${where}: ${e && (e.message || e)}`); } catch (e2) {}
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

function decodeSs(ssid) {
    if (!ssid) return '';
    if (Array.isArray(ssid)) {
        let s = '';
        for (let i = 0; i < ssid.length; i++) s += String.fromCharCode(ssid[i]);
        return s;
    }
    return typeof ssid === 'string' ? ssid : String(ssid);
}

function mkRow(iconName, label, right, chipClass) {
    const row = new St.BoxLayout({style_class: 'mac-panel-row', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    if (iconName) {
        try {
            const ic = new St.Icon({icon_name: iconName, style_class: 'mac-panel-icon', y_align: Clutter.ActorAlign.CENTER});
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
            vertical: true, style_class: 'mac-cc-detail',
            visible: false, opacity: 0, x_expand: true,
        });
        // Tag as a Liquid Glass pod, same as the tiles (see asGlassToggle).
        try { h.asGlassToggle && h.asGlassToggle(detailRoot); } catch (e) {}
        host.add_child(detailRoot);
        detailCont = new St.BoxLayout({vertical: true, x_expand: true});
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
    function switchRow(iconName, chipClass, label, sw) {
        return mkRow(iconName, label, sw, chipClass);
    }

    function skeletonWifi() {
        const sw = mkSwitch(true, (on) => {
            dbusCall(Gio.DBus.system, 'org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager',
                'org.freedesktop.DBus.Properties', 'Set',
                new GLib.Variant('(ssv)', ['org.freedesktop.NetworkManager', 'WirelessEnabled',
                    new GLib.Variant('b', on)]))
                .catch(e => warn(`WirelessEnabled set failed: ${e}`));
        });
        detailCont.add_child(backRow());
        detailCont.add_child(headerRow('Wi-Fi', sw));
        detailCont.add_child(section(tr('networks', 'Networks')));
        const list = new St.BoxLayout({vertical: true, x_expand: true, name: 'wifi-list'});
        detailCont.add_child(list);
        detailCont.add_child(sep());
        detailCont.add_child(settingsRow('gnome-control-center wifi', 'Wi-Fi Settings…', 'mac-chip-blue'));
        return list;
    }

    function skeletonBluetooth() {
        const sw = mkSwitch(true, (on) => {
            dbusCall(Gio.DBus.session, 'org.bluez', '/', 'org.freedesktop.DBus.Properties', 'Set',
                new GLib.Variant('(ssv)', ['org.bluez', 'Powered', new GLib.Variant('b', on)]))
                .catch(e => warn(`BlueZ Powered set failed: ${e}`));
        });
        detailCont.add_child(backRow());
        detailCont.add_child(headerRow('Bluetooth', sw));
        detailCont.add_child(section(tr('devices', 'Devices')));
        const list = new St.BoxLayout({vertical: true, x_expand: true, name: 'bt-list'});
        detailCont.add_child(list);
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

    async function populateWifi(list, myGen) {
        const NM = 'org.freedesktop.NetworkManager';
        try {
            const devs = await dbusCall(Gio.DBus.system, NM, '/org/freedesktop/NetworkManager', NM, 'GetDevices');
            const paths = devs?.unpack()[0] || [];
            let wifiDev = null;
            for (const p of paths) {
                try {
                    const d = (await dbusCall(Gio.DBus.system, NM, p, 'org.freedesktop.DBus.Properties', 'GetAll',
                        new GLib.Variant('(s)', ['org.freedesktop.NetworkManager.Device'])))?.unpack()[0] || {};
                    if (d.DeviceType === 2) { wifiDev = p; break; }
                } catch (e) {}
            }
            if (gen !== myGen) return;
            if (!wifiDev) { list.add_child(infoRow(tr('noWifiDev', 'No Wi-Fi device found.'))); return; }
            const w = (await dbusCall(Gio.DBus.system, NM, wifiDev, 'org.freedesktop.DBus.Properties', 'GetAll',
                new GLib.Variant('(s)', ['org.freedesktop.NetworkManager.Device.Wireless'])))?.unpack()[0] || {};
            const aps = w.AccessPoints || [];
            const active = w.ActiveAccessPoint || '/';
            const rows = [];
            for (const ap of aps) {
                try {
                    const a = (await dbusCall(Gio.DBus.system, NM, ap, 'org.freedesktop.DBus.Properties', 'GetAll',
                        new GLib.Variant('(s)', ['org.freedesktop.NetworkManager.AccessPoint'])))?.unpack()[0] || {};
                    rows.push({path: ap, ssid: decodeSs(a.Ssid) || '?', strength: a.Strength || 0});
                } catch (e) {}
            }
            rows.sort((x, y) => (y.strength - x.strength) || x.ssid.localeCompare(y.ssid));
            if (gen !== myGen) return;
            if (!rows.length) { list.add_child(infoRow(tr('noNetworks', 'No networks found.'))); return; }
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
                        .catch(e => warn(`attivazione Wi-Fi fallita: ${e}`));
                    back();
                });
                list.add_child(b);
            }
        } catch (e) {
            if (gen !== myGen) return;
            warn(`populate Wi-Fi failed (NetworkManager absent?): ${e && (e.message || e)}`);
            if (list.get_n_children() === 0)
                list.add_child(infoRow(tr('noNM', 'NetworkManager not available.')));
        }
    }

    async function populateBluetooth(list, myGen) {
        try {
            const res = await dbusCall(Gio.DBus.session, 'org.bluez', '/', 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects', null);
            const objs = res?.unpack()[0] || {};
            if (gen !== myGen) return;
            const devices = [];
            for (const path of Object.keys(objs)) {
                const d = objs[path];
                if (d && d['org.bluez.Device1']) {
                    const p = d['org.bluez.Device1'];
                    devices.push({path, name: p.Name || p.Alias || '?', connected: !!p.Connected, icon: p.Icon || 'bluetooth-symbolic'});
                }
            }
            if (!devices.length) { list.add_child(infoRow(tr('noBt', 'No Bluetooth devices.'))); return; }
            for (const dev of devices) {
                const right = new St.Label({text: dev.connected ? tr('connected', 'Connected') : '', style_class: 'mac-panel-sub'});
                const row = mkRow(dev.icon, dev.name, right, 'mac-chip-blue');
                const b = new St.Button({style_class: 'mac-panel-item', x_expand: true, child: row});
                b.connect('clicked', () => {
                    dbusCall(Gio.DBus.session, 'org.bluez', dev.path, 'org.bluez.Device1', dev.connected ? 'Disconnect' : 'Connect', null)
                        .catch(e => warn(`Bluetooth ${dev.connected ? 'disconnect' : 'connect'} failed: ${e}`));
                });
                list.add_child(b);
            }
        } catch (e) {
            if (gen !== myGen) return;
            warn(`populate Bluetooth failed (BlueZ absent?): ${e && (e.message || e)}`);
            if (list.get_n_children() === 0)
                list.add_child(infoRow(tr('noBlueZ', 'BlueZ not available.')));
        }
    }

    function swapIn() {
        if (!detailRoot) return;
        warn('detail shown');
        // Hide the main tiles but keep `.mac-cc` itself visible: the detail
        // sheet is one of its children now (a sibling of the tiles), so it is
        // treated by Liquid Glass exactly like them.
        if (mainKids) for (const k of mainKids) { try { k.hide(); } catch (e) {} }
        // Unfold from the top like a curtain: pivot at the top-centre so the
        // sheet grows downward as it fades in (macOS-style reveal).
        let px = 0.5, py = 0.0;
        try {
            if (anchor && ext._panel) {
                const a = anchor;
                const [ax, ay] = a.get_transformed_position();
                const [aw, ah] = a.get_transformed_size();
                const [bx, by] = ext._panel.get_transformed_position();
                const [bw, bh] = ext._panel.get_transformed_size();
                if (bw > 0 && bh > 0) {
                    px = Math.max(0, Math.min(1, (ax + aw / 2 - bx) / bw));
                    py = Math.max(0, Math.min(1, (ay + ah / 2 - by) / bh));
                }
            }
        } catch (e) {}
        detailRoot.set_pivot_point(px, py);
        detailRoot.visible = true;
        detailRoot.opacity = 0;
        detailRoot.scale_x = 0.92;
        detailRoot.scale_y = 0.88;
        detailRoot.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: 200, mode: EASE});
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

    function open(kind) {
        try {
            if (closing) return true;
            if (currentKind === kind && detailRoot && detailRoot.visible) { back(); return true; }
            gen++;
            const myGen = gen;
            if (!ensureRoot()) { resetMainInstant(); return false; }
            clear();
            currentKind = kind;

            let list = null;
            if (kind === 'wifi') list = skeletonWifi();
            else if (kind === 'bluetooth') list = skeletonBluetooth();
            else if (kind === 'sound') skeletonSimple(tr('sound', 'Sound'), () => {
                detailCont.add_child(section(tr('output', 'Output Devices')));
                const out = mkSwitch(true, () => {});
                detailCont.add_child(switchRow('audio-volume-high-symbolic', 'mac-chip-purple', tr('output', 'Output'), out));
                detailCont.add_child(sep());
                detailCont.add_child(settingsRow('gnome-control-center sound', 'Sound Settings…', 'mac-chip-purple'));
            });
            else if (kind === 'display') skeletonSimple(tr('display', 'Display'), () => {
                const night = mkSwitch(!!(ext._colorSettings && ext._colorSettings.get_boolean('night-light-enabled')), (on) => {
                    try { ext._colorSettings && ext._colorSettings.set_boolean('night-light-enabled', on); } catch (e) {}
                });
                detailCont.add_child(switchRow('weather-clear-night-symbolic', 'mac-chip-orange', tr('night', 'Night Shift'), night));
                detailCont.add_child(sep());
                detailCont.add_child(settingsRow('gnome-control-center display', 'Display Settings…', 'mac-chip-orange'));
            });
            else if (kind === 'focus') skeletonSimple(tr('dnd', 'Focus'), () => {
                const sw = mkSwitch(!!(ext._notifSettings && !ext._notifSettings.get_boolean('show-banners')), (on) => {
                    try { ext._notifSettings && ext._notifSettings.set_boolean('show-banners', !on); } catch (e) {}
                });
                detailCont.add_child(switchRow('notifications-disabled-symbolic', 'mac-chip-purple', tr('dndShort', 'Do Not Disturb'), sw));
                detailCont.add_child(sep());
                detailCont.add_child(settingsRow('gnome-control-center notifications', 'Notifications Settings…', 'mac-chip-purple'));
            });
            else { resetMainInstant(); return false; }

            swapIn();

            if (kind === 'wifi') populateWifi(list, myGen).catch(e => fail(e, 'wifi'));
            else if (kind === 'bluetooth') populateBluetooth(list, myGen).catch(e => fail(e, 'bluetooth'));
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
        if (detailRoot) {
            let px = 0.5, py = 0.0;
            try {
                if (anchor && ext._panel) {
                    const a = anchor;
                    const [ax, ay] = a.get_transformed_position();
                    const [aw, ah] = a.get_transformed_size();
                    const [bx, by] = ext._panel.get_transformed_position();
                    const [bw, bh] = ext._panel.get_transformed_size();
                    if (bw > 0 && bh > 0) {
                        px = Math.max(0, Math.min(1, (ax + aw / 2 - bx) / bw));
                        py = Math.max(0, Math.min(1, (ay + ah / 2 - by) / bh));
                    }
                }
            } catch (e) {}
            detailRoot.set_pivot_point(px, py);
            detailRoot.ease({opacity: 0, scale_x: 0.92, scale_y: 0.88, duration: 160, mode: EASE,
                onComplete: () => { try { if (detailRoot) detailRoot.visible = false; anchor = null; } catch (e) {} }});
        } else {
            try { anchor = null; } catch (e) {}
        }
        // Bring the tiles back with a matching unfold.
        if (mainKids) for (const k of mainKids) {
            try {
                k.show();
                k.set_pivot_point(0.5, 0);
                k.opacity = 0; k.scale_x = 0.97; k.scale_y = 0.86;
                k.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: 180, mode: EASE});
            } catch (e) {}
        }
    }

    function close() {
        closing = true;
        gen++;
        currentKind = null;
        if (detailRoot) { try { detailRoot.hide(); detailRoot.opacity = 0; } catch (e) {} }
        if (mainKids) for (const k of mainKids) { try { k.show(); } catch (e) {} }
        try { anchor = null; } catch (e) {}
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => { closing = false; return GLib.SOURCE_REMOVE; });
    }

    function destroy() {
        gen++;
        try { detailRoot && detailRoot.destroy(); } catch (e) {}
        detailRoot = null; detailCont = null; mainKids = null;
    }

    return {open, close, destroy, back};
}
