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

// Base OTA markup: ₹0 (no blanket markup)
const OTA_MARKUP = Number(process.env.OTA_MARKUP || 0);

// SpiceJet-only markup on OTA base prices: ₹100
const SPICEJET_OTA_MARKUP = Number(process.env.SPICEJET_OTA_MARKUP || 100);


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

// FlightAPI expects: Economy | Premium_Economy | Business | First (based on your earlier notes + typical docs)
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
    _mongoClient = new MongoClient(MONGO_URI, {
      // keep defaults; your connection already works for /payment-options
    });
    await _mongoClient.connect();
  }
  return _mongoClient.db(MONGODB_DB).collection(MONGO_COL);
}

// --------------------
// FlightAPI call (FIXED): onewaytrip
// --------------------
function buildOnewayTripUrl({ from, to, date, adults, children, infants, cabin, currency }) {
  if (!FLIGHTAPI_KEY) throw new Error("Missing FLIGHTAPI_KEY env var");

  // IMPORTANT: FlightAPI price search uses /onewaytrip/... not /oneway/...
  // format:
  // https://api.flightapi.io/onewaytrip/<api-key>/<from>/<to>/<date>/<adults>/<children>/<infants>/<cabin>/<currency>
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
// FlightAPI responses often look "Skyscanner-style" with itineraries/legs/segments/carriers.
// This mapper is defensive.
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
// FIX #4: Limit results (Indian carriers + non-stop first)
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
  // 1. Keep Indian carriers only (if available)
  const indian = flights.filter(f => isIndianCarrier(f.airlineName));
  const pool = indian.length > 0 ? indian : flights;

  // 2. Non-stop first
  pool.sort((a, b) => (a.stops || 0) - (b.stops || 0));

  // 3. Limit
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
  const s = normalizeText(raw);

  // common suffix cleanup
  const cleaned = s
    .replace(/\bbank\b/g, "bank")
    .replace(/\bltd\b/g, "ltd")
    .replace(/\blimited\b/g, "ltd")
    .trim();

  // lightweight alias mapping (expand as you see patterns)
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

  // EMI normalization
  if (t.includes("emi") || r.includes("emi") || r.includes("no cost emi") || r.includes("no-cost emi")) return "emi";

  // Netbanking normalization
  if (t.includes("net") && t.includes("bank")) return "netbanking";
  if (r.includes("net banking") || r.includes("netbanking")) return "netbanking";

  // Credit / Debit
  if (t.includes("credit")) return "creditcard";
  if (t.includes("debit")) return "debitcard";

  // UPI / Wallet
  if (t.includes("upi") || r.includes("upi")) return "upi";
  if (t.includes("wallet") || r.includes("wallet")) return "wallet";

  return t || "other";
}

function paymentKey(pm) {
  const type = normalizePaymentType(pm?.type, pm?.raw);
  const bank = pm?.bank ? normalizeBankName(pm.bank) : "";
  const network = normalizeText(pm?.network || "");
  // key is used only for matching/dedup
  return `${type}|${bank}|${network}`;
}


// Extract (type,name) from offer documents with different shapes
function extractOfferConstraints(offer) {
  const text = String(offer?.terms || "").toLowerCase();
  return {
    requiresEligibleBIN: text.includes("bin"),
    appOnly: text.includes("mobile app"),
    websiteOnly: text.includes("website bookings"),
    onePerUser: text.includes("once per"),
  };
}

