import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

const NONE = Gio.DBusCallFlags.NONE;

function decodeSs(ssid) {
    if (!ssid) return '';
    if (Array.isArray(ssid)) {
        // ay
        let s = '';
        for (let i = 0; i < ssid.length; i++) s += String.fromCharCode(ssid[i]);
        return s;
    }
    // string
    try {
        if (typeof ssid === 'string') return ssid;
        return String(ssid);
    } catch (e) {
        return '';
    }
}

function hasSec(flags, wpa, rsn) {
    const f = flags | (wpa || 0) | (rsn || 0);
    // NM_802_11_AP_SECURE = 0x1 etc., but rough: if secured flags set
    return !!f;
}

function dbusCall(bus, name, path, iface, method, params) {
    return new Promise((resolve, reject) => {
        bus.call(name, path, iface, method, params || null, null, NONE, -1, null, (c, res) => {
            try { resolve(c.call_finish(res)); } catch (e) { reject(e); }
        });
    });
}
function dbusGetAll(bus, name, path, iface) {
    return dbusCall(bus, name, path, 'org.freedesktop.DBus.Properties', 'GetAll', new GLib.Variant('(s)', [iface]))
        .then(v => v?.unpack()[0] || {});
}

function mkRow(iconName, label, right) {
    const row = new St.BoxLayout({style_class: 'mac-panel-row', x_expand: true, y_align: Clutter.ActorAlign.CENTER, spacing: 8});
    if (iconName) {
        const ic = new St.Icon({icon_name: iconName, style_class: 'mac-panel-icon'});
        row.add_child(ic);
    }
    const lab = new St.Label({text: label, style_class: 'mac-panel-label', x_expand: true});
    lab.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    row.add_child(lab);
    if (right) {
        if (right instanceof St.Widget) row.add_child(right);
        else {
            const r = new St.Label({text: String(right), style_class: 'mac-panel-sub'});
            row.add_child(r);
        }
    }
    return row;
}

