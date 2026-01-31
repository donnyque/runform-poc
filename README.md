# RunForm PoC

RunForm PoC er en mobil-web-app til løbeform-feedback på løbebånd. Appen bruger telefonens kamera og pose-estimering (MediaPipe) til at vise et skelet-overlay i realtid og beregne simple mål under løb. Målingerne er relative og vejledende – ikke medicinske.

## Features

- **Pose-overlay** – Live skelet over video fra frontkamera
- **Kalibrering** – Baseline-lås (5 sek) før tracking
- **Metrics** – Kadence (spm), stabilitet, VO proxy (relativ), frame quality og pålidelighed
- **Pause / Fortsæt** – Pause under session; total tid og aktiv tid vises
- **Session summary** – Oversigt med nøgletal, indsigt, sparklines og sammenligning med forrige session
- **Historik** – Seneste sessioner (max 30), åbn/slet
- **Eksport** – Kopier summary som tekst eller download session som JSON

## Sådan bruger du appen

1. Åbn appen via **HTTPS** (påkrævet for kamera) på din telefon.
2. **Placér telefonen** stabilt – gulv, skammel eller stativ – så hele kroppen er i billedet.
3. Tryk **Start** og hold still under kalibreringen (5 sek).
4. Når baseline er låst: **Løb** på løbebåndet. Du kan bruge **Pause** og **Fortsæt** undervejs.
5. Tryk **Stop og se resultat** for at se summary med nøgletal og indsigt.

## Begrænsninger

- Målingerne er **relative** og afhænger af lys, vinkel og afstand.
- Bedst resultat fås typisk med **kamera fra siden** (ikke direkte forfra).
- Appen er **ikke til medicinsk brug** – kun til generel løbe-feedback.

## Lokal udvikling

```bash
npm install
npm run dev
```

Åbn den viste URL i browser (HTTPS på mobil kræver fx tunnel eller lokal netværks-URL).

Build til produktion:

```bash
npm run build
```

## License

All rights reserved.
