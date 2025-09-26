// services/kiwiAdapter.js — ESM

function toDDMMYYYY(input) {
  if (!input) return "";
  if (typeof input === "string") {
    const s = input.trim();
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;
    const mIso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (mIso) { const [, y, m, d] = mIso; return `${d}/${m}/${y}`; }
    const mSlash = s.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
    if (mSlash) { const [, y, m, d] = mSlash; return `${d}/${m}/${y}`; }
    const d = new Date(s); if (!Number.isNaN(d)) {
      return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
    }
    return s;
  }
  const d = new Date(input);
  return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
}

async function safeText(res){ try{return await res.text();}catch{return "";} }

/**
 * Core: call RapidAPI "Kiwi.com Cheap Flights" -> /round-trip
 */
export async function kiwiRoundTrip({
  from, to, departureDate, returnDate = "",
  adults = 1, travelClass = "economy", currency = "INR"
}) {
  if (!process.env.RAPIDAPI_KEY) throw new Error("RAPIDAPI_KEY not set");
  if (!from || !to || !departureDate) throw new Error("from, to, departureDate required");

  const url = new URL("https://kiwi-com-cheap-flights.p.rapidapi.com/round-trip");

  // Required basics
  const dep = toDDMMYYYY(departureDate);
  url.searchParams.set("from", String(from).toUpperCase());
  url.searchParams.set("to",   String(to).toUpperCase());
  url.searchParams.set("dateFrom", dep);
  url.searchParams.set("dateTo",   dep);

  if (returnDate) {
    const ret = toDDMMYYYY(returnDate);
    url.searchParams.set("returnFrom", ret);
    url.searchParams.set("returnTo",   ret);
  } else {
    url.searchParams.set("returnFrom", "");
    url.searchParams.set("returnTo",   "");
  }

  url.searchParams.set("adults", String(adults));
  url.searchParams.set("selectedCabins", String(travelClass||"economy").toLowerCase());
  url.searchParams.set("currency", currency || "INR");

  // 👇 Add common market/localization params many RapidAPI travel APIs expect
  url.searchParams.set("market", "IN");
  url.searchParams.set("locale", "en-IN");
  url.searchParams.set("site",   "IN");
  url.searchParams.set("country","IN");

  const res = await fetch(url, {
    headers: {
      "X-RapidAPI-Key": process.env.RAPIDAPI_KEY,
      "X-RapidAPI-Host": "kiwi-com-cheap-flights.p.rapidapi.com"
    }
  });

  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`Kiwi API ${res.status}: ${body?.slice(0,500)}`);
  }

  const json = await res.json();
  // Inject the request URL into the payload for debugging via your rawSnippet
  if (json && typeof json === "object") {
    json._meta = { requestUrl: url.toString() };
  }
  return json;
}

export function extractCarriers(json) {
  const carriers = new Set();
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      const lk = k.toLowerCase();
      if (typeof v === "string") {
        if (lk.includes("airline") || lk.includes("carrier")) carriers.add(v.toUpperCase());
      } else if (Array.isArray(v)) {
        if (lk.includes("airlines") || lk.includes("carriers")) v.forEach(x => typeof x === "string" && carriers.add(x.toUpperCase()));
        v.forEach(walk);
      } else if (typeof v === "object") {
        if (v && typeof v.code === "string" && (lk.includes("airline") || lk.includes("carrier"))) carriers.add(v.code.toUpperCase());
        if (v && typeof v.name === "string" && (lk.includes("airline") || lk.includes("carrier"))) carriers.add(v.name.toUpperCase());
        walk(v);
      }
    }
  };
  walk(json);
  return [...carriers].slice(0, 100);
}

export function findAnyPrice(json) {
  let found = null;
  const walk = (node) => {
    if (found !== null || !node) return;
    if (Array.isArray(node)) return node.some(v => (walk(v), found!==null));
    if (typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (found !== null) break;
      if (typeof v === "number" && /price|total|amount|fare|value|grand/i.test(k)) { found = v; break; }
      if (typeof v === "string" && /price|total|amount|fare|value|grand/i.test(k)) {
        const n = parseFloat(v.replace(/[, ₹$€]/g, "")); if (!Number.isNaN(n)) { found = n; break; }
      }
      if (typeof v === "object") walk(v);
    }
  };
  walk(json);
  return found;
}

export function lccPresence(json) {
  const carriers = extractCarriers(json);
  const asText = JSON.stringify(json).toUpperCase();
  const has = (t) => carriers.includes(t) || asText.includes(t);
  return {
    indigo:   has("6E") || has("INDIGO"),
    akasa:    has("QP") || has("AKASA"),
    spicejet: has("SG") || has("SPICEJET"),
    carriersSample: carriers.slice(0, 20),
  };
}
