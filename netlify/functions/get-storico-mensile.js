"use strict";

const BASE_URL = "https://reports-retidigitali.supermoney.it";

async function login() {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
    body: JSON.stringify({ email: process.env.SM_REPORTS_EMAIL, password: process.env.SM_REPORTS_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login fallito (${res.status})`);
  const data = await res.json();
  if (!data.token) throw new Error("Nessun token nella risposta di login.");
  return data.token;
}

async function fetchCSV(token, from, to) {
  const url = `${BASE_URL}/service/consuntivo/csv-tl?tipoProdotto[]=utility&from=${from}&to=${to}&resultsPerPage=2000&page=1&limit=2000`;
  const res = await fetch(url, { headers: { Authorization: token, "X-Requested-With": "XMLHttpRequest" } });
  if (!res.ok) throw new Error(`Fetch CSV fallito (${res.status})`);
  return res.text();
}

function parseLine(line) {
  const cols = [];
  let cur = "", inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ";" && !inQuote) { cols.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  cols.push(cur.trim());
  return cols;
}

function lastDayOfMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

function workdaysInMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  let count = 0;
  for (let d = 1; d <= last; d++) {
    const dow = new Date(y, m - 1, d).getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

function aggregateMonth(csvText) {
  const lines = csvText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split("\n");
  if (lines.length < 2) return { total: 0, rid: 0, byFornitore: {}, byTipoFornitura: {} };

  const headers = parseLine(lines[0]).map(h => h.toLowerCase());
  const idx = {};
  [["stato","stato"],["modalita pagamento","modalitaPagamento"],["fornitore","fornitore"],["tipo fornitura","tipoFornitura"]].forEach(([h,k]) => {
    const i = headers.indexOf(h);
    if (i !== -1) idx[k] = i;
  });

  let total = 0, rid = 0;
  const byFornitore = {}, byTipoFornitura = {};
  lines.slice(1).filter(l => l.trim()).forEach(line => {
    const cols = parseLine(line);
    const stato = (cols[idx.stato] || "").toLowerCase();
    if (stato.startsWith("ko") || stato.includes("annullat")) return;
    total++;
    const mp = (cols[idx.modalitaPagamento] || "").toLowerCase();
    const isRid = mp.includes("sdd") || mp.includes("addebito");
    if (isRid) rid++;

    const f = (idx.fornitore !== undefined ? cols[idx.fornitore] : "") || "Altro";
    if (!byFornitore[f]) byFornitore[f] = { total: 0, rid: 0 };
    byFornitore[f].total++;
    if (isRid) byFornitore[f].rid++;

    const tf = (idx.tipoFornitura !== undefined ? cols[idx.tipoFornitura] : "") || "Altro";
    if (!byTipoFornitura[tf]) byTipoFornitura[tf] = { total: 0 };
    byTipoFornitura[tf].total++;
  });

  return { total, rid, byFornitore, byTipoFornitura };
}

const HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: HEADERS, body: "" };

  if (!process.env.SM_REPORTS_EMAIL || !process.env.SM_REPORTS_PASSWORD) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: "Credenziali mancanti." }) };
  }

  // months=3 (default) → scarica gli ultimi N mesi completi
  const params = event.queryStringParameters || {};
  const nMonths = Math.min(12, Math.max(1, parseInt(params.months || "6", 10)));

  try {
    const token = await login();
    const results = [];
    const now = new Date();

    for (let i = 1; i <= nMonths; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const ym = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      const from = ym + "-01";
      const to = ym + "-" + String(lastDayOfMonth(ym)).padStart(2, "0");
      const workdays = workdaysInMonth(ym);

      const csvText = await fetchCSV(token, from, to);
      const { total, rid, byFornitore, byTipoFornitura } = aggregateMonth(csvText);
      const ridPct = total > 0 ? ((rid / total) * 100).toFixed(1) : "0.0";

      results.push({ month: ym, total, rid, ridPct, workdays, byFornitore, byTipoFornitura });
    }

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ months: results }) };
  } catch (err) {
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
