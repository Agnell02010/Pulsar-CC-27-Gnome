/* Control Center widgets, built on the calibrated geometry and drawn in Cairo.
 *
 * drawCalibratedSquircle() is the same superellipse Liquid Glass uses for the
 * glass behind the pods (Apple's continuous corner), and that glass is what
 * paints both the pod body and its edge now: these layers only draw the discs,
 * they never stroke a border and never tint the pod. Nothing is an
 * image: the old PNG discs and SVG backgrounds are gone, which is why the
 * shapes are crisp at any size.
 *
 *   grid    398 = 192 + 14 + 192, outer padding 16, gap 14
 *   pill    192 x 89   inner circle d=50 centred at (44, 44.5)
 *                      text from x=78, vertically centred, wraps
 *   media   192 x 192  (= 89 + 14 + 89), cover 50x50 r=9 at 18,18
 *   circle  89 x 89
 *   slider  398 x 82
 */
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Cairo from 'gi://cairo';

/* One knob: the calibrated reference is 1:1 at 398 x 622, which is big on a
 * desktop. 0.76 keeps every proportion of that reference and lands the panel on
 * the size it had before (146px columns, 310 + padding of it). */
export const SCALE = 0.76;

export const PAD = Math.round(16 * SCALE);          // 12
export const GAP = Math.round(14 * SCALE);          // 11
export const COL = Math.round(192 * SCALE);         // 146
export const GRID = COL * 2 + GAP;                  // 303
export const PILL_W = COL;                          // 146
export const PILL_H = Math.round(89 * SCALE);       // 68
export const MEDIA = PILL_H * 2 + GAP;              // 147
export const CIRCLE = PILL_H;                       // 68
export const SLIDER_W = GRID;                       // 303
export const SLIDER_H = Math.round(82 * SCALE);     // 62

/* 50 spec units = 38 rendered: the photo's white disc is 72/1.457 ~= 49.4.
 * Its centre sits at 44 spec units from the pod edge (was 47: 3 too far right,
 * which is one of the reasons the text looked glued to the disc). */
export const BUBBLE = 38;                            // 50 spec units
export const BUBBLE_CX = Math.round(44 * SCALE);     // 33
export const BUBBLE_CY = PILL_H / 2;
export const TEXT_LEFT = Math.round(78 * SCALE);     // 59, the photo's 78-79
export const TEXT_RIGHT = Math.round(4 * SCALE);     // 3
export const TEXT_W = PILL_W - TEXT_LEFT - TEXT_RIGHT;
export const TEXT_TOP = Math.round((PILL_H - BUBBLE) / 2);  // disc inset

/* How much white the option disc adds on top of the pill's glass. The disc has
 * to read as a lighter circle inside the pod (macOS does the same), but it must
 * stay translucent: this is a sheen, not a coat of grey paint. */
const BUBBLE_LIGHT = 0.38;

export const ART = Math.round(50 * SCALE);          // 38 (photo: 73 / 1.457)
export const ART_X = Math.round(18 * SCALE);        // 14
export const ART_Y = ART_X;
export const ART_R = Math.round(9 * SCALE);         // 7

export const REF_H = PILL_H;                        // the corner is half the pod
export const EXP_X = 2.88;
export const EXP_Y = 1.9;
export const ARCH = 0.45;

/* The pod shape, drawn with the SAME superellipse Liquid Glass uses for the
 * glass behind it (glass.frag's cornerShape()):
 *
 *     k = min(1 + smoothing, min(halfW, halfH) / radius)
 *     n = -1 / log2(1 - 0.29289322 / k)
 *
 * `n` is the corner exponent: 2 is a plain quarter circle, and as `k` grows the
 * corner stretches out and meets the sides with zero curvature, i.e. the Apple
 * continuous corner. For a pill the radius is half the height, so k stays 1 and
 * n stays 2: the ends are half-circles. That is why the 303x62 sliders read as
 * fully-round capsules while the 147x147 player keeps its soft square corners.
 *
 * Matching the shader matters: both curves are visible at once (the glass below,
 * our fill above), and any mismatch shows up as a second rim.
 * The previous anisotropic superellipse (expX 2.88, expY 1.9) bulged more on
 * top/bottom than on the sides and read as squared-off; this one is symmetric
 * and follows Apple's smoothing. */
