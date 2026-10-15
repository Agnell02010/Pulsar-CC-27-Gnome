# Liquid Glass profiles

This folder contains two ready-made profiles for the
**Liquid Glass** extension (`liquid-glass@thinkingcoding1231.gmail.com`), used
to make the glass line up with the Control Center.

## Applying a profile

```bash
./applica-profilo.sh no-blur    # glass without blur (recommended)
./applica-profilo.sh blur       # glass with blur
./applica-profilo.sh salva      # save the current settings
```

Or by hand:

```bash
dconf load /org/gnome/shell/extensions/liquid-glass/ \
    < "liquid_glass_settings(NO_BLUR).txt"
```

The script automatically backs up the previous settings to
`~/.config/pulsar-cc/lg-backup/`.

## Which one to pick?

| | NO_BLUR | BLUR |
|---|---|---|
| Blur | no | yes |
| Performance | better | heavier |
| Look | crisp, light glass | soft glass |

## Keys that matter for the Control Center

| Key | NO_BLUR | BLUR | Meaning |
|---|---|---|---|
| `quick-settings-apply-to` | `1` | `1` | apply the glass to every tile (*Toggles* mode) |
| `quick-settings-toggle-corner-radius` | `30.0` | `32.5` | corner radius of the glass on the tiles |
| `quick-settings-glass-expand` | `0` | `0` | the glass must **not** overflow the panel |
| `quick-settings-blur-radius` | `1` | `12` | blur of the panel |
| `quick-settings-corner-radius` | `35.63` | `35.63` | corner radius of the glass panel |
| `output-logs` | `false` | `false` | debug logging off |

> If the glass overflows the panel, `quick-settings-glass-expand` must stay `0`
> and the radius (`toggle-corner-radius`) should be lowered (e.g. `29`).
