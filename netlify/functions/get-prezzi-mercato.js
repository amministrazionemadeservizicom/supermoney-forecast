"use strict";

const { inflateRaw } = require("zlib");
const { promisify } = require("util");
const inflateRawAsync = promisify(inflateRaw);

const GME_BASE = "https://api.mercatoelettrico.org/request";
const ENERGY_CHARTS = "https://api.energy-charts.info";

// Conversioni: GME pubblica in €/MWh
// PUN: €/MWh → €/kWh = ÷ 1000
// PSV: €/MWh → €/smc = × 0.01069 (1 Smc ≈ 9.5 kWh = 0.0095 MWh → ~105.3 Smc/MWh)
const PSV_MWH_TO_SMC = 1 / 105.3;

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

function toYMDInt(d) {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

// ---- GME auth ----
const GME_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0",
  "Accept": "application/json",
};

async function gmeLogin() {
  const res = await fetch(`${GME_BASE}/api/v1/Auth`, {
    method: "POST",
    headers: GME_HEADERS,
    body: JSON.stringify({
      Login: process.env.GME_LOGIN,
      Password: process.env.GME_PASSWORD,
    }),
  });
  if (!res.ok) throw new Error(`GME Auth fallito (${res.status})`);
  const data = await res.json();
  if (!data.token) throw new Error("Nessun token GME");
  return data.token;
}

// ---- ZIP parser (no dipendenze esterne) ----
function parseZipEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset < buffer.length - 4) {
    if (
      buffer[offset] === 0x50 && buffer[offset + 1] === 0x4b &&
      buffer[offset + 2] === 0x03 && buffer[offset + 3] === 0x04
    ) {
      const compression  = buffer.readUInt16LE(offset + 8);
      const compressedSz = buffer.readUInt32LE(offset + 18);
      const filenameLen  = buffer.readUInt16LE(offset + 26);
      const extraLen     = buffer.readUInt16LE(offset + 28);
      const filename     = buffer.toString("utf8", offset + 30, offset + 30 + filenameLen);
      const dataOffset   = offset + 30 + filenameLen + extraLen;
      entries.push({ filename, compression, data: buffer.slice(dataOffset, dataOffset + compressedSz) });
      offset = dataOffset + compressedSz;
    } else {
      offset++;
    }
  }
  return entries;
}

async function decodeZipToCSV(base64) {
  const buf = Buffer.from(base64, "base64");
  const entries = parseZipEntries(buf);
  if (!entries.length) throw new Error("ZIP vuoto o non riconosciuto");
  const entry = entries[0];
  if (entry.compression === 0) return entry.data.toString("utf8");
  if (entry.compression === 8) return (await inflateRawAsync(entry.data)).toString("utf8");
  throw new Error(`Compressione ZIP ${entry.compression} non supportata`);
}

