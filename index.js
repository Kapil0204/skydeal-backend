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

// Mongo envs
const MONGO_URI = process.env.MONGO_URI;
const MONGODB_DB = process.env.MONGODB_DB || "skydeal";
const MONGO_COL = process.env.MONGO_COL || "offers";

// FlightAPI env
const FLIGHTAPI_KEY = process.env.FLIGHTAPI_KEY;

// Estimated discount flag
const ENABLE_ESTIMATED_DISCOUNTS =
  String(process.env.ENABLE_ESTIMATED_DISCOUNTS || "").toLowerCase() === "true";

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
 * Normalize eligiblePaymentMethods -> array of objects
 */
function extractOfferPaymentMethods(offer) {
  if (!offer || typeof offer !== "object") return [];

  if (Array.isArray(offer.eligiblePaymentMethods) && offer.eligiblePaymentMethods.length > 0) {
    return offer.eligiblePaymentMethods
      .filter(pm => pm && typeof pm === "object")
      .map(pm => ({
        type: pm.type || null,
        bank: pm.bank || null,
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

  if (Array.isArray(offer.paymentMethods) && offer.paymentMethods.length > 0) {
    return offer.paymentMethods
      .filter(pm => pm && typeof pm === "object")
      .map(pm => ({
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

/**
 * ✅ NEW: Get offer's portal name consistently, and map it to your OTAS list.
 * This is the key fix so /search doesn't "lose" offers per portal.
 */
function getOfferPortalName(offer) {
  const raw =
    offer?.sourceMetadata?.sourcePortal ??
    offer?.sourcePortal ??
    offer?.parsedFields?.sourceMetadata?.sourcePortal ??
    offer?.parsedFields?.sourcePortal ??
    null;

  const s = String(raw || "").trim();
  if (!s) return null;

  const n = s.toLowerCase();

  if (n.includes("goibibo")) return "Goibibo";
  if (n.includes("makemytrip") || n.includes("make my trip") || n.includes("mmt")) return "MakeMyTrip";
  if (n.includes("yatra")) return "Yatra";
  if (n.includes("ease") && n.includes("trip")) return "EaseMyTrip";
  if (n.includes("cleartrip") || n.includes("clear trip")) return "Cleartrip";

  // If it’s exactly one of your OTAs
  const exact = OTAS.find(p => p.toLowerCase() === n);
  return exact || null;
}

/**
 * ✅ NEW: Bucket all offers by portal once.
 */
function bucketOffersByPortal(allOffers) {
  const byPortal = Object.fromEntries(OTAS.map(p => [p, []]));
  const unknown = [];

  for (const o of (Array.isArray(allOffers) ? allOffers : [])) {
    const p = getOfferPortalName(o);
    if (p && byPortal[p]) byPortal[p].push(o);
    else unknown.push(o);
  }

  return { byPortal, unknownCount: unknown.length };
}

/**
 * Inclusive by default; exclude only when obvious non-flight.
 */
function isFlightOffer(offer) {
  const text = `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""} ${offer?.terms || ""}`.toLowerCase();

  const cats = offer?.offerCategories || offer?.parsedFields?.offerCategories;
  const catBlob = Array.isArray(cats) ? cats.map(c => String(c || "").toLowerCase()).join(" | ") : "";

  const NEG_RE = /\bhotel(s)?\b|\bbus(es)?\b|\btourism\b|\battraction(s)?\b|\bholiday(s)?\b|\bcab(s)?\b|\btrain(s)?\b/;
  if (NEG_RE.test(text) || NEG_RE.test(catBlob)) return false;

  const POS_RE = /\bflight(s)?\b|\bairfare\b|\bdomestic\s+flight(s)?\b|\binternational\s+flight(s)?\b/;
  if (POS_RE.test(text) || POS_RE.test(catBlob)) return true;

  return true;
}

function isOfferExpired(offer) {
  if (typeof offer?.isExpired === "boolean") return offer.isExpired;

  const end =
    offer?.validityPeriod?.endDate ||
    offer?.parsedFields?.validityPeriod?.endDate ||
    null;

  if (end) {
    const t = new Date(end);
    if (!isNaN(t)) return t.getTime() < Date.now();
  }

  // Fallback heuristic (keep as-is, but lenient)
  return false;
}

function getMinTxnValue(offer) {
  const v =
    offer?.minTransactionValue ??
    offer?.parsedFields?.minTransactionValue ??
    null;

  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// --------------------
// Discount compute
// --------------------
function parsePercentFromRawDiscount(offer) {
  const txt = String(
    offer?.rawDiscount ||
    offer?.parsedFields?.rawDiscount ||
    offer?.offerSummary ||
    offer?.rawText ||
    ""
  );

  if (!txt) return null;

  const mAny = txt.match(/(\d{1,2})\s*%/);
  if (mAny) {
    const p = Number(mAny[1]);
    if (p > 0 && p < 90) return p;
  }

  return null;
}

function parseUpToCapFromRawDiscount(offer) {
  // detects "up to ₹1,000"
  const txt = String(
    offer?.rawDiscount ||
    offer?.parsedFields?.rawDiscount ||
    offer?.offerSummary ||
    offer?.rawText ||
    ""
  );

  const m = txt.match(/up\s*to\s*₹?\s*([\d,]+)/i);
  if (!m) return null;
  const v = Number(String(m[1]).replace(/[^\d]/g, ""));
  return Number.isFinite(v) ? v : null;
}

function computeDiscountedPrice(offer, baseAmount) {
  const base = Number(baseAmount);
  if (!Number.isFinite(base) || base <= 0) return baseAmount;

  // 1) deterministic percent
  let pct = null;
  if (offer?.discountPercent != null) {
    const n = Number(offer.discountPercent);
    if (Number.isFinite(n) && n > 0) pct = n;
  }

  // 2) estimated percent (enabled by env)
  if (pct == null && ENABLE_ESTIMATED_DISCOUNTS) {
    pct = parsePercentFromRawDiscount(offer);
  }

  // Apply percent, respect "up to" cap if present
  if (pct != null) {
    const rawDiscounted = base * (pct / 100);
    const cap = parseUpToCapFromRawDiscount(offer);
    const appliedDiscount = (cap && Number.isFinite(cap)) ? Math.min(rawDiscounted, cap) : rawDiscounted;
    const discounted = Math.round(base - appliedDiscount);
    return discounted < base ? discounted : base;
  }

  // 3) deterministic flat
  const flat = Number(offer?.flatDiscountAmount);
  if (Number.isFinite(flat) && flat > 0) {
    const discounted = Math.round(base - flat);
    return discounted < base ? discounted : base;
  }

  return base;
}

// --------------------
// Payment matching
// --------------------
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
  const methodCanonical = pm?.methodCanonical
    ? String(pm.methodCanonical).toUpperCase()
    : null;

  const typeRaw = String(pm?.type || "").toLowerCase();

  const typeNorm =
    methodCanonical ||
    (/credit/.test(typeRaw) ? "CREDIT_CARD" :
     /debit/.test(typeRaw) ? "DEBIT_CARD" :
     /net\s*bank/.test(typeRaw) ? "NET_BANKING" :
     /upi/.test(typeRaw) ? "UPI" :
     /wallet/.test(typeRaw) ? "WALLET" :
     /emi/.test(typeRaw) ? "EMI" :
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
    emiOnly: pm?.emiOnly === true,
    raw: String(pm?.raw || "").toLowerCase(),
  };
}

function offerMatchesSelectedPayment(offer, selectedPaymentMethods) {
  const sel = Array.isArray(selectedPaymentMethods) ? selectedPaymentMethods : [];
  if (sel.length === 0) return false;

  const offerPMs = extractOfferPaymentMethods(offer);
  if (!Array.isArray(offerPMs) || offerPMs.length === 0) return false;

  const selNorm = sel.map(normalizeSelectedPM).filter(x => x.typeNorm && x.bankCanonical);
  if (selNorm.length === 0) return false;

  const offerNorm = offerPMs.map(normalizeOfferPM).filter(x => x.typeNorm && x.bankCanonical);
  if (offerNorm.length === 0) return false;

  for (const s of selNorm) {
    for (const o of offerNorm) {
      // exact match
      if (s.typeNorm === o.typeNorm && s.bankCanonical === o.bankCanonical) return true;

      // ✅ EMI selection can match CC offers with emiOnly=true
      if (
        s.typeNorm === "EMI" &&
        s.bankCanonical === o.bankCanonical &&
        (o.typeNorm === "EMI" || o.emiOnly === true || o.raw.includes("emi"))
      ) {
        return true;
      }
    }
  }

  return false;
}

function getMatchedSelectedPaymentLabel(offer, selectedPaymentMethods) {
  if (!Array.isArray(selectedPaymentMethods) || selectedPaymentMethods.length === 0) return null;

  const offerPMs = extractOfferPaymentMethods(offer);
  if (offerPMs.length === 0) return null;

  const sel = selectedPaymentMethods.map((x) => {
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

// --------------------
// Core evaluator
// --------------------
function evaluateOfferForFlight({
  offer,
  portal,
  baseAmount,
  eligibilityAmount,
  selectedPaymentMethods,
}) {
  if (!offer) return { ok: false, reasons: ["NO_OFFER"] };

  if (!isFlightOffer(offer)) return { ok: false, reasons: ["NOT_FLIGHT_OFFER"] };
  if (isOfferExpired(offer)) return { ok: false, reasons: ["EXPIRED"] };

  const offerPMs = extractOfferPaymentMethods(offer);
  if (!Array.isArray(offerPMs) || offerPMs.length === 0) return { ok: false, reasons: ["NO_PAYMENT_METHODS_IN_OFFER"] };

  const sel = Array.isArray(selectedPaymentMethods) ? selectedPaymentMethods : [];
  if (sel.length === 0) return { ok: false, reasons: ["NO_SELECTED_PAYMENT_METHODS"] };
  if (!offerMatchesSelectedPayment(offer, sel)) return { ok: false, reasons: ["PAYMENT_MISMATCH"] };

  const minTxn = getMinTxnValue(offer);
  const amt = Number(eligibilityAmount ?? baseAmount);
  if (Number.isFinite(minTxn) && minTxn > 0 && Number(amt) < minTxn) {
    return { ok: false, reasons: ["MIN_TXN_NOT_MET"], minTxn };
  }

  const discounted = computeDiscountedPrice(offer, baseAmount);
  if (!Number.isFinite(discounted)) return { ok: false, reasons: ["DISCOUNT_NOT_COMPUTABLE"] };
  if (discounted >= baseAmount) return { ok: false, reasons: ["NO_IMPROVEMENT"] };

  return { ok: true, discounted, minTxn };
}

function pickBestOfferForPortal(offersForPortal, portal, baseAmount, selectedPaymentMethods, eligibilityAmount) {
  const sel = Array.isArray(selectedPaymentMethods) ? selectedPaymentMethods : [];
  if (sel.length === 0) return null;

  let best = null;

  for (const offer of (Array.isArray(offersForPortal) ? offersForPortal : [])) {
    const ev = evaluateOfferForFlight({
      offer,
      portal,
      baseAmount,
      eligibilityAmount,
      selectedPaymentMethods: sel,
    });

    if (!ev.ok) continue;

    if (!best || ev.discounted < best.finalPrice) {
      best = {
        finalPrice: ev.discounted,
        offer,
      };
    }
  }

  return best;
}

function buildInfoOffersForPortal(offersForPortal, portal, selectedPaymentMethods, limit = 5) {
  const sel = Array.isArray(selectedPaymentMethods) ? selectedPaymentMethods : [];
  if (sel.length === 0) return [];

  const info = [];

  for (const offer of (Array.isArray(offersForPortal) ? offersForPortal : [])) {
    if (!isFlightOffer(offer)) continue;
    if (isOfferExpired(offer)) continue;
    if (!offerMatchesSelectedPayment(offer, selectedPaymentMethods)) continue;

    // only show non-deterministic offers as "info"
    const percent = offer?.discountPercent ?? offer?.parsedFields?.discountPercent ?? null;
    const flat = offer?.flatDiscountAmount ?? offer?.parsedFields?.flatDiscountAmount ?? null;

    const hasDeterministicSignal =
      (typeof percent === "number" && percent > 0) ||
      (flat != null && String(flat).replace(/[^\d.]/g, "") !== "");

    if (hasDeterministicSignal) continue;

    info.push({
      title: offer?.title || null,
      couponCode: offer?.couponCode || offer?.code || offer?.parsedFields?.couponCode || offer?.parsedFields?.code || null,
      rawDiscount: offer?.rawDiscount || offer?.parsedFields?.rawDiscount || null,
      offerSummary: offer?.offerSummary || offer?.parsedFields?.offerSummary || null,
      terms: offer?.terms || offer?.parsedFields?.terms || null,
      paymentHint: getMatchedSelectedPaymentLabel(offer, selectedPaymentMethods) || null,
      sourcePortal: getOfferPortalName(offer) || null,
    });

    if (info.length >= limit) break;
  }

  return info;
}

async function applyOffersToFlight(flight, selectedPaymentMethods, offersByPortal, passengers = 1) {
  const base = typeof flight.price === "number" ? flight.price : 0;

  const portalPrices = OTAS.map((portal) => {
    const portalBase = Math.round(base);
    const eligibilityAmount = Math.round(portalBase * Math.max(1, Number(passengers) || 1));

    const offersForPortal = offersByPortal?.[portal] || [];

    const best = pickBestOfferForPortal(
      offersForPortal,
      portal,
      portalBase,
      selectedPaymentMethods,
      eligibilityAmount
    );

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
          terms: best.offer?.terms || best.offer?.parsedFields?.terms || null,
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
      terms: bestDeal?.terms || null,
      constraints: bestDeal?.constraints || null,
      paymentLabel: (best ? (matchedPaymentLabel || paymentLabelFromSelection(selectedPaymentMethods)) : null),
      explain: best
        ? `Applied ${bestDeal?.code || "an offer"} on ${portal} to reduce price from ₹${portalBase} to ₹${best.finalPrice}`
        : null,
      infoOffers: buildInfoOffersForPortal(offersForPortal, portal, selectedPaymentMethods, 5),
      debugCounts: {
        offersForPortal: offersForPortal.length,
      }
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

    meta.selectedPaymentMethods = selectedPaymentMethods;
    meta.ENABLE_ESTIMATED_DISCOUNTS = ENABLE_ESTIMATED_DISCOUNTS;

    if (!from || !to || !outDate) {
      return res.status(400).json({
        meta: { ...meta, error: "Missing from/to/departureDate" },
        outboundFlights: [],
        returnFlights: [],
      });
    }

    // Load offers ONCE per request
    const col = await getOffersCollection();
    const allOffers = await col.find({}, { projection: { _id: 0 } }).toArray();

    // ✅ Bucket offers by portal once (key fix)
    const { byPortal, unknownCount } = bucketOffersByPortal(allOffers);
    meta.offers = {
      total: allOffers.length,
      unknownPortalCount: unknownCount,
      byPortal: Object.fromEntries(OTAS.map(p => [p, (byPortal[p] || []).length])),
    };

    // Outbound
    const outRes = await fetchOneWayTrip({ from, to, date: outDate, adults, cabin, currency });
    meta.outStatus = outRes.status;
    meta.request.outTried = outRes.tried;

    const outFlightsRaw = mapFlightsFromFlightAPI(outRes.data);
    const outFlightsLimited = limitAndSortFlights(outFlightsRaw);

    const outboundFlights = [];
    for (const f of outFlightsLimited) {
      outboundFlights.push(await applyOffersToFlight(f, selectedPaymentMethods, byPortal, adults));
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
        enriched.push(await applyOffersToFlight(f, selectedPaymentMethods, byPortal, adults));
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

// Keep your existing debug routes (unchanged)
app.get("/debug/payment-match", async (req, res) => {
  try {
    const portal = String(req.query.portal || "Cleartrip");
    const bank = String(req.query.bank || "Axis Bank");
    const type = String(req.query.type || "Credit Card");
    const selectedPaymentMethods = [{ type, name: bank }];

    const col = await getOffersCollection();
    const offers = await col.find(
      { "sourceMetadata.sourcePortal": portal },
      { projection: { _id: 0, title: 1, rawDiscount: 1, eligiblePaymentMethods: 1, offerCategories: 1, validityPeriod: 1, sourceMetadata: 1 } }
    ).toArray();

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
          offerSummary: 1,
          sourceMetadata: 1,
          sourcePortal: 1,
        }
      }
    ).toArray();

    const stats = {
      portal,
      total: offers.length,
      ok: 0,
      notOk: 0,
      isFlight: 0,
      notExpired: 0,
      matchesPayment: 0,
      wouldApplyNow: 0,
    };

    const samples = [];

    for (const o of offers) {
      const isFlight = isFlightOffer(o);
      if (isFlight) stats.isFlight++;

      const expired = isOfferExpired(o);
      if (!expired) stats.notExpired++;

      const payOk = offerMatchesSelectedPayment(o, selectedPaymentMethods);
      if (payOk) stats.matchesPayment++;

      const minTxn = getMinTxnValue(o);
      const minOk = !(minTxn > 0 && baseAmount < minTxn);

      const ev = evaluateOfferForFlight({
        offer: o,
        portal,
        baseAmount,
        eligibilityAmount: baseAmount,
        selectedPaymentMethods,
      });

      if (ev.ok) {
        stats.ok++;
        stats.wouldApplyNow++;
      } else {
        stats.notOk++;
      }

      if (samples.length < 25 && payOk) {
        samples.push({
          title: o.title || null,
          code: getCouponCode(o),
          rawDiscount: o.rawDiscount || null,
          minTransactionValue: minTxn,
          expired,
          isFlight,
          wouldApplyNow: ev.ok,
          failReasons: ev.ok ? [] : ev.reasons,
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
