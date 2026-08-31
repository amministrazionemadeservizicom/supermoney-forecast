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

## Integrazione automatica con Supermoney

Il pulsante **"Sincronizza da Supermoney"** (accanto al form) chiama la Netlify Function `get-produzione`, che:
1. Fa login a `reports-retidigitali.supermoney.it` con le credenziali da variabili d'ambiente
2. Scarica il CSV consuntivo per la data selezionata
3. Conta i contratti per stato (OK / in lavorazione / KO) e per gestore e tipo fornitura
4. Restituisce `{ date, value, totals, byFornitore, byTipoFornitura }`

Il frontend precompila il campo **Produzione** con il totale contratti del giorno e mostra il breakdown. L'utente può modificare il valore prima di salvare con **Aggiungi**.

### Variabili d'ambiente su Netlify

Nel pannello Netlify → **Site configuration → Environment variables**, aggiungi:

| Variabile | Valore |
|---|---|
| `SM_REPORTS_EMAIL` | email di accesso a Supermoney Reports |
| `SM_REPORTS_PASSWORD` | password corrispondente |

### Test in locale con `netlify dev`

1. Installa la CLI (una sola volta): `npm install -g netlify-cli`
2. Crea un file `.env` nella root del progetto (non committato — è in `.gitignore`):
   ```
   SM_REPORTS_EMAIL=tua@email.it
   SM_REPORTS_PASSWORD=tuapassword
   ```
3. Avvia: `netlify dev`
4. Il sito gira su `http://localhost:8888` e la function è disponibile su
   `http://localhost:8888/.netlify/functions/get-produzione?date=2025-08-31`

### Mock locale (se l'API non e' raggiungibile)

Se vuoi sviluppare senza credenziali reali, commenta temporaneamente il corpo di `netlify/functions/get-produzione.js` e restituisci dati finti:

```js
exports.handler = async function(event) {
  const date = (event.queryStringParameters || {}).date || new Date().toISOString().slice(0,10);
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      date,
      value: 42,
      totals: { total: 42, ok: 18, progress: 20, ko: 4 },
      byFornitore: {
        "Acea": { total: 15, ok: 7, progress: 7, ko: 1 },
        "Edison": { total: 12, ok: 5, progress: 6, ko: 1 },
        "E.On": { total: 15, ok: 6, progress: 7, ko: 2 },
      },
      byTipoFornitura: {
        "luce": { total: 25, ok: 11, progress: 12, ko: 2 },
        "gas": { total: 17, ok: 7, progress: 8, ko: 2 },
      },
    }),
  };
};
```

## TODO — integrazione automatica con Supermoney (storico)

L'obiettivo è che il numero di produzione giornaliera arrivi in automatico da un report di "Supermoney" invece che via inserimento manuale. Prima di implementarla servono queste informazioni (da chiarire con Debora):

1. Che sistema è esattamente "Supermoney" (gestionale interno, portale web, altro) e c'è una documentazione API?
2. È già disponibile una chiave/token API, o va richiesta al fornitore?
3. In quale report/campo esatto si trova il dato di produzione giornaliera da leggere?

Approccio previsto una volta note queste informazioni: una **Netlify Function** (serverless, cartella `netlify/functions/`) che chiama l'API di Supermoney lato server usando una variabile d'ambiente per la chiave (mai esposta nel browser), recupera il dato del giorno e lo restituisce al frontend, che lo usa per aggiornare automaticamente lo storico al posto dell'inserimento manuale (che resterà comunque disponibile come fallback/correzione).
