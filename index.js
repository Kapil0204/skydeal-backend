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

// Feature flags
const ENABLE_ESTIMATED_DISCOUNTS =
  String(process.env.ENABLE_ESTIMATED_DISCOUNTS || "false").toLowerCase() === "true";

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

function normalizeCabinShort(cabin) {
  const c = String(cabin || "Economy");
  if (c === "Premium_Economy") return "premium";
  if (c === "Business") return "business";
  if (c === "First") return "first";
  return "economy";
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
// Limit results
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
  "go first",
];

function isIndianCarrier(airlineName) {
  const n = String(airlineName || "").toLowerCase();
  return INDIAN_CARRIERS.some((c) => n.includes(c));
}

function limitAndSortFlights(flights) {
  const indian = flights.filter((f) => isIndianCarrier(f.airlineName));
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
 * ===========================
 * Inference fallback (kept)
 * ===========================
 */
function inferPaymentMethodsFromText(offer) {
  const blob = String(
    `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""} ${offer?.terms || ""}`
  ).toLowerCase();

  const inferredTypes = new Set();
  if (/\bno[\s-]?cost\s*emi\b|\bemi\b/.test(blob)) inferredTypes.add("EMI");
  if (/\bcredit\s*card\b|\bcc\b/.test(blob)) inferredTypes.add("CREDIT_CARD");
  if (/\bdebit\s*card\b/.test(blob)) inferredTypes.add("DEBIT_CARD");
  if (/\bnet\s*banking\b|\bnetbanking\b|\binternet\s*banking\b/.test(blob)) inferredTypes.add("NET_BANKING");
  if (/\bupi\b/.test(blob)) inferredTypes.add("UPI");
  if (/\bwallet\b/.test(blob)) inferredTypes.add("WALLET");

  const bankRules = [
    { re: /\baxis\b/, bank: "Axis Bank", canon: "AXIS_BANK" },
    { re: /\bhdfc\b/, bank: "HDFC Bank", canon: "HDFC_BANK" },
    { re: /\bicici\b/, bank: "ICICI Bank", canon: "ICICI_BANK" },
    { re: /\bhsbc\b/, bank: "HSBC", canon: "HSBC" },
    { re: /\bsbi\b|\bstate bank\b/, bank: "State Bank of India", canon: "STATE_BANK_OF_INDIA" },
    { re: /\bkotak\b/, bank: "Kotak Bank", canon: "KOTAK_BANK" },
    { re: /\byes bank\b|\byes\b/, bank: "Yes Bank", canon: "YES_BANK" },
    { re: /\brbl\b/, bank: "RBL Bank", canon: "RBL_BANK" },
    { re: /\bau bank\b|\bau small\b|\bau small finance\b/, bank: "AU Bank", canon: "AU_BANK" },
    { re: /\bfederal\b/, bank: "Federal Bank", canon: "FEDERAL_BANK" },
    { re: /\bidfc\b/, bank: "IDFC First Bank", canon: "IDFC_FIRST_BANK" },
    { re: /\bindusind\b/, bank: "IndusInd Bank", canon: "INDUSIND_BANK" },
  ];

  const banks = bankRules.filter((r) => r.re.test(blob));
  if (inferredTypes.size === 0 || banks.length === 0) return [];

  const out = [];
  for (const b of banks) {
    for (const t of inferredTypes) {
      out.push({
        type:
          t === "EMI" ? "emi" :
          t === "CREDIT_CARD" ? "credit_card" :
          t === "DEBIT_CARD" ? "debit_card" :
          t === "NET_BANKING" ? "net_banking" :
          t === "UPI" ? "upi" : "wallet",
        bank: b.bank,
        network: null,
        methodCanonical: t,
        bankCanonical: b.canon,
        networkCanonical: null,
        emiOnly: t === "EMI" || /\bemi\b/.test(blob),
        tenureMonths: null,
        conditions: /\bno[\s-]?cost\s*emi\b/.test(blob) ? "No-Cost EMI" : null,
        raw: `${b.bank} (inferred)`,
        inferred: true,
      });
    }
  }
  return out;
}

function extractOfferPaymentMethods(offer) {
  if (!offer || typeof offer !== "object") return [];

  let out = [];

  if (Array.isArray(offer.eligiblePaymentMethods) && offer.eligiblePaymentMethods.length > 0) {
    out = offer.eligiblePaymentMethods
      .filter((pm) => pm && typeof pm === "object")
      .map((pm) => ({
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
      .filter((pm) => pm.type || pm.methodCanonical || pm.bank || pm.bankCanonical);
  } else if (Array.isArray(offer.paymentMethods) && offer.paymentMethods.length > 0) {
    out = offer.paymentMethods
      .filter((pm) => pm && typeof pm === "object")
      .map((pm) => ({
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
      .filter((pm) => pm.type || pm.methodCanonical || pm.bank || pm.bankCanonical);
  }

  if (!out || out.length === 0) {
    const inferred = inferPaymentMethodsFromText(offer);
    if (Array.isArray(inferred) && inferred.length > 0) return inferred;
  }

  return out || [];
}

function offerAppliesToPortal(offer, portalName) {
  const portal = String(portalName || "").toLowerCase().trim();

  const src =
    offer?.sourceMetadata?.sourcePortal ??
    offer?.sourcePortal ??
    offer?.parsedFields?.sourceMetadata?.sourcePortal ??
    null;

  if (src) {
    return String(src).toLowerCase().trim() === portal;
  }

  const platforms =
    offer?.parsedApplicablePlatforms ||
    offer?.applicablePlatforms ||
    offer?.platforms ||
    offer?.parsedFields?.parsedApplicablePlatforms ||
    null;

  if (Array.isArray(platforms) && platforms.length > 0) {
    return platforms.some((p) => String(p || "").toLowerCase().includes(portal));
  }

  return false;
}

function isFlightOffer(offer) {
  const text = `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""} ${offer?.terms || ""}`.toLowerCase();
  const cats = offer?.offerCategories || offer?.parsedFields?.offerCategories;
  const catBlob = Array.isArray(cats) ? cats.map((c) => String(c || "").toLowerCase()).join(" | ") : "";

  const combined = `${text} ${catBlob}`.trim();

  // Any strong flight signal?
  const FLIGHT_RE =
    /\bflight(s)?\b|\bairfare\b|\bair\s*ticket(s)?\b|\bair\s*travel\b|\bdomestic\s+flight(s)?\b|\binternational\s+flight(s)?\b/;

  // Strong non-flight verticals (these should NEVER apply to flights unless flight is explicitly mentioned)
  const NON_FLIGHT_RE =
    /\bhotel(s)?\b|\bbus(es)?\b|\bcab(s)?\b|\btrain(s)?\b|\bholiday(s)?\b|\btourism\b|\battraction(s)?\b|\bactivity\b|\bactivities\b|\bvisa\b|\bforex\b|\bcruise\b|\bcar\s*rental\b/;

  const hasFlightSignal = FLIGHT_RE.test(combined);
  const hasNonFlightSignal = NON_FLIGHT_RE.test(combined);

  // ✅ Hard rule:
  // If it mentions tourism/attractions/holidays/etc AND does NOT mention flights -> reject.
  if (hasNonFlightSignal && !hasFlightSignal) return false;

  // If it mentions flights, accept (even if it also mentions hotels via "flights & hotels")
  if (hasFlightSignal) return true;

  // Otherwise reject
  return false;
}


function isHotelOnlyOffer(offer) {
  const text = `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.terms || ""}`.toLowerCase();

  const mentionsHotel = /\bhotel(s)?\b/.test(text);
  const mentionsFlight = /\bflight(s)?\b|\bair\s*ticket(s)?\b|\bairfare\b/.test(text);

  // ❌ Explicit hotel-only offer
  return mentionsHotel && !mentionsFlight;
}

function isOfferExpired(offer) {
  if (typeof offer?.isExpired === "boolean") return offer.isExpired;

  const end = offer?.validityPeriod?.endDate || offer?.parsedFields?.validityPeriod?.endDate || null;

  if (end) {
    const t = new Date(end);
    if (!isNaN(t)) return t.getTime() < Date.now();
  }

  const blobs = [];
  if (offer?.validityPeriod?.raw) blobs.push(String(offer.validityPeriod.raw));
  if (offer?.parsedFields?.validityPeriod?.raw) blobs.push(String(offer.parsedFields.validityPeriod.raw));

  const keyTerms = offer?.offerSummary?.keyTerms || offer?.parsedFields?.offerSummary?.keyTerms;
  if (Array.isArray(keyTerms)) blobs.push(keyTerms.join(" | "));

  if (offer?.terms?.raw) blobs.push(String(offer.terms.raw));
  if (offer?.parsedFields?.terms?.raw) blobs.push(String(offer.parsedFields.terms.raw));

  blobs.push(String(offer?.title || ""));
  blobs.push(String(offer?.rawDiscount || ""));
  blobs.push(String(offer?.rawText || ""));

  const text = blobs.filter(Boolean).join(" \n ");

  const monthNames =
    "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  const re1 = new RegExp(`\\b${monthNames}\\s+\\d{1,2}(?:st|nd|rd|th)?[,]?\\s+\\d{4}\\b`, "ig");
  const re2 = new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${monthNames}\\s+\\d{4}\\b`, "ig");
  const re3 = /\b\d{4}-\d{2}-\d{2}\b/g;

  const candidates = [...(text.match(re1) || []), ...(text.match(re2) || []), ...(text.match(re3) || [])];

  if (candidates.length === 0) return false;

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

function getMinTxnValue(offer) {
  const v = offer?.minTransactionValue ?? offer?.parsedFields?.minTransactionValue ?? null;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// --------------------
// Discount compute
// --------------------
function parsePercentFromRawDiscount(offer, isDomestic) {
  const txt = String(offer?.rawDiscount || offer?.parsedFields?.rawDiscount || offer?.offerSummary || offer?.rawText || "");
  if (!txt) return null;

  if (isDomestic) {
    const mDom = txt.match(/(\d{1,2})\s*%[^%]{0,60}\bdomestic\b/i);
    if (mDom) return Number(mDom[1]);
  }

  const mAny = txt.match(/(\d{1,2})\s*%/);
  if (mAny) {
    const p = Number(mAny[1]);
    if (p > 0 && p < 90) return p;
  }

  return null;
}

function computeDiscountedPrice(offer, baseAmount, isDomestic) {
  const base = Number(baseAmount);
  if (!Number.isFinite(base) || base <= 0) return baseAmount;

  let pct = null;
  if (offer?.discountPercent != null) {
    const n = Number(offer.discountPercent);
    if (Number.isFinite(n) && n > 0) pct = n;
  }

  if (pct == null) {
    if (ENABLE_ESTIMATED_DISCOUNTS) pct = parsePercentFromRawDiscount(offer, isDomestic);
  }

  if (pct != null) {
    const discounted = Math.round(base * (1 - pct / 100));
    return discounted < base ? discounted : base;
  }

  const flat = Number(offer?.flatDiscountAmount);
  if (Number.isFinite(flat) && flat > 0) {
    const discounted = Math.round(base - flat);
    return discounted < base ? discounted : base;
  }

  return base;
}

// --------------------
// Payment matching (robust)
// --------------------
function bankCanonicalFromAny(raw) {
  const s = String(raw || "").toUpperCase();

  const rules = [
    { re: /\bAXIS\b/, canon: "AXIS_BANK" },
    { re: /\bHDFC\b/, canon: "HDFC_BANK" },
    { re: /\bICICI\b/, canon: "ICICI_BANK" },
    { re: /\bHSBC\b/, canon: "HSBC" },
    { re: /\bSBI\b|\bSTATE_BANK\b/, canon: "STATE_BANK_OF_INDIA" },
    { re: /\bKOTAK\b/, canon: "KOTAK_BANK" },
    { re: /\bYES\b/, canon: "YES_BANK" },
    { re: /\bRBL\b/, canon: "RBL_BANK" },
    { re: /\bAU\b/, canon: "AU_BANK" },
    { re: /\bFEDERAL\b/, canon: "FEDERAL_BANK" },
    { re: /\bIDFC\b/, canon: "IDFC_FIRST_BANK" },
    { re: /\bINDUSIND\b/, canon: "INDUSIND_BANK" },
  ];

  for (const r of rules) {
    if (r.re.test(s)) return r.canon;
  }

  const cleaned = s.replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || null;
}

function normalizeSelectedPM(pm) {
  const typeRaw = String(pm?.type || "").trim();
  const nameRaw = String(pm?.name || pm?.bank || "").trim();
  const t = typeRaw.toLowerCase().replace(/\s+/g, "");

  const typeNorm =
    /emi/.test(t) ? "EMI" :
    /credit/.test(t) ? "CREDIT_CARD" :
    /debit/.test(t) ? "DEBIT_CARD" :
    /netbank/.test(t) || /netbanking/.test(t) ? "NET_BANKING" :
    /upi/.test(t) ? "UPI" :
    /wallet/.test(t) ? "WALLET" :
    null;

  const bankCanonical = bankCanonicalFromAny(nameRaw);
  return { typeNorm, bankCanonical, nameRaw };
}

function normalizeOfferPM(pm) {
  const methodCanonical = pm?.methodCanonical ? String(pm.methodCanonical).toUpperCase() : null;
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

  const bankFromFields = pm?.bankCanonical || pm?.bank || pm?.name || pm?.raw || "";
  const bankCanonical = bankCanonicalFromAny(bankFromFields);

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

  const selNorm = sel.map(normalizeSelectedPM).filter((x) => x.typeNorm && x.bankCanonical);
  if (selNorm.length === 0) return false;

  const offerNorm = offerPMs.map(normalizeOfferPM).filter((x) => x.typeNorm);
  if (offerNorm.length === 0) return false;

  for (const s of selNorm) {
    for (const o of offerNorm) {
      if (o.bankCanonical) {
        if (s.bankCanonical !== o.bankCanonical) continue;
      } else {
        const blob = `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.rawText || ""}`.toUpperCase();
        if (!blob.includes(String(s.nameRaw || "").toUpperCase().split(" ")[0])) continue;
      }

      if (s.typeNorm === o.typeNorm) return true;

      if (
        s.typeNorm === "EMI" &&
        o.typeNorm === "CREDIT_CARD" &&
        (o.emiOnly === true || o.raw.includes("emi"))
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

// scope/cabin sanity
function offerScopeMatchesTrip(offer, isDomestic, cabin) {
  const blob = normalizeText(`${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.rawText || ""} ${offer?.offerSummary || ""} ${offer?.terms || ""}`);
  const cats = offer?.offerCategories || offer?.parsedFields?.offerCategories;
  const catBlob = Array.isArray(cats) ? normalizeText(cats.map((c) => String(c || "")).join(" ")) : "";
  const combined = `${blob} ${catBlob}`.trim();
    // ✅ Extra safety: reject non-flight verticals unless flight is explicitly mentioned
  const hasFlight = /\bflight(s)?\b|\bair\s*ticket(s)?\b|\bairfare\b/.test(combined);
  const hasNonFlightVertical =
    /\btourism\b|\battraction(s)?\b|\bholiday(s)?\b|\bbus(es)?\b|\bcab(s)?\b|\btrain(s)?\b|\bhotel(s)?\b/.test(combined);

  if (hasNonFlightVertical && !hasFlight) return false;

  const cabinShort = normalizeCabinShort(cabin);

  if ((cabinShort === "economy" || cabinShort === "premium") && /\bbusiness\s+class\b|\bfirst\s+class\b/.test(combined)) {
    return false;
  }

  if (isDomestic) {
    const hasDomesticFlights = /\bdomestic\s+flight(s)?\b/.test(combined);
    const hasInternationalFlights = /\binternational\s+flight(s)?\b/.test(combined);

    if (hasInternationalFlights && !hasDomesticFlights) return false;

    if (/\binternational\b/.test(combined) && !/\bdomestic\b/.test(combined) && /\bflight(s)?\b/.test(combined)) {
      return false;
    }
  }

  return true;
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
  isDomestic,
  cabin,
}) {
  if (!offer) return { ok: false, reasons: ["NO_OFFER"] };

  // ✅ Gate 1: must be a flight offer
  if (!isFlightOffer(offer)) return { ok: false, reasons: ["NOT_FLIGHT_OFFER"] };
    // HARD BLOCK: non-flight verticals must never apply to flight booking
  // unless "flight/air ticket/airfare" is explicitly mentioned.
  const nfBlob = `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.rawText || ""} ${offer?.terms || ""}`.toLowerCase();
  const mentionsFlight = /\bflight(s)?\b|\bair\s*ticket(s)?\b|\bairfare\b/.test(nfBlob);
  const mentionsNonFlight = /\btourism\b|\battraction(s)?\b|\bholiday(s)?\b|\bactivity\b|\bvisa\b|\bforex\b|\bbus(es)?\b|\bcab(s)?\b|\btrain(s)?\b|\bhotel(s)?\b/.test(nfBlob);

  if (mentionsNonFlight && !mentionsFlight) {
    return { ok: false, reasons: ["NON_FLIGHT_VERTICAL"] };
  }


  // ✅ NEW: reject explicit hotel-only offers (prevents hotel offers applying to flights)
  if (isHotelOnlyOffer(offer)) return { ok: false, reasons: ["HOTEL_ONLY"] };

  if (isOfferExpired(offer)) return { ok: false, reasons: ["EXPIRED"] };
  if (!offerAppliesToPortal(offer, portal)) return { ok: false, reasons: ["PORTAL_MISMATCH"] };
  if (!offerScopeMatchesTrip(offer, isDomestic, cabin)) return { ok: false, reasons: ["SCOPE_MISMATCH"] };

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

  const discounted = computeDiscountedPrice(offer, baseAmount, isDomestic);
  if (!Number.isFinite(discounted)) return { ok: false, reasons: ["DISCOUNT_NOT_COMPUTABLE"] };
  if (discounted >= baseAmount) return { ok: false, reasons: ["NO_IMPROVEMENT"] };

  return { ok: true, discounted, minTxn };
}

function pickBestOfferForPortal(offers, portal, baseAmount, selectedPaymentMethods, eligibilityAmount, cabin) {
  const sel = Array.isArray(selectedPaymentMethods) ? selectedPaymentMethods : [];
  if (sel.length === 0) return null;

  let best = null;

  for (const offer of offers) {
    const isDomestic = true; // Phase-1 assumption

    const ev = evaluateOfferForFlight({
      offer,
      portal,
      baseAmount,
      eligibilityAmount,
      selectedPaymentMethods: sel,
      isDomestic,
      cabin,
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

function buildInfoOffersForPortal(offers, portal, selectedPaymentMethods, cabin, limit = 5) {
  const sel = Array.isArray(selectedPaymentMethods) ? selectedPaymentMethods : [];
  if (sel.length === 0) return [];

  const info = [];

  for (const offer of offers) {
    if (!isFlightOffer(offer)) continue;
    // ✅ keep info list flight-only, but also skip hotel-only
    if (isHotelOnlyOffer(offer)) continue;
    if (isOfferExpired(offer)) continue;
    if (!offerAppliesToPortal(offer, portal)) continue;
    if (!offerScopeMatchesTrip(offer, true, cabin)) continue;
    if (!offerMatchesSelectedPayment(offer, selectedPaymentMethods)) continue;

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
      sourcePortal: offer?.sourceMetadata?.sourcePortal || offer?.sourcePortal || null,
    });

    if (info.length >= limit) break;
  }

  return info;
}

async function applyOffersToFlight(flight, selectedPaymentMethods, offers, passengers = 1, cabin = "Economy") {
  const base = typeof flight.price === "number" ? flight.price : 0;

  const portalPrices = OTAS.map((portal) => {
    const portalBase = Math.round(base);
    const eligibilityAmount = Math.round(portalBase * Math.max(1, Number(passengers) || 1));

    const best = pickBestOfferForPortal(
      offers,
      portal,
      portalBase,
      selectedPaymentMethods,
      eligibilityAmount,
      cabin
    );

    const matchedPaymentLabel = best ? (getMatchedSelectedPaymentLabel(best.offer, selectedPaymentMethods) || null) : null;

    const bestDeal = best
      ? {
          portal,
          finalPrice: best.finalPrice,
          basePrice: portalBase,
          applied: true,
          code:
            best.offer?.couponCode ||
            best.offer?.code ||
            best.offer?.parsedFields?.couponCode ||
            best.offer?.parsedFields?.code ||
            null,
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
      paymentLabel: best ? (matchedPaymentLabel || paymentLabelFromSelection(selectedPaymentMethods)) : null,
      explain: best ? `Applied ${bestDeal?.code || "an offer"} on ${portal} to reduce price from ₹${portalBase} to ₹${best.finalPrice}` : null,
      infoOffers: buildInfoOffersForPortal(offers, portal, selectedPaymentMethods, cabin, 5),
      debugCounts: {
        offersForPortal: offers.filter((o) => offerAppliesToPortal(o, portal)).length,
      },
    };
  });

  const bestPortal = portalPrices.reduce((acc, p) => (acc == null || p.finalPrice < acc.finalPrice ? p : acc), null);

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
// ✅ RESTORED: Payment options (Mongo-driven, no fallback)
// --------------------
function canonicalTypeToFrontendBucket(methodCanonicalOrType) {
  const v = String(methodCanonicalOrType || "").toUpperCase();
  if (v === "EMI") return "EMI";
  if (v === "CREDIT_CARD") return "CreditCard";
  if (v === "DEBIT_CARD") return "DebitCard";
  if (v === "NET_BANKING") return "NetBanking";
  if (v === "UPI") return "UPI";
  if (v === "WALLET") return "Wallet";
  return null;
}

function offerPmToCanonical(pm) {
  const method = String(pm?.methodCanonical || "").toUpperCase();
  if (method) return method;

  const t = String(pm?.type || "").toLowerCase();
  if (t.includes("emi")) return "EMI";
  if (t.includes("credit")) return "CREDIT_CARD";
  if (t.includes("debit")) return "DEBIT_CARD";
  if (t.includes("net")) return "NET_BANKING";
  if (t.includes("upi")) return "UPI";
  if (t.includes("wallet")) return "WALLET";
  return null;
}

function pickDisplayBankName(pm) {
  // preserve what user expects (Axis Bank etc.)
  const b = pm?.bank || pm?.name || "";
  const raw = String(b || "").trim();
  if (!raw) return null;
  // light cleanup
  return raw.replace(/\s+/g, " ").trim();
}

async function computePaymentOptionsFromOffers() {
  const col = await getOffersCollection();
  const offers = await col.find({}, { projection: { _id: 0 } }).toArray();

  const buckets = {
    EMI: new Set(),
    CreditCard: new Set(),
    DebitCard: new Set(),
    NetBanking: new Set(),
    UPI: new Set(),
    Wallet: new Set(),
  };

  for (const offer of offers) {
    const pms = extractOfferPaymentMethods(offer); // includes inference if needed
    for (const pm of pms) {
      const canon = offerPmToCanonical(pm);
      const bucket = canonicalTypeToFrontendBucket(canon);
      if (!bucket) continue;

      const bank = pickDisplayBankName(pm);
      if (!bank) continue;

      buckets[bucket].add(bank);
    }
  }

  const options = {
    EMI: Array.from(buckets.EMI).sort(),
    CreditCard: Array.from(buckets.CreditCard).sort(),
    DebitCard: Array.from(buckets.DebitCard).sort(),
    NetBanking: Array.from(buckets.NetBanking).sort(),
    UPI: Array.from(buckets.UPI).sort(),
    Wallet: Array.from(buckets.Wallet).sort(),
  };

  return { usedFallback: false, options };
}

// --------------------
// ✅ RESTORED: /payment-options
// --------------------
app.get("/payment-options", async (req, res) => {
  try {
    const out = await computePaymentOptionsFromOffers();
    res.json(out);
  } catch (e) {
    res.status(500).json({ usedFallback: false, error: e?.message || "Failed to load payment options" });
  }
});

// --------------------
// ✅ RESTORED: /debug/why-not-applied
// --------------------
app.get("/debug/why-not-applied", async (req, res) => {
  try {
    const portal = String(req.query.portal || "").trim();
    const bank = String(req.query.bank || "").trim();
    const type = String(req.query.type || "").trim(); // e.g. EMI
    const amount = Number(req.query.amount || 0) || 0;

    if (!portal || !bank || !type) {
      return res.status(400).json({ error: "Missing portal/bank/type" });
    }

    const selectedPaymentMethods = [{ type, name: bank }];

    const col = await getOffersCollection();
    const offers = await col.find(
      { "sourceMetadata.sourcePortal": portal },
      { projection: { _id: 0 } }
    ).toArray();

    const stats = {
      portal,
      total: offers.length,
      ok: 0,
      notOk: 0,
      isFlight: 0,
      notExpired: 0,
      matchesPayment: 0,
      portalMatch: 0,
      scopeOK: 0,
      minTxnOK: 0,
      wouldApplyNow: 0,
      hotelOnly: 0, // ✅ NEW stat
    };

    const samples = [];

    for (const offer of offers) {
      const failReasons = [];

      const flight = isFlightOffer(offer);
      if (flight) stats.isFlight++;
      else failReasons.push("NOT_FLIGHT_OFFER");

      // ✅ NEW: explicitly track hotel-only rejects
      const hotelOnly = isHotelOnlyOffer(offer);
      if (hotelOnly) stats.hotelOnly++;
      if (hotelOnly) failReasons.push("HOTEL_ONLY");

      const expired = isOfferExpired(offer);
      if (!expired) stats.notExpired++;
      else failReasons.push("EXPIRED");

      const pMatch = offerAppliesToPortal(offer, portal);
      if (pMatch) stats.portalMatch++;
      else failReasons.push("PORTAL_MISMATCH");

      const scope = offerScopeMatchesTrip(offer, true, "Economy");
      if (scope) stats.scopeOK++;
      else failReasons.push("SCOPE_MISMATCH");

      const pay = offerMatchesSelectedPayment(offer, selectedPaymentMethods);
      if (pay) stats.matchesPayment++;
      else failReasons.push("PAYMENT_MISMATCH");

      const minTxn = getMinTxnValue(offer);
      if (!minTxn || amount >= minTxn) stats.minTxnOK++;
      else failReasons.push("MIN_TXN_NOT_MET");

      // Would apply now = all gates except improvement test
      // (hotel-only should block wouldApplyNow as well)
      const wouldApplyNow = failReasons.length === 0;

      if (wouldApplyNow) stats.wouldApplyNow++;

      // ok = wouldApplyNow AND compute yields improvement
      let ok = false;
      if (wouldApplyNow) {
        const discounted = computeDiscountedPrice(offer, amount, true);
        ok = Number.isFinite(discounted) && discounted < amount;
      }

      if (ok) stats.ok++;
      else stats.notOk++;

      if (samples.length < 10 && (wouldApplyNow || ok)) {
        samples.push({
          title: offer?.title || null,
          code: offer?.couponCode || offer?.code || null,
          rawDiscount: offer?.rawDiscount || null,
          minTransactionValue: minTxn || 0,
          expired: !!expired,
          isFlight: !!flight,
          hotelOnly: !!hotelOnly,
          wouldApplyNow,
          failReasons,
        });
      }
    }

    res.json({ selectedPaymentMethods, baseAmount: amount, stats, samples });
  } catch (e) {
    res.status(500).json({ error: e?.message || "debug failed" });
  }
});

// --------------------
// Search flights + apply offers
// --------------------
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
    meta.usedFallback = false;

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
      outboundFlights.push(await applyOffersToFlight(f, selectedPaymentMethods, offers, adults, cabin));
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
        enriched.push(await applyOffersToFlight(f, selectedPaymentMethods, offers, adults, cabin));
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