export function crea(ext, h) {
    const {St, Clutter, Gio, GLib, Main} = h.global || imports.gi;
    let detailRoot = null;
    let detailCont = null;
    let currentKind = null;
    let busy = false;
    let wifiTimer = 0;

    function ensureRoot() {
        if (detailRoot) return detailRoot;
        const box = ext._qs.menu.box;
        detailRoot = new St.BoxLayout({vertical: true, style_class: 'mac-cc-detail', visible: false, opacity: 0});
        // add after main panel? main panel is ext._panel
        const children = box.get_children();
        let idx = 0;
        for (let i = 0; i < children.length; i++) {
            if (children[i] === ext._panel) { idx = i + 1; break; }
        }
        box.insert_child_at_index(detailRoot, idx);
        detailCont = new St.BoxLayout({vertical: true, spacing: 6, x_expand: true});
        detailRoot.add_child(detailCont);
        return detailRoot;
    }

    function clear() {
        while (detailCont?.get_n_children()) {
            detailCont.get_last_child()?.destroy();
        }
    }

    function backRow() {
        const b = new St.Button({style_class: 'mac-panel-back', x_expand: true, child: mkRow('go-previous-symbolic', h.tr ? h.tr('back') || '< Back' : '< Back')});
        b.connect('clicked', () => close());
        return b;
    }

    function headerRow(title, switchWidget) {
        const r = new St.BoxLayout({style_class: 'mac-panel-header', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const lab = new St.Label({text: title, style_class: 'mac-panel-title', x_expand: true});
        lab.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        r.add_child(lab);
        if (switchWidget) r.add_child(switchWidget);
        return r;
    }

    function sep() {
        const s = new St.Widget({style_class: 'mac-panel-sep', height: 1, x_expand: true});
        return s;
    }

    function section(title) {
        const l = new St.Label({text: title, style_class: 'mac-panel-section', x_expand: true});
        return l;
    }

    function wifiRow(ap, activePath, devicePath) {
        let right = null;
        if (activePath === ap.path) right = mkRow(null, h.tr ? h.tr('on') || 'Connected' : 'Connected');
        const r = mkRow('network-wireless-signal-good-symbolic', ap.ssid || 'Unknown', right);
        const b = new St.Button({style_class: 'mac-panel-item', x_expand: true, child: r});
        b.connect('clicked', () => {
            // activate
            try {
                const NM = 'org.freedesktop.NetworkManager';
                dbusCall(Gio.DBus.system, NM, '/org/freedesktop/NetworkManager', NM, 'ActivateConnection',
                    new GLib.Variant('(ooo)', ['/', devicePath, ap.path])).catch(() => {});
                close();
            } catch (e) {}
        });
        return b;
    }

    async function buildWifi() {
        clear();
        const NM = 'org.freedesktop.NetworkManager';
        try {
            const devs = await dbusCall(Gio.DBus.system, NM, '/org/freedesktop/NetworkManager', NM, 'GetDevices');
            const paths = devs?.unpack()[0] || [];
            let wifiDev = null;
            for (let i = 0; i < paths.length; i++) {
                try {
                    const d = await dbusGetAll(Gio.DBus.system, NM, paths[i], 'org.freedesktop.NetworkManager.Device');
                    if (d.DeviceType === 2) { wifiDev = {path: paths[i], ...d}; break; }
                } catch (e) {}
            }
            if (!wifiDev) return;
            const w = await dbusGetAll(Gio.DBus.system, NM, wifiDev.path, 'org.freedesktop.NetworkManager.Device.Wireless');
            const aps = w.AccessPoints || [];
            let active = w.ActiveAccessPoint || '/';
            // build AP list
            const list = [];
            for (let i = 0; i < aps.length; i++) {
                try {
                    const a = await dbusGetAll(Gio.DBus.system, NM, aps[i], 'org.freedesktop.NetworkManager.AccessPoint');
                    list.push({path: aps[i], ssid: decodeSs(a.Ssid), strength: a.Strength || 0, flags: a.Flags||0, wpa:a.WpaFlags||0, rsn:a.RsnFlags||0});
                } catch (e) {}
            }
            list.sort((x,y) => (y.strength - x.strength) || (x.ssid.localeCompare(y.ssid)));
            // header
            detailCont.add_child(backRow());
            detailCont.add_child(sep());
            const toggle = new St.Switch({active: true}); // best effort; could read WirelessEnabled
            detailCont.add_child(headerRow('Wi-Fi', toggle));
            detailCont.add_child(sep());
            detailCont.add_child(section('Known Networks'));
            for (let i = 0; i < list.length; i++) {
                detailCont.add_child(wifiRow(list[i], active, wifiDev.path));
            }
            detailCont.add_child(sep());
            const settings = mkRow('preferences-system-symbolic', 'Wi-Fi Settings…');
            const sb = new St.Button({style_class: 'mac-panel-item', x_expand: true, child: settings});
            sb.connect('clicked', () => { h.launch('gnome-control-center wifi'); ext._qs.menu.close(); });
            detailCont.add_child(sb);
        } catch (e) { logError(e, 'wifi detail'); }
    }

    function buildBluetooth() {
        clear();
        detailCont.add_child(backRow());
        detailCont.add_child(sep());
        detailCont.add_child(headerRow('Bluetooth', new St.Switch({active: true})));
        detailCont.add_child(sep());
        detailCont.add_child(section('Devices'));
        detailCont.add_child(mkRow(null, '(Bluetooth devices list — TBD, iterabile con BlueZ ObjectManager)'));
        detailCont.add_child(sep());
        const s = mkRow('preferences-system-symbolic', 'Bluetooth Settings…');
        const sb = new St.Button({style_class: 'mac-panel-item', x_expand: true, child: s});
        sb.connect('clicked', () => { h.launch('gnome-control-center bluetooth'); ext._qs.menu.close(); });
        detailCont.add_child(sb);
    }

    function buildSound() {
        clear();
        detailCont.add_child(backRow());
        detailCont.add_child(sep());
        detailCont.add_child(headerRow(h.tr('sound') || 'Sound', null));
        detailCont.add_child(sep());
        detailCont.add_child(section('Output Devices'));
        detailCont.add_child(mkRow(null, '(Output devices via Gvc — da completare)'));
        detailCont.add_child(sep());
        const s = mkRow('preferences-system-symbolic', 'Sound Settings…');
        const sb = new St.Button({style_class: 'mac-panel-item', x_expand: true, child: s});
        sb.connect('clicked', () => { h.launch('gnome-control-center sound'); ext._qs.menu.close(); });
        detailCont.add_child(sb);
    }

    function buildDisplay() {
        clear();
        detailCont.add_child(backRow());
        detailCont.add_child(sep());
        detailCont.add_child(headerRow(h.tr('display') || 'Display', null));
        detailCont.add_child(sep());
        detailCont.add_child(mkRow(null, 'Brightness'));
        detailCont.add_child(sep());
        const night = new St.Switch({active: ext._colorSettings?.get_boolean('night-light-enabled') || false});
        night.connect('notify::active', () => {
            if (ext._colorSettings) ext._colorSettings.set_boolean('night-light-enabled', night.active);
        });
        detailCont.add_child(headerRow(h.tr('night') || 'Night Shift', night));
        detailCont.add_child(sep());
        const s = mkRow('preferences-system-symbolic', 'Display Settings…');
        const sb = new St.Button({style_class: 'mac-panel-item', x_expand: true, child: s});
        sb.connect('clicked', () => { h.launch('gnome-control-center display'); ext._qs.menu.close(); });
        detailCont.add_child(sb);
    }

    function buildFocus() {
        clear();
        detailCont.add_child(backRow());
        detailCont.add_child(sep());
        detailCont.add_child(headerRow(h.tr('dnd') || 'Focus', null));
        detailCont.add_child(sep());
        const dnd = !ext._notifSettings?.get_boolean('show-banners');
        const sw = new St.Switch({active: dnd});
        sw.connect('notify::active', () => {
            if (ext._notifSettings) ext._notifSettings.set_boolean('show-banners', !sw.active);
        });
        detailCont.add_child(headerRow('Do Not Disturb', sw));
        detailCont.add_child(sep());
        const s = mkRow('preferences-system-symbolic', 'Notifications & Focus Settings…');
        const sb = new St.Button({style_class: 'mac-panel-item', x_expand: true, child: s});
        sb.connect('clicked', () => { h.launch('gnome-control-center notifications'); ext._qs.menu.close(); });
        detailCont.add_child(sb);
    }

    async function build(k) {
        ensureRoot();
        currentKind = k;
        if (k === 'wifi') await buildWifi();
        else if (k === 'bluetooth') await buildBluetooth();
        else if (k === 'sound') await buildSound();
        else if (k === 'display') buildDisplay();
        else if (k === 'focus') buildFocus();
        else return false;
        return true;
    }

    function showDetail() {
        const root = ensureRoot();
        root.visible = true;
        root.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }
    function hideMain() {
        if (ext._panel) {
            ext._panel.ease({opacity: 0, scale_x: 0.98, scale_y: 0.98, duration: 130, mode: Clutter.AnimationMode.EASE_OUT_QUAD, onComplete: () => { if (ext._panel) ext._panel.hide(); }});
        }
    }
    function showMain() {
        if (ext._panel) {
            ext._panel.show();
            ext._panel.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
    }
    function hideDetail() {
        if (detailRoot) {
            detailRoot.ease({opacity: 0, scale_x: 0.98, scale_y: 0.98, duration: 130, mode: Clutter.AnimationMode.EASE_OUT_QUAD, onComplete: () => { if (detailRoot) detailRoot.visible = false; }});
        }
    }

    async function open(k) {
        if (busy) return true;
        busy = true;
        ensureRoot();
        if (currentKind === k && detailRoot?.visible) { close(); busy = false; return true; }
        if (detailRoot?.visible) { hideDetail(); await GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => GLib.SOURCE_REMOVE); }
        hideMain();
        await GLib.timeout_add(GLib.PRIORITY_DEFAULT, 140, () => GLib.SOURCE_REMOVE);
        const ok = await build(k);
        if (ok) showDetail();
        else { showMain(); }
        busy = false;
        return ok;
    }
    function close() {
        if (busy) return;
        busy = true;
        hideDetail();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 140, () => { showMain(); busy = false; return GLib.SOURCE_REMOVE; });
    }
    function destroy() {
        if (wifiTimer) { GLib.source_remove(wifiTimer); wifiTimer = 0; }
        detailRoot?.destroy();
        detailRoot = null; detailCont = null;
    }
    return {open, close, destroy, busy};
}
