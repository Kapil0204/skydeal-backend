// index.js (SkyDeal backend) — ESM
import express from "express";
import cors from "cors";
import axios from "axios";
import { MongoClient } from "mongodb";

// --------------------
// Setup
// --------------------
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// --------------------
// Config
// --------------------
const OTAS = ["Goibibo", "MakeMyTrip", "Yatra", "EaseMyTrip", "Cleartrip"];

// ✅ Simulation removed: no blanket markup, no SpiceJet-specific markup
// (We keep base prices exactly as FlightAPI returns)

// Mongo envs
const MONGO_URI = process.env.MONGO_URI;
const MONGODB_DB = process.env.MONGODB_DB || "skydeal";
const MONGO_COL = process.env.MONGO_COL || "offers";

// FlightAPI env
const FLIGHTAPI_KEY = process.env.FLIGHTAPI_KEY;

// --------------------
// Helpers: Date + Cabin
// --------------------
function toISO(d) {
  if (!d) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d; // yyyy-mm-dd
  const m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/); // dd/mm/yyyy
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const t = new Date(d);
  if (!isNaN(t)) return t.toISOString().slice(0, 10);
  return "";
}
function paymentLabelFromSelection(selectedPaymentMethods) {
  const sel = Array.isArray(selectedPaymentMethods) ? selectedPaymentMethods : [];
  if (!sel.length) return null;

  const first = sel[0] || {};
  const bank = String(first.name || first.bank || "").trim();
  const type = String(first.type || "").trim().toLowerCase().replace(/\s+/g, "");

  if (!bank && !type) return null;
  return [bank || null, type || null].filter(Boolean).join(" • ");
}


// FlightAPI expects: Economy | Premium_Economy | Business | First
function normalizeCabin(travelClass) {
  const v = String(travelClass || "economy").toLowerCase().trim();
  if (v === "premium economy" || v === "premium_economy" || v === "premium-economy") return "Premium_Economy";
  if (v === "business") return "Business";
  if (v === "first") return "First";
  return "Economy";
}

// --------------------
// Mongo (single client)
// --------------------
let _mongoClient = null;

async function getOffersCollection() {
  if (!MONGO_URI) throw new Error("Missing MONGO_URI env var");
  if (!_mongoClient) {
    _mongoClient = new MongoClient(MONGO_URI, {});
    await _mongoClient.connect();
  }
  return _mongoClient.db(MONGODB_DB).collection(MONGO_COL);
}

// --------------------
// FlightAPI call: onewaytrip
// --------------------
function buildOnewayTripUrl({ from, to, date, adults, children, infants, cabin, currency }) {
  if (!FLIGHTAPI_KEY) throw new Error("Missing FLIGHTAPI_KEY env var");
  return `https://api.flightapi.io/onewaytrip/${encodeURIComponent(FLIGHTAPI_KEY)}/${from}/${to}/${date}/${adults}/${children}/${infants}/${cabin}/${currency}`;
}

async function fetchOneWayTrip({ from, to, date, adults = 1, cabin = "Economy", currency = "INR" }) {
  const url = buildOnewayTripUrl({
    from,
    to,
    date,
    adults,
    children: 0,
    infants: 0,
    cabin,
    currency,
  });

  const tried = [{ url }];

  try {
    const r = await axios.get(url, { timeout: 25000 });
    return { status: r.status, data: r.data, tried };
  } catch (e) {
    const st = e?.response?.status || 0;
    const body =
      typeof e?.response?.data === "string"
        ? e.response.data
        : e?.response?.data
          ? JSON.stringify(e.response.data)
          : "";
    tried[0].status = st;
    tried[0].body = body.slice(0, 800);

    const err = new Error(`FlightAPI request failed (${st || "no-status"})`);
    err.status = st || 500;
    err.tried = tried;
    throw err;
  }
}

// --------------------
// Map FlightAPI response to consistent flights
// --------------------
function mapFlightsFromFlightAPI(raw) {
  const itineraries = Array.isArray(raw?.itineraries) ? raw.itineraries : [];
  const legs = Array.isArray(raw?.legs) ? raw.legs : [];
  const carriers = Array.isArray(raw?.carriers) ? raw.carriers : [];
  const segments = Array.isArray(raw?.segments) ? raw.segments : [];

  const legById = Object.fromEntries(legs.map((l) => [l.id, l]));
  const carrierById = Object.fromEntries(carriers.map((c) => [String(c.id), c]));
  const segmentById = Object.fromEntries(segments.map((s) => [s.id, s]));

  const flights = [];

  for (const it of itineraries) {
    const legId = Array.isArray(it.leg_ids) ? it.leg_ids[0] : null;
    const leg = legId ? legById[legId] : null;

    // cheapest price
    let cheapestAmount = null;
    const pricingOptions = Array.isArray(it.pricing_options) ? it.pricing_options : [];
    for (const opt of pricingOptions) {
      const amount = opt?.price?.amount;
      if (typeof amount === "number") {
        if (cheapestAmount === null || amount < cheapestAmount) cheapestAmount = amount;
      }
    }

    // Carrier name
    const marketingCarrierId = Array.isArray(leg?.marketing_carrier_ids) ? leg.marketing_carrier_ids[0] : null;
    const carrier = marketingCarrierId != null ? carrierById[String(marketingCarrierId)] : null;
    const airlineName = carrier?.name || carrier?.display_name || carrier?.code || "-";

    // flight number guess from first segment
    let flightNumber = "-";
    if (Array.isArray(leg?.segment_ids) && leg.segment_ids.length > 0) {
      const seg = segmentById[leg.segment_ids[0]];
      const num = seg?.flight_number || seg?.marketing_flight_number;
      if (num) flightNumber = String(num);
    }

    const departureTime = leg?.departure || null;
    const arrivalTime = leg?.arrival || null;
    const stops = typeof leg?.stop_count === "number" ? leg.stop_count : 0;

    flights.push({
      airlineName,
      flightNumber,
      departureTime,
      arrivalTime,
      stops,
      price: typeof cheapestAmount === "number" ? cheapestAmount : 0,
      raw: { itinerary: it, leg },
    });
  }

  return flights;
}

