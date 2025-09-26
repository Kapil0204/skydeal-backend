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
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s; // DD/MM/YYYY
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

/* ======================= Normalization (ultra-agnostic) ======================= */

/** Utilities */
const isObj = (x) => x && typeof x === "object";

function numify(x) {
  if (x == null) return null;
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x === "string") {
    const n = parseFloat(x.replace(/[, ₹$€]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Price extractor (broad scan) */
function pickPriceINR(it) {
  const direct = it?.pricing?.grandTotal ?? it?.pricing?.total ??
                 it?.price?.grandTotal ?? it?.price?.total ??
                 it?.fare?.total ?? it?.total ?? it?.amount ?? it?.grandTotal;
  const d = numify(direct);
  if (d != null) return d;

  let found = null;
  (function walk(n) {
    if (found !== null || !n) return;
    if (Array.isArray(n)) { for (const x of n) { walk(x); if (found !== null) break; } return; }
    if (!isObj(n)) return;
    for (const [k, v] of Object.entries(n)) {
      if (found !== null) break;
      if (/price|total|amount|fare|value|grand/i.test(k)) {
        const n2 = numify(v);
        if (n2 != null) { found = n2; break; }
      }
      if (isObj(v) || Array.isArray(v)) walk(v);
    }
  })(it);
  return found;
}

/** Generic key-based string/number finder (deep) */
function deepFindByKeyRegex(node, keyRegex) {
  let out = null;
  (function walk(n) {
    if (out !== null || !n) return;
    if (Array.isArray(n)) { for (const x of n) { walk(x); if (out !== null) break; } return; }
    if (!isObj(n)) return;
    for (const [k, v] of Object.entries(n)) {
      if (out !== null) break;
      if (keyRegex.test(k)) {
        if (typeof v === "string" || typeof v === "number") { out = v; break; }
        if (isObj(v) && typeof v.iso === "string") { out = v.iso; break; }
      }
      if (isObj(v) || Array.isArray(v)) walk(v);
    }
  })(node);
  return out;
}

/** For airport codes, also accept 3-letter tokens inside strings */
function deepFindIATA(node, keyRegex) {
  const val = deepFindByKeyRegex(node, keyRegex);
  if (val == null) return null;
  const s = String(val).toUpperCase();
  const m = s.match(/\b([A-Z]{3})\b/);
  return m ? m[1] : /^[A-Z]{3}$/.test(s) ? s : null;
}

/** Choose the “best” array of segment-like objects anywhere in the itinerary */
function deepFindSegmentArray(it) {
  let best = null;

  function scoreSegmentArray(arr) {
    // Look at first few elements to score: dep/arr presence, times, airports, carrier/number
    let score = 0;
    for (let i = 0; i < Math.min(arr.length, 3); i++) {
      const s = arr[i];
      if (!isObj(s)) continue;
      const hasDep = s.departure || s.depart || s.from || s.origin || s.start;
      const hasArr = s.arrival || s.arrive || s.to || s.destination || s.end;
      if (hasDep) score += 2;
      if (hasArr) score += 2;

      const depTime = deepFindByKeyRegex(s, /(dep|origin|from|start).*(utc|time|date|iso)|^(dep|origin|from|start)$/i);
      const arrTime = deepFindByKeyRegex(s, /(arr|dest|to|end).*(utc|time|date|iso)|^(arr|dest|to|end)$/i);
      if (depTime) score += 2;
      if (arrTime) score += 2;

      const depIata = deepFindIATA(s, /(dep|origin|from|start).*(iata|code|airport)|^(dep|origin|from|start)$/i);
      const arrIata = deepFindIATA(s, /(arr|dest|to|end).*(iata|code|airport)|^(arr|dest|to|end)$/i);
      if (depIata) score += 2;
      if (arrIata) score += 2;

      const carrier = deepFindByKeyRegex(s, /(marketing|operating|carrier|airline|company).*(code|name)?/i);
      const number  = deepFindByKeyRegex(s, /(marketing)?flight(number)?|^number$|^no$/i);
      if (carrier) score += 1;
      if (number) score += 1;
    }
    return score;
  }

  (function walk(n) {
    if (!n) return;
    if (Array.isArray(n) && n.length && isObj(n[0])) {
      const sc = scoreSegmentArray(n);
      if (sc > 0 && (!best || sc > best.score)) best = { arr: n, score: sc };
      // also walk into items to find nested arrays
      for (const item of n) walk(item);
      return;
    }
    if (isObj(n)) {
      for (const v of Object.values(n)) walk(v);
    }
  })(it);

  return best ? best.arr : null;
}

/**
 * Normalize Kiwi wrapper payload into rows:
 * { carrier, flightNo, depTime, arrTime, depIATA, arrIATA, priceINR, source }
 */
export function normalizeKiwiItineraries(json, maxRows = 50) {
  const itins = Array.isArray(json?.itineraries) ? json.itineraries : [];
  const out = [];

  for (const it of itins) {
    const segs = deepFindSegmentArray(it);
    if (!Array.isArray(segs) || segs.length === 0) continue;

    const first = segs[0];
    const last  = segs[segs.length - 1];

    // times
    const depTime = deepFindByKeyRegex(first, /(dep|origin|from|start).*(utc|time|date|iso)|^(dep|origin|from|start)$/i);
    const arrTime = deepFindByKeyRegex(last,  /(arr|dest|to|end).*(utc|time|date|iso)|^(arr|dest|to|end)$/i);

    // airports
    const depIATA = deepFindIATA(first, /(dep|origin|from|start).*(iata|code|airport)|^(dep|origin|from|start)$/i);
    const arrIATA = deepFindIATA(last,  /(arr|dest|to|end).*(iata|code|airport)|^(arr|dest|to|end)$/i);

    // carrier + flight
    const carrier = String(
      deepFindByKeyRegex(first, /(marketing|operating|carrier|airline|company).*(code|name)?/i) ||
      deepFindByKeyRegex(it,    /(marketing|operating|carrier|airline|company).*(code|name)?/i) || ""
    ).toUpperCase();

    const number  = String(
      deepFindByKeyRegex(first, /(marketing)?flight(number)?|^number$|^no$/i) ||
      deepFindByKeyRegex(it,    /(marketing)?flight(number)?|^number$|^no$/i) || ""
    ).toUpperCase().replace(/\s+/g, "");

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
