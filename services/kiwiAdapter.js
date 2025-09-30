// services/kiwiAdapter.js — ESM
// RapidAPI: kiwi-com-cheap-flights (Round trip)
// Requires: process.env.RAPIDAPI_KEY
// Note: This is a RapidAPI wrapper, not Kiwi Tequila. Param names differ.

/* ---------------- Date helpers ---------------- */
import { Buffer } from "buffer";

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

  // ---- tighten route fidelity on RapidAPI wrapper ----
url.searchParams.set("contentProviders", "KIWI");            // only Kiwi content
url.searchParams.set("allowReturnFromDifferentCity", "false");
url.searchParams.set("allowChangeInboundDestination", "false");
url.searchParams.set("allowChangeInboundSource", "false");
url.searchParams.set("applyMixedClasses", "false");
url.searchParams.set("enableTrueHiddenCity", "false");
url.searchParams.set("enableThrowAwayTicketing", "false");
url.searchParams.set("allowOvernightStopover", "false");


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

/* ---------------- Helpers for the encoded Kiwi itinerary ---------------- */

/** Try to decode the Base64 payload embedded in it.id or it.shareId. */
// ⬇️ replace your current decodeEmbedded(...) with this version
function decodeEmbedded(it) {
  const pickStr = (s) => (typeof s === "string" ? s : null);
  const val = pickStr(it?.id) || pickStr(it?.shareId) || null;
  if (!val) return null;

  // val looks like "ItineraryReturn:eyJwcm92aWRlcnMiOiJ..."
  const idx = val.indexOf(":");
  const b64raw = idx >= 0 ? val.slice(idx + 1) : val;

  // make base64url safe for Buffer
  const b64 = b64raw.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const padded = b64.length % 4 === 0 ? b64 : b64 + "=".repeat(4 - (b64.length % 4));

  try {
    const txt = Buffer.from(padded, "base64").toString("utf8");
    // the payload should be JSON like: { "route_data": "...", "price": "4418", ... }
    const obj = JSON.parse(txt);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}


/**
 * Parse the route_data string into array of segments.
 * Example token: "AI:9951:DMU:1760001600:GAU:1760005500:economy:False::IX"
 */
function parseRouteData(routeData) {
  if (typeof routeData !== "string" || !routeData) return [];
  const segTokens = routeData.split("|").map(s => s.trim()).filter(Boolean);
  const segs = [];
  for (const tok of segTokens) {
    const parts = tok.split(":");
    // Minimum expected fields: carrier, number, from, depEpoch, to, arrEpoch
    if (parts.length < 6) continue;
    const carrier = (parts[0] || "").toUpperCase();
    const number  = parts[1] || "";
    const from    = (parts[2] || "").toUpperCase();
    const depEp   = Number(parts[3] || 0);
    const to      = (parts[4] || "").toUpperCase();
    const arrEp   = Number(parts[5] || 0);
    // Marketing carrier code often sits at the tail (e.g., IX)
    const maybeMarketing = (parts[parts.length - 1] || "").toUpperCase();
    const marketingCarrier = /^[A-Z0-9]{2}$/.test(maybeMarketing) ? maybeMarketing : null;

    segs.push({
      carrier,
      number,
      marketingCarrier,
      from,
      to,
      depIso: Number.isFinite(depEp) && depEp > 0 ? new Date(depEp * 1000).toISOString() : null,
      arrIso: Number.isFinite(arrEp) && arrEp > 0 ? new Date(arrEp * 1000).toISOString() : null,
    });
  }
  return segs;
}

/** Try to extract price as number from itinerary or the decoded payload. */
function pickPriceFromItinerary(it, decoded) {
  const direct =
    it?.pricing?.grandTotal ?? it?.pricing?.total ?? it?.price?.grandTotal ?? it?.price?.total ??
    it?.fare?.total ?? it?.total ?? it?.amount ?? it?.grandTotal ?? it?.price?.amount;
  const asNum = (x) => (typeof x === "string" ? parseFloat(x.replace(/[, ₹$€]/g, "")) : Number(x));
  if (direct != null && Number.isFinite(asNum(direct))) return asNum(direct);

  if (decoded && decoded.price != null && Number.isFinite(asNum(decoded.price))) {
    return asNum(decoded.price);
  }
  return null;
}

/* ---------------- Normalization for SkyDeal (date/time/cost only) --------------- */

function isObject(x){ return x && typeof x === "object"; }

function collectSegmentsFrom(it) {
  // Priority paths (if the wrapper ever exposes them)
  if (Array.isArray(it?.segments) && it.segments.length) return it.segments;
  if (Array.isArray(it?.legs) && it.legs.length) return it.legs;
  if (Array.isArray(it?.bounds?.[0]?.segments) && it.bounds[0].segments.length) return it.bounds[0].segments;
  if (Array.isArray(it?.outbound?.segments) && it.outbound.segments.length) return it.outbound.segments;
  if (Array.isArray(it?.slices?.[0]?.segments) && it.slices[0].segments.length) return it.slices[0].segments;
  return null;
}

function pickTimeNode(n) {
  if (!isObject(n)) return null;
  const s =
    n.timeUtc || n.utc || n.dateUtc || n.at || n.time || n.datetime || n.dateTime || n.localDateTime || n.local;
  if (typeof s === "string") return s;
  if (typeof s === "number" && Number.isFinite(s)) {
    const d = new Date(s > 1e12 ? s : s*1000);
    if (!Number.isNaN(d)) return d.toISOString();
  }
  if (isObject(n.iso) && typeof n.iso === "string") return n.iso;
  if (typeof n.iso === "string") return n.iso;
  return null;
}

function pickAirportCode(n) {
  if (!isObject(n)) return null;
  const a = n.airport || n.airportInfo || n;
  const c = a?.code || a?.iata || a?.IATA || a?.id;
  if (typeof c === "string") {
    const up = c.toUpperCase();
    if (/^[A-Z]{3}$/.test(up)) return up;
    const m = up.match(/\b([A-Z]{3})\b/);
    if (m) return m[1];
    return up;
  }
  return null;
}

function pickCarrierCode(n) {
  if (!isObject(n)) return null;
  const cand =
    n.marketingCarrier || n.operatingCarrier || n.carrier || n.airline || n.company || {};
  if (typeof cand === "string") return cand.toUpperCase();
  if (isObject(cand)) {
    if (typeof cand.code === "string") return cand.code.toUpperCase();
    if (typeof cand.name === "string") return cand.name.toUpperCase();
  }
  return null;
}

function pickFlightNumber(n) {
  if (!isObject(n)) return null;
  const v = n.flightNumber ?? n.number ?? n.flightNo ?? n.no ?? n.marketingFlightNumber;
  return v != null ? String(v).toUpperCase() : null;
}
function sliceOutboundLegs(segs, ORG, DST) {
  if (!Array.isArray(segs) || !segs.length || !ORG || !DST) return null;
  // find first leg that departs ORG
  let start = segs.findIndex(s => (s.from || s.depIATA || "").toUpperCase() === ORG);
  if (start < 0) return null;
  // walk forward until we reach DST
  let end = start;
  while (end < segs.length) {
    const to = (segs[end].to || segs[end].arrIATA || "").toUpperCase();
    if (to === DST) break;
    end += 1;
  }
  if (end >= segs.length) return null; // never reached DST
  return segs.slice(start, end + 1);
}

/**
 * Normalize Kiwi wrapper payload into rows:
 * { carrier, flightNo, depTime, arrTime, depIATA, arrIATA, priceINR, source }
 * Supports both:
 *  - native segment arrays (if ever present)
 *  - encoded Base64 `id`/`shareId` with `route_data`
 */
export function normalizeKiwiItineraries(json, maxRows = 50, filter = {}) {
  const itins = Array.isArray(json?.itineraries) ? json.itineraries : [];
  const out = [];
  const ORG = (filter.from || "").toUpperCase();
  const DST = (filter.to || "").toUpperCase();

  for (const it of itins) {
    let row = null;

    // Try native segments first
    let segsNative = collectSegmentsFrom(it);
    if (Array.isArray(segsNative) && segsNative.length) {
      // map to a uniform shape for slicing
      const mapped = segsNative.map(seg => ({
        from: pickAirportCode((seg?.departure || seg)?.airport || seg?.origin || seg?.from || seg) || null,
        to:   pickAirportCode((seg?.arrival   || seg)?.airport || seg?.destination || seg?.to   || seg) || null,
        depIso: pickTimeNode(seg?.departure || seg?.depart || seg) || null,
        arrIso: pickTimeNode(seg?.arrival  || seg?.arrive  || seg) || null,
        carrier: (pickCarrierCode(seg) || "").toUpperCase(),
        number: pickFlightNumber(seg) || null,
      }));

      const slice = sliceOutboundLegs(mapped, ORG, DST);
if (ORG && DST && (!slice || !slice.length)) continue; // skip non-matching itineraries

      const slice = sliceOutboundLegs(segsEnc, ORG, DST);
if (ORG && DST && (!slice || !slice.length)) continue; // skip non-matching itineraries


      // prefer segment-level carrier/number
      const carrierCode = (first.carrier || pickCarrierCode(it) || "").toUpperCase();
      const flightNo = first.number ? `${carrierCode ? carrierCode + "-" : ""}${String(first.number).toUpperCase()}` : null;
      const priceINR = pickPriceFromItinerary(it, null);

      row = {
        carrier: carrierCode || null,
        flightNo: flightNo || null,
        depTime: first.depIso || null,
        arrTime: last.arrIso || null,
        depIATA: first.from || null,
        arrIATA: last.to || null,
        priceINR: priceINR ?? null,
        source: "kiwi-rapidapi"
      };

      // If filter provided, enforce it; discard if it doesn't match
      if (ORG && row.depIATA !== ORG) row = null;
      if (DST && row?.arrIATA !== DST) row = null;

    } else {
      // Fallback: decode Base64 id/shareId -> parse route_data
      const decoded = decodeEmbedded(it);
      const segsEnc = parseRouteData(decoded?.route_data);
      if (segsEnc && segsEnc.length) {
        const slice = sliceOutboundLegs(segsEnc, ORG, DST) || segsEnc;
        const first = slice[0];
        const last  = slice[slice.length - 1];

        const carrierCode = (first.marketingCarrier || first.carrier || "").toUpperCase();
        const flightNo = first.number ? `${carrierCode ? carrierCode + "-" : ""}${String(first.number).toUpperCase()}` : null;
        const priceINR = pickPriceFromItinerary(it, decoded);

        row = {
          carrier: carrierCode || null,
          flightNo: flightNo || null,
          depTime: first.depIso || null,
          arrTime: last.arrIso || null,
          depIATA: first.from || null,
          arrIATA: last.to || null,
          priceINR: priceINR ?? null,
          source: "kiwi-rapidapi"
        };

        if (ORG && row.depIATA !== ORG) row = null;
        if (DST && row?.arrIATA !== DST) row = null;
      }
    }

    if (row && (row.depTime || row.arrTime || row.priceINR != null)) {
      out.push(row);
      if (out.length >= maxRows) break;
    }
  }

  return out;
}