function superelly(cr, cx, cy, r, n, a0, a1, steps = 24) {
    for (let i = 1; i <= steps; i++) {
        const t = a0 + (a1 - a0) * i / steps;
        const dx = r * Math.pow(Math.abs(Math.sin(t)), 2 / n);
        const dy = r * Math.pow(Math.abs(Math.cos(t)), 2 / n);
        cr.lineTo(cx + Math.sign(Math.sin(t)) * dx,
                  cy - Math.sign(Math.cos(t)) * dy);
    }
}

export function drawCalibratedSquircle(cr, width, height,
    radius = REF_H / 2, smoothing = 1.0) {

    const bx = width / 2;
    const by = height / 2;
    const r0 = Math.max(0, Math.min(radius, Math.min(bx, by)));
    const k = Math.min(1 + smoothing,
        Math.max(Math.min(bx, by) / Math.max(r0, 1e-3), 1));
    const n = -1 / Math.log2(1 - 0.29289322 / k);
    const r = r0 * k;

    cr.newPath();
    cr.moveTo(r, 0);

    // Top edge, then clockwise: TR, BR, BL, TL corners.
    cr.lineTo(width - r, 0);
    superelly(cr, width - r, r, r, n, 0, Math.PI / 2);
    cr.lineTo(width, height - r);
    superelly(cr, width - r, height - r, r, n, Math.PI / 2, Math.PI);
    cr.lineTo(r, height);
    superelly(cr, r, height - r, r, n, Math.PI, 1.5 * Math.PI);
    cr.lineTo(0, r);
    superelly(cr, r, r, r, n, 1.5 * Math.PI, 2 * Math.PI);
    cr.closePath();
}

/* A disc is glass, not paint.
 *
 * The round buttons ARE Liquid Glass pods, so the frost (and its rim light) is
 * already painted behind them. The old off state filled a 0.42 grey disc at 92%
 * alpha on top of that, which covered the blur completely: over a bright
 * wallpaper every circle read as a flat dark hole instead of glass.  Off is now
 * NOTHING — the pod's own glass is the disc, as on macOS — and on stays a solid
 * white disc, which is exactly the enabled state there.
 *
 * The option circle inside a pill is not a pod: the glass behind it is the
 * pill's, so it needs its own light. It is a translucent white sheen (the same
 * light the pods get, one step brighter) that lets that glass through, so the
 * disc follows the backdrop — light on a light wallpaper, dark on a dark window
 * — instead of being a fixed grey. */
function fillDisc(cr, cx, cy, r, on, sheen = 0) {
    if (!on && sheen <= 0)
        return;                       // off round button: the glass is the disc

    cr.newPath();
    cr.arc(cx, cy, r, 0, 2 * Math.PI);
    if (on) {
        cr.setSourceRGBA(1, 1, 1, 1);
        cr.fill();
        return;
    }
    const light = new Cairo.LinearGradient(0, cy - r, 0, cy + r);
    light.addColorStopRGBA(0.00, 1, 1, 1, sheen);
    light.addColorStopRGBA(0.55, 1, 1, 1, sheen * 0.62);
    light.addColorStopRGBA(1.00, 1, 1, 1, sheen * 0.78);
    cr.setSource(light);
    cr.fill();
}

/* The pod outline as an actor. `bubble` draws the pill's inner circle too,
 * `filled` paints the pod white (the "on" disc of the round buttons). */
export const PodShape = GObject.registerClass(
class PodShape extends St.DrawingArea {
    _init(params = {}) {
        const {bubble = false, circle = false, on = false, ...rest} = params;
        super._init({x_expand: true, y_expand: true, ...rest});
        this._bubble = bubble;
        this._circle = circle;
        this._on = on;
        this.connect('repaint', () => this._draw());
        this.connect('notify::size', () => this.queue_repaint());
    }

    setOn(on) {
        if (this._on === on)
            return;
        this._on = on;
        this.queue_repaint();
    }

    _draw() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        if (w < 8 || h < 8) {
            cr.$dispose();
            return;
        }

        cr.save();

        if (this._circle) {
            // A true circle: on = solid white, off = the Liquid Glass itself.
            if (this._on) {
                cr.newPath();
                cr.arc(w / 2, h / 2, Math.min(w, h) / 2, 0, 2 * Math.PI);
                cr.setSourceRGBA(1, 1, 1, 1);
                cr.fill();
            }
        } else if (this._bubble) {
            // The option disc: glass, never a sphere. The pill body itself is
            // only the Liquid Glass behind it, tinted with the theme's widget
            // colour (pannelli.js keeps that tint in sync), so this layer paints
            // nothing for the pod: a tint of our own is exactly what made the
            // circles and the pills drift apart in colour.
            fillDisc(cr, BUBBLE_CX, h / 2, BUBBLE / 2, this._on, BUBBLE_LIGHT);
        }

        cr.restore();
        cr.$dispose();
    }
});

