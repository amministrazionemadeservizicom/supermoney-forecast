"use strict";

const BASE_URL = "https://reports-retidigitali.supermoney.it";

async function login() {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: JSON.stringify({
      email: process.env.SM_REPORTS_EMAIL,
      password: process.env.SM_REPORTS_PASSWORD,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Login Supermoney fallito (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.token) throw new Error("Nessun token nella risposta di login Supermoney.");
  return data.token;
}

async function fetchCSV(token, date) {
  const url =
    `${BASE_URL}/service/consuntivo/csv-tl` +
    `?tipoProdotto[]=utility&from=${date}&to=${date}&resultsPerPage=2000&page=1&limit=2000`;
  const res = await fetch(url, {
    headers: {
      Authorization: token,
      "X-Requested-With": "XMLHttpRequest",
    },
  });
  if (!res.ok) throw new Error(`Fetch CSV Supermoney fallito (${res.status}).`);
  return res.text();
}

// Parsa una riga CSV delimitata da ";" con supporto a campi quotati
function parseLine(line) {
  const cols = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQuote = !inQuote; }
    } else if (ch === ";" && !inQuote) {
      cols.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cols.push(cur.trim());
  return cols;
}

function parseCSVRows(csvText) {
  const lines = csvText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split("\n");
  if (lines.length < 2) return [];

  const rawHeaders = parseLine(lines[0]).map((h) => h.toLowerCase());

  const colMap = {
    "stato": "stato",
    "fornitore": "fornitore",
    "tipo fornitura": "tipoFornitura",
    "tipo contratto": "tipoContratto",
  };

  const idx = {};
  rawHeaders.forEach((h, i) => {
    if (colMap[h] !== undefined) idx[colMap[h]] = i;
  });

  return lines
    .slice(1)
    .filter((l) => l.trim())
    .map((line) => {
      const cols = parseLine(line);
      return {
        stato: cols[idx.stato] ?? "",
        fornitore: cols[idx.fornitore] ?? "",
        tipoFornitura: cols[idx.tipoFornitura] ?? "",
        tipoContratto: cols[idx.tipoContratto] ?? "",
      };
    });
}

function classifyStato(stato) {
  const s = stato.toLowerCase();
  if (s.startsWith("ko")) return "ko";
  if (s === "contratto attivato") return "ok";
  return "progress";
}

function buildBreakdown(rows) {
  const totals = { total: 0, ok: 0, progress: 0, ko: 0 };
  const byFornitore = {};
  const byTipoFornitura = {};

  for (const row of rows) {
    const type = classifyStato(row.stato);
    totals.total++;
    totals[type]++;

    const f = row.fornitore || "Altro";
    if (!byFornitore[f]) byFornitore[f] = { total: 0, ok: 0, progress: 0, ko: 0 };
    byFornitore[f].total++;
    byFornitore[f][type]++;

    const tf = row.tipoFornitura || "Altro";
    if (!byTipoFornitura[tf]) byTipoFornitura[tf] = { total: 0, ok: 0, progress: 0, ko: 0 };
    byTipoFornitura[tf].total++;
    byTipoFornitura[tf][type]++;
  }

  return { totals, byFornitore, byTipoFornitura };
}

const RESPONSE_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: RESPONSE_HEADERS, body: "" };
  }

  const params = event.queryStringParameters || {};
  const date = params.date || new Date().toISOString().slice(0, 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return {
      statusCode: 400,
      headers: RESPONSE_HEADERS,
      body: JSON.stringify({ error: "Formato data non valido. Usa YYYY-MM-DD." }),
    };
  }

  if (!process.env.SM_REPORTS_EMAIL || !process.env.SM_REPORTS_PASSWORD) {
    return {
      statusCode: 500,
      headers: RESPONSE_HEADERS,
      body: JSON.stringify({
        error: "Credenziali Supermoney non configurate (variabili d'ambiente SM_REPORTS_EMAIL / SM_REPORTS_PASSWORD mancanti).",
      }),
    };
  }

  try {
    const token = await login();
    const csvText = await fetchCSV(token, date);
    const rows = parseCSVRows(csvText);

    if (rows.length === 0) {
      return {
        statusCode: 200,
        headers: RESPONSE_HEADERS,
        body: JSON.stringify({
          date,
          value: 0,
          totals: { total: 0, ok: 0, progress: 0, ko: 0 },
          byFornitore: {},
          byTipoFornitura: {},
        }),
      };
    }

    const { totals, byFornitore, byTipoFornitura } = buildBreakdown(rows);

    // value = totale contratti del giorno (tutti gli stati), usato dal forecast
    return {
      statusCode: 200,
      headers: RESPONSE_HEADERS,
      body: JSON.stringify({ date, value: totals.total, totals, byFornitore, byTipoFornitura }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: RESPONSE_HEADERS,
      body: JSON.stringify({ error: err.message || "Errore nel recupero dati da Supermoney." }),
    };
  }
};
