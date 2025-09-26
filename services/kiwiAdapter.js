// services/kiwiAdapter.js — ESM
// RapidAPI: kiwi-com-cheap-flights (Round trip)
// Requires: process.env.RAPIDAPI_KEY
// Note: This is a RapidAPI wrapper, not Kiwi Tequila. Param names differ.

/* ---------------- Date helpers ---------------- */

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

/* ----------- Provider location mapping ---------- */
/**
 * Some RapidAPI travel wrappers expect "City:slug_cc" for source/destination.
 * These are best-effort slugs for common Indian cities + a few globals.
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

  // Search behaviour (these matter for this wrapper)
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
// ---------------- Normalization for SkyDeal (date/time/cost only) ---------------
function pickTime(obj) {
  // return ISO-like string if found (prioritize UTC/ISO-looking fields)
  if (!obj || typeof obj !== "object") return null;
  const candidates = [];
  const pushIf = (v) => { if (v && typeof v === "string") candidates.push(v); };
  // common shapes
  pushIf(obj.utc); pushIf(obj.UTC); pushIf(obj.timeUtc); pushIf(obj.dateUtc);
  pushIf(obj.at); pushIf(obj.time); pushIf(obj.datetime); pushIf(obj.dateTime || obj.date_time);
  pushIf(obj.localDateTime || obj.localTime || obj.local);
  // pick the first ISO-like
  const iso = candidates.find(s => /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s));
  return iso || candidates[0] || null;
}

function pickAirport(obj) {
  if (!obj || typeof obj !== "object") return null;
  const vals = [];
  for (const k of ["iata", "IATA", "code", "airportCode", "airport", "id"]) {
    const v = obj[k];
    if (typeof v === "string" && /^[A-Z]{3}$/.test(v)) return v;
    if (typeof v === "string") vals.push(v.toUpperCase());
  }
  // last resort: scan strings for IATA-looking tokens
  for (const v of vals) {
    const m = v.match(/\b([A-Z]{3})\b/);
    if (m) return m[1];
  }
  return null;
}

function pickCarrier(obj) {
  if (!obj || typeof obj !== "object") return null;
  const v = obj.marketingCarrier || obj.operatingCarrier || obj.carrier || obj.airline || {};
  if (typeof v === "string") return v.toUpperCase();
  if (v && typeof v.code === "string") return v.code.toUpperCase();
  if (v && typeof v.name === "string") return v.name.toUpperCase();
  return null;
}

function pickFlightNo(obj) {
  if (!obj || typeof obj !== "object") return null;
  for (const k of ["flightNumber", "number", "flightNo", "no"]) {
    const v = obj[k];
    if (v != null) return String(v).toUpperCase();
  }
  return null;
}

// Try to extract a price (INR) from an itinerary node
function pickPriceINR(it) {
  const tryPaths = [
    it?.pricing?.grandTotal, it?.pricing?.total, it?.price?.total, it?.price?.amount,
    it?.fare?.total, it?.total, it?.amount, it?.grandTotal
  ];
  for (const v of tryPaths) {
    const n = typeof v === "string" ? parseFloat(v.replace(/[, ₹$€]/g, "")) : Number(v);
    if (Number.isFinite(n)) return n;
  }
  // fallback: scan object
  let found = null;
  (function walk(n) {
    if (found !== null || !n) return;
    if (Array.isArray(n)) { for (const x of n) { walk(x); if (found !== null) break; } return; }
    if (typeof n !== "object") return;
    for (const [k, v] of Object.entries(n)) {
      if (found !== null) break;
      if (typeof v === "number" && /price|total|amount|fare|value|grand/i.test(k)) { found = v; break; }
      if (typeof v === "string" && /price|total|amount|fare|value|grand/i.test(k)) {
        const n2 = parseFloat(v.replace(/[, ₹$€]/g, "")); if (Number.isNaN(n2)) continue; found = n2; break;
      }
      if (typeof v === "object") walk(v);
    }
  })(it);
  return found;
}

/**
 * Normalize Kiwi wrapper payload into rows: { carrier, flightNo, depTime, arrTime, depIATA, arrIATA, priceINR }
 * We try several common layouts: itineraries[].segments, .legs, .outbound.segments, .bounds[0].segments.
 */
export function normalizeKiwiItineraries(json, maxRows = 30) {
  const itins = Array.isArray(json?.itineraries) ? json.itineraries : [];
  const out = [];

  for (const it of itins) {
    let segs =
      Array.isArray(it?.segments) ? it.segments :
      Array.isArray(it?.legs) ? it.legs :
      Array.isArray(it?.bounds?.[0]?.segments) ? it.bounds[0].segments :
      Array.isArray(it?.outbound?.segments) ? it.outbound.segments :
      null;

    // If no recognizable segment list, scan for any array that looks like segments
    if (!segs) {
      for (const [k, v] of Object.entries(it)) {
        if (Array.isArray(v) && v.length && typeof v[0] === "object" && (
          /segment|leg|bound|slice/i.test(k)
        )) { segs = v; break; }
      }
    }

    if (!Array.isArray(segs) || segs.length === 0) continue;

    const first = segs[0];
    const last  = segs[segs.length - 1];

    const depTime = pickTime(first?.departure || first?.depart || first);
    const arrTime = pickTime(last?.arrival || last?.arrive || last);

    const depIATA = pickAirport(first?.departure?.airport || first?.origin || first?.from || first);
    const arrIATA = pickAirport(last?.arrival?.airport  || last?.destination || last?.to  || last);

    const carrier = (pickCarrier(first) || pickCarrier(it) || "").toUpperCase();
    const flightNoRaw = pickFlightNo(first) || pickFlightNo(it);
    const flightNo = flightNoRaw ? `${carrier ? carrier : ""}${carrier && flightNoRaw ? "-" : ""}${flightNoRaw}` : null;

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
        source: "kiwi-rapidapi"
      });
    }

    if (out.length >= maxRows) break;
  }

  return out;
}