function extractOfferPaymentMethods(offer) {
  const out = [];
  const pm = offer?.paymentMethods;

  // Shape A: [{type, bank/network/name, ...}]
  if (Array.isArray(pm)) {
    for (const x of pm) {
      if (typeof x === "string") {
        // string like "ICICI Bank" without type (not ideal)
        out.push({ type: "Other", name: x });
      } else if (x && typeof x === "object") {
        const type = normalizePaymentType(x.type || x.methodType || x.paymentType);
        const name =
          x.name ||
          x.bank ||
          x.bankName ||
          x.provider ||
          x.network ||
          x.cardNetwork ||
          x.issuer ||
          "";
        if (name) out.push({ type, name: String(name) });
      }
    }
  }

  // Shape B: rawFields.paymentMethods may exist
  const rawPM = offer?.rawFields?.paymentMethods;
  if (Array.isArray(rawPM)) {
    for (const x of rawPM) {
      if (x && typeof x === "object") {
        const type = normalizePaymentType(x.type);
        const name = x.name || x.bank || x.network || x.provider;
        if (name) out.push({ type, name: String(name) });
      }
    }
  }

  return out;
}

function offerAppliesToPortal(offer, portalName) {
  // If offer has explicit platform/portal targeting, respect it. Otherwise assume it can apply.
  const candidates = [
    offer?.sourcePortal,
    offer?.sourceMetadata?.sourcePortal,
  ].filter(Boolean);

  if (candidates.length > 0) {
    return candidates.some((p) => String(p).toLowerCase() === String(portalName).toLowerCase());
  }

  const platforms = offer?.parsedApplicablePlatforms || offer?.applicablePlatforms || offer?.platforms;
  if (Array.isArray(platforms) && platforms.length > 0) {
    return platforms.some((p) => String(p).toLowerCase().includes(String(portalName).toLowerCase()));
  }

  return true;
}
function isFlightOffer(offer) {
  const cats = offer?.offerCategories || [];
  const isFlightCategory = Array.isArray(cats) && cats.some(c => /^(flights?|flight)$/i.test(String(c)));

  if (!isFlightCategory) return false;

  // Exclude ancillary / add-on offers that should NOT reduce base fare
  const hay = normalizeText(
    `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.terms || ""}`
  );

 const ancillaryKeywords = [
  "baggage", "baggages", "excess baggage", "excess baggages",
  "seat", "seat selection",
  "cancellation", "free cancellation", "cancellation cover",
  "insurance", "travel insurance",
  "meal", "meals",
  "lounge",
  "web checkin", "web check-in", "check-in",
  "visa"
];


  if (ancillaryKeywords.some(k => hay.includes(normalizeText(k)))) return false;

  return true;
}



function isOfferExpired(offer) {
  if (typeof offer?.isExpired === "boolean") return offer.isExpired;

  // try parsed validityPeriod end
  const end = offer?.validityPeriod?.endDate || offer?.parsedFields?.validityPeriod?.endDate;
  if (end) {
    const t = new Date(end);
    if (!isNaN(t)) return t.getTime() < Date.now();
  }
  return false; // default: not expired if unknown
}

function minTxnOK(offer, amount) {
  const v =
    offer?.minTransactionValue ??
    offer?.parsedFields?.minTransactionValue ??
    offer?.parsedFields?.minTxnValue ??
    null;

  if (typeof v === "number") return amount >= v;

  // sometimes minTransactionValue is string like "4000"
  const n = Number(String(v || "").replace(/[^\d.]/g, ""));
  if (!isNaN(n) && n > 0) return amount >= n;

  return true; // if unknown, do not block
}
function detectDomesticInternationalCap(offer, isDomestic) {
  const text = String(offer?.rawDiscount || "").toLowerCase();

  // Look for explicit dual-scope wording
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
  // Support percent discount AND flat discount (you explicitly need flat-amount support)
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

  let final = baseAmount;

  if (typeof percent === "number" && percent > 0) {
    final = baseAmount * (1 - percent / 100);
  } else {
    const n = Number(String(flat || "").replace(/[^\d.]/g, ""));
    if (!isNaN(n) && n > 0) final = baseAmount - n;
  }

  // cap by maxDiscountAmount if present (if percent was used)
  let maxAmt =
  offer?.maxDiscountAmount ??
  offer?.parsedFields?.maxDiscountAmount ??
  null;

// 🔒 STEP 2: Domestic / International override (only if detected)
const scopedCap = detectDomesticInternationalCap(offer, isDomestic);
if (typeof scopedCap === "number") {
  maxAmt = scopedCap;
}


  if (typeof percent === "number" && percent > 0 && maxAmt != null) {
    const maxN = Number(String(maxAmt).replace(/[^\d.]/g, ""));
    if (!isNaN(maxN) && maxN > 0) {
      const discount = baseAmount - final;
      if (discount > maxN) final = baseAmount - maxN;
    }
  }

  // no negative
  if (final < 0) final = 0;
  return Math.round(final);
}
function textBlobForPaymentInference(offer) {
  return [
    offer?.title,
    offer?.rawDiscount,
    offer?.rawText,
    offer?.offerSummary,
    offer?.terms,
  ]
    .filter(Boolean)
    .join(" \n ")
    .toLowerCase();
}