// --------------------
// Limit results (Indian carriers + non-stop first)
// --------------------
const MAX_RESULTS_PER_DIRECTION = 25;

const INDIAN_CARRIERS = [
  "air india express",
  "air india",
  "indigo",
  "akasa",
  "spicejet",
  "fly91",
  "star air",
  "alliance air",
  "trujet",
  "vistara",
  "go first"
];

function isIndianCarrier(airlineName) {
  const n = String(airlineName || "").toLowerCase();
  return INDIAN_CARRIERS.some(c => n.includes(c));
}

function limitAndSortFlights(flights) {
  const indian = flights.filter(f => isIndianCarrier(f.airlineName));
  const pool = indian.length > 0 ? indian : flights;

  pool.sort((a, b) => (a.stops || 0) - (b.stops || 0));
  return pool.slice(0, MAX_RESULTS_PER_DIRECTION);
}

// --------------------
// Offer matching + pricing
// --------------------
function normalizeText(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "");
}

function normalizeBankName(raw) {
  const s0 = String(raw || "").trim();
  // ✅ handle canonical formats like AXIS_BANK / HDFC_BANK etc.
  const s = normalizeText(s0.replace(/_/g, " "));

  if (s.includes("flipkart") && s.includes("axis")) return "axis bank";
  if (s === "au bank" || s.includes("au bank")) return "au small finance bank";

  const cleaned = s
    .replace(/\bbank\b/g, "bank")
    .replace(/\bltd\b/g, "ltd")
    .replace(/\blimited\b/g, "ltd")
    .trim();

  const map = new Map([
    ["hdfc", "hdfc bank"],
    ["hdfc bank", "hdfc bank"],
    ["axis", "axis bank"],
    ["axis bank", "axis bank"],
    ["federal", "federal bank"],
    ["federal bank", "federal bank"],
    ["icici", "icici bank"],
    ["icici bank", "icici bank"],
    ["sbi", "state bank of india"],
    ["state bank of india", "state bank of india"],
    ["au small bank", "au small finance bank"],
    ["au small finance bank", "au small finance bank"],
  ]);

  return map.get(cleaned) || cleaned;
}


function normalizePaymentType(rawType, rawText = "") {
  const t = normalizeText(rawType);
  const r = normalizeText(rawText);

  if (t.includes("emi") || r.includes("emi") || r.includes("no cost emi") || r.includes("no-cost emi")) return "emi";
  if (t.includes("net") && t.includes("bank")) return "netbanking";
  if (r.includes("net banking") || r.includes("netbanking")) return "netbanking";
  if (t.includes("credit")) return "creditcard";
  if (t.includes("debit")) return "debitcard";
  if (t.includes("upi") || r.includes("upi")) return "upi";
  if (t.includes("wallet") || r.includes("wallet")) return "wallet";

  return t || "other";
}

// Extract constraints
function extractOfferConstraints(offer) {
  const text = String(offer?.terms || "").toLowerCase();
  return {
    requiresEligibleBIN: text.includes("bin"),
    appOnly: text.includes("mobile app"),
    websiteOnly: text.includes("website bookings"),
    onePerUser: text.includes("once per"),
  };
}

/**
 * ✅ KEY FIX:
 * Your Mongo docs store payment eligibility in `eligiblePaymentMethods` (not `paymentMethods`).
 * We normalize that into the format: [{ type, bank, name, raw }]
 */
function extractOfferPaymentMethods(offer) {
  // Always return an array of normalized objects:
  // { type, bank, network, methodCanonical, bankCanonical, networkCanonical, raw, conditions, ... }
  if (!offer || typeof offer !== "object") return [];

  // ----------------------------
  // 1) Preferred: eligiblePaymentMethods (your DB has this)
  // ----------------------------
  if (Array.isArray(offer.eligiblePaymentMethods) && offer.eligiblePaymentMethods.length > 0) {
    return offer.eligiblePaymentMethods
      .filter(pm => pm && typeof pm === "object")
      .map(pm => ({
        // Keep both raw + canonical fields so other functions can match reliably
        type: pm.type || null, // e.g. "credit_card"
        bank: pm.bank || null, // e.g. "Axis Bank"
        network: pm.network || null, // may be null

        methodCanonical: pm.methodCanonical || null, // e.g. "CREDIT_CARD"
        bankCanonical: pm.bankCanonical || null, // e.g. "AXIS_BANK"
        networkCanonical: pm.networkCanonical || null,

        // extra optional metadata (keep it, useful later)
        cardVariant: pm.cardVariant || null,
        emiOnly: pm.emiOnly === true,
        tenureMonths: pm.tenureMonths ?? null,
        conditions: pm.conditions || null,
        raw: pm.raw || null,
      }))
      .filter(pm => pm.type || pm.methodCanonical || pm.bank || pm.bankCanonical);
  }

  // ----------------------------
  // 2) Legacy/alternate: paymentMethods (your DB currently does NOT have this)
  // ----------------------------
  if (Array.isArray(offer.paymentMethods) && offer.paymentMethods.length > 0) {
    return offer.paymentMethods
      .filter(pm => pm && typeof pm === "object")
      .map(pm => ({
        // Many older schemas look like { type:"Credit Card", name:"Axis Bank", bank:"Axis Bank", ... }
        type: pm.type || null,
        bank: pm.bank || pm.name || null,
        network: pm.network || null,

        methodCanonical: pm.methodCanonical || null,
        bankCanonical: pm.bankCanonical || null,
        networkCanonical: pm.networkCanonical || null,

        cardVariant: pm.cardVariant || null,
        emiOnly: pm.emiOnly === true,
        tenureMonths: pm.tenureMonths ?? null,
        conditions: pm.conditions || null,
        raw: pm.raw || null,
      }))
      .filter(pm => pm.type || pm.methodCanonical || pm.bank || pm.bankCanonical);
  }

  return [];
}