/* ---------- the widgets ---------- */

export const TogglePillTile = GObject.registerClass(
class TogglePillTile extends St.Widget {
    _init({title, subtitle = null, iconName, icon, singleLineCenter = false, extraClass = ''}) {
        // FixedLayout, not BinLayout: in GNOME Shell 51 Clutter.BinLayout
        // ignores x_align/y_align and centres every child (measured: a child
        // asked at x=14 landed at 54). With FixedLayout the x/y below are the
        // real pixel positions, which is what this calibrated design needs.
        super._init({
            layout_manager: new Clutter.FixedLayout(),
            style_class: `mac-tile ${extraClass}`,
            width: PILL_W,
            height: PILL_H,
            reactive: true,
            can_focus: true,
        });

        this.shape = new PodShape({bubble: true});
        this.shape.set_position(0, 0);
        this.shape.set_size(PILL_W, PILL_H);
        this.add_child(this.shape);

        // Option circle: a button, diameter 38 (50 spec units), centred at
        // (33, 34) — the same circle the outline draws under it.
        this.bubble = new St.Button({
            style_class: 'mac-bubble',
            width: BUBBLE,
            height: BUBBLE,
            can_focus: true,
            reactive: true,
            child: icon ?? new St.Icon({icon_name: iconName, icon_size: 21}),
        });
        this.bubble.set_position(BUBBLE_CX - BUBBLE / 2, TEXT_TOP);   // 14, 15
        this.add_child(this.bubble);

        // Text block: full pill height, and the inner box is centred by the
        // button's own BinLayout, so 1, 2 or 3 lines all sit in the middle.
        this.textBtn = new St.Button({
            style_class: 'mac-tile-text-btn',
            width: TEXT_W,
            height: PILL_H,
            can_focus: true,
            reactive: true,
        });
        this.textBtn.set_position(TEXT_LEFT, 0);

        // The box is exactly as tall as the pill and uses two elastic spacers:
        // that is how the text block is vertically centred without relying on
        // an alignment the shell ignores.
        this.textBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            width: TEXT_W,
            height: PILL_H,
        });
        this.textBox.add_child(new St.Widget({y_expand: true}));

        this.titleLabel = new St.Label({
            text: title,
            style_class: 'mac-title',
            width: TEXT_W,
            reactive: false,
            can_focus: false,
        });
        this.titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.titleLabel.clutter_text.line_wrap = false;
        this.textBox.add_child(this.titleLabel);

        // Always built, even when empty: extension.js refreshes its text later
        // (`this._wifi._sub.text = ...`), and an absent label broke the whole
        // panel build with "this._night._sub is undefined".
        this.subLabel = new St.Label({
            text: subtitle ?? '',
            style_class: 'mac-sub',
            width: TEXT_W,
            reactive: false,
            can_focus: false,
        });
        // The photo wraps the network name onto a second line instead of
        // squeezing it into one ellipsized row.
        this.subLabel.clutter_text.line_wrap = true;
        this.subLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this.subLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.textBox.add_child(this.subLabel);
        this.textBox.add_child(new St.Widget({y_expand: true}));

        this.textBtn.set_child(this.textBox);
        this.add_child(this.textBtn);
    }

    setOn(on) {
        if (on)
            this.add_style_pseudo_class('checked');
        else
            this.remove_style_pseudo_class('checked');
        this.shape.setOn(on);
    }
});

