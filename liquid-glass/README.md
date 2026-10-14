# Profili Liquid Glass

Questa cartella contiene due profili pronti per l'estensione
**Liquid Glass** (`liquid-glass@thinkingcoding1231.gmail.com`), che servono a
far combaciare il vetro con il Centro di controllo.

## Applicare un profilo

```bash
./applica-profilo.sh no-blur    # vetro senza sfocatura (consigliato)
./applica-profilo.sh blur       # vetro con sfocatura
./applica-profilo.sh salva      # salva le impostazioni attuali
```

Oppure, a mano:

```bash
dconf load /org/gnome/shell/extensions/liquid-glass/ \
    < "liquid_glass_settings(NO_BLUR).txt"
```

Lo script salva automaticamente un backup delle impostazioni precedenti in
`~/.config/pulsar-cc/lg-backup/`.

## Quale scegliere?

| | NO_BLUR | BLUR |
|---|---|---|
| Sfocatura | no | sì |
| Prestazioni | migliori | più pesante |
| Effetto | vetro netto e leggero | vetro morbido |

## Valori importanti per il Centro di controllo

| Chiave | NO_BLUR | BLUR | Significato |
|---|---|---|---|
| `quick-settings-apply-to` | `1` | `1` | applica il vetro a tutte le tessere (*Toggles*) |
| `quick-settings-toggle-corner-radius` | `30.0` | `32.5` | raggio del vetro sulle tessere |
| `quick-settings-glass-expand` | `0` | `0` | il vetro **non** deve sbordare dal pannello |
| `quick-settings-blur-radius` | `1` | `12` | sfocatura del pannello |
| `quick-settings-corner-radius` | `35.63` | `35.63` | raggio del pannello vetro |
| `output-logs` | `false` | `false` | log di debug disattivati |

> Se il vetro esce fuori dal pannello, `quick-settings-glass-expand` deve
> restare `0` e il raggio (`toggle-corner-radius`) va abbassato (es. `29`).