function offerAppliesToPortal(offer, portalName) {
  const portal = String(portalName || "").toLowerCase().trim();

  // 1) Prefer source metadata (most reliable in your pipeline)
  const src =
    offer?.sourceMetadata?.sourcePortal ??
    offer?.sourcePortal ??
    offer?.parsedFields?.sourceMetadata?.sourcePortal ??
    null;

  if (src) {
    return String(src).toLowerCase().trim() === portal;
  }

  // 2) Next: applicable platforms list
  const platforms =
    offer?.parsedApplicablePlatforms ||
    offer?.applicablePlatforms ||
    offer?.platforms ||
    offer?.parsedFields?.parsedApplicablePlatforms ||
    null;

  if (Array.isArray(platforms) && platforms.length > 0) {
    return platforms.some((p) => String(p || "").toLowerCase().includes(portal));
  }

  // 3) If we don't know the portal, DON'T apply it (avoid cross-portal bleed)
  return false;
}


/**
 * ✅ KEY FIX:
 * Many offers have offerCategories: [] (like your sample Cleartrip doc).
 * So:
 * - If categories include "Flight" -> accept
 * - Else infer "flight" from text, but reject obvious non-flight categories
 * - Still keep your ancillary exclusion keywords
 */
function isFlightOffer(offer) {
  const text = `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""} ${offer?.terms || ""}`.toLowerCase();

  // Hard exclusions (add more later if needed)
  if (/\bhotel(s)?\b/.test(text)) return false;
  if (/\bbus\b/.test(text)) return false;
  if (/\bholiday(s)?\b/.test(text)) return false;

  // Positive flight signals
  if (/\bflight(s)?\b/.test(text)) return true;
  if (/\bairfare\b/.test(text)) return true;
  if (/\bdomestic flights?\b/.test(text)) return true;
  if (/\binternational flights?\b/.test(text)) return true;

  // If you rely on categories sometimes, keep it as an additional signal:
  const cats = offer?.offerCategories || offer?.parsedFields?.offerCategories;
  if (Array.isArray(cats) && cats.some(c => /flight/i.test(c))) return true;

  return false;
}



