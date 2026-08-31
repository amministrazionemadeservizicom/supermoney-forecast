# Proiezione Produzione

Tool a pagina singola per inserire la produzione giornaliera e vedere subito tre proiezioni per il giorno successivo:

- **Media semplice** — media aritmetica di tutti i giorni inseriti.
- **Trend (regressione lineare)** — retta di tendenza sui dati storici, proietta il giorno dopo seguendo l'andamento (crescita/calo).
- **Media ponderata (ultimi 3 giorni)** — pesi 1-2-3, il giorno più recente pesa il triplo del più lontano (si adatta automaticamente con 1 o 2 soli giorni disponibili).

Include grafico storico + proiezioni e tabella con storico modificabile/eliminabile.

## Stack

Un solo file HTML autosufficiente (`index.html`): niente build, niente dipendenze da installare. CSS e JS sono inline, i font vengono da Google Fonts via CDN.

I dati sono salvati in `localStorage` del browser (chiave `produzione-forecast-v1`) — persistono sul dispositivo/browser usato, non sono sincronizzati tra postazioni diverse. Se serve un archivio condiviso tra più persone/postazioni, va aggiunto un backend (vedi TODO sotto).

## Sviluppo locale

Non serve un server: basta aprire `index.html` nel browser. Per un piccolo server locale (utile per testare bene i font/percorsi):

```bash
npx serve .
# oppure
python3 -m http.server 8080
```

## Deploy su Netlify

Il repo è già pronto per Netlify (vedi `netlify.toml`, pubblica la root senza build):

1. **Drag-and-drop veloce**: vai su [app.netlify.com/drop](https://app.netlify.com/drop) e trascina questa cartella (o uno zip). Ottieni subito un URL live, poi lo colleghi al tuo account Netlify quando vuoi.
2. **Da Git** (consigliato per gli aggiornamenti futuri): inizializza un repo (`git init`, `git add .`, `git commit`), pubblicalo su GitHub/GitLab, poi su Netlify scegli "Import from Git" e collega il repo. Ogni push farà un nuovo deploy automatico.
3. **Netlify CLI**: `npx netlify-cli deploy --prod` dalla cartella del progetto (richiede login `netlify login` la prima volta).

## TODO — integrazione automatica con Supermoney

L'obiettivo è che il numero di produzione giornaliera arrivi in automatico da un report di "Supermoney" invece che via inserimento manuale. Prima di implementarla servono queste informazioni (da chiarire con Debora):

1. Che sistema è esattamente "Supermoney" (gestionale interno, portale web, altro) e c'è una documentazione API?
2. È già disponibile una chiave/token API, o va richiesta al fornitore?
3. In quale report/campo esatto si trova il dato di produzione giornaliera da leggere?

Approccio previsto una volta note queste informazioni: una **Netlify Function** (serverless, cartella `netlify/functions/`) che chiama l'API di Supermoney lato server usando una variabile d'ambiente per la chiave (mai esposta nel browser), recupera il dato del giorno e lo restituisce al frontend, che lo usa per aggiornare automaticamente lo storico al posto dell'inserimento manuale (che resterà comunque disponibile come fallback/correzione).
