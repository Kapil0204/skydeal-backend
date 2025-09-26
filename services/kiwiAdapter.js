// services/kiwiAdapter.js — ESM
// RapidAPI: kiwi-com-cheap-flights (Round trip)
// Requires: process.env.RAPIDAPI_KEY
// Note: This is a RapidAPI wrapper, not Kiwi Tequila. Param names differ.

/* ======================= Date helpers ======================= */

function ddmmyyyy(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

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

/* =========== Provider location mapping (wrapper-specific) =========== */
/**
 * Some RapidAPI travel wrappers expect "City:slug_cc" for source/destination.
 * Best-effort slugs for common Indian cities + a few globals.
 */
const IATA_TO_CITY_SLUG = {
  // India
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

/* ======================= Fetch helpers ======================= */
async function safeText(res) {
  try { return await res.text(); } catch { return ""; }
}

/* ======================= Core API call ======================= */
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

  // --- Dates (DD/MM/YYYY) ---
  const dep = toDDMMYYYY(departureDate);
  url.searchParams.set("dateFrom", dep);
  url.searchParams.set("dateTo", dep);
  if (returnDate) {
    const ret = toDDMMYYYY(returnDate);
    url.searchParams.set("returnFrom", ret);
    url.searchParams.set("returnTo", ret);
  } else {
    url.searchParams.set("returnFrom", "");
    url.searchParams.set("returnTo", "");
  }

  // --- IATA hints (some wrappers accept) ---
  url.searchParams.set("from", String(from).toUpperCase());
  url.searchParams.set("to", String(to).toUpperCase());

  // --- Wrapper-specific params (CRITICAL) ---
  const srcSlug = iataToCitySlug(from);
  const dstSlug = iataToCitySlug(to);
  const srcCountry = iataToCountry(from);
  const dstCountry = iataToCountry(to);

  // Allow both City and Country (comma-separated)
  url.searchParams.set("source", [srcSlug, `Country:${srcCountry}`].filter(Boolean).join(","));
  url.searchParams.set("destination", [dstSlug, `Country:${dstCountry}`].filter(Boolean).join(","));

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

  // Search behaviour (these help this wrapper)
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

  // Echo the exact request URL for debugging via /kiwi/probe?debug=1
  if (json && typeof json === "object") {
    json._meta = { requestUrl: url.toString() };
  }
  return json;
}

/* ======================= Utility scanners ======================= */

export function extractCarriers(json) {
  const carriers = new Set();
  (function walk(node) {
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
  })(json);
  return [...carriers].slice(0, 100);
}

export function findAnyPrice(json) {
  let found = null;
  (function walk(n) {
    if (found !== null || !n) return;
    if (Array.isArray(n)) { for (const x of n) { walk(x); if (found !== null) break; } return; }
    if (typeof n !== "object") return;
    for (const [k, v] of Object.entries(n)) {
      if (found !== null) break;
      if (typeof v === "number" && /price|total|amount|fare|value|grand/i.test(k)) { found = v; break; }
      if (typeof v === "string" && /price|total|amount|fare|value|grand/i.test(k)) {
        const n2 = parseFloat(v.replace(/[, ₹$€]/g, "")); if (!Number.isNaN(n2)) { found = n2; break; }
      }
      if (typeof v === "object") walk(v);
    }
  })(json);
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

/* ======================= Normalization ======================= */
// ---------------- Normalization for SkyDeal (date/time/cost only) ---------------
function isObj(x){ return x && typeof x === "object"; }

function pickTimeNode(n) {
  if (!isObj(n)) return null;
  const s =
    n.timeUtc || n.utc || n.dateUtc || n.at ||
    n.time || n.datetime || n.dateTime || n.date_time ||
    n.localDateTime || n.local || n.iso;
  if (typeof s === "string") return s;
  if (typeof s === "number" && Number.isFinite(s)) {
    const d = new Date(s > 1e12 ? s : s * 1000);
    if (!Number.isNaN(d)) return d.toISOString();
  }
  return null;
}

function pickAirportCode(n) {
  if (!isObj(n)) return null;
  const a = n.airport || n.airportInfo || n.origin || n.destination || n;
  const c = a?.code || a?.iata || a?.IATA || a?.id;
  if (typeof c === "string") {
    const up = c.toUpperCase();
    if (/^[A-Z]{3}$/.test(up)) return up;
    const m = up.match(/\b([A-Z]{3})\b/);
    return m ? m[1] : up;
  }
  return null;
}

function pickCarrierCode(n) {
  if (!isObj(n)) return null;
  const cand = n.marketingCarrier || n.operatingCarrier || n.carrier || n.airline || n.company || {};
  if (typeof cand === "string") return cand.toUpperCase();
  if (isObj(cand)) {
    if (typeof cand.code === "string") return cand.code.toUpperCase();
    if (typeof cand.name === "string") return cand.name.toUpperCase();
  }
  return null;
}

function pickFlightNumber(n) {
  if (!isObj(n)) return null;
  const v = n.marketingFlightNumber ?? n.flightNumber ?? n.number ?? n.flightNo ?? n.no;
  return v != null ? String(v).toUpperCase() : null;
}

function pickPriceINR(it) {
  const asNum = (x) => (typeof x === "string" ? parseFloat(x.replace(/[, ₹$€]/g, "")) : Number(x));
  const p1 = it?.pricing?.grandTotal ?? it?.pricing?.total ??
             it?.price?.grandTotal ?? it?.price?.total ??
             it?.fare?.total ?? it?.total ?? it?.amount ?? it?.grandTotal;
  if (p1 != null && Number.isFinite(asNum(p1))) return asNum(p1);

  let found = null;
  (function walk(n) {
    if (found !== null || !n) return;
    if (Array.isArray(n)) { for (const x of n) { walk(x); if (found !== null) break; } return; }
    if (!isObj(n)) return;
    for (const [k, v] of Object.entries(n)) {
      if (found !== null) break;
      if (typeof v === "number" && /price|total|amount|fare|value|grand/i.test(k)) { found = v; break; }
      if (typeof v === "string" && /price|total|amount|fare|value|grand/i.test(k)) {
        const n2 = parseFloat(v.replace(/[, ₹$€]/g, "")); if (Number.isFinite(n2)) { found = n2; break; }
      }
      if (isObj(v) || Array.isArray(v)) walk(v);
    }
  })(it);
  return found;
}

// Find the “segments” array wherever it lives (segments/legs/slices/bounds…)
function collectSegmentsFrom(it) {
  // Common direct shapes
  if (Array.isArray(it?.segments) && it.segments.length) return it.segments;
  if (Array.isArray(it?.legs) && it.legs.length) return it.legs;

  // Kiwi-like nested shapes
  if (Array.isArray(it?.bounds)) {
    for (const b of it.bounds) {
      if (Array.isArray(b?.segments) && b.segments.length) return b.segments;
      if (Array.isArray(b?.legs) && b.legs.length) return b.legs;
    }
  }
  if (Array.isArray(it?.slices)) {
    for (const s of it.slices) {
      if (Array.isArray(s?.segments) && s.segments.length) return s.segments;
      if (Array.isArray(s?.legs) && s.legs.length) return s.legs;
    }
  }
  if (Array.isArray(it?.outbound?.segments) && it.outbound.segments.length) return it.outbound.segments;

  // Deep probe: any array of objects with departure/arrival-like nodes
  const candidates = [];
  (function scan(node) {
    if (!isObj(node)) return;
    for (const [, v] of Object.entries(node)) {
      if (Array.isArray(v) && v.length && isObj(v[0])) {
        const looksSegmenty = v.some(s =>
          isObj(s) && (s.departure || s.arrival || s.depart || s.arrive)
        );
        if (looksSegmenty) candidates.push(v);
      } else if (isObj(v)) scan(v);
    }
  })(it);
  return candidates[0] || null;
}

/**
 * Normalize Kiwi wrapper payload into rows:
 * { carrier, flightNo, depTime, arrTime, depIATA, arrIATA, priceINR, source }
 */
export function normalizeKiwiItineraries(json, maxRows = 50) {
  const itins = Array.isArray(json?.itineraries) ? json.itineraries : [];
  const out = [];

  for (const it of itins) {
    const segs = collectSegmentsFrom(it);
    if (!Array.isArray(segs) || segs.length === 0) continue;

    const first = segs[0];
    const last  = segs[segs.length - 1];

    // times
    const depTime = pickTimeNode(first?.departure || first?.depart || first);
    const arrTime = pickTimeNode(last?.arrival  || last?.arrive  || last);

    // airports
    const depIATA = pickAirportCode(
      (first?.departure || first)?.airport || first?.origin || first?.from || first
    );
    const arrIATA = pickAirportCode(
      (last?.arrival || last)?.airport || last?.destination || last?.to || last
    );

    // carrier + flight
    const carrier = (pickCarrierCode(first) || pickCarrierCode(it) || "").toUpperCase();
    const number  = pickFlightNumber(first) || pickFlightNumber(it);
    const flightNo = number ? `${carrier ? carrier : ""}${carrier && number ? "-" : ""}${number}` : null;

    // price
    const priceINR = pickPriceINR(it);

    if (depTime || arrTime || priceINR) {
      out.push({
        carrier: carrier || null,
        flightNo: flightNo || null,
        depTime: depTime || null,
        arrTime: arrTime || null,
        depIATA: depIATA || null,
        arrIATA: arrIATA || null,
        priceINR: priceINR ?? null,
        source: "kiwi-rapidapi",
      });
    }
    if (out.length >= maxRows) break;
  }

  return out;
}
