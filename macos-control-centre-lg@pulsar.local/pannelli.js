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
    function switchRow(iconName, chipClass, label, sw) {
        return mkRow(iconName, label, sw, chipClass);
    }

    function skeletonWifi() {
        let quiet = true;
        const list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, name: 'wifi-list'});
        const refreshList = () => {
            if (currentKind !== 'wifi' || !detailRoot || !detailRoot.visible) return;
            populateWifi(list, gen).catch(() => {});
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
            populateBluetooth(list, gen).catch(() => {});
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

    async function populateWifi(list, myGen) {
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
                list.add_child(b);
            }
        } catch (e) {
            if (gen !== myGen) return;
            warn(`populate Wi-Fi failed (NetworkManager absent?): ${e && (e.message || e)}`);
            clearChildren(list);
            list.add_child(infoRow(tr('noNM', 'NetworkManager not available.')));
        }
    }

    async function populateBluetooth(list, myGen) {
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
                                if (gen === myGen) populateBluetooth(list, myGen).catch(() => {});
                                return GLib.SOURCE_REMOVE;
                            });
                        })
                        .catch(e => warn(`Bluetooth ${dev.connected ? 'disconnect' : 'connect'} failed: ${e && (e.message || e)}`));
                });
                list.add_child(b);
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
        // Grow out of the pill. The fade and the stretch share one duration so
        // the sheet reads as a single motion, and the ease stays monotonic (no
        // overshoot past 1.0): Liquid Glass rebuilds the pod's blur region every
        // time its size changes, so an overshoot would make it grow, shrink and
        // rebuild again — that stutter is what made the reveal feel choppy.
        //
        // The content stays hidden for the first stretch: a pod's own opacity
        // does not touch its Liquid Glass (only its content), so what you see is
        // the bare glass stretching out of the pill, and the text fades in only
        // once the sheet is nearly full — the pill widening and changing its
        // text, rather than a new panel popping open.
        // onDone fires only when the reveal is over, so the caller can do its
        // heavy work (DBus, building rows) without fighting the animation.
        detailRoot.ease({opacity: 255, delay: 110, duration: 130, mode: EASE});
        detailRoot.ease({
            scale_x: 1,
            scale_y: 1,
            duration: 240,
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
                const out = mkSwitch(true, () => {});
                detailCont.add_child(switchRow('audio-volume-high-symbolic', 'mac-chip-purple', tr('output', 'Output'), out));
                detailCont.add_child(sep());
                detailCont.add_child(settingsRow('gnome-control-center sound', 'Sound Settings…', 'mac-chip-purple'));
            });
            else if (kind === 'display') skeletonSimple(tr('display', 'Display'), () => {
                const night = mkSwitch(!!(ext._colorSettings && ext._colorSettings.get_boolean('night-light-enabled')), (on) => {
                    try { ext._colorSettings && ext._colorSettings.set_boolean('night-light-enabled', on); } catch (e) {}
                    syncMainTiles();
                });
                detailCont.add_child(switchRow('weather-clear-night-symbolic', 'mac-chip-orange', tr('night', 'Night Shift'), night));
                detailCont.add_child(sep());
                detailCont.add_child(settingsRow('gnome-control-center display', 'Display Settings…', 'mac-chip-orange'));
            });
            else if (kind === 'focus') skeletonSimple(tr('dnd', 'Focus'), () => {
                const sw = mkSwitch(!!(ext._notifSettings && !ext._notifSettings.get_boolean('show-banners')), (on) => {
                    try { ext._notifSettings && ext._notifSettings.set_boolean('show-banners', !on); } catch (e) {}
                    syncMainTiles();
                });
                detailCont.add_child(switchRow('notifications-disabled-symbolic', 'mac-chip-purple', tr('dndShort', 'Do Not Disturb'), sw));
                detailCont.add_child(sep());
                detailCont.add_child(settingsRow('gnome-control-center notifications', 'Notifications Settings…', 'mac-chip-purple'));
            });
            else { resetMainInstant(); return false; }

            // The data queries run only when the reveal is over. Building the rows
            // (and the panel relayout that follows) blocks the main loop for a
            // hundred-odd milliseconds, and while the reveal was animating that
            // showed up as the sheet freezing halfway through growing. Bluetooth
            // starts scanning right away so devices keep trickling in.
            if (kind === 'bluetooth') startBtDiscovery();
            swapIn(() => {
                if (gen !== myGen) return;
                if (kind === 'wifi') {
                    populateWifi(list, myGen).catch(e => fail(e, 'wifi'));
                } else if (kind === 'bluetooth') {
                    populateBluetooth(list, myGen).catch(e => fail(e, 'bluetooth'));
                    // Devices trickle in while the adapter scans, so re-read the
                    // list a few times instead of waiting a single long beat —
                    // otherwise the panel sat on "No Bluetooth devices".
                    for (const t of [1500, 3000, 6000, 10000]) {
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, t, () => {
                            if (gen === myGen && currentKind === 'bluetooth' && detailRoot && detailRoot.visible)
                                populateBluetooth(list, myGen).catch(() => {});
                            return GLib.SOURCE_REMOVE;
                        });
                    }
                }
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
        try { detailRoot && detailRoot.destroy(); } catch (e) {}
        detailRoot = null; detailCont = null; mainKids = null;
    }

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
