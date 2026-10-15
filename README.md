# Pulsar CC 27 — Centro di controllo macOS per GNOME

Un **Centro di controllo in stile macOS** per GNOME Shell 50, con effetto
**Liquid Glass**. Le tessere, i quattro cerchi, il lettore multimediale e gli
slider sono tutti marcati come "toggle" così che l'estensione *Liquid Glass*
applichi il vetro **a tutto**, non solo ai pulsanti.

Realizzato da **[Agnell02010](https://github.com/Agnell02010)**.

![GNOME Shell 50](https://img.shields.io/badge/GNOME%20Shell-50-blue)
![Licenza GPL-2.0](https://img.shields.io/badge/licenza-GPL--2.0--or--later-green)

---

## ✨ Cosa contiene

| Elemento | Descrizione |
|---|---|
| **Tessere** | Wi-Fi/Bluetooth (a pillola), Aereo, Non disturbare, Risparmio energetico, Tema scuro, Screenshot, Registra schermo, Contrasto |
| **4 cerchi** | cerchi perfetti in stile macOS (con effetto vetro) |
| **Lettore** | titolo, artista, copertina arrotondata, tasti *rewind / play-pausa / forward* centrati |
| **Slider** | volume e luminosità allineati, barra sottile come su macOS |
| **Icone** | set di icone SF Symbol, normalizzate 1:1 con macOS |
| **Font** | San Francisco (`SF UI Text`) |
| **Vetro** | Liquid Glass applicato a ogni elemento del pannello |
| **Animazioni** | apertura a cascata, pressione elastica, pop di stato, crossfade play/pausa — regolabili senza logout |

---

## 📋 Requisiti

1. **GNOME Shell 50** (funziona su Wayland e X11).
2. **Estensione [Liquid Glass](https://extensions.gnome.org/extension/7344/liquid-glass/)**
   installata e attiva (`liquid-glass@thinkingcoding1231.gmail.com`).
   *Senza di essa l'estensione funziona lo stesso, ma non compare l'effetto vetro.*
3. *(Consigliato)* tema GNOME Shell **MacTahoe-Dark** per il look 1:1.
   L'estensione è comunque autoprotetta contro i temi che spostano i figli
   delle tessere: il lettore resta centrato anche con altri temi.
4. *(Consigliato)* estensione **User Themes** per applicare il tema.
5. *(Per il lettore)* un lettore MPRIS qualsiasi (Spotify, Firefox, ecc.).

---

## 🚀 Installazione (amico)

```bash
git clone https://github.com/Agnell02010/Pulsar-CC-27-Gnome.git
cd Pulsar-CC-27-Gnome
./install.sh
```

Lo script:

1. copia l'estensione in `~/.local/share/gnome-shell/extensions/`;
2. la abilita;
3. chiede se applicare il profilo **Liquid Glass** incluso (consigliato: NO_BLUR);
4. dice cosa fare per finire (logout/login).

### Manuale (se preferisci)

```bash
# 1. estensione
mkdir -p ~/.local/share/gnome-shell/extensions
cp -r macos-control-centre-lg@pulsar.local ~/.local/share/gnome-shell/extensions/
gnome-extensions enable macos-control-centre-lg@pulsar.local

# 2. Liquid Glass (profilo consigliato, senza blur)
dconf load /org/gnome/shell/extensions/liquid-glass/ \
    < liquid-glass/liquid_glass_settings\(NO_BLUR\).txt

# 3. esci e rientra (su Wayland serve il logout)
```

> ⚠️ Su **Wayland** le nuove estensioni richiedono un **logout/login** per
> essere caricate. Su X11 basta `Alt+F2` → `r`.

### Dopo il login

Premi **`Super+S`** per aprire il Centro di controllo (o clicca l'icona di
sistema in alto a destra).

---

## 🎛️ Profili Liquid Glass

Nella cartella `liquid-glass/` trovi due profili pronti:

| Profilo | Effetto | Uso |
|---|---|---|
| `liquid_glass_settings(NO_BLUR).txt` | vetro **senza** sfocatura | **consigliato**, più leggero |
| `liquid_glass_settings(BLUR).txt` | vetro **con** sfocatura | effetto più "morbido" |

Applichi un profilo con:

```bash
dconf load /org/gnome/shell/extensions/liquid-glass/ < liquid-glass/liquid_glass_settings\(NO_BLUR\).txt
```

oppure con gli script inclusi:

```bash
./liquid-glass/applica-profilo.sh no-blur
./liquid-glass/applica-profilo.sh blur
```

I valori chiave per il Centro di controllo sono:

```
quick-settings-apply-to=1                # modalità "Toggles" (vetro su tutto)
quick-settings-toggle-corner-radius=30.0 # raggio delle tessere (vetro che combacia)
quick-settings-glass-expand=0            # il vetro NON deve sbordare dal pannello
```

---

## 🎬 Animazioni (e come regolarle senza logout)

L'estensione replica le animazioni in stile macOS:

| Animazione | Cosa fa |
|---|---|
| **Apertura a cascata** | all'apertura le tessere entrano una dopo l'altra (fade + mini-zoom), da sinistra a destra |
| **Pressione** | quando schiacci una tessera/un cerchio/un tasto del lettore, si comprime e torna su con un rimbalzo elastico |
| **Pop di stato** | la bolla (o il cerchio) fa un piccolo "pop" quando passa da off a on |
| **Play/Pausa** | il glifo cambia con una dissolvenza incrociata |
| **Slider** | la tessera si solleva leggermente mentre trascini lo slider |

> ⚠️ GNOME (St) **non supporta le animazioni in CSS**, quindi sono scritte in
> JavaScript. La prima volta che installi questa versione serve **un logout**
> (una volta sola).

**Per regolarle NON serve più fare logout.** Alla prima accensione viene creato
questo file:

```
~/.config/pulsar-cc/animazione.json
```

viene **riletto a ogni apertura** del Centro di controllo: modifichi un numero,
riapri il pannello e vedi subito l'effetto. Se il file è assente o ha un errore,
si usano i valori predefiniti (nessun rischio).

```jsonc
{
    "enabled": true,          // false = nessuna animazione

    "enterBase": 30,          // ritardo iniziale della cascata (ms)
    "enterStep": 18,          // distanza fra due tessere (ms)  ← il "ritmo"
    "enterDuration": 240,     // durata dell'entrata (ms)
    "enterScale": 0.96,       // da che scala parte (1 = solo dissolvenza)
    "enterRise": 4,           // di quanti px scende dall'alto (0 = niente)

    "pressScale": 0.94,       // quanto si schiaccia premendo
    "pressDown": 80,          // tempo per schiacciarsi (ms)
    "pressUp": 240,           // tempo per tornare su, col rimbalzo (ms)

    "popScale": 1.12,         // quanto si allarga la bolla al cambio stato
    "popDown": 110,
    "popUp": 230,
    "popDelay": 120,          // aspetta che finisca la pressione (ms)

    "iconOut": 80,            // play→pausa: uscita del glifo (ms)
    "iconIn": 200,            // play→pausa: entrata del glifo (ms)

    "sliderLift": 1.02,       // quanto si solleva la tessera trascinando
    "sliderUp": 140,
    "sliderDown": 240
}
```

Esempi rapidi:

- cascata più lenta e "di lusso": `enterStep: 30`, `enterDuration: 320`
- più secca/istantanea (stile macOS): `enterStep: 12`, `enterDuration: 180`
- niente rimbalzo: `pressUp: 120`
- tutto spento: `enabled: false`

Una copia del file è anche in [`animazione-esempio.json`](animazione-esempio.json).

---

## 🗑️ Disinstallazione

```bash
./uninstall.sh
```

Rimuove l'estensione (lascia intatte le impostazioni di Liquid Glass). Poi
esci e rientra.

---

## 🔧 Struttura del progetto

```
.
├── macos-control-centre-lg@pulsar.local/   # l'estensione GNOME
│   ├── extension.js                        # logica (pannello, MPRIS, luminosità, animazioni…)
│   ├── stylesheet.css                      # tutto lo stile (tessere, cerchi, slider)
│   ├── metadata.json
│   ├── icons/                              # icone SVG in stile SF Symbol
│   └── *.png                               # bolle / cerchi di sfondo
├── liquid-glass/                           # profili per l'estensione Liquid Glass
│   ├── liquid_glass_settings(NO_BLUR).txt
│   ├── liquid_glass_settings(BLUR).txt
│   └── applica-profilo.sh
├── install.sh
├── uninstall.sh
├── animazione-esempio.json                 # esempio dei parametri animazioni
├── LICENSE
└── README.md
```

---

## ❓ Domande frequenti

**Non vedo l'estensione dopo l'installazione.**
Su Wayland serve un logout/login. Verifica con
`gnome-extensions list --enabled | grep macos`.

**Il vetro esce fuori dal pannello / sborda.**
Applica il profilo NO_BLUR (ha `quick-settings-glass-expand=0` e
`quick-settings-toggle-corner-radius=30.0`) oppure abbassa ancora il raggio.

**Il pannello ha un fondo nero dietro al vetro.**
L'estensione lo rimuove da sola con `.quick-settings { background: none }`.
Se hai un tema personalizzato che lo rimette, controlla il tuo tema.

**Il lettore è spostato a destra.**
L'estensione neutralizza il padding che i temi (es. MacTahoe) iniettano nei
figli delle tessere. Se usi un tema diverso, apri una issue.

**Su che versioni funziona?**
GNOME Shell 50. Per altre versioni potrebbe servire un adattamento.

---

## 📜 Licenza

GPL-2.0-or-later — vedi [LICENSE](LICENSE).

Se preferisci un'altra licenza (MIT, GPL-3.0, …) apri una issue.

---

## English (short)

A **macOS-style Control Centre** for GNOME Shell 50 with a **Liquid Glass**
effect applied to *every* element (tiles, circles, media player, sliders).

Requirements: GNOME Shell 50, [Liquid Glass](https://extensions.gnome.org/extension/7344/liquid-glass/)
extension *(optional but needed for the glass)*, optionally the *MacTahoe-Dark*
shell theme.

```bash
git clone https://github.com/Agnell02010/Pulsar-CC-27-Gnome.git
cd Pulsar-CC-27-Gnome
./install.sh          # installs + enables the extension
# then log out and back in (Wayland)
```

Press `Super+S` to open the Control Centre. Apply a Liquid Glass profile from
`liquid-glass/` with `dconf load` (see above). Licensed under GPL-2.0-or-later.