function inferPaymentTypesFromOfferText(offer) {
  const t = textBlobForPaymentInference(offer);

  const types = new Set();

  if (/(?:\bemi\b|no[\s-]?cost\s*emi|credit\s*card\s*emi)/i.test(t)) types.add("emi");
  if (/(?:\bupi\b|bhim|gpay|google\s*pay|phonepe|paytm\s*upi)/i.test(t)) types.add("upi");
  if (/(?:net\s*banking|netbanking|internet\s*banking)/i.test(t)) types.add("netbanking");
  if (/(?:\bwallet\b|paytm\s*wallet|amazon\s*pay|mobikwik|freecharge)/i.test(t)) types.add("wallet");
  if (/(?:\bcredit\s*card\b)/i.test(t)) types.add("creditcard");
  if (/(?:\bdebit\s*card\b)/i.test(t)) types.add("debitcard");

  return types;
}

function normalizeSelectedPaymentToTypes(selectedPaymentMethods) {
  const types = new Set();
  const banks = new Set();

  const arr = Array.isArray(selectedPaymentMethods) ? selectedPaymentMethods : [];

  for (const s of arr) {
    if (typeof s === "string") {
      const t = normalizePaymentType(s, s);
      if (t) types.add(t);
      banks.add(normalizeBankName(s));
      continue;
    }

    const t = normalizePaymentType(s?.type || s?.name || "", s?.raw || "");
    if (t) types.add(t);

    const b = s?.bank || s?.name || s?.raw || "";
    if (b) banks.add(normalizeBankName(b));
  }

  return { types, banks };
}

function offerMatchesSelectedPayment(offer, selectedPaymentMethods) {
  const selected = Array.isArray(selectedPaymentMethods) ? selectedPaymentMethods : [];
  if (selected.length === 0) return true;

  const { types: selectedTypes, banks: selectedBanks } = normalizeSelectedPaymentToTypes(selected);

  const offerPMs = Array.isArray(offer?.paymentMethods) ? offer.paymentMethods : [];

  // If offer has structured payment methods, match against them
  if (offerPMs.length > 0) {
    for (const pm of offerPMs) {
      const offerType = normalizePaymentType(pm?.type || "", pm?.raw || "");
      const offerBank = pm?.bank ? normalizeBankName(pm.bank) : "";

      // type-only match (e.g., user selected "Credit Card")
      if (selectedTypes.has(offerType)) return true;

      // bank match (e.g., user selected "HDFC Bank")
      if (offerBank && selectedBanks.has(offerBank)) return true;

      // last-resort contains match
      const hay = normalizeText(`${pm?.type || ""} ${pm?.bank || ""} ${pm?.network || ""} ${pm?.raw || ""}`);
      for (const s of selected) {
        const needle = normalizeText(typeof s === "string" ? s : `${s?.type || ""} ${s?.bank || ""} ${s?.name || ""} ${s?.raw || ""}`);
        if (needle && hay.includes(needle)) return true;
      }
    }
    return false;
  }

  // If offer has NO structured paymentMethods, infer from text (ONLY for payment gating)
  const inferredTypes = inferPaymentTypesFromOfferText(offer);

  // If text indicates it is payment-specific, require intersection
  if (inferredTypes.size > 0) {
    for (const t of inferredTypes) {
      if (selectedTypes.has(t)) return true;
    }
    // also allow bank selection matching if bank appears in text
    const blob = normalizeText(textBlobForPaymentInference(offer));
    for (const b of selectedBanks) {
      if (b && blob.includes(normalizeText(b))) return true;
    }
    return false;
  }

  // Offer does not appear payment-specific → don't block it due to payment selection
  return true;
}





