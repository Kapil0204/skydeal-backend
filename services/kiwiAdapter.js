// services/kiwiAdapter.js — ESM
// RapidAPI: kiwi-com-cheap-flights (Round trip)
// Requires: process.env.RAPIDAPI_KEY
// Note: This is NOT Kiwi's Tequila; param names differ.

/* ---------------- Date helpers ---------------- */

function toDDMMYYYY(input) {
  if (!input) return "";
  if (typeof input === "string") {
    const s = input.trim();
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s; // already DD/MM/YYYY
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); // YYYY-MM-DD
    if (iso) { const [, y, m, d] = iso; return `${d}/${m}/${y}`; }
    const slash = s.match(/^(\d{4})\/(\d{2})\/(\d{2})$/); // YYYY/MM/DD
    if (slash) { const [, y, m, d] = slash; return `${d}/${m}/${y}`; }
    const d = new Date(s);
    if (!Number.isNaN(d)) return ddmmyyyy(d);
    return s;
  }
  return ddmmyyyy(new Date(input));
}

function ddmmyyyy(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/* ----------- Provider location mapping ---------- */
/**
 * Some RapidAPI travel wrappers expect "City:slug_cc" for source/destination.
 * These are best-effort slugs for common Indian cities + a few globals.
 * If a slug is missing or incorrect, we fall back to "Country:XX".
 */
const IATA_TO_CITY_SLUG = {
  // India (best-guess slugs; adjust if vendor expects variants)
  BLR: "City:bangalore_in",
  DEL: "City:delhi_in",
  BOM: "City:mumbai_in",
  MAA: "City:chennai_in",
  HYD: "City:hyderabad_in",
  CCU: "City:kolkata_in",
  GOI: "City:goa_in",
  COK: "City:kochi_in",
  AMD: "City:ahmedabad_in",
  PNQ: "City:pune_in",
  LKO: "City:lucknow_in",
  PAT: "City:patna_in",
  // Global samples
  LHR: "City:london_gb",
  BCN: "City:barcelona_es",
  DXB: "City:dubai_ae",
  SIN: "City:singapore_sg",
};

const IATA_TO_COUNTRY = {
  // India
  BLR: "IN", DEL: "IN", BOM: "IN", MAA: "IN", HYD: "IN", CCU: "IN",
  GOI: "IN", COK: "IN", AMD: "IN", PNQ: "IN", LKO: "IN", PAT: "IN",
  // Global samples
  LHR: "GB", BCN: "ES", DXB: "AE", SIN: "SG",
};

function iataToCitySlug(iata) {
  const key = String(iata || "").toUpperCase();
  return IATA_TO_CITY_SLUG[key] || null;
}

function iataToCountry(iata) {
  const key = String(iata || "").toUpperCase();
  return IATA_TO_COUNTRY[key] || "IN"; // default to India
}

/* ----------------- Fetch helpers ---------------- */

async function safeText(res) {
  try { return await res.text(); } catch { return ""; }
}

/* ----------------- Core API call ---------------- */

/**
 * Call RapidAPI "Kiwi.com Cheap Flights" (Round trip).
 * For one-way, leave returnDate empty.
 */
export async function kiwiRoundTrip({
  from, to, departureDate, returnDate = "",
  adults = 1, travelClass = "economy", currency = "INR"
}) {
  if (!process.env.RAPIDAPI_KEY) throw new Error("RAPIDAPI_KEY not set");
  if (!from || !to || !departureDate) throw new Error("from, to, departureDate required");

  const url = new URL("https://kiwi-com-cheap-flights.p.rapidapi.com/round-trip");

  // Dates (wrapper prefers DD/MM/YYYY)
  const dep = toDDMMYYYY(departureDate);
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

  // Basic IATA params — some wrappers accept these
  url.searchParams.set("from", String(from).toUpperCase()); // e.g., BLR
  url.searchParams.set("to",   String(to).toUpperCase());   // e.g., DEL

  // Wrapper-specific params seen in the RapidAPI UI
  const srcSlug = iataToCitySlug(from);
  const dstSlug = iataToCitySlug(to);
  const srcCountry = iataToCountry(from);
  const dstCountry = iataToCountry(to);

  // You can pass multiple values (comma-separated). We include City + Country.
  url.searchParams.set(
    "source",
    [srcSlug, `Country:${srcCountry}`].filter(Boolean).join(",")
  );
  url.searchParams.set(
    "destination",
    [dstSlug, `Country:${dstCountry}`].filter(Boolean).join(",")
  );

  url.searchParams.set("currency", currency || "INR");
  url.searchParams.set("locale", "en-IN");
  url.searchParams.set("market", "IN");
  url.searchParams.set("country", "IN");
  url.searchParams.set("site", "IN");

  // Pax & cabin
  url.searchParams.set("adults", String(adults));
  url.searchParams.set("children", "0");
  url.searchParams.set("infants", "0");
  url.searchParams.set("selectedCabins", String(travelClass || "economy").toLowerCase());

  // Search behaviour
  url.searchParams.set("transportTypes", "FLIGHT");
  url.searchParams.set("sort", "QUALITY");
  url.searchParams.set("sortOrder", "ASCENDING");
  url.searchParams.set("limit", "20");

  const res = await fetch(url, {
    headers: {
      "X-RapidAPI-Key": process.env.RAPIDAPI_KEY,
      "X-RapidAPI-Host": "kiwi-com-cheap-flights.p.rapidapi.com",
    },
  });

  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`Kiwi API ${res.status}: ${body?.slice(0, 500)}`);
  }

  const json = await res.json();

  // Echo the exact request URL for debugging via your /kiwi/probe?debug=1
  if (json && typeof json === "object") {
    json._meta = { requestUrl: url.toString() };
  }
  return json;
}

/* ---------------- Result utilities ---------------- */

export function extractCarriers(json) {
  const carriers = new Set();
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== "object") return;

    for (const [k, v] of Object.entries(node)) {
      const lk = k.toLowerCase();
      if (typeof v === "string") {
        if (lk.includes("airline") || lk.includes("carrier")) carriers.add(v.toUpperCase());
      } else if (Array.isArray(v)) {
        if (lk.includes("airlines") || lk.includes("carriers")) {
          v.forEach((x) => typeof x === "string" && carriers.add(x.toUpperCase()));
        }
        v.forEach(walk);
      } else if (typeof v === "object") {
        if (v && typeof v.code === "string" && (lk.includes("airline") || lk.includes("carrier"))) {
          carriers.add(v.code.toUpperCase());
        }
        if (v && typeof v.name === "string" && (lk.includes("airline") || lk.includes("carrier"))) {
          carriers.add(v.name.toUpperCase());
        }
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
    if (Array.isArray(node)) { for (const v of node) { walk(v); if (found !== null) break; } return; }
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