export const MediaSquareTile = GObject.registerClass(
class MediaSquareTile extends St.Widget {
    _init() {
        super._init({
            layout_manager: new Clutter.FixedLayout(),
            style_class: 'mac-media',
            width: MEDIA,
            height: MEDIA,
            x_expand: true,
            reactive: true,
        });

        this.shape = new PodShape();
        this.shape.set_position(0, 0);
        this.shape.set_size(MEDIA, MEDIA);
        this.add_child(this.shape);

        // Album cover: 50 spec units, radius 9, at (18, 18).
        this.art = new St.Widget({
            style_class: 'mac-media-art',
            width: ART,
            height: ART,
        });
        this.art.set_position(ART_X, ART_Y);
        this.add_child(this.art);

        // Text starts at 92 spec units (the photo's measured title top).
        const titleTop = Math.round(88 * SCALE);     // 67
        const textW = MEDIA - ART_X * 2;
        this.titleLabel = new St.Label({
            text: '',
            style_class: 'mac-title mac-media-title',
            width: textW,
        });
        this.titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.titleLabel.clutter_text.line_wrap = false;
        this.titleLabel.set_position(ART_X, titleTop);
        this.add_child(this.titleLabel);

        this.subLabel = new St.Label({
            text: '',
            style_class: 'mac-sub mac-media-sub',
            width: textW,
        });
        this.subLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.subLabel.clutter_text.line_wrap = false;
        this.subLabel.set_position(ART_X, titleTop + Math.round(24 * SCALE));  // 85
        this.add_child(this.subLabel);

        // The controls sit a little above the bottom edge, as in the photo.
        // Full width + two elastic spacers in _buildMedia: the row is centred
        // without any alignment property.
        this.controls = new St.BoxLayout({
            style_class: 'mac-media-controls',
            width: MEDIA,
            height: 30,
        });
        this.controls.set_position(0, MEDIA - Math.round(21 * SCALE) - 30);   // 101
        this.add_child(this.controls);
    }
});

export const CircleTile = GObject.registerClass(
class CircleTile extends St.Widget {
    _init({icon, extraClass = ''}) {
        super._init({
            layout_manager: new Clutter.FixedLayout(),
            style_class: `mac-circle ${extraClass}`,
            width: CIRCLE,
            height: CIRCLE,
            can_focus: true,
            reactive: true,
        });

        this.shape = new PodShape({circle: true});
        this.shape.set_position(0, 0);
        this.shape.set_size(CIRCLE, CIRCLE);
        this.add_child(this.shape);

        this.button = new St.Button({
            style_class: 'mac-circle-button',
            width: CIRCLE,
            height: CIRCLE,
            can_focus: true,
            reactive: true,
            child: icon,
        });
        this.button.set_position(0, 0);
        this.add_child(this.button);
    }

    setOn(on) {
        if (on)
            this.add_style_pseudo_class('checked');
        else
            this.remove_style_pseudo_class('checked');
        this.shape.setOn(on);
    }
});

export const SliderBar = GObject.registerClass(
class SliderBar extends St.Widget {
    _init({title, lowIcon, highIcon, slider, trail = null}) {
        super._init({
            layout_manager: new Clutter.FixedLayout(),
            style_class: 'mac-slider-tile',
            width: SLIDER_W,
            height: SLIDER_H,
            reactive: true,
        });

        this.shape = new PodShape();
        this.shape.set_position(0, 0);
        this.shape.set_size(SLIDER_W, SLIDER_H);
        this.add_child(this.shape);

        this.titleLabel = new St.Label({
            text: title,
            style_class: 'mac-title',
        });
        // 24 spec units from the left, ~13 from the top.
        this.titleLabel.set_position(Math.round(24 * SCALE), 10);   // 18, 10
        this.add_child(this.titleLabel);

        // The bar row sits at 44 from the top (the photo's 57/82 of the pod),
        // far enough below the title that the two never touch.
        const rowH = 28;
        this.row = new St.BoxLayout({
            style_class: 'mac-slider-row',
            width: SLIDER_W - Math.round(21 * SCALE) * 2,     // 271
            height: rowH,
        });
        this.row.set_position(Math.round(21 * SCALE), 30);   // 16, 30
        this.add_child(this.row);

        this.row.add_child(lowIcon);
        this.slider = slider;
        this.row.add_child(slider);
        this.row.add_child(highIcon);
        if (trail)
            this.row.add_child(trail);
    }
});