// ---- CSV → medie mensili ----
function csvToMonthly(csvText, priceMultiplier) {
  const lines = csvText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split("\n");
  if (lines.length < 2) return [];

  const delim = lines[0].includes(";") ? ";" : ",";
  const headers = lines[0].split(delim).map(h => h.replace(/"/g, "").trim().toLowerCase());

  const dateIdx  = headers.findIndex(h => /data|date|giorno/i.test(h));
  const priceIdx = headers.findIndex(h => /prezzo|price|pun|psv|value/i.test(h));
  const di = dateIdx  >= 0 ? dateIdx  : 0;
  const pi = priceIdx >= 0 ? priceIdx : 1;

  const monthly = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(delim).map(c => c.replace(/"/g, "").trim());
    if (cols.length <= Math.max(di, pi)) continue;
    const dateStr = cols[di];
    const price   = parseFloat(cols[pi].replace(",", "."));
    if (!dateStr || isNaN(price)) continue;

    let ym;
    if (/^\d{4}-\d{2}/.test(dateStr))       ym = dateStr.slice(0, 7);
    else if (/^\d{2}\/\d{2}\/\d{4}/.test(dateStr)) {
      const [d, m, y] = dateStr.split("/");
      ym = `${y}-${m.padStart(2, "0")}`;
    }
    if (!ym) continue;

    if (!monthly[ym]) monthly[ym] = { sum: 0, n: 0, min: Infinity, max: -Infinity };
    const p = price * priceMultiplier;
    monthly[ym].sum += p;
    monthly[ym].n++;
    if (p < monthly[ym].min) monthly[ym].min = p;
    if (p > monthly[ym].max) monthly[ym].max = p;
  }

  return Object.entries(monthly)
    .map(([month, d]) => ({
      month,
      avg: d.n > 0 ? Math.round(d.sum / d.n * 10000) / 10000 : 0,
      min: d.min === Infinity  ? 0 : Math.round(d.min * 10000) / 10000,
      max: d.max === -Infinity ? 0 : Math.round(d.max * 10000) / 10000,
    }))
    .sort((a, b) => a.month < b.month ? -1 : 1);
}

// ---- Parsing JSON da GAS_ContinuousTrading → medie mensili ---
function gctJsonToMonthly(jsonText) {
  let rows;
  try { rows = JSON.parse(jsonText); } catch (_) { return []; }
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const monthly = {};
  for (const row of rows) {
    const dateStr = String(row.FlowDate || "");
    const price = parseFloat(row.AveragePrice);
    if (dateStr.length !== 8 || isNaN(price) || price <= 0) continue;
    const ym = dateStr.slice(0, 4) + "-" + dateStr.slice(4, 6);
    if (!monthly[ym]) monthly[ym] = { sum: 0, n: 0, min: Infinity, max: -Infinity };
    const p = price * PSV_MWH_TO_SMC; // €/MWh → €/smc
    monthly[ym].sum += p;
    monthly[ym].n++;
    if (p < monthly[ym].min) monthly[ym].min = p;
    if (p > monthly[ym].max) monthly[ym].max = p;
  }

  return Object.entries(monthly)
    .map(([month, d]) => ({
      month,
      avg: d.n > 0 ? Math.round(d.sum / d.n * 10000) / 10000 : 0,
      min: d.min === Infinity  ? 0 : Math.round(d.min * 10000) / 10000,
      max: d.max === -Infinity ? 0 : Math.round(d.max * 10000) / 10000,
    }))
    .sort((a, b) => a.month < b.month ? -1 : 1);
}

// ---- PSV da GME ----
async function fetchPSV(token, intervalStart, intervalEnd) {
  const debugSteps = [];
  for (const dataName of ["GAS_ContinuousTrading", "GAS_PGasResults"]) {
    try {
      const res = await fetch(`${GME_BASE}/api/v1/RequestData`, {
        method: "POST",
        headers: { ...GME_HEADERS, Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          Platform: "PublicMarketResults",
          Segment: "MGP-GAS",
          DataName: dataName,
          IntervalStart: intervalStart,
          IntervalEnd: intervalEnd,
        }),
      });
      debugSteps.push(`${dataName} http=${res.status}`);
      if (!res.ok) continue;
      const data = await res.json();
      debugSteps.push(`${dataName} contentResponse=${!!data.contentResponse}`);
      if (!data.contentResponse) continue;
      const content = await decodeZipToCSV(data.contentResponse);
      debugSteps.push(`${dataName} contentLen=${content.length}`);

      // GAS_ContinuousTrading restituisce JSON; GAS_PGasResults restituisce CSV
      let monthly;
      if (dataName === "GAS_ContinuousTrading") {
        monthly = gctJsonToMonthly(content);
      } else {
        monthly = csvToMonthly(content, PSV_MWH_TO_SMC);
      }
      debugSteps.push(`${dataName} monthly=${monthly.length}`);
      if (monthly.length > 0) return { monthly, source: dataName, debug: debugSteps };
    } catch (e) { debugSteps.push(`${dataName} ERR=${e.message}`); console.error(`PSV ${dataName}:`, e.message); continue; }
  }
  return { monthly: [], source: null, debug: debugSteps };
}

// ---- PUN da energy-charts.info (no auth) ----
async function fetchPUN(isoStart, isoEnd) {
  const url = `${ENERGY_CHARTS}/price?bzn=IT-North&start=${isoStart}&end=${isoEnd}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Energy Charts fallito (${res.status})`);
  const data = await res.json();

  const monthly = {};
  const prices     = data.price        || [];
  const timestamps = data.unix_seconds || [];

  for (let i = 0; i < timestamps.length; i++) {
    const price = prices[i];
    if (price === null || price === undefined) continue;
    const d  = new Date(timestamps[i] * 1000);
    const ym = d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
    if (!monthly[ym]) monthly[ym] = { sum: 0, n: 0, min: Infinity, max: -Infinity };
    // PUN: €/MWh → €/kWh
    const p = price / 1000;
    monthly[ym].sum += p;
    monthly[ym].n++;
    if (p < monthly[ym].min) monthly[ym].min = p;
    if (p > monthly[ym].max) monthly[ym].max = p;
  }

  return Object.entries(monthly)
    .map(([month, d]) => ({
      month,
      avg: d.n > 0 ? Math.round(d.sum / d.n * 100000) / 100000 : 0,
      min: d.min === Infinity  ? 0 : Math.round(d.min * 100000) / 100000,
      max: d.max === -Infinity ? 0 : Math.round(d.max * 100000) / 100000,
    }))
    .sort((a, b) => a.month < b.month ? -1 : 1);
}

// ---- Handler ----
exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: HEADERS, body: "" };

  try {
    const now    = new Date();
    const start  = new Date(now.getFullYear(), now.getMonth() - 12, 1);
    const isoStart = start.toISOString().slice(0, 10);
    const isoEnd   = now.toISOString().slice(0, 10);

    // PUN (energia elettrica, €/kWh)
    let pun = [];
    try { pun = await fetchPUN(isoStart, isoEnd); }
    catch (e) { console.error("PUN:", e.message); }

    // PSV (gas naturale, €/smc)
    let psv = [], psvSource = null, psvError = null;
    if (process.env.GME_LOGIN && process.env.GME_PASSWORD) {
      try {
        const token = await gmeLogin();
        const r = await fetchPSV(token, toYMDInt(start), toYMDInt(now));
        psv = r.monthly; psvSource = r.source; psvError = r.debug;
      } catch (e) { psvError = e.message; console.error("PSV:", e.message); }
    } else { psvError = "GME_LOGIN/GME_PASSWORD env vars missing"; }

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ cachedAt: now.toISOString(), pun, psv, psvSource, psvError }),
    };
  } catch (err) {
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
