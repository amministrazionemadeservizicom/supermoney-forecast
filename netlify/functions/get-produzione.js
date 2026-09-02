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

async function fetchCSV(token, from, to) {
  const url =
    `${BASE_URL}/service/consuntivo/csv-tl` +
    `?tipoProdotto[]=utility&from=${from}&to=${to}&resultsPerPage=2000&page=1&limit=2000`;
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
    "modalita pagamento": "modalitaPagamento",
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
        modalitaPagamento: cols[idx.modalitaPagamento] ?? "",
      };
    });
}

function isExcluded(stato) {
  const s = (stato || "").toLowerCase();
  return s.startsWith("ko") || s.includes("annullat");
}

function isRid(modalitaPagamento) {
  const m = (modalitaPagamento || "").toLowerCase();
  return m.includes("sdd") || m.includes("addebito");
}

function buildBreakdown(rows) {
  let total = 0;
  const byFornitore = {};
  const byTipoFornitura = {};
  let rid = 0;

  for (const row of rows) {
    if (isExcluded(row.stato)) continue; // ignora KO e annullati

    total++;
    const isRidPayment = isRid(row.modalitaPagamento);
    if (isRidPayment) rid++;

    const f = row.fornitore || "Altro";
    if (!byFornitore[f]) byFornitore[f] = { total: 0, rid: 0 };
    byFornitore[f].total++;
    if (isRidPayment) byFornitore[f].rid++;

    const tf = row.tipoFornitura || "Altro";
    if (!byTipoFornitura[tf]) byTipoFornitura[tf] = { total: 0 };
    byTipoFornitura[tf].total++;
  }

  const ridPct = total > 0 ? ((rid / total) * 100).toFixed(1) : "0.0";
  return { total, byFornitore, byTipoFornitura, rid, ridPct };
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

  // Calcola la data di riferimento in ora italiana (Europe/Rome)
  const nowIt = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Rome" }));
  function isoDate(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  const todayIt = isoDate(nowIt);

  const defaultFrom = todayIt.slice(0, 7) + "-01"; // primo del mese corrente
  // Se viene passata una singola "date", usala per entrambi (backward compat)
  const from = params.from || (params.date ? params.date : defaultFrom);
  const to   = params.to   || (params.date ? params.date : todayIt);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
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
    const csvText = await fetchCSV(token, from, to);
    const rows = parseCSVRows(csvText);

    if (rows.length === 0) {
      return {
        statusCode: 200,
        headers: RESPONSE_HEADERS,
        body: JSON.stringify({
          from, to,
          value: 0, rid: 0, ridPct: "0.0",
          byFornitore: {}, byFornitoreActive: {},
          byTipoFornitura: {},
        }),
      };
    }

    const { total, byFornitore, byTipoFornitura, rid, ridPct } = buildBreakdown(rows);

    // byFornitore per il frontend: solo count per provider
    const byFornitoreCount = {};
    for (const [f, r] of Object.entries(byFornitore)) {
      byFornitoreCount[f] = r.total;
    }

    return {
      statusCode: 200,
      headers: RESPONSE_HEADERS,
      body: JSON.stringify({
        from, to,
        value: total,
        rid,
        ridPct,
        byFornitore,
        byFornitoreActive: byFornitoreCount,
        byTipoFornitura,
      }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: RESPONSE_HEADERS,
      body: JSON.stringify({ error: err.message || "Errore nel recupero dati da Supermoney." }),
    };
  }
};