function getMatchedSelectedPaymentLabel(offer, selectedPaymentMethods) {
  if (!Array.isArray(selectedPaymentMethods) || selectedPaymentMethods.length === 0) return null;

  const offerPMs = extractOfferPaymentMethods(offer);
  if (offerPMs.length === 0) return null;

  // selected can be strings OR objects
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
    const name = normalizeBankName(pm.bank || pm.name || pm.raw || "");

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


function offerHasPaymentRestriction(offer) {
  // structured PMs
  const pm = Array.isArray(offer?.paymentMethods) ? offer.paymentMethods : [];
  if (pm.length > 0) return true;

  // inferred from text
  const blob = normalizeText(
    `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.rawText || ""} ${offer?.offerSummary || ""} ${offer?.terms || ""}`
  );

  return (
    /\bemi\b|no\s*cost\s*emi|no-?cost\s*emi/.test(blob) ||
    /\bupi\b|bhim|gpay|google\s*pay|phonepe|paytm\s*upi/.test(blob) ||
    /net\s*banking|netbanking|internet\s*banking/.test(blob) ||
    /\bwallet\b|paytm\s*wallet|amazon\s*pay|mobikwik|freecharge/.test(blob) ||
    /\bcredit\s*card\b/.test(blob) ||
    /\bdebit\s*card\b/.test(blob)
  );
}
function offerScopeMatchesTrip(offer, isDomestic) {
  const blob = normalizeText(
    `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.rawText || ""} ${offer?.offerSummary || ""} ${offer?.terms || ""}`
  );

  // If it explicitly says "international" and does NOT say "domestic",
  // block it for domestic searches.
  if (isDomestic && blob.includes("international") && !blob.includes("domestic")) return false;

  // Very conservative destination keyword blocklist (only for domestic searches).
  // (Add more if you keep seeing them; this is meant to avoid obvious irrelevance.)
  const obviousInternational = [
    "krabi",
    "siem reap",
    "cebu",
    "bangkok",
    "singapore",
    "dubai",
    "kuala lumpur",
    "ho chi minh",
    "phuket",
    "bali",
  ].map(normalizeText);

  if (isDomestic && obviousInternational.some(k => blob.includes(k)) && !blob.includes("domestic")) {
    return false;
  }

  return true;
}


function pickBestOfferForPortal(offers, portal, baseAmount, selectedPaymentMethods) {
  // ✅ Phase-1 rule: if user didn't select any payment method,
  // we should NOT apply payment-restricted offers by default.
  const sel = Array.isArray(selectedPaymentMethods) ? selectedPaymentMethods : [];
  if (sel.length === 0) return null;

  let best = null;

  for (const offer of offers) {
    if (!isFlightOffer(offer)) continue;
    if (isOfferExpired(offer)) continue;
    if (!offerAppliesToPortal(offer, portal)) continue;

    const isDomestic = true;
    if (typeof offerScopeMatchesTrip === "function") {
      if (!offerScopeMatchesTrip(offer, isDomestic)) continue;
    }

    if (!offerMatchesSelectedPayment(offer, selectedPaymentMethods)) continue;

    // 🔒 PAYMENT-PHASE RULE: only apply payment-method-related offers
    if (!offerHasPaymentRestriction(offer)) continue;

    if (!minTxnOK(offer, baseAmount)) continue;

    const discounted = computeDiscountedPrice(offer, baseAmount, isDomestic);

    // 🔒 Ignore offers that do not reduce price
    if (discounted >= baseAmount) continue;

    if (!best || discounted < best.finalPrice) {
      best = { finalPrice: discounted, offer };
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

    // IMPORTANT: info offers should still respect payment filtering
    // so we don’t show irrelevant bank-only deals when user selected something else.
    if (!offerMatchesSelectedPayment(offer, selectedPaymentMethods)) continue;

    // We ONLY want offers that are NOT deterministic / not applied.
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

    // If deterministic, ignore here (those are eligible for pricing path already)
    if (hasDeterministicSignal) continue;

    info.push({
      title: offer?.title || null,
      couponCode: offer?.couponCode || offer?.code || offer?.parsedFields?.couponCode || offer?.parsedFields?.code || null,
      rawDiscount: offer?.rawDiscount || offer?.parsedFields?.rawDiscount || null,
      offerSummary: offer?.offerSummary || offer?.parsedFields?.offerSummary || null,
      terms: offer?.terms || offer?.parsedFields?.terms || null,
      paymentHint: getMatchedSelectedPaymentLabel(offer, selectedPaymentMethods) || null,
      sourcePortal: offer?.sourceMetadata?.sourcePortal || null,
    });

    if (info.length >= limit) break;
  }

  return info;
}


async function applyOffersToFlight(flight, selectedPaymentMethods, offers) {
  const base = typeof flight.price === "number" ? flight.price : 0;

  const portalPrices = OTAS.map((portal) => {
    const isSpiceJet = String(flight.airlineName || "").toLowerCase().includes("spicejet");
const portalBase = Math.round(base + OTA_MARKUP + (isSpiceJet ? SPICEJET_OTA_MARKUP : 0));


    const best = pickBestOfferForPortal(offers, portal, portalBase, selectedPaymentMethods);
    const matchedPaymentLabel = best ? getMatchedSelectedPaymentLabel(best.offer, selectedPaymentMethods) : null;


    // ✅ bestDeal must be based on THIS portal's best offer, not bestPortal (which is computed later)
    const bestDeal = best
      ? {
          portal,
          finalPrice: best.finalPrice,
          basePrice: portalBase,
          applied: true,
          code: best.offer?.code || best.offer?.couponCode || best.offer?.parsedFields?.code || null,
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
        paymentLabel: matchedPaymentLabel,
      infoOffers: buildInfoOffersForPortal(offers, portal, selectedPaymentMethods, 5),
    
    };
  });

  // best overall among portals
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

        }
      : null,
  };
}