function isOfferExpired(offer) {
  // 1) If explicitly set, trust it
  if (typeof offer?.isExpired === "boolean") return offer.isExpired;

  // 2) If parsed endDate exists, use it
  const end =
    offer?.validityPeriod?.endDate ||
    offer?.parsedFields?.validityPeriod?.endDate ||
    null;

  if (end) {
    const t = new Date(end);
    if (!isNaN(t)) return t.getTime() < Date.now();
  }

  // 3) Heuristic: parse end date from any text we have
  const blobs = [];

  // validityPeriod raw (if you store it)
  if (offer?.validityPeriod?.raw) blobs.push(String(offer.validityPeriod.raw));
  if (offer?.parsedFields?.validityPeriod?.raw) blobs.push(String(offer.parsedFields.validityPeriod.raw));

  // offerSummary keyTerms often contains validity
  const keyTerms = offer?.offerSummary?.keyTerms || offer?.parsedFields?.offerSummary?.keyTerms;
  if (Array.isArray(keyTerms)) blobs.push(keyTerms.join(" | "));

  // terms raw
  if (offer?.terms?.raw) blobs.push(String(offer.terms.raw));
  if (offer?.parsedFields?.terms?.raw) blobs.push(String(offer.parsedFields.terms.raw));

  // fallback text fields
  blobs.push(String(offer?.title || ""));
  blobs.push(String(offer?.rawDiscount || ""));
  blobs.push(String(offer?.rawText || ""));

  const text = blobs.filter(Boolean).join(" \n ");

  // Match patterns like "December 31, 2025" / "Dec 31 2025" / "31 Dec 2025"
  const monthNames = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  const re1 = new RegExp(`\\b${monthNames}\\s+\\d{1,2}(?:st|nd|rd|th)?[,]?\\s+\\d{4}\\b`, "ig"); // Dec 31, 2025
  const re2 = new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${monthNames}\\s+\\d{4}\\b`, "ig"); // 31 Dec 2025
  const re3 = /\b\d{4}-\d{2}-\d{2}\b/g; // 2025-12-31

  const candidates = [
    ...(text.match(re1) || []),
    ...(text.match(re2) || []),
    ...(text.match(re3) || []),
  ];

  if (candidates.length === 0) return false;

  // Take the *latest* date we can parse (most likely the end date)
  let latest = null;
  for (const s of candidates) {
    const d = new Date(s.replace(/(\d+)(st|nd|rd|th)/gi, "$1"));
    if (!isNaN(d)) {
      if (!latest || d.getTime() > latest.getTime()) latest = d;
    }
  }

  if (!latest) return false;

  return latest.getTime() < Date.now();
}


function minTxnOK(offer, amount) {
  const base = Number(amount);
  if (!Number.isFinite(base) || base <= 0) return false;

  // Get structured value if exists
  const v =
    offer?.minTransactionValue ??
    offer?.parsedFields?.minTransactionValue ??
    offer?.parsedFields?.minTxnValue ??
    null;

  // If numeric, enforce
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return base >= v;

  // If string contains number, enforce
  const n = Number(String(v || "").replace(/[^\d]/g, ""));
  if (Number.isFinite(n) && n > 0) return base >= n;

  // If minTxn is missing, check if the offer text suggests there IS a minimum
  const t = [
    offer?.rawDiscount,
    offer?.title,
    offer?.terms?.raw,
    offer?.parsedFields?.terms?.raw,
    offer?.rawText,
    offer?.offerSummary ? JSON.stringify(offer.offerSummary) : null,
  ]
    .filter(Boolean)
    .join(" \n ")
    .toLowerCase();

  const mentionsMin =
    /\bminimum\b/.test(t) ||
    /\bmin\b/.test(t) ||
    /\bmin(?:imum)?\s*(?:txn|transaction|spend|booking|fare)\b/.test(t) ||
    /\bbooking\s*value\b/.test(t) ||
    /\btransaction\s*value\b/.test(t) ||
    /\bmin(?:imum)?\s*purchase\b/.test(t);

  // If it mentions a minimum but we couldn't parse it, DO NOT apply automatically
  if (mentionsMin) return false;

  // If it does NOT mention a minimum, allow
  return true;
}


function detectDomesticInternationalCap(offer, isDomestic) {
  const text = String(offer?.rawDiscount || "").toLowerCase();
  if (text.includes("domestic") && text.includes("international")) {
    if (isDomestic) {
      const m = text.match(/domestic.*?rs\.?\s*([\d,]+)/i);
      if (m) return Number(m[1].replace(/,/g, ""));
    } else {
      const m = text.match(/international.*?rs\.?\s*([\d,]+)/i);
      if (m) return Number(m[1].replace(/,/g, ""));
    }
  }
  return null;
}

function computeDiscountedPrice(offer, baseAmount, isDomestic) {
  const base = Number(baseAmount);
  if (!Number.isFinite(base) || base <= 0) return baseAmount;

  // 1) Prefer parsed discountPercent if present
  let pct = null;
  if (offer?.discountPercent != null) {
    const n = Number(offer.discountPercent);
    if (Number.isFinite(n) && n > 0) pct = n;
  }

  // 2) If missing, parse from rawDiscount text (THIS FIXES YOUR AXIS CASE)
  if (pct == null) {
    pct = parsePercentFromRawDiscount(offer, isDomestic);
  }

  if (pct != null) {
    const discounted = Math.round(base * (1 - pct / 100));
    return discounted < base ? discounted : base;
  }
  // ---- Fallback for "Up to X%" discounts ----
  if (process.env.ENABLE_ESTIMATED_DISCOUNTS === "true") {
if (
  baseAmount > 0 &&
  !offer.discountPercent &&
  !offer.flatDiscountAmount &&
  typeof offer.rawDiscount === "string"
) {
  const m = offer.rawDiscount.match(/up to\s*(\d+)\s*%/i);
  if (m) {
    const statedPct = Number(m[1]);

    // Conservative fallback:
    // take 50% of stated, cap at 10%
    const effectivePct = Math.min(Math.floor(statedPct / 2), 10);

    if (effectivePct > 0) {
      const discounted = Math.floor(
        baseAmount * (1 - effectivePct / 100)
      );

      return {
        price: discounted,
        meta: {
          estimated: true,
          method: "UP_TO_PERCENT_FALLBACK",
          appliedPercent: effectivePct,
          statedPercent: statedPct,
        },
      };
    }
  }
}
}

  // 3) Flat discount support (you said you need this later; keep it safe now)
  const flat = Number(offer?.flatDiscountAmount);
  if (Number.isFinite(flat) && flat > 0) {
    const discounted = Math.round(base - flat);
    return discounted < base ? discounted : base;
  }

  return base;
}

function parsePercentFromRawDiscount(offer, isDomestic) {
  const txt = String(
    offer?.rawDiscount ||
    offer?.parsedFields?.rawDiscount ||
    offer?.offerSummary ||
    offer?.rawText ||
    ""
  );

  if (!txt) return null;

  // Prefer a domestic-specific % if available
  if (isDomestic) {
    const mDom = txt.match(/(\d{1,2})\s*%[^%]{0,40}\bdomestic\b/i);
    if (mDom) return Number(mDom[1]);
  }

  // Otherwise take the first reasonable percent (1-90)
  const mAny = txt.match(/(\d{1,2})\s*%/);
  if (mAny) {
    const p = Number(mAny[1]);
    if (p > 0 && p < 90) return p;
  }

  return null;
}


function normalizeSelectedPM(pm) {
  const typeRaw = String(pm?.type || "").trim();
  const nameRaw = String(pm?.name || pm?.bank || "").trim();

  const t = typeRaw.toLowerCase();

  let typeNorm =
    /emi/.test(t) ? "EMI" :
    /credit/.test(t) ? "CREDIT_CARD" :
    /debit/.test(t) ? "DEBIT_CARD" :
    /net\s*bank/.test(t) ? "NET_BANKING" :
    /upi/.test(t) ? "UPI" :
    /wallet/.test(t) ? "WALLET" :
    null;

  const bankCanonical = nameRaw
    ? nameRaw
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
    : null;

  return { typeNorm, bankCanonical, nameRaw };
}


function normalizeOfferPM(pm) {
  // pm can be from eligiblePaymentMethods or legacy paymentMethods
  const methodCanonical = pm?.methodCanonical
    ? String(pm.methodCanonical).toUpperCase()
    : null;

  const typeRaw = String(pm?.type || "").toLowerCase();

  const typeNorm =
    methodCanonical ||
    (/emi/.test(typeRaw) ? "EMI" :
     /credit/.test(typeRaw) ? "CREDIT_CARD" :
     /debit/.test(typeRaw) ? "DEBIT_CARD" :
     /net\s*bank/.test(typeRaw) ? "NET_BANKING" :
     /upi/.test(typeRaw) ? "UPI" :
     /wallet/.test(typeRaw) ? "WALLET" :
     null);

  const bankCanonical =
    pm?.bankCanonical
      ? String(pm.bankCanonical).toUpperCase()
      : (pm?.bank || pm?.name)
        ? String(pm.bank || pm.name)
            .toUpperCase()
            .replace(/[^A-Z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "")
        : null;

  return {
    typeNorm,
    bankCanonical,
    emiOnly: pm?.emiOnly === true,   // ✅ CRITICAL
    tenureMonths: pm?.tenureMonths ?? null
  };
}

function offerMatchesSelectedPayment(offer, selectedPaymentMethods) {
  const sel = Array.isArray(selectedPaymentMethods) ? selectedPaymentMethods : [];
  if (sel.length === 0) return false;

  const offerPMs = extractOfferPaymentMethods(offer);
  if (!Array.isArray(offerPMs) || offerPMs.length === 0) return false;

  const selNorm = sel
    .map(normalizeSelectedPM)
    .filter(x => x.typeNorm && x.bankCanonical);

  if (selNorm.length === 0) return false;

  const offerNorm = offerPMs
    .map(normalizeOfferPM)
    .filter(x => x.typeNorm && x.bankCanonical);

  if (offerNorm.length === 0) return false;

  for (const s of selNorm) {
    for (const o of offerNorm) {
      if (s.bankCanonical !== o.bankCanonical) continue;

      // ✅ EMI selection should match:
      // (A) explicit EMI offers
      // (B) CREDIT_CARD offers that are emiOnly:true
      if (s.typeNorm === "EMI") {
        if (o.typeNorm === "EMI") return true;
        if (o.typeNorm === "CREDIT_CARD" && o.emiOnly === true) return true;
        if (o.typeNorm === "DEBIT_CARD" && o.emiOnly === true) return true; // safe
        continue;
      }

      // ✅ Credit card selection should NOT match emiOnly:true offers
      // (unless user also selected EMI separately)
      if (s.typeNorm === "CREDIT_CARD") {
        if (o.typeNorm === "CREDIT_CARD" && o.emiOnly !== true) return true;
        continue;
      }

      // ✅ Default: exact match type + bank
      if (s.typeNorm === o.typeNorm) return true;
    }
  }

  return false;
}




function getMatchedSelectedPaymentLabel(offer, selectedPaymentMethods) {
  if (!Array.isArray(selectedPaymentMethods) || selectedPaymentMethods.length === 0) return null;

  const offerPMs = extractOfferPaymentMethods(offer);
  if (offerPMs.length === 0) return null;

  const sel = selectedPaymentMethods.map((x) => {
    if (typeof x === "string") {
      const t = normalizePaymentType(x, x);
      return { type: t, name: normalizeBankName(x), rawName: x };
    }
    const t = normalizePaymentType(x?.type || x?.name || "", x?.raw || "");
    const nm = normalizeBankName(x?.name || x?.bank || x?.raw || "");
    return { type: t, name: nm, rawName: x?.name || x?.bank || x?.raw || "" };
  });

  for (const pm of offerPMs) {
    const t = normalizePaymentType(pm.type, pm.raw || "");
    const name = normalizeBankName(pm.bank || pm.name || "");

    const match = sel.find((s) => s.type === t && (!s.name || s.name === name));
    if (match) {
      const namePart = match.rawName ? match.rawName : "";
      const typePart = match.type ? match.type : "";
      if (namePart && typePart) return `${namePart} • ${typePart}`;
      if (namePart) return namePart;
      if (typePart) return typePart;
      return null;
    }
  }

  return null;
}

function offerScopeMatchesTrip(offer, isDomestic) {
  const blob = normalizeText(
    `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.rawText || ""} ${offer?.offerSummary || ""} ${offer?.terms || ""}`
  );

  if (isDomestic && blob.includes("international") && !blob.includes("domestic")) return false;

  const obviousInternational = [
    "krabi", "siem reap", "cebu", "bangkok", "singapore", "dubai",
    "kuala lumpur", "ho chi minh", "phuket", "bali",
  ].map(normalizeText);

  if (isDomestic && obviousInternational.some(k => blob.includes(k)) && !blob.includes("domestic")) {
    return false;
  }

  return true;
}

function pickBestOfferForPortal(offers, portal, baseAmount, selectedPaymentMethods) {
  const sel = Array.isArray(selectedPaymentMethods) ? selectedPaymentMethods : [];
  if (sel.length === 0) return null;

  let best = null;

  for (const offer of offers) {
    if (!isFlightOffer(offer)) continue;
    if (isOfferExpired(offer)) continue;
    if (!offerAppliesToPortal(offer, portal)) continue;

    const isDomestic = true; // Phase-1 assumption (keep as-is for now)
    if (!offerScopeMatchesTrip(offer, isDomestic)) continue;

    // Phase-1 rule: only payment-method offers
    const offerPMs = extractOfferPaymentMethods(offer);
    if (!Array.isArray(offerPMs) || offerPMs.length === 0) continue;

    if (!offerMatchesSelectedPayment(offer, sel)) continue;
    if (!minTxnOK(offer, baseAmount)) continue;

const result = computeDiscountedPrice(offer, baseAmount, isDomestic);

const discounted =
  typeof result === "number" ? result : result.price;

const discountMeta =
  typeof result === "object" ? result.meta : null;

// If no deterministic improvement, skip
if (discounted >= baseAmount) continue;

if (!best || discounted < best.finalPrice) {
  best = {
    finalPrice: discounted,
    offer,
    explain: discountMeta
      ? {
          type: "ESTIMATED_DISCOUNT",
          message: `Estimated ${discountMeta.appliedPercent}% off (offer says up to ${discountMeta.statedPercent}%)`,
          confidence: "LOW",
          method: discountMeta.method,
        }
      : null,
  };
}

  }

  return best;
}


function buildInfoOffersForPortal(offers, portal, selectedPaymentMethods, limit = 5) {
  const sel = Array.isArray(selectedPaymentMethods) ? selectedPaymentMethods : [];
  if (sel.length === 0) return [];

  const info = [];

  for (const offer of offers) {
    if (!isFlightOffer(offer)) continue;
    if (isOfferExpired(offer)) continue;
    if (!offerAppliesToPortal(offer, portal)) continue;

    if (!offerMatchesSelectedPayment(offer, selectedPaymentMethods)) continue;

    const percent =
      offer?.discountPercent ??
      offer?.parsedFields?.discountPercent ??
      null;

    const flat =
      offer?.flatDiscountAmount ??
      offer?.parsedFields?.flatDiscountAmount ??
      offer?.discountAmount ??
      offer?.parsedFields?.discountAmount ??
      null;

    const hasDeterministicSignal =
      (typeof percent === "number" && percent > 0) ||
      (flat != null && String(flat).replace(/[^\d.]/g, "") !== "");

    // If deterministic, it would've been eligible to apply (subject to minTxn etc)
    // For infoOffers, we only want "potentially relevant but not computable"
    if (hasDeterministicSignal) continue;

    info.push({
      title: offer?.title || null,
      couponCode: offer?.couponCode || offer?.code || offer?.parsedFields?.couponCode || offer?.parsedFields?.code || null,
      rawDiscount: offer?.rawDiscount || offer?.parsedFields?.rawDiscount || null,
      offerSummary: offer?.offerSummary || offer?.parsedFields?.offerSummary || null,
      terms: offer?.terms || offer?.parsedFields?.terms || null,
      paymentHint: getMatchedSelectedPaymentLabel(offer, selectedPaymentMethods) || null,
      sourcePortal: offer?.sourceMetadata?.sourcePortal || offer?.sourcePortal || null,
    });

    if (info.length >= limit) break;
  }

  return info;
}

async function applyOffersToFlight(flight, selectedPaymentMethods, offers) {
  const base = typeof flight.price === "number" ? flight.price : 0;

  const portalPrices = OTAS.map((portal) => {
    const portalBase = Math.round(base);

    const best = pickBestOfferForPortal(offers, portal, portalBase, selectedPaymentMethods);
    const matchedPaymentLabel = best
      ? (getMatchedSelectedPaymentLabel(best.offer, selectedPaymentMethods) || null)
      : null;

    const bestDeal = best
      ? {
          portal,
          finalPrice: best.finalPrice,
          basePrice: portalBase,
          applied: true,
          code: best.offer?.couponCode || best.offer?.code || best.offer?.parsedFields?.couponCode || best.offer?.parsedFields?.code || null,
          title: best.offer?.title || null,
          rawDiscount: best.offer?.rawDiscount || best.offer?.parsedFields?.rawDiscount || null,
          constraints: extractOfferConstraints(best.offer),
        }
      : null;

    return {
      portal,
      basePrice: portalBase,
      finalPrice: best ? best.finalPrice : portalBase,
      applied: !!best,
      code: bestDeal?.code || null,
      title: bestDeal?.title || null,
      rawDiscount: bestDeal?.rawDiscount || null,
      terms: best?.offer?.terms || null,
      constraints: bestDeal?.constraints || null,
      paymentLabel: (best ? (matchedPaymentLabel || paymentLabelFromSelection(selectedPaymentMethods)) : null),
      explain: best
  ? `Applied ${bestDeal?.code || "an offer"} on ${portal} to reduce price from ₹${portalBase} to ₹${best.finalPrice}`
  : null,

      infoOffers: buildInfoOffersForPortal(offers, portal, selectedPaymentMethods, 5),
      

    };
  });

  const bestPortal = portalPrices.reduce(
    (acc, p) => (acc == null || p.finalPrice < acc.finalPrice ? p : acc),
    null
  );

  return {
    ...flight,
    portalPrices,
    bestDeal: bestPortal
      ? {
          portal: bestPortal.portal,
          finalPrice: bestPortal.finalPrice,
          basePrice: bestPortal.basePrice,
          applied: bestPortal.applied,
          code: bestPortal.code,
          title: bestPortal.title,
          rawDiscount: bestPortal.rawDiscount,
          constraints: bestPortal.constraints || null,
          paymentLabel: bestPortal.paymentLabel || null,
        explain: bestPortal?.applied
  ? `Best price is on ${bestPortal.portal} because ${bestPortal.code || "an offer"} reduced ₹${bestPortal.basePrice} → ₹${bestPortal.finalPrice}`
  : null,

        }
      : null,
  };
}

// --------------------
// Routes
// --------------------
function getCouponCode(offer) {
  return (
    offer?.couponCode ||
    offer?.code ||
    offer?.parsedFields?.couponCode ||
    offer?.parsedFields?.code ||
    null
  );
}

function getDeterministicDiscountSignal(offer) {
  const pct =
    offer?.discountPercent ??
    offer?.parsedFields?.discountPercent ??
    null;

  const flat =
    offer?.flatDiscountAmount ??
    offer?.parsedFields?.flatDiscountAmount ??
    offer?.discountAmount ??
    offer?.parsedFields?.discountAmount ??
    null;

  const pctOk = typeof pct === "number" && pct > 0;
  const flatOk = flat != null && String(flat).replace(/[^\d.]/g, "") !== "";

  return { pct, flat, pctOk, flatOk, deterministic: pctOk || flatOk };
}

function offerMentionsUpToPercent(offer) {
  const txt = String(
    offer?.rawDiscount ||
    offer?.parsedFields?.rawDiscount ||
    offer?.title ||
    ""
  ).toLowerCase();
  return /\bup to\s*\d+\s*%/.test(txt);
}


// Payment options must come from Mongo (no static fallback list)
app.get("/payment-options", async (req, res) => {
  const meta = { usedFallback: false };

  function textBlobForInference(offer) {
    return [
      offer?.title,
      offer?.rawDiscount,
      offer?.rawText,
      offer?.offerSummary,
      offer?.terms,
      offer?.rawFields ? JSON.stringify(offer.rawFields) : null,
    ]
      .filter(Boolean)
      .join(" \n ")
      .toLowerCase();
  }

  function inferTypesFromText(offer) {
    const t = textBlobForInference(offer);
    const inferred = new Set();

    if (/(?:\bemi\b|no[\s-]?cost\s*emi|easy\s*emi|credit\s*card\s*emi)/i.test(t)) inferred.add("EMI");
    if (/(?:\bupi\b|bhim|gpay|google\s*pay|phonepe|paytm\s*upi)/i.test(t)) inferred.add("UPI");
    if (/(?:net\s*banking|netbanking|internet\s*banking)/i.test(t)) inferred.add("Net Banking");
    if (/(?:\bwallet\b|paytm\s*wallet|amazon\s*pay|mobikwik|freecharge)/i.test(t)) inferred.add("Wallet");
    if (/(?:\bcredit\s*card\b)/i.test(t)) inferred.add("Credit Card");
    if (/(?:\bdebit\s*card\b)/i.test(t)) inferred.add("Debit Card");

    return Array.from(inferred);
  }

  const CANON_KEYS = ["Credit Card", "Debit Card", "Net Banking", "UPI", "Wallet", "EMI"];

  function uiBucketFromNormalizedType(normType) {
    switch (normType) {
      case "creditcard": return "Credit Card";
      case "debitcard": return "Debit Card";
      case "netbanking": return "Net Banking";
      case "upi": return "UPI";
      case "wallet": return "Wallet";
      case "emi": return "EMI";
      default: return null;
    }
  }

  function normalizeDisplayNameForUI(rawName) {
    const n = normalizeBankName(rawName);
    return n
      .split(" ")
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  try {
    const col = await getOffersCollection();

    const offers = await col
.find({}, { projection: { _id: 0, title: 1, rawDiscount: 1, rawText: 1, offerSummary: 1, terms: 1, paymentMethods: 1, eligiblePaymentMethods: 1, rawFields: 1 } })
      .toArray();

    const groups = {
      "Credit Card": new Set(),
      "Debit Card": new Set(),
      "Net Banking": new Set(),
      "UPI": new Set(),
      "Wallet": new Set(),
      "EMI": new Set(),
    };

    for (const offer of offers) {
      const structured = extractOfferPaymentMethods(offer);
      const hasStructured = Array.isArray(structured) && structured.length > 0;

      if (hasStructured) {
        for (const pm of structured) {
          const normType = normalizePaymentType(pm.type, pm.raw || "");
          const bucket = uiBucketFromNormalizedType(normType);
          if (!bucket) continue;

          const nameRaw = pm.bank || pm.name || "";
          if (!nameRaw) continue;

          const name = normalizeDisplayNameForUI(nameRaw);
          if (!name) continue;

          groups[bucket].add(name);
        }
      } else {
        // ONLY for options list, not for matching
        const inferredTypes = inferTypesFromText(offer);
        for (const t of inferredTypes) {
          if (!groups[t]) continue;
          groups[t].add(`Any ${t}`);
        }
      }
    }

    const options = {};
    for (const [k, set] of Object.entries(groups)) {
      const arr = Array.from(set).filter(Boolean);

      const anyLabel = `Any ${k}`;
      const hasSpecific = arr.some(x => x !== anyLabel);

      options[k] = (hasSpecific ? arr.filter(x => x !== anyLabel) : arr)
        .sort((a, b) => a.localeCompare(b));
    }

    res.json({ ...meta, options });
  } catch (e) {
    res.status(500).json({
      usedFallback: false,
      options: CANON_KEYS.reduce((acc, k) => (acc[k] = [], acc), {}),
      error: e?.message || "Failed to load payment options",
    });
  }
});

// Search flights + apply offers
app.post("/search", async (req, res) => {
  const body = req.body || {};
  const meta = { source: "flightapi", outStatus: 0, retStatus: 0, request: {} };

  try {
    const from = String(body.from || "").trim().toUpperCase();
    const to = String(body.to || "").trim().toUpperCase();
    const outDate = toISO(body.departureDate);
    const retDate = toISO(body.returnDate);

    const tripType = body.tripType === "round-trip" ? "round-trip" : "one-way";
    const adults = Number(body.passengers || 1) || 1;
    const cabin = normalizeCabin(body.travelClass);
    const currency = "INR";

    const selectedPaymentMethods = Array.isArray(body.paymentMethods) ? body.paymentMethods : [];

    if (!from || !to || !outDate) {
      return res.status(400).json({
        meta: { ...meta, error: "Missing from/to/departureDate" },
        outboundFlights: [],
        returnFlights: [],
      });
    }

    // Load offers ONCE per request
    const col = await getOffersCollection();
    const offers = await col.find({}, { projection: { _id: 0 } }).toArray();

    // Outbound
    const outRes = await fetchOneWayTrip({ from, to, date: outDate, adults, cabin, currency });
    meta.outStatus = outRes.status;
    meta.request.outTried = outRes.tried;

    const outFlightsRaw = mapFlightsFromFlightAPI(outRes.data);
    const outFlightsLimited = limitAndSortFlights(outFlightsRaw);

    const outboundFlights = [];
    for (const f of outFlightsLimited) {
      outboundFlights.push(await applyOffersToFlight(f, selectedPaymentMethods, offers));
    }

    // Return
    let returnFlights = [];
    if (tripType === "round-trip" && retDate) {
      const retRes = await fetchOneWayTrip({ from: to, to: from, date: retDate, adults, cabin, currency });
      meta.retStatus = retRes.status;
      meta.request.retTried = retRes.tried;

      const retFlightsRaw = mapFlightsFromFlightAPI(retRes.data);
      const retFlightsLimited = limitAndSortFlights(retFlightsRaw);

      const enriched = [];
      for (const f of retFlightsLimited) {
        enriched.push(await applyOffersToFlight(f, selectedPaymentMethods, offers));
      }
      returnFlights = enriched;
    }

    res.json({ meta, outboundFlights, returnFlights });
  } catch (e) {
    const status = e?.status || e?.response?.status || 500;
    meta.outStatus = meta.outStatus || status;
    meta.error = e?.message || "Search failed";
    meta.request.tried = e?.tried || [];

    res.status(500).json({ meta, outboundFlights: [], returnFlights: [] });
  }
});

app.get("/debug/payment-match", async (req, res) => {
  try {
    const portal = String(req.query.portal || "Cleartrip");
    const bank = String(req.query.bank || "Axis Bank");
    const type = String(req.query.type || "Credit Card");

    const selectedPaymentMethods = [{ type, name: bank }];

    const col = await getOffersCollection();
    const offers = await col.find(
      { "sourceMetadata.sourcePortal": portal },
      { projection: { _id: 0, title: 1, rawDiscount: 1, eligiblePaymentMethods: 1, offerCategories: 1, validityPeriod: 1 } }
    ).toArray();

    // show a small sample of what extractOfferPaymentMethods produces
    const sample = offers.slice(0, 20).map(o => ({
      title: o.title,
      extractedPMs: extractOfferPaymentMethods(o),
      matches: offerMatchesSelectedPayment(o, selectedPaymentMethods),
      isFlight: isFlightOffer(o),
      expired: isOfferExpired(o),
    }));

    const matchCount = offers.filter(o => offerMatchesSelectedPayment(o, selectedPaymentMethods)).length;

    res.json({
      portal,
      selectedPaymentMethods,
      portalOfferCount: offers.length,
      matchCount,
      sample,
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || "debug failed" });
  }
});
app.get("/debug/why-not-applied", async (req, res) => {
  try {
    const portal = String(req.query.portal || "Goibibo");
    const bank = String(req.query.bank || "Axis Bank");
    const type = String(req.query.type || "Credit Card");
    const baseAmount = Number(req.query.amount || 9000) || 9000;

    const selectedPaymentMethods = [{ type, name: bank }];

    const col = await getOffersCollection();

    // pull only portal offers to keep response readable
    const offers = await col.find(
      { "sourceMetadata.sourcePortal": portal },
      {
        projection: {
          _id: 0,
          title: 1,
          rawDiscount: 1,
          discountPercent: 1,
          flatDiscountAmount: 1,
          minTransactionValue: 1,
          offerCategories: 1,
          isExpired: 1,
          validityPeriod: 1,
          parsedFields: 1,
          eligiblePaymentMethods: 1,
          paymentMethods: 1,
          terms: 1,
          offerSummary: 1
        }
      }
    ).toArray();

    const stats = {
      portal,
      total: offers.length,
      isFlight: 0,
      notExpired: 0,
      matchesPayment: 0,
      minTxnOK: 0,
      deterministicDiscount: 0,
      mentionsUpTo: 0,
      wouldApplyIfEstimatedUpToAllowed: 0,
      wouldApplyNow: 0
    };

    const samples = [];

    for (const o of offers) {
      const row = { title: o.title || null, code: getCouponCode(o), rawDiscount: o.rawDiscount || null };

      const flightOk = isFlightOffer(o);
      if (flightOk) stats.isFlight++;

      const expired = isOfferExpired(o);
      if (!expired) stats.notExpired++;

      const payOk = offerMatchesSelectedPayment(o, selectedPaymentMethods);
      if (payOk) stats.matchesPayment++;

      const minOk = minTxnOK(o, baseAmount);
      if (minOk) stats.minTxnOK++;

      const sig = getDeterministicDiscountSignal(o);
      if (sig.deterministic) stats.deterministicDiscount++;

      const upTo = offerMentionsUpToPercent(o);
      if (upTo) stats.mentionsUpTo++;

      // "Would apply now" logic mirrors your pipeline
      let wouldApplyNow = false;
      let wouldApplyIfEstimated = false;

      if (flightOk && !expired && payOk && minOk) {
        if (sig.deterministic) {
          const result = computeDiscountedPrice(o, baseAmount, true);
          const discounted = typeof result === "number" ? result : result?.price;
          if (typeof discounted === "number" && discounted < baseAmount) wouldApplyNow = true;
        } else {
          // If only "up to %" exists, it is not deterministic unless you allow estimation
          if (upTo) wouldApplyIfEstimated = true;
        }
      }

      if (wouldApplyIfEstimated) stats.wouldApplyIfEstimatedUpToAllowed++;
      if (wouldApplyNow) stats.wouldApplyNow++;

      // Keep response small but useful: collect first 20 offers that reach "matchesPayment"
      if (samples.length < 20 && payOk) {
        samples.push({
          title: row.title,
          code: row.code,
          rawDiscount: row.rawDiscount,
          expired,
          minTxnOK: minOk,
          discountPercent: o.discountPercent ?? o?.parsedFields?.discountPercent ?? null,
          flatDiscountAmount: o.flatDiscountAmount ?? o?.parsedFields?.flatDiscountAmount ?? null,
          mentionsUpTo: upTo,
          extractedPMs: extractOfferPaymentMethods(o),
          deterministicDiscount: sig.deterministic
        });
      }
    }

    res.json({
      selectedPaymentMethods,
      baseAmount,
      stats,
      samples
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || "debug failed" });
  }
});


app.listen(PORT, () => {
  console.log(`SkyDeal backend listening on ${PORT}`);
});