// --------------------
// Routes
// --------------------

// Payment options must come from Mongo (no static fallback list)
app.get("/payment-options", async (req, res) => {
  const meta = { usedFallback: false };

  // 🔒 Only affects /payment-options output (does NOT touch offer matching)
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

    // EMI
    if (/(?:\bemi\b|no[\s-]?cost\s*emi|easy\s*emi|credit\s*card\s*emi)/i.test(t)) inferred.add("EMI");

    // UPI
    if (/(?:\bupi\b|bhim|gpay|google\s*pay|phonepe|paytm\s*upi)/i.test(t)) inferred.add("UPI");

    // Net Banking
    if (/(?:net\s*banking|netbanking|internet\s*banking)/i.test(t)) inferred.add("Net Banking");

    // Wallet
    if (/(?:\bwallet\b|paytm\s*wallet|amazon\s*pay|mobikwik|freecharge)/i.test(t)) inferred.add("Wallet");

    // Cards (generic)
    if (/(?:\bcredit\s*card\b)/i.test(t)) inferred.add("Credit Card");
    if (/(?:\bdebit\s*card\b)/i.test(t)) inferred.add("Debit Card");

    return Array.from(inferred);
  }

  function pickName(pm) {
    // normalize "name" from whichever field exists in your parsed schema
    // (pm.name might be absent; pm.bank/raw might exist)
    const candidates = [pm?.name, pm?.bank, pm?.network, pm?.raw];
    for (const c of candidates) {
      const s = String(c || "").trim();
      if (s) return s;
    }
    return "";
  }

  // ✅ Canonical UI buckets (don’t allow random keys)
  const CANON_KEYS = ["Credit Card", "Debit Card", "Net Banking", "UPI", "Wallet", "EMI"];
  // Map internal normalized types -> UI bucket labels
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

// Normalize + dedupe card/bank labels (so you don't get slight variants)
function normalizeDisplayNameForUI(rawName) {
  // If it's a bank, normalize with your existing bank normalizer
  const n = normalizeBankName(rawName);
  // Make it readable in UI (basic Title Case)
  return n
    .split(" ")
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}


  try {
    const col = await getOffersCollection();

    // pull only what we need
    const offers = await col
      .find(
        {},
        { projection: { _id: 0, title: 1, rawDiscount: 1, rawText: 1, offerSummary: 1, terms: 1, paymentMethods: 1, rawFields: 1 } }
      )
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
      // 1) Structured PMs (preferred)
      const structured = extractOfferPaymentMethods(offer); // keep your existing helper
      const hasStructured = Array.isArray(structured) && structured.length > 0;

      if (hasStructured) {
        for (const pm of structured) {
  const normType = normalizePaymentType(pm.type, pm.raw || "");
  const bucket = uiBucketFromNormalizedType(normType);
  if (!bucket) continue;

  const nameRaw = pickName(pm);
  if (!nameRaw) continue;

  const name = normalizeDisplayNameForUI(nameRaw);
  if (!name) continue;

  groups[bucket].add(name);
}

      } else {
        // 2) Inference fallback (ONLY for options list)
        const inferredTypes = inferTypesFromText(offer);
        for (const t of inferredTypes) {
          if (!groups[t]) continue;
          // add a generic option so the tab is not empty
          // (offer matching stays separate; this is only for UI availability)
          groups[t].add(`Any ${t}`);
        }
      }
    }

    // convert to arrays (sorted)
    // convert to arrays (sorted) with smart "Any X" handling
const options = {};
for (const [k, set] of Object.entries(groups)) {
  const arr = Array.from(set).filter(Boolean);

  const anyLabel = `Any ${k}`;
  const hasAny = arr.includes(anyLabel);
  const hasSpecific = arr.some(x => x !== anyLabel);

  // If real banks exist, hide generic "Any X"
  options[k] = (hasSpecific ? arr.filter(x => x !== anyLabel) : arr)
    .sort((a, b) => a.localeCompare(b));
}

    res.json({ ...meta, options });
  } catch (e) {
    res.status(500).json({
      usedFallback: false,
      options: {
        "Credit Card": [],
        "Debit Card": [],
        "Net Banking": [],
        "UPI": [],
        "Wallet": [],
        "EMI": [],
      },
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

    // Outbound
    const outRes = await fetchOneWayTrip({ from, to, date: outDate, adults, cabin, currency });
    meta.outStatus = outRes.status;
    meta.request.outTried = outRes.tried;

    const outFlightsRaw = mapFlightsFromFlightAPI(outRes.data);
    // --------------------
// FIX #1: Load offers ONCE per search request
// --------------------
const col = await getOffersCollection();
const offers = await col.find({}, { projection: { _id: 0 } }).toArray();

    const outFlightsLimited = limitAndSortFlights(outFlightsRaw);


    // Apply offers per flight
  
    const outboundFlights = [];
    for (const f of outFlightsLimited) {
      outboundFlights.push(await applyOffersToFlight(f, selectedPaymentMethods, offers));
    }

    // Return (if round-trip)
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

app.listen(PORT, () => {
  console.log(`SkyDeal backend listening on ${PORT}`);
});
