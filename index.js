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
// Route geography helpers
// --------------------
const INDIAN_IATA_AIRPORTS = new Set([
  "AMD","ATQ","BBI","BDQ","BHO","BHU","BLR","BOM","CCJ","CCU","CJB","COK","DED","DEL","DMU",
  "GAU","GOI","GOP","GWL","HBX","HYD","IDR","IXA","IXB","IXC","IXD","IXE","IXG","IXJ","IXL",
  "IXM","IXR","IXS","IXU","JAI","JDH","JGA","JLR","JRG","JSA","IXY","JGB","KNU","LKO","MAA",
  "MYQ","NAG","PAT","PNQ","RJA","RPR","SAG","SLV","SXR","STV","SXV","TRV","TRZ","UDR","VGA",
  "VNS","VTZ","PNY","AGX","DIB","IMF","SHL","AIP","NDC","TIR","RDP","JRH","TEZ","TCR","TCR",
  "COH","DHM","KUU","LEH","SBI","TCR","UDR","BEP","HJR","JLG","AJL","IXK","ISK","JAI","NMI"
]);

function isIndianAirportIata(iata) {
  return INDIAN_IATA_AIRPORTS.has(String(iata || "").trim().toUpperCase());
}

function isDomesticRoute(from, to) {
  const a = String(from || "").trim().toUpperCase();
  const b = String(to || "").trim().toUpperCase();
  if (!a || !b) return true; // safe default
  return isIndianAirportIata(a) && isIndianAirportIata(b);
}

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

function isSuspiciousGenericOffer(offer, allOffersForPortal = []) {
  const hasPayment =
    (offer?.eligiblePaymentMethods && offer.eligiblePaymentMethods.length > 0) ||
    (offer?.paymentMethods && offer.paymentMethods.length > 0);

  if (hasPayment) return false;

  const coupon = offer?.couponCode;
  if (!coupon) return false;

  // check if same coupon exists with payment-specific version
  const hasPaymentVariant = allOffersForPortal.some(o =>
    o?.couponCode === coupon &&
    (
      (o?.eligiblePaymentMethods && o.eligiblePaymentMethods.length > 0) ||
      (o?.paymentMethods && o.paymentMethods.length > 0)
    )
  );

  return hasPaymentVariant;
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

  const tried = [];
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      const text = await res.text();

      const triedRow = {
        url,
        status: res.status,
        attempt,
        ...(attempt > 1 ? { retry: true } : {}),
      };

      if (!res.ok) {
        triedRow.body = text.slice(0, 800);
      }

      tried.push(triedRow);

      if (res.ok) {
        return {
          status: res.status,
          data: JSON.parse(text),
          tried,
        };
      } else {
        lastError = {
          status: res.status,
          body: text,
        };
      }
    } catch (err) {
      lastError = { error: err.message };
      tried.push({
        url,
        attempt,
        ...(attempt > 1 ? { retry: true } : {}),
        error: err.message,
      });
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  const err = new Error(
    `FlightAPI request failed (${lastError?.status || lastError?.error || "no-status"})`
  );
  err.status = lastError?.status || 500;
  err.tried = tried;
  throw err;
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
function isValidBestOffer(offer) {
  if (!offer || typeof offer !== "object") return false;

  // 1. Expiry
  if (isOfferExpired(offer)) return false;

  const rawDiscount = String(
    offer?.rawDiscount ||
    offer?.parsedFields?.rawDiscount ||
    ""
  ).trim();

  const title = String(offer?.title || "").trim();

  const blob = `${title} ${rawDiscount}`.toLowerCase();

  const percent = Number(
    offer?.discountPercent ??
    offer?.parsedFields?.discountPercent ??
    0
  );

  const flat = Number(
    offer?.flatDiscountAmount ??
    offer?.parsedFields?.flatDiscountAmount ??
    0
  );

  const maxCap = Number(
    offer?.maxDiscountAmount ??
    offer?.parsedFields?.maxDiscountAmount ??
    0
  );

  const minTxn = Number(
    offer?.minTransactionValue ??
    offer?.parsedFields?.minTransactionValue ??
    0
  );

  const hasPercent = Number.isFinite(percent) && percent > 0;
  const hasFlat = Number.isFinite(flat) && flat > 0;
  const hasCap = Number.isFinite(maxCap) && maxCap > 0;
  const hasMinTxn = Number.isFinite(minTxn) && minTxn > 0;

  const mentionsUpTo = /\bup\s*to\b|\bupto\b/.test(blob);
  const mentionsCashback = /\bcashback\b/.test(blob);
  const mentionsInstantDiscount =
    /\binstant discount\b/.test(blob) ||
    /\binstant off\b/.test(blob) ||
    /\bflat\b/.test(blob) ||
    /\boff\b/.test(blob) ||
    /\bdiscount\b/.test(blob);

  // 2. Must have some real discount signal
  if (!hasPercent && !hasFlat) return false;

  // 3. Cashback-only should never become best offer
  // Allow mixed offers only if they also have a real instant-discount structure
  if (mentionsCashback && !mentionsInstantDiscount) return false;

  // 4. Pure vague "up to" rows should never become best offer
  // Examples:
  // - "Up to 25% OFF*"
  // - "Up to 15% OFF on Domestic Flights for All Users"
  // Allow only if there is a calculable structure:
  // - cap
  // - flat amount
  // - or min transaction
  if (mentionsUpTo && !hasFlat && !hasCap && !hasMinTxn) return false;

  // 5. Coupon required but missing code
  const code =
    offer?.couponCode ||
    offer?.code ||
    offer?.parsedFields?.couponCode ||
    offer?.parsedFields?.code ||
    null;

  if (offer?.couponRequired && !code) return false;

  // 6. Percent-only offers without cap are too vague for best-price selection
  // Example: "Up to 15% OFF*" with no max cap
  if (hasPercent && !hasFlat && !hasCap) return false;

  return true;
}

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
    // IMPORTANT: inference must be CORE-only.
  // rawText/terms often contain template noise (nav/footer) and causes false bank matches.
  const offerSummary =
    typeof offer?.offerSummary === "string"
      ? offer.offerSummary
      : offer?.offerSummary
        ? JSON.stringify(offer.offerSummary)
        : (offer?.parsedFields?.offerSummary ? JSON.stringify(offer.parsedFields.offerSummary) : "");

  const blob = String(`${offer?.title || ""} ${offer?.rawDiscount || ""} ${offerSummary}`)
    .toLowerCase()
    .slice(0, 8000);

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
function extractOfferPaymentMethodsNoInference(offer) {
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
        inferred: pm.inferred === true, // if DB ever has it
      }))
      // ✅ HARD FILTER: remove null-only PM rows like your Malaysia example
      .filter((pm) => {
        const hasAny =
          (pm.type && String(pm.type).trim() !== "") ||
          (pm.methodCanonical && String(pm.methodCanonical).trim() !== "") ||
          (pm.bank && String(pm.bank).trim() !== "") ||
          (pm.bankCanonical && String(pm.bankCanonical).trim() !== "");
        return hasAny;
      });
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
        inferred: pm.inferred === true,
      }))
      .filter((pm) => {
        const hasAny =
          (pm.type && String(pm.type).trim() !== "") ||
          (pm.methodCanonical && String(pm.methodCanonical).trim() !== "") ||
          (pm.bank && String(pm.bank).trim() !== "") ||
          (pm.bankCanonical && String(pm.bankCanonical).trim() !== "");
        return hasAny;
      });
  }

  // ❌ IMPORTANT: no inferPaymentMethodsFromText() here
  return out || [];
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
        inferred: false, // ✅ explicit, not inferred
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
        inferred: false, // ✅ explicit, not inferred
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
  // IMPORTANT: Only trust "core" fields for classification.
  // rawText/terms often contain site template noise (e.g., nav/footer with “Flights”).
  const title = String(offer?.title || "");
  const rawDiscount = String(offer?.rawDiscount || offer?.parsedFields?.rawDiscount || "");
  const offerSummary =
    typeof offer?.offerSummary === "string"
      ? offer.offerSummary
      : offer?.offerSummary
        ? JSON.stringify(offer.offerSummary)
        : (offer?.parsedFields?.offerSummary ? JSON.stringify(offer.parsedFields.offerSummary) : "");

  const core = `${title} ${rawDiscount} ${offerSummary}`.toLowerCase();

  const cats = offer?.offerCategories || offer?.parsedFields?.offerCategories;
  const catBlob = Array.isArray(cats)
    ? cats.map((c) => String(c || "").toLowerCase()).join(" | ")
    : "";

  // Strong non-flight verticals (if core says these and does NOT say flights, it’s NOT a flight offer)
  const NON_FLIGHT_RE =
    /\bhotel(s)?\b|\bbus(es)?\b|\bcab(s)?\b|\btrain(s)?\b|\btourism\b|\battraction(s)?\b|\bholiday(s)?\b|\bactivities?\b|\bvisa\b|\bforex\b/;

  // Strong flight signals (must appear in CORE text)
    // Strong flight signals (must appear in CORE text)
  // ✅ Added airline+fare combo to catch titles like "Malaysia Airlines Exclusive Fares"
  const FLIGHT_CORE_RE =
    /\bflight(s)?\b|\bair\s*ticket(s)?\b|\bairfare\b|\bdomestic\s+flight(s)?\b|\binternational\s+flight(s)?\b|\bairlines?\b.*\bfare(s)?\b|\bfare(s)?\b.*\bairlines?\b/;

  const coreHasFlight = FLIGHT_CORE_RE.test(core);
  const coreHasNonFlight = NON_FLIGHT_RE.test(core);

  // If core clearly indicates a non-flight vertical AND does not clearly indicate flights => reject
  if (coreHasNonFlight && !coreHasFlight) return false;

  // If core clearly indicates flights => accept
  if (coreHasFlight) return true;

  // Weak fallback: if categories say flight AND core doesn't indicate non-flight verticals
  // (prevents template noise from rawText causing false positives)
  const catsSayFlight = /\bflight(s)?\b/.test(catBlob);
  if (catsSayFlight && !coreHasNonFlight) return true;

  return false;
}

function isHotelOnlyOffer(offer) {
  const text = `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.terms || ""}`.toLowerCase();

  const mentionsHotel = /\bhotel(s)?\b/.test(text);
  const mentionsFlight = /\bflight(s)?\b|\bair\s*ticket(s)?\b|\bairfare\b/.test(text);

  // ❌ Explicit hotel-only offer
  return mentionsHotel && !mentionsFlight;
}

function isFirstTimeOrNewUserOffer(offer) {
  const blob = normalizeText(
    `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""} ${offer?.terms?.raw || offer?.terms || ""}`
  );

  return (
    /\bnew\s*user(s)?\b/.test(blob) ||
    /\bnew\s*customer(s)?\b/.test(blob) ||
    /\bfirst\s*(booking|transaction|order|purchase|trip|flight)\b/.test(blob) ||
    /\bfirst[-\s]*time\b/.test(blob) ||
    /\bfirst\s*app\s*booking\b/.test(blob) ||
    /\bfirst\s*ever\b/.test(blob)
  );
}

function hasExplicitOfferPaymentMethods(offer) {
  const pms =
    offer?.parsedFields?.paymentMethods ||
    offer?.paymentMethods ||
    offer?.eligiblePaymentMethods ||
    offer?.parsedFields?.eligiblePaymentMethods ||
    [];

  if (Array.isArray(pms) && pms.length > 0) return true;

  const blob = `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.rawText || ""} ${offer?.terms?.raw || offer?.terms || ""}`.toLowerCase();

  const bankKeywords = [
    "axis", "hdfc", "icici", "sbi", "kotak", "amex", "indusind",
    "hsbc", "idfc", "yes bank", "rbl", "au bank", "federal", "canara",
    "bank of baroda", "central bank", "onecard", "cred"
  ];

  const paymentKeywords = [
    "credit card", "debit card", "emi", "upi", "wallet", "net banking", "netbanking", "card"
  ];

  const mentionsBank = bankKeywords.some((b) => blob.includes(b));
  const mentionsPayment = paymentKeywords.some((p) => blob.includes(p));

  return mentionsBank || mentionsPayment;
}
function isNoPaymentOffer(offer) {
  return !hasExplicitOfferPaymentMethods(offer);
}

function offerTargetsThisAirline(offer, airlineName) {
  const airline = normalizeText(airlineName || "");
  if (!airline) return false;

  const routeRestrictions = Array.isArray(offer?.terms?.routeOrAirlineRestrictions)
    ? offer.terms.routeOrAirlineRestrictions.join(" ")
    : "";

  const parsedRouteRestrictions = Array.isArray(offer?.parsedFields?.terms?.routeOrAirlineRestrictions)
    ? offer.parsedFields.terms.routeOrAirlineRestrictions.join(" ")
    : "";

  const blob = normalizeText(
    `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""} ${offer?.terms?.raw || offer?.terms || ""} ${routeRestrictions} ${parsedRouteRestrictions}`
  );

  if (blob.includes(airline)) return true;

  // Airline aliases / codes
  if (airline.includes("air india express") && (/\bair india express\b/.test(blob) || /\baix\b/.test(blob))) return true;
  if (airline.includes("air india") && /\bair india\b/.test(blob)) return true;
  if (airline.includes("indigo") && (/\bindigo\b/.test(blob) || /\b6e\b/.test(blob))) return true;
  if (airline.includes("spicejet") && (/\bspicejet\b/.test(blob) || /\bsg\b/.test(blob))) return true;
  if (airline.includes("akasa") && (/\bakasa\b/.test(blob) || /\bqp\b/.test(blob))) return true;
  if (airline.includes("alliance air") && /\balliance air\b/.test(blob)) return true;
  if (airline.includes("star air") && /\bstar air\b/.test(blob)) return true;
  if (airline.includes("fly91") && /\bfly91\b/.test(blob)) return true;

  return false;
}

function getOfferKindForFlight(offer, selectedPaymentMethods, flightAirlineName) {
  const hasExplicitPM = hasExplicitOfferPaymentMethods(offer);
  const hasSelectedPM = Array.isArray(selectedPaymentMethods) && selectedPaymentMethods.length > 0;

  // 1) Payment-required offers must not apply when user selected nothing
     if (hasExplicitPM) {
    if (!hasSelectedPM) {
      return { kind: null, reason: "PAYMENT_REQUIRED_NOT_SELECTED" };
    }

    const matches = offerMatchesSelectedPayment(offer, selectedPaymentMethods);
    if (matches) {
      return { kind: "payment" };
    }

    return { kind: null, reason: "PAYMENT_MISMATCH" };
  }

  // 2) No explicit payment requirement → airline or portal
  if (offerTargetsThisAirline(offer, flightAirlineName)) {
    return { kind: "airline" };
  }

  return { kind: "portal" };
}

function getOfferTypeLabel(kind, offer = null) {
  const suffix = offer && isCashbackStyleOffer(offer) ? " (cashback)" : "";

  if (kind === "payment") return `Payment offer${suffix}`;
  if (kind === "airline") return `Airline offer${suffix}`;
  if (kind === "portal") return `Portal offer (no payment required)${suffix}`;
  return null;
}

function getOfferChannelLabel(offer) {
  const c = extractOfferConstraints(offer);
  if (c.appOnly) return "Book on app";
  if (c.websiteOnly) return "Book on website";
  return null;
}
function offerCannotBeClubbed(offer) {
  const blob = normalizeText(
    `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""} ${offer?.terms?.raw || offer?.terms || ""}`
  );

  return (
    /\bcannot be clubbed\b/.test(blob) ||
    /\bcan not be clubbed\b/.test(blob) ||
    /\bnot be clubbed\b/.test(blob) ||
    /\bnot valid with any other offer\b/.test(blob) ||
    /\bcannot be combined\b/.test(blob) ||
    /\bnot combinable\b/.test(blob) ||
    /\bnot applicable with any other offer\b/.test(blob)
  );
}
function offerRequiresRoundTrip(offer) {
  const blob = normalizeText(
    `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""}`
  );

  return (
    blob.includes("return flight") ||
    blob.includes("return flights") ||
    blob.includes("return booking") ||
    blob.includes("round trip") ||
    blob.includes("round-trip") ||
    blob.includes("roundtrip")
  );
}

function offerRequiresOneWayOnly(offer) {
  const blob = normalizeText(
    `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""} ${offer?.terms?.raw || offer?.terms || ""}`
  );

  const hasOneWay =
    /\bone way\b|\bone-way\b|\boneway\b/.test(blob);

  const hasRoundTrip =
    /\bround trip\b|\bround-trip\b|\broundtrip\b|\breturn booking(s)?\b|\breturn flight(s)?\b/.test(blob);

  return hasOneWay && !hasRoundTrip;
}
function getPassengerRestrictionResult(offer, passengers = 1) {
  const pax = Math.max(1, Number(passengers) || 1);

  const blob = normalizeText(
    `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""} ${offer?.terms?.raw || offer?.terms || ""}`
  );

  // Solo / single passenger only
  if (
    /\bsolo traveler only\b/.test(blob) ||
    /\bsolo traveller only\b/.test(blob) ||
    /\bsingle passenger only\b/.test(blob) ||
    /\bone passenger only\b/.test(blob) ||
    /\bonly for 1 passenger\b/.test(blob)
  ) {
    if (pax !== 1) {
      return { ok: false, reason: "PASSENGER_COUNT_RESTRICTED_SOLO_ONLY" };
    }
  }

  // Minimum passenger count
  const minMatch =
    blob.match(/\bminimum\s+(\d+)\s+passenger(s)?\b/) ||
    blob.match(/\bmin(?:imum)?\s+(\d+)\s+passenger(s)?\b/) ||
    blob.match(/\bvalid only for (\d+)\+\s*passenger(s)?\b/) ||
    blob.match(/\bfor (\d+)\+\s*passenger(s)?\b/);

  if (minMatch && minMatch[1]) {
    const minPax = Number(minMatch[1]);
    if (Number.isFinite(minPax) && pax < minPax) {
      return { ok: false, reason: "PASSENGER_COUNT_BELOW_MINIMUM", minPassengers: minPax };
    }
  }

  // Maximum passenger count
  const maxMatch =
    blob.match(/\bmaximum\s+(\d+)\s+passenger(s)?\b/) ||
    blob.match(/\bmax(?:imum)?\s+(\d+)\s+passenger(s)?\b/) ||
    blob.match(/\bup to (\d+)\s+passenger(s)? only\b/);

  if (maxMatch && maxMatch[1]) {
    const maxPax = Number(maxMatch[1]);
    if (Number.isFinite(maxPax) && pax > maxPax) {
      return { ok: false, reason: "PASSENGER_COUNT_ABOVE_MAXIMUM", maxPassengers: maxPax };
    }
  }

  // Infant restrictions
  if (
    /\binfant not allowed\b/.test(blob) ||
    /\bnot valid with infant\b/.test(blob) ||
    /\bexcluding infant\b/.test(blob)
  ) {
    // current request model does not separately carry infants
    // keep this as informational only for now
    return { ok: true, warning: "INFANT_RESTRICTION_PRESENT_BUT_NOT_ENFORCED" };
  }

  return { ok: true };
}

function isOfferExpired(offer) {
  if (typeof offer?.isExpired === "boolean") return offer.isExpired;

  const toDate =
    offer?.validityPeriod?.to ||
    offer?.parsedFields?.validityPeriod?.to ||
    offer?.validityPeriod?.endDate ||
    offer?.parsedFields?.validityPeriod?.endDate ||
    null;

  function parseDateLoose(x) {
    const s = String(x || "").trim();
    if (!s) return null;

    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
      const d = new Date(s);
      return isNaN(d) ? null : d;
    }

    const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (m) {
      const dd = Number(m[1]), mm = Number(m[2]), yy = Number(m[3]);
      const d = new Date(Date.UTC(yy, mm - 1, dd));
      return isNaN(d) ? null : d;
    }

    const d2 = new Date(s.replace(/(\d+)(st|nd|rd|th)/gi, "$1"));
    return isNaN(d2) ? null : d2;
  }

  // 1) Strong structured validity first
  if (toDate) {
    const t = parseDateLoose(toDate);
    if (t) {
      const end = new Date(t);
      end.setHours(23, 59, 59, 999);

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      return end.getTime() < today.getTime();
    }
  }

  // 2) If no structured validity exists, only trust text fallback
  const blobs = [];
  if (offer?.validityPeriod?.raw) blobs.push(String(offer.validityPeriod.raw));
  if (offer?.parsedFields?.validityPeriod?.raw) blobs.push(String(offer.parsedFields.validityPeriod.raw));
  if (offer?.terms?.raw) blobs.push(String(offer.terms.raw));
  if (offer?.parsedFields?.terms?.raw) blobs.push(String(offer.parsedFields.terms.raw));
  blobs.push(String(offer?.title || ""));
  blobs.push(String(offer?.rawDiscount || ""));
  blobs.push(String(offer?.rawText || ""));

  const text = blobs.filter(Boolean).join(" \n ");
  const lower = text.toLowerCase();

  const monthNames =
    "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  const re1 = new RegExp(`\\b${monthNames}\\s+\\d{1,2}(?:st|nd|rd|th)?[,]?\\s+\\d{4}\\b`, "ig");
  const re2 = new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${monthNames}\\s+\\d{4}\\b`, "ig");
  const re3 = /\b\d{4}-\d{2}-\d{2}\b/g;

  const candidates = [
    ...(text.match(re1) || []),
    ...(text.match(re2) || []),
    ...(text.match(re3) || []),
  ];

  if (candidates.length === 0) return false;

  const bookingValidityHints = [
    "valid till",
    "valid until",
    "validity",
    "booking period",
    "book by",
    "offer valid till",
    "offer valid until",
    "campaign period",
    "booking till",
    "expires on",
    "expiring on",
    "offer ends",
  ];

  let latest = null;

  for (const s of candidates) {
    const idx = lower.indexOf(String(s).toLowerCase());
    const winStart = Math.max(0, idx - 80);
    const winEnd = Math.min(lower.length, idx + 120);
    const windowTxt = lower.slice(winStart, winEnd);

    const looksLikeBookingValidity = bookingValidityHints.some((hint) => windowTxt.includes(hint));
    if (!looksLikeBookingValidity) continue;

    const d = new Date(String(s).replace(/(\d+)(st|nd|rd|th)/gi, "$1"));
    if (!isNaN(d)) {
      if (!latest || d.getTime() > latest.getTime()) latest = d;
    }
  }

  if (!latest) return false;

  const end = new Date(latest);
  end.setHours(23, 59, 59, 999);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return end.getTime() < today.getTime();
}
function inferMinTxnFromText(offer) {
  const blob = String(
    `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""} ${offer?.terms || ""}`
  );

  // Only trust amounts when they appear near min txn language
  const patterns = [
    /min(?:imum)?\s*(?:txn|transaction|booking|purchase)\s*(?:amount|value)?[^₹\d]{0,30}(?:₹|rs\.?|inr)?\s*([\d,]{3,})/i,
    /valid\s*on\s*(?:minimum)?\s*(?:transaction|booking)\s*(?:amount|value)?[^₹\d]{0,30}(?:₹|rs\.?|inr)?\s*([\d,]{3,})/i,
    /(?:minimum|min\.)\s*(?:amount|value)\s*[:\-]?\s*(?:₹|rs\.?|inr)?\s*([\d,]{3,})/i,
  ];

  // ✅ FIX #2: Flight-safe inference:
  // If coupon appears across verticals (Flights + Hotels), don't accidentally pick hotel min amount.
  // We only accept a match if a nearby window mentions "flight(s)" and does NOT mention "hotel(s)".
  const lower = blob.toLowerCase();
  for (const re of patterns) {
    const m = re.exec(blob);
    if (m && m[1]) {
      const idx = m.index != null ? m.index : -1;
      const winStart = Math.max(0, idx - 120);
      const winEnd = Math.min(lower.length, idx + 200);
      const windowTxt = lower.slice(winStart, winEnd);

      const hasFlightNearby = /\bflight(s)?\b|\bair\s*ticket(s)?\b|\bairfare\b/.test(windowTxt);
      const hasHotelNearby = /\bhotel(s)?\b/.test(windowTxt);

      if (!hasFlightNearby || hasHotelNearby) continue;

      const n = Number(String(m[1]).replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0) return n;
    }
  }

  return 0;
}

function getMinTxnValue(offer) {
  // ✅ FIX #2: Prefer tiered min transaction values (bestTierForDisplay / discountTiers)
  const tierMin =
    offer?.bestTierForDisplay?.minTransactionValue ??
    offer?.parsedFields?.bestTierForDisplay?.minTransactionValue ??
    null;

  const tierMinNum = Number(tierMin);
  if (Number.isFinite(tierMinNum) && tierMinNum > 0) return tierMinNum;

  const tiers =
    offer?.discountTiers ??
    offer?.parsedFields?.discountTiers ??
    null;

  if (Array.isArray(tiers) && tiers.length > 0) {
    const mins = tiers
      .map((t) => Number(t?.minTransactionValue))
      .filter((n) => Number.isFinite(n) && n > 0);

    if (mins.length > 0) return Math.min(...mins);
  }

  const v = offer?.minTransactionValue ?? offer?.parsedFields?.minTransactionValue ?? null;
  const n = Number(v);

  // If Mongo has a real value, trust it
  if (Number.isFinite(n) && n > 0) return n;

  // Otherwise infer from text (flight-safe; prevents picking hotel minimum)
  const inferred = inferMinTxnFromText(offer);
  return Number.isFinite(inferred) ? inferred : 0;
}

// --------------------
// Discount compute
// --------------------

function parsePercentFromRawDiscount(offer, isDomestic) {
  const txt = String(
    offer?.rawDiscount ||
    offer?.parsedFields?.rawDiscount ||
    offer?.offerSummary ||
    offer?.rawText ||
    ""
  );

  if (!txt) return null;

  const lower = txt.toLowerCase();

  // 1) Prefer explicit instant/upfront discount percentage when present
  const instantPct =
    lower.match(/(\d{1,2})\s*%\s*instant\s*discount/i) ||
    lower.match(/instant\s*discount[^%]{0,40}(\d{1,2})\s*%/i) ||
    lower.match(/(\d{1,2})\s*%\s*instant\s*off/i) ||
    lower.match(/instant\s*off[^%]{0,40}(\d{1,2})\s*%/i) ||
    lower.match(/\bflat\s*(\d{1,2})\s*%\s*off\b/i) ||
    lower.match(/\b(\d{1,2})\s*%\s*off\b/i);

  if (instantPct) {
    return Number(instantPct[1]);
  }

  // 2) Mixed offers: choose the first non-cashback percentage chunk
  const percentMatches = [...lower.matchAll(/(\d{1,2})\s*%/g)].map((m) => ({
    pct: Number(m[1]),
    idx: m.index ?? 0,
  }));

  if (percentMatches.length > 0) {
    for (const m of percentMatches) {
      const windowTxt = lower.slice(Math.max(0, m.idx - 35), Math.min(lower.length, m.idx + 55));

      // skip cashback/reward/coins/wallet/statement-credit percentages
      if (
        /cashback/.test(windowTxt) ||
        /reward/.test(windowTxt) ||
        /supercoin/.test(windowTxt) ||
        /coin/.test(windowTxt) ||
        /wallet/.test(windowTxt) ||
        /statement/.test(windowTxt)
      ) {
        continue;
      }

      // Prefer explicit discount/off context
      if (
        /instant/.test(windowTxt) ||
        /discount/.test(windowTxt) ||
        /\boff\b/.test(windowTxt)
      ) {
        return m.pct;
      }
    }
  }

  return null;
}

function offerIsPerPassenger(offer) {
  const blob = normalizeText(
    `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""} ${offer?.terms?.raw || offer?.terms || ""}`
  );

  return (
    /\bper passenger\b/.test(blob) ||
    /\bper pax\b/.test(blob) ||
    /\bfor each passenger\b/.test(blob) ||
    /\bfor every passenger\b/.test(blob) ||
    /\bper person\b/.test(blob)
  );
}

function isCashbackStyleOffer(offer) {
  const blob = normalizeText(
    `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""} ${offer?.terms?.raw || offer?.terms || ""}`
  );

  const hasCashbackSignal =
    /\bcashback\b/.test(blob) ||
    /\bback as cashback\b/.test(blob) ||
    /\bget .* cashback\b/.test(blob) ||
    /\badditional cashback\b/.test(blob) ||
    /\bbonus\b/.test(blob) ||
    /\breward point(s)?\b/.test(blob) ||
    /\bsupercoin(s)?\b/.test(blob) ||
    /\bcoin(s)?\b/.test(blob) ||
    /\bwallet credit\b/.test(blob) ||
    /\bcredited later\b/.test(blob) ||
    /\bcredited within\b/.test(blob) ||
    /\bstatement credit\b/.test(blob) ||
    /\bcredit shell\b/.test(blob);

  const hasUpfrontDiscountSignal =
    /\binstant discount\b/.test(blob) ||
    /\binstant off\b/.test(blob) ||
    /\bflat .* off\b/.test(blob) ||
    /\bdiscount\b/.test(blob) ||
    /\boff\b/.test(blob);

  // Cashback-style means cashback/reward exists.
  // Mixed offers may still also have upfront discount, but cashback part should not count in price.
  return hasCashbackSignal && !hasUpfrontDiscountSignal;
}

function getOfferMaxDiscountAmount(offer, passengers = 1) {
  const pax = Math.max(1, Number(passengers) || 1);

  const direct =
    offer?.maxDiscountAmount ??
    offer?.parsedFields?.maxDiscountAmount ??
    offer?.bestTierForDisplay?.maxDiscountAmount ??
    offer?.parsedFields?.bestTierForDisplay?.maxDiscountAmount ??
    null;

  const directNum = Number(direct);

  if (Number.isFinite(directNum) && directNum > 0) {
    return offerIsPerPassenger(offer) ? directNum * pax : directNum;
  }

  const tiers =
    offer?.discountTiers ??
    offer?.parsedFields?.discountTiers ??
    null;

  if (Array.isArray(tiers) && tiers.length > 0) {
    const caps = tiers
      .map((t) => Number(t?.maxDiscountAmount))
      .filter((n) => Number.isFinite(n) && n > 0);

    if (caps.length > 0) {
      const bestCap = Math.max(...caps);
      return offerIsPerPassenger(offer) ? bestCap * pax : bestCap;
    }
  }

  const blob = String(
    `${offer?.rawDiscount || ""} ${offer?.title || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""}`
  );

  const m =
    blob.match(/\bup to\s*(?:rs\.?|inr|₹)\s*([\d,]{3,})/i) ||
    blob.match(/\bcapped at\s*(?:rs\.?|inr|₹)\s*([\d,]{3,})/i) ||
    blob.match(/\bmax(?:imum)?\s*(?:discount)?\s*(?:of)?\s*(?:rs\.?|inr|₹)\s*([\d,]{3,})/i);

  if (m && m[1]) {
    const n = Number(String(m[1]).replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) {
      return offerIsPerPassenger(offer) ? n * pax : n;
    }
  }

  return null;
}

function computeDiscountedPrice(offer, baseAmount, isDomestic, passengers = 1) {
  const base = Number(baseAmount);
  const pax = Math.max(1, Number(passengers) || 1);

  if (!Number.isFinite(base) || base <= 0) return baseAmount;

  const perPassenger = offerIsPerPassenger(offer);
  const maxCap = getOfferMaxDiscountAmount(offer, passengers);

  // Pure cashback / rewards / coins must not reduce upfront payable price
  if (isCashbackStyleOffer(offer)) {
    return base;
  }

  let pct = null;

  // Trust structured percent only if the raw text does not look cashback-only
  if (offer?.discountPercent != null) {
    const n = Number(offer.discountPercent);
    if (Number.isFinite(n) && n > 0) {
      pct = parsePercentFromRawDiscount(offer, isDomestic) ?? n;
    }
  }

  if (pct == null && ENABLE_ESTIMATED_DISCOUNTS) {
    pct = parsePercentFromRawDiscount(offer, isDomestic);
  }

  if (pct != null && Number.isFinite(pct) && pct > 0) {
    let discountAmount = 0;

    if (perPassenger) {
      const perPaxBase = base / pax;
      let perPaxDiscount = Math.round(perPaxBase * (pct / 100));

      if (Number.isFinite(maxCap) && maxCap > 0) {
        perPaxDiscount = Math.min(perPaxDiscount, maxCap);
      }

      discountAmount = perPaxDiscount * pax;
    } else {
      discountAmount = Math.round(base * (pct / 100));

      if (Number.isFinite(maxCap) && maxCap > 0) {
        discountAmount = Math.min(discountAmount, maxCap);
      }
    }

    const discounted = Math.round(base - discountAmount);
    return discounted < base ? discounted : base;
  }

  const flat = Number(
    offer?.flatDiscountAmount ??
    offer?.parsedFields?.flatDiscountAmount
  );

  if (Number.isFinite(flat) && flat > 0) {
    let discountAmount = perPassenger ? Math.round(flat * pax) : Math.round(flat);

    if (!perPassenger && Number.isFinite(maxCap) && maxCap > 0) {
      discountAmount = Math.min(discountAmount, maxCap);
    }

    const discounted = Math.round(base - discountAmount);
    return discounted < base ? discounted : base;
  }

  return base;
}

// --------------------
// Payment matching (robust)
// --------------------
function bankCanonicalFromAny(raw) {
  const s = String(raw || "").toUpperCase().replace(/\s+/g, " ").trim();

  if (!s) return null;

  if (/\bFLIPKART\b.*\bAXIS\b|\bAXIS\b.*\bFLIPKART\b/.test(s)) return "AXIS_BANK";
  if (/\bAXIS\b/.test(s)) return "AXIS_BANK";

  if (/\bHDFC\b/.test(s)) return "HDFC_BANK";
  if (/\bICICI\b/.test(s)) return "ICICI_BANK";
  if (/\bHSBC\b/.test(s)) return "HSBC";
  if (/\bSBI\b|\bSTATE BANK\b|\bSTATE_BANK\b/.test(s)) return "STATE_BANK_OF_INDIA";
  if (/\bKOTAK\b/.test(s)) return "KOTAK_BANK";
  if (/\bYES\b/.test(s)) return "YES_BANK";
  if (/\bRBL\b/.test(s)) return "RBL_BANK";
  if (/\bAU\b|\bAU SMALL\b/.test(s)) return "AU_BANK";
  if (/\bFEDERAL\b/.test(s)) return "FEDERAL_BANK";
  if (/\bIDFC\b/.test(s)) return "IDFC_FIRST_BANK";
  if (/\bINDUSIND\b/.test(s)) return "INDUSIND_BANK";
  if (/\bAMEX\b|\bAMERICAN EXPRESS\b/.test(s)) return "AMERICAN_EXPRESS";
  if (/\bONECARD\b|\bONE CARD\b/.test(s)) return "ONECARD";

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

  const tenureMonths =
    Number(pm?.tenureMonths) ||
    Number(pm?.emiTenureMonths) ||
    null;

  const networkRaw = String(pm?.network || "").trim();
  const networkCanonical =
    /visa/i.test(networkRaw) ? "VISA" :
    /master/i.test(networkRaw) ? "MASTERCARD" :
    /rupay/i.test(networkRaw) ? "RUPAY" :
    /american express|amex/i.test(networkRaw) ? "AMERICAN_EXPRESS" :
    null;

  const providerRaw = String(pm?.provider || "").trim();
  const providerCanonical =
    /cred/i.test(providerRaw) ? "CRED" :
    /google\s*pay|gpay/i.test(providerRaw) ? "GOOGLE_PAY" :
    /phonepe/i.test(providerRaw) ? "PHONEPE" :
    /paytm/i.test(providerRaw) ? "PAYTM" :
    /bhim/i.test(providerRaw) ? "BHIM" :
    /amazon\s*pay/i.test(providerRaw) ? "AMAZON_PAY" :
    /mobikwik/i.test(providerRaw) ? "MOBIKWIK" :
    /freecharge/i.test(providerRaw) ? "FREECHARGE" :
    null;

    const cardFamilyRaw = String(pm?.cardFamily || pm?.cardVariant || "").trim();
  const cardFamilyCanonical =
    /flipkart\s*axis/i.test(cardFamilyRaw) ? "FLIPKART_AXIS" :
    /axis\s*atlas/i.test(cardFamilyRaw) ? "AXIS_ATLAS" :
    /axis\s*ace/i.test(cardFamilyRaw) ? "AXIS_ACE" :
    /axis\s*neo/i.test(cardFamilyRaw) ? "AXIS_NEO" :
    /axis\s*rewards/i.test(cardFamilyRaw) ? "AXIS_REWARDS" :
    /axis\s*vistara/i.test(cardFamilyRaw) ? "AXIS_VISTARA" :
    /amazon\s*pay\s*icici/i.test(cardFamilyRaw) ? "AMAZON_PAY_ICICI" :
    /tata\s*neu/i.test(cardFamilyRaw) ? "TATA_NEU" :
    /swiggy\s*hdfc/i.test(cardFamilyRaw) ? "SWIGGY_HDFC" :
    /diners/i.test(cardFamilyRaw) ? "DINERS" :
    /infinia/i.test(cardFamilyRaw) ? "INFINIA" :
    /regalia/i.test(cardFamilyRaw) ? "REGALIA" :
    /millennia/i.test(cardFamilyRaw) ? "MILLENNIA" :
    /sbi\s*cashback/i.test(cardFamilyRaw) ? "SBI_CASHBACK" :
    /simplyclick/i.test(cardFamilyRaw) ? "SIMPLYCLICK" :
    /simplysave/i.test(cardFamilyRaw) ? "SIMPLYSAVE" :
    /coral/i.test(cardFamilyRaw) ? "CORAL" :
    /rubyx/i.test(cardFamilyRaw) ? "RUBYX" :
    /sapphiro/i.test(cardFamilyRaw) ? "SAPPHIRO" :
    /emeralde/i.test(cardFamilyRaw) ? "EMERALDE" :
    null;
  const isCorporate =
    pm?.isCorporate === true ? true :
    pm?.isCorporate === false ? false :
    null;

  return {
    typeNorm,
    bankCanonical,
    nameRaw,
    tenureMonths,
    networkCanonical,
    providerCanonical,
    cardFamilyCanonical,
    isCorporate
  };
}
function extractAllowedEmiTenuresFromOffer(offer, pm = null) {
  const sources = [
    pm?.conditions || "",
    pm?.raw || "",
    offer?.title || "",
    offer?.rawDiscount || "",
    offer?.offerSummary || "",
    offer?.rawText || "",
    offer?.terms?.raw || offer?.terms || "",
  ]
    .map((x) => String(x || ""))
    .join(" ");

  const blob = normalizeText(sources);

  if (!/\bemi\b/.test(blob)) return [];

  const found = new Set();

  // patterns like "3 & 6 months", "3 and 6 months", "3/6 months"
  const pairRegex = /(\d{1,2})\s*(?:&|and|\/)\s*(\d{1,2})\s*month(s)?/gi;
  let m;
  while ((m = pairRegex.exec(blob)) !== null) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (Number.isFinite(a)) found.add(a);
    if (Number.isFinite(b)) found.add(b);
  }

  // patterns like "6 months EMI", "9 month tenure", "12 months only"
  const singleRegex = /(\d{1,2})\s*month(s)?/gi;
  while ((m = singleRegex.exec(blob)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) found.add(n);
  }

  // remove silly values
  const out = Array.from(found).filter((n) => n >= 2 && n <= 60).sort((a, b) => a - b);
  return out;
}

function extractOfferNetworkRestrictions(offer, pm = null) {
  const blob = normalizeText(
    `${pm?.raw || ""} ${pm?.conditions || ""} ${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""} ${offer?.terms?.raw || offer?.terms || ""}`
  );

  const allowed = new Set();
  const excluded = new Set();

  if (/\bvisa\b/.test(blob)) allowed.add("VISA");
  if (/\bmastercard\b|\bmaster card\b/.test(blob)) allowed.add("MASTERCARD");
  if (/\brupay\b/.test(blob)) allowed.add("RUPAY");
  if (/\bamerican express\b|\bamex\b/.test(blob)) allowed.add("AMERICAN_EXPRESS");

  if (/\bnot valid on visa\b|\bexcluding visa\b/.test(blob)) excluded.add("VISA");
  if (/\bnot valid on mastercard\b|\bexcluding mastercard\b|\bexcluding master card\b/.test(blob)) excluded.add("MASTERCARD");
  if (/\bnot valid on rupay\b|\bexcluding rupay\b/.test(blob)) excluded.add("RUPAY");
  if (/\bnot valid on american express\b|\bnot valid on amex\b|\bexcluding amex\b/.test(blob)) excluded.add("AMERICAN_EXPRESS");

  return {
    allowed: Array.from(allowed),
    excluded: Array.from(excluded)
  };
}

function extractOfferProviderRestrictions(offer, pm = null) {
  const blob = normalizeText(
    `${pm?.raw || ""} ${pm?.conditions || ""} ${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""} ${offer?.terms?.raw || offer?.terms || ""}`
  );

  const allowed = new Set();

  if (/\bcred\b/.test(blob)) allowed.add("CRED");
  if (/\bgoogle pay\b|\bgpay\b/.test(blob)) allowed.add("GOOGLE_PAY");
  if (/\bphonepe\b/.test(blob)) allowed.add("PHONEPE");
  if (/\bpaytm\b/.test(blob)) allowed.add("PAYTM");
  if (/\bbhim\b/.test(blob)) allowed.add("BHIM");
  if (/\bamazon pay\b/.test(blob)) allowed.add("AMAZON_PAY");
  if (/\bmobikwik\b/.test(blob)) allowed.add("MOBIKWIK");
  if (/\bfreecharge\b/.test(blob)) allowed.add("FREECHARGE");

  return Array.from(allowed);
}

function extractOfferCardFamilyRestrictions(offer, pm = null) {
  const blob = normalizeText(
    `${pm?.raw || ""} ${pm?.conditions || ""} ${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""} ${offer?.terms?.raw || offer?.terms || ""}`
  );

  const allowed = new Set();

  if (/\bflipkart\s*axis\b/.test(blob)) allowed.add("FLIPKART_AXIS");
  if (/\baxis\s*atlas\b/.test(blob)) allowed.add("AXIS_ATLAS");
  if (/\baxis\s*ace\b/.test(blob)) allowed.add("AXIS_ACE");
  if (/\baxis\s*neo\b/.test(blob)) allowed.add("AXIS_NEO");
  if (/\baxis\s*rewards\b/.test(blob)) allowed.add("AXIS_REWARDS");
  if (/\baxis\s*vistara\b/.test(blob)) allowed.add("AXIS_VISTARA");

  if (/\bamazon\s*pay\s*icici\b/.test(blob)) allowed.add("AMAZON_PAY_ICICI");
  if (/\btata\s*neu\b/.test(blob)) allowed.add("TATA_NEU");
  if (/\bswiggy\s*hdfc\b/.test(blob)) allowed.add("SWIGGY_HDFC");

  if (/\bdiners\b/.test(blob)) allowed.add("DINERS");
  if (/\binfinia\b/.test(blob)) allowed.add("INFINIA");
  if (/\bregalia\b/.test(blob)) allowed.add("REGALIA");
  if (/\bmillennia\b/.test(blob)) allowed.add("MILLENNIA");

  if (/\bsbi\s*cashback\b/.test(blob)) allowed.add("SBI_CASHBACK");
  if (/\bsimplyclick\b/.test(blob)) allowed.add("SIMPLYCLICK");
  if (/\bsimplysave\b/.test(blob)) allowed.add("SIMPLYSAVE");

  if (/\bcoral\b/.test(blob)) allowed.add("CORAL");
  if (/\brubyx\b/.test(blob)) allowed.add("RUBYX");
  if (/\bsapphiro\b/.test(blob)) allowed.add("SAPPHIRO");
  if (/\bemeralde\b/.test(blob)) allowed.add("EMERALDE");

  return Array.from(allowed);
}

function extractOfferCorporateRestriction(offer, pm = null) {
  const blob = normalizeText(
    `${pm?.raw || ""} ${pm?.conditions || ""} ${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""} ${offer?.terms?.raw || offer?.terms || ""}`
  );

  const excludesCorporate =
    /\bnot valid on corporate\b/.test(blob) ||
    /\bnot applicable on corporate\b/.test(blob) ||
    /\bexcluding corporate\b/.test(blob) ||
    /\bnot valid on commercial\b/.test(blob) ||
    /\bnot applicable on commercial\b/.test(blob) ||
    /\bexcluding commercial\b/.test(blob);

  const corporateOnly =
    /\bcorporate cards only\b/.test(blob) ||
    /\bcommercial cards only\b/.test(blob);

  return { excludesCorporate, corporateOnly };
}

function normalizeOfferPM(pm, offer = null) {
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

  const explicitTenure =
    Number(pm?.tenureMonths) ||
    null;

  const inferredTenures = extractAllowedEmiTenuresFromOffer(offer, pm);
  const networkRestrictions = extractOfferNetworkRestrictions(offer, pm);
  const providerRestrictions = extractOfferProviderRestrictions(offer, pm);
  const cardFamilyRestrictions = extractOfferCardFamilyRestrictions(offer, pm);
  const corporateRestriction = extractOfferCorporateRestriction(offer, pm);

  return {
    typeNorm,
    bankCanonical,
    emiOnly: pm?.emiOnly === true,
    raw: String(pm?.raw || "").toLowerCase(),
    tenureMonths: explicitTenure,
    allowedTenures: inferredTenures,
    allowedNetworks: networkRestrictions.allowed,
    excludedNetworks: networkRestrictions.excluded,
    allowedProviders: providerRestrictions,
    allowedCardFamilies: cardFamilyRestrictions,
    excludesCorporate: corporateRestriction.excludesCorporate,
    corporateOnly: corporateRestriction.corporateOnly
  };
}

function offerMatchesSelectedPayment(offer, selectedPaymentMethods = []) {
  if (!Array.isArray(selectedPaymentMethods) || selectedPaymentMethods.length === 0) {
    return false;
  }

  const selNorm = selectedPaymentMethods
    .map(normalizeSelectedPM)
    .filter((x) => x.typeNorm);

  if (selNorm.length === 0) return false;

  // -----------------------------
  // 1) Hard bank guard from code/title/raw text
  // -----------------------------
  const inferredBankFromCodeOrText = bankCanonicalFromAny(
    [
      offer?.couponCode || offer?.code || "",
      offer?.title || "",
      offer?.rawDiscount || "",
      offer?.rawText || "",
    ].join(" ")
  );

  const selectedBanks = selNorm.map((x) => x.bankCanonical).filter(Boolean);

  if (
    inferredBankFromCodeOrText &&
    selectedBanks.length > 0 &&
    !selectedBanks.includes(inferredBankFromCodeOrText)
  ) {
    return false;
  }

  // -----------------------------
  // 2) Structured PM match only
  // -----------------------------
  const offerPMs = extractOfferPaymentMethodsNoInference(offer);

  if (!Array.isArray(offerPMs) || offerPMs.length === 0) {
    return false;
  }

  const offerNorm = offerPMs
    .map((pm) => normalizeOfferPM(pm, offer))
    .filter((x) => x.typeNorm);

  if (offerNorm.length === 0) return false;

   for (const s of selNorm) {
    for (const o of offerNorm) {
      // UPI
      if (s.typeNorm === "UPI") {
        if (o.typeNorm !== "UPI") continue;

        if (
          Array.isArray(o.allowedProviders) &&
          o.allowedProviders.length > 0 &&
          s.providerCanonical &&
          !o.allowedProviders.includes(s.providerCanonical)
        ) {
          continue;
        }

        if (o.bankCanonical) {
          if (s.bankCanonical && s.bankCanonical === o.bankCanonical) return true;
          continue;
        }

        // Generic UPI offer with no bank restriction
        if (!o.bankCanonical) return true;
        continue;
      }

      // EMI
      if (s.typeNorm === "EMI") {
        if (o.typeNorm !== "EMI" && !(o.typeNorm === "CREDIT_CARD" && o.emiOnly === true)) {
          continue;
        }

        if (
          Number.isFinite(s.tenureMonths) &&
          Array.isArray(o.allowedTenures) &&
          o.allowedTenures.length > 0 &&
          !o.allowedTenures.includes(Number(s.tenureMonths))
        ) {
          continue;
        }

        if (
          Number.isFinite(s.tenureMonths) &&
          Number.isFinite(o.tenureMonths) &&
          Number(s.tenureMonths) !== Number(o.tenureMonths)
        ) {
          continue;
        }

        if (
          o.excludesCorporate === true &&
          s.isCorporate === true
        ) {
          continue;
        }

        if (
          o.corporateOnly === true &&
          s.isCorporate === false
        ) {
          continue;
        }

        if (o.bankCanonical) {
          if (s.bankCanonical && s.bankCanonical === o.bankCanonical) return true;
          continue;
        }

        continue;
      }

      // Credit / Debit / NetBanking / Wallet
      if (s.typeNorm === o.typeNorm) {
        if (
          Array.isArray(o.allowedNetworks) &&
          o.allowedNetworks.length > 0 &&
          s.networkCanonical &&
          !o.allowedNetworks.includes(s.networkCanonical)
        ) {
          continue;
        }

        if (
          Array.isArray(o.excludedNetworks) &&
          o.excludedNetworks.length > 0 &&
          s.networkCanonical &&
          o.excludedNetworks.includes(s.networkCanonical)
        ) {
          continue;
        }

        // Card-family logic:
        // 1) If offer is family-specific and user explicitly selected a conflicting family => reject
        // 2) If offer is family-specific and user selected only the generic bank card (no family) => do NOT apply
        if (Array.isArray(o.allowedCardFamilies) && o.allowedCardFamilies.length > 0) {
          if (!s.cardFamilyCanonical) {
            continue;
          }
          if (!o.allowedCardFamilies.includes(s.cardFamilyCanonical)) {
            continue;
          }
        }

        if (
          o.excludesCorporate === true &&
          s.isCorporate === true
        ) {
          continue;
        }

        if (
          o.corporateOnly === true &&
          s.isCorporate === false
        ) {
          continue;
        }

        if (o.bankCanonical) {
          if (s.bankCanonical && s.bankCanonical === o.bankCanonical) return true;
          continue;
        }

        continue;
      }
    }
  }

  return false;
}

function getMatchedSelectedPaymentLabel(offer, selectedPaymentMethods) {
  if (!Array.isArray(selectedPaymentMethods) || selectedPaymentMethods.length === 0) return null;

  const offerPMs = extractOfferPaymentMethodsNoInference(offer);
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
function getInfoOfferDisplayLabel(offer, selectedPaymentMethods = []) {
  const exact = getMatchedSelectedPaymentLabel(offer, selectedPaymentMethods);
  if (exact) return "Exact match";

  const offerPMs =
    offer?.paymentMethods ||
    offer?.parsedFields?.paymentMethods ||
    offer?.eligiblePaymentMethods ||
    offer?.parsedFields?.eligiblePaymentMethods ||
    [];

  const selected = Array.isArray(selectedPaymentMethods) ? selectedPaymentMethods : [];

  const sameBank = Array.isArray(offerPMs) && offerPMs.some((pm) =>
    selected.some((sel) => {
      const offerBank = normalizeBankName(pm?.bank || pm?.name || pm?.raw || "");
      const selectedBank = normalizeBankName(sel?.name || sel?.bank || "");
      return offerBank && selectedBank && offerBank === selectedBank;
    })
  );

  if (sameBank) return "Same bank alternative";

  return "Related offer";
}
function getInfoOfferReasonLabel(offer, selectedPaymentMethods = []) {
  const validForBest = isValidBestOffer(offer);
  if (!validForBest) return "Shown for reference only";

  const offerPMs = extractOfferPaymentMethodsNoInference(offer);
  const selNorm = Array.isArray(selectedPaymentMethods)
    ? selectedPaymentMethods.map(normalizeSelectedPM).filter((x) => x.typeNorm)
    : [];

  if (!selNorm.length) return null;
  if (!offerPMs.length) return null;

  const offerNorm = offerPMs
    .map((pm) => normalizeOfferPM(pm, offer))
    .filter((x) => x.typeNorm);

  if (!offerNorm.length) return null;

  for (const s of selNorm) {
    for (const o of offerNorm) {
      const sameBank = !o.bankCanonical || (s.bankCanonical && s.bankCanonical === o.bankCanonical);

      if (!sameBank) continue;

      if (o.typeNorm === "EMI" && s.typeNorm !== "EMI") {
        return "Requires EMI";
      }

      if (
        Array.isArray(o.allowedCardFamilies) &&
        o.allowedCardFamilies.length > 0 &&
        !s.cardFamilyCanonical
      ) {
        return "Specific card required";
      }

      if (
        Array.isArray(o.allowedCardFamilies) &&
        o.allowedCardFamilies.length > 0 &&
        s.cardFamilyCanonical &&
        !o.allowedCardFamilies.includes(s.cardFamilyCanonical)
      ) {
        return "Different card variant required";
      }

      if (
        Array.isArray(o.allowedNetworks) &&
        o.allowedNetworks.length > 0 &&
        s.networkCanonical &&
        !o.allowedNetworks.includes(s.networkCanonical)
      ) {
        return "Different card network required";
      }

      if (o.corporateOnly === true && s.isCorporate === false) {
        return "Corporate card required";
      }

      if (o.excludesCorporate === true && s.isCorporate === true) {
        return "Not valid on corporate cards";
      }
    }
  }

  return null;
}

function extractBestNumericDiscountValue(offer) {
  const pct = Number(offer?.discountPercent ?? offer?.parsedFields?.discountPercent);
  const flat = Number(offer?.flatDiscountAmount ?? offer?.parsedFields?.flatDiscountAmount);

  if (Number.isFinite(flat) && flat > 0) return flat;
  if (Number.isFinite(pct) && pct > 0) return pct;

  const raw = String(
    offer?.rawDiscount ||
    offer?.parsedFields?.rawDiscount ||
    offer?.offerSummary?.headline ||
    ""
  );

  const pctMatch = raw.match(/(\d{1,2})\s*%/);
  if (pctMatch) return Number(pctMatch[1]);

  const amtMatch = raw.match(/(?:₹|rs\.?|inr)\s*([\d,]+)/i);
  if (amtMatch) return Number(String(amtMatch[1]).replace(/,/g, ""));

  return 0;
}

function scoreInfoOfferForDisplay({
  offer,
  selectedPaymentMethods,
  isSpecificFamilyInfoOnly,
}) {
  let score = 0;

  if (offerMatchesSelectedPayment(offer, selectedPaymentMethods)) score += 100;
  if (isSpecificFamilyInfoOnly) score += 20;

  const kind = getOfferKindForFlight(offer, selectedPaymentMethods, "")?.kind;
  if (kind === "payment") score += 40;
  if (kind === "airline") score += 15;
  if (kind === "portal") score += 10;

  const blob = normalizeText(
    `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary?.headline || ""}`
  );

  if (/\bemi\b/.test(blob)) score += 12;
  if (/\binstant discount\b|\boff\b|\bdiscount\b/.test(blob)) score += 10;
  if (isCashbackStyleOffer(offer)) score -= 8;

  score += Math.min(25, extractBestNumericDiscountValue(offer));

  return score;
}

function isSpecificFamilyOfferForGenericSelectedBank(offer, selectedPaymentMethods = []) {
  if (!Array.isArray(selectedPaymentMethods) || selectedPaymentMethods.length === 0) return false;

  const selNorm = selectedPaymentMethods
    .map(normalizeSelectedPM)
    .filter((x) => x.typeNorm);

  if (selNorm.length === 0) return false;

  const offerPMs = extractOfferPaymentMethodsNoInference(offer);
  if (!Array.isArray(offerPMs) || offerPMs.length === 0) return false;

  const offerNorm = offerPMs
    .map((pm) => normalizeOfferPM(pm, offer))
    .filter((x) => x.typeNorm);

  if (offerNorm.length === 0) return false;

  for (const s of selNorm) {
    for (const o of offerNorm) {
      if (s.typeNorm !== o.typeNorm) continue;
      if (o.bankCanonical && s.bankCanonical && o.bankCanonical !== s.bankCanonical) continue;

      if (
        Array.isArray(o.allowedCardFamilies) &&
        o.allowedCardFamilies.length > 0 &&
        !s.cardFamilyCanonical
      ) {
        return true;
      }
    }
  }

  return false;
}

// scope/cabin sanity
function offerScopeMatchesTrip(offer, isDomestic, cabin) {
  // IMPORTANT:
  // Only trust CORE fields for domestic/international scope.
  // rawText/terms often contain mixed portal/template noise and can mention both domestic + international.
  const title = String(offer?.title || "");
  const rawDiscount = String(offer?.rawDiscount || offer?.parsedFields?.rawDiscount || "");
  const offerSummary =
    typeof offer?.offerSummary === "string"
      ? offer.offerSummary
      : offer?.offerSummary
        ? JSON.stringify(offer.offerSummary)
        : (offer?.parsedFields?.offerSummary ? JSON.stringify(offer.parsedFields.offerSummary) : "");

  const core = normalizeText(`${title} ${rawDiscount} ${offerSummary}`);

  const cats = offer?.offerCategories || offer?.parsedFields?.offerCategories;
  const catBlob = Array.isArray(cats)
    ? normalizeText(cats.map((c) => String(c || "")).join(" "))
    : "";

  const combined = `${core} ${catBlob}`.trim();

  // Reject clear non-flight verticals unless flights are explicitly mentioned in core/categories
  const hasFlight = /\bflight(s)?\b|\bair\s*ticket(s)?\b|\bairfare\b/.test(combined);
  const hasNonFlightVertical =
    /\btourism\b|\battraction(s)?\b|\bholiday(s)?\b|\bbus(es)?\b|\bcab(s)?\b|\btrain(s)?\b|\bhotel(s)?\b/.test(combined);

  if (hasNonFlightVertical && !hasFlight) return false;

  const cabinShort = normalizeCabinShort(cabin);

  if (
    (cabinShort === "economy" || cabinShort === "premium") &&
    /\bbusiness\s+class\b|\bfirst\s+class\b/.test(combined)
  ) {
    return false;
  }

  const mentionsDomesticFlights =
    /\bdomestic\s+flight(s)?\b/.test(combined) ||
    (/\bdomestic\b/.test(combined) && /\bflight(s)?\b/.test(combined));

  const mentionsInternationalFlights =
    /\binternational\s+flight(s)?\b/.test(combined) ||
    (/\binternational\b/.test(combined) && /\bflight(s)?\b/.test(combined));

  if (isDomestic) {
    // Domestic search must reject international-only flight offers
    if (mentionsInternationalFlights && !mentionsDomesticFlights) {
      return false;
    }
  } else {
    // International search must reject domestic-only flight offers
    if (mentionsDomesticFlights && !mentionsInternationalFlights) {
      return false;
    }
  }

  return true;
}

// --------------------
// Core evaluator
function evaluateOfferForFlight({
  offer,
  portal,
  baseAmount,
  eligibilityAmount,
  selectedPaymentMethods,
  isDomestic,
  cabin,
  flightAirlineName,
  tripType,
  passengers,
  allOffers = [],
}) {
  if (!offer) return { ok: false, reasons: ["NO_OFFER"] };

  if (!isFlightOffer(offer)) return { ok: false, reasons: ["NOT_FLIGHT_OFFER"] };
  if (isHotelOnlyOffer(offer)) return { ok: false, reasons: ["HOTEL_ONLY_OFFER"] };

  const nfBlob = `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.rawText || ""} ${offer?.terms || ""}`.toLowerCase();
  const mentionsFlight = /\bflight(s)?\b|\bair\s*ticket(s)?\b|\bairfare\b/.test(nfBlob);
  const mentionsNonFlight = /\btourism\b|\battraction(s)?\b|\bholiday(s)?\b|\bactivity\b|\bvisa\b|\bforex\b|\bbus(es)?\b|\bcab(s)?\b|\btrain(s)?\b|\bhotel(s)?\b/.test(nfBlob);

  if (mentionsNonFlight && !mentionsFlight) {
    return { ok: false, reasons: ["NON_FLIGHT_VERTICAL"] };
  }

  if (isHotelOnlyOffer(offer)) return { ok: false, reasons: ["HOTEL_ONLY"] };
  if (isFirstTimeOrNewUserOffer(offer)) return { ok: false, reasons: ["FIRST_TIME_OR_NEW_USER"] };

    if (isOfferExpired(offer)) return { ok: false, reasons: ["EXPIRED"] };
if (!offerAppliesToPortal(offer, portal)) return { ok: false, reasons: ["PORTAL_MISMATCH"] };
if (!offerScopeMatchesTrip(offer, isDomestic, cabin)) return { ok: false, reasons: ["SCOPE_MISMATCH"] };

if (isSuspiciousGenericOffer(offer, allOffers || [])) {
  return { ok: false, reasons: ["SUSPICIOUS_GENERIC_VARIANT"] };
}

// Best-offer trust filter:
// allow display elsewhere, but never let non-deterministic / vague offers become applied winners
if (!isValidBestOffer(offer)) {
  return { ok: false, reasons: ["NOT_VALID_BEST_OFFER"] };
}



  if (tripType === "one-way" && offerRequiresRoundTrip(offer)) {
    return { ok: false, reasons: ["ROUND_TRIP_ONLY"] };
  }
  const passengerRestriction = getPassengerRestrictionResult(offer, passengers);
  if (!passengerRestriction.ok) {
    return {
      ok: false,
      reasons: [passengerRestriction.reason || "PASSENGER_COUNT_RESTRICTED"],
    };
  }
  const hasExplicitPM = hasExplicitOfferPaymentMethods(offer);
  const hasSelectedPM = Array.isArray(selectedPaymentMethods) && selectedPaymentMethods.length > 0;

  if (hasExplicitPM && !hasSelectedPM) {
    return { ok: false, reasons: ["PAYMENT_REQUIRED_NOT_SELECTED"] };
  }

  const kindInfo = getOfferKindForFlight(offer, selectedPaymentMethods, flightAirlineName);
  if (!kindInfo.kind) {
    return { ok: false, reasons: [kindInfo.reason || "NOT_ELIGIBLE"] };
  }

  const minTxn = getMinTxnValue(offer);
  const totalAmount = Number(eligibilityAmount ?? baseAmount);
  const pax = Math.max(1, Number(passengers) || 1);
  const perPassengerAmount = totalAmount / pax;
  const isPerPax = offerIsPerPassenger(offer);

  if (Number.isFinite(minTxn) && minTxn > 0) {
    if (isPerPax) {
      if (perPassengerAmount < minTxn) {
        return { ok: false, reasons: ["MIN_TXN_NOT_MET_PER_PAX"], minTxn };
      }
    } else {
      if (totalAmount < minTxn) {
        return { ok: false, reasons: ["MIN_TXN_NOT_MET"], minTxn };
      }
    }
  }

  const discounted = computeDiscountedPrice(offer, baseAmount, isDomestic, passengers);
  const maxDiscountAmount = getOfferMaxDiscountAmount(offer);

  if (!Number.isFinite(discounted)) return { ok: false, reasons: ["DISCOUNT_NOT_COMPUTABLE"] };
  if (discounted >= baseAmount) return { ok: false, reasons: ["NO_IMPROVEMENT"] };

    return {
    ok: true,
    discounted,
    minTxn,
    maxDiscountAmount,
    offerKind: kindInfo.kind,
    offerTypeLabel: getOfferTypeLabel(kindInfo.kind, offer),
    channelLabel: getOfferChannelLabel(offer),
  };
}

function pickBestOfferForPortal(
  offers,
  portal,
  baseAmount,
  selectedPaymentMethods,
  eligibilityAmount,
  cabin,
  flightAirlineName,
  tripType,
  passengers,
  isDomestic
) {
  const paymentCandidates = [];
  const portalCandidates = [];
  const airlineCandidates = [];

  for (const offer of offers) {

const ev = evaluateOfferForFlight({
  offer,
  portal,
  baseAmount,
  eligibilityAmount,
  selectedPaymentMethods,
  isDomestic,
  cabin,
  flightAirlineName,
  tripType,
  passengers,
  allOffers: offers,
});

    if (!ev.ok) continue;

    const row = {
  finalPrice: ev.discounted,
  offer,
  offerKind: ev.offerKind,
  offerTypeLabel: ev.offerTypeLabel,
  channelLabel: ev.channelLabel,
  nonClubbable: offerCannotBeClubbed(offer),
  maxDiscountAmount: ev.maxDiscountAmount ?? null,
};

    if (ev.offerKind === "payment") {
      paymentCandidates.push(row);
    } else if (ev.offerKind === "airline") {
      airlineCandidates.push(row);
    } else {
      portalCandidates.push(row);
    }
  }

  const byBestPrice = (a, b) => a.finalPrice - b.finalPrice;

paymentCandidates.sort(byBestPrice);
portalCandidates.sort(byBestPrice);
airlineCandidates.sort(byBestPrice);

const all = [
  ...paymentCandidates,
  ...portalCandidates,
  ...airlineCandidates,
].sort(byBestPrice);

// Phase-1 non-clubbing rule:
// always return only ONE best offer per portal.
// If multiple candidates exist, cheapest valid one wins.
return all.length > 0 ? all[0] : null;
}

function buildInfoOffersForPortal(
  offers,
  portal,
  selectedPaymentMethods,
  cabin,
  isDomestic,
  appliedCouponCode,
  limit = 5
) {
  const sel = Array.isArray(selectedPaymentMethods) ? selectedPaymentMethods : [];
  if (sel.length === 0) return [];

  const info = [];
  const seen = new Set();

  for (const offer of offers) {
       if (!isFlightOffer(offer)) continue;
if (isHotelOnlyOffer(offer)) continue;
if (isOfferExpired(offer)) continue;
if (!offerAppliesToPortal(offer, portal)) continue;
if (isSuspiciousGenericOffer(offer, offers)) continue;

    const coreBlob = normalizeText(
      `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""}`
    );

    const termsBlob = normalizeText(
      `${offer?.terms?.raw || offer?.terms || ""} ${offer?.parsedFields?.terms?.raw || ""}`
    );

    const scopeBlob = `${coreBlob} ${termsBlob}`;

    if (
      (normalizeCabinShort(cabin) === "economy" || normalizeCabinShort(cabin) === "premium") &&
      /\bbusiness class\b|\bfirst class\b/.test(scopeBlob)
    ) {
      continue;
    }

    if (isDomestic) {
      if (/\binternational flight(s)?\b/.test(scopeBlob) && !/\bdomestic flight(s)?\b/.test(scopeBlob)) {
        continue;
      }
    } else {
      if (/\bdomestic flight(s)?\b/.test(scopeBlob) && !/\binternational flight(s)?\b/.test(scopeBlob)) {
        continue;
      }
    }

    if (offerRequiresRoundTrip(offer)) continue;

    const offerCouponCode =
      offer?.couponCode ||
      offer?.code ||
      offer?.parsedFields?.couponCode ||
      offer?.parsedFields?.code ||
      null;

    if (appliedCouponCode && offerCouponCode && offerCouponCode === appliedCouponCode) {
      continue;
    }

    const matchesNormally = offerMatchesSelectedPayment(offer, selectedPaymentMethods);
    const isSpecificFamilyInfoOnly = isSpecificFamilyOfferForGenericSelectedBank(
      offer,
      selectedPaymentMethods
    );

    const offerPMs =
      offer?.paymentMethods ||
      offer?.parsedFields?.paymentMethods ||
      offer?.eligiblePaymentMethods ||
      offer?.parsedFields?.eligiblePaymentMethods ||
      [];

    const isBroadBankMatch =
      Array.isArray(offerPMs) &&
      offerPMs.some((pm) =>
        selectedPaymentMethods?.some((selPm) => {
          const offerBank = normalizeBankName(pm?.bank || pm?.name || pm?.raw || "");
          const selectedBank = normalizeBankName(selPm?.name || selPm?.bank || "");
          return offerBank && selectedBank && offerBank === selectedBank;
        })
      );

    if (!matchesNormally && !isSpecificFamilyInfoOnly && !isBroadBankMatch) continue;

    const dedupeKey = [
      offerCouponCode || "",
      String(offer?.title || "").trim().toLowerCase(),
      String(offer?.rawDiscount || "").trim().toLowerCase(),
      String(offer?.sourceMetadata?.sourcePortal || offer?.sourcePortal || portal).trim().toLowerCase()
    ].join("|");

    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

        const paymentHint =
      getMatchedSelectedPaymentLabel(offer, selectedPaymentMethods) ||
      (() => {
        const explicitPMs = extractOfferPaymentMethodsNoInference(offer);
        const firstPm = Array.isArray(explicitPMs) && explicitPMs.length > 0 ? explicitPMs[0] : null;
        if (!firstPm) return null;

        const rawBank = firstPm?.bank || firstPm?.name || firstPm?.raw || null;
        const rawType = firstPm?.type || firstPm?.methodCanonical || null;

        const bank = rawBank
          ? (normalizeBankDisplayName(rawBank) || rawBank)
          : null;

        const typeNorm = String(rawType || "").toUpperCase();
        const type =
          typeNorm === "EMI" ? "EMI" :
          typeNorm === "CREDIT_CARD" ? "Credit Card" :
          typeNorm === "DEBIT_CARD" ? "Debit Card" :
          typeNorm === "NET_BANKING" ? "Net Banking" :
          typeNorm === "UPI" ? "UPI" :
          typeNorm === "WALLET" ? "Wallet" :
          rawType || null;

        return [bank, type].filter(Boolean).join(" • ") || null;
      })();

        const validForBest = isValidBestOffer(offer);

     info.push({
      title: offer?.title || null,
      couponCode:
        offer?.couponCode ||
        offer?.code ||
        offer?.parsedFields?.couponCode ||
        offer?.parsedFields?.code ||
        null,
      rawDiscount: offer?.rawDiscount || offer?.parsedFields?.rawDiscount || null,
      offerSummary: offer?.offerSummary || offer?.parsedFields?.offerSummary || null,
      terms: offer?.terms || offer?.parsedFields?.terms || null,
      paymentHint: getMatchedSelectedPaymentLabel(offer, selectedPaymentMethods) || null,
      sourcePortal: offer?.sourceMetadata?.sourcePortal || offer?.sourcePortal || null,
      requiresSpecificCardType: isSpecificFamilyInfoOnly === true,
            infoLabel:
        isSpecificFamilyInfoOnly
          ? "Specific card required"
          : (
              getInfoOfferReasonLabel(offer, selectedPaymentMethods) ||
              getInfoOfferDisplayLabel(offer, selectedPaymentMethods)
            ),
    });
  }

  return info
    .sort((a, b) => (b._score || 0) - (a._score || 0))
    .slice(0, limit)
    .map(({ _score, ...rest }) => rest);
}

async function applyOffersToFlight(
  flight,
  selectedPaymentMethods,
  offers,
  passengers = 1,
  cabin = "Economy",
  tripType = "one-way",
  isDomestic = true
) {
  const base = typeof flight.price === "number" ? flight.price : 0;

    const portalPrices = OTAS.map((portal) => {
    const portalBase = Math.round(base);
    const eligibilityAmount = Math.round(portalBase * Math.max(1, Number(passengers) || 1));

    const matchingCandidates = [];

    for (const offer of offers) {
   const ev = evaluateOfferForFlight({
  offer,
  portal,
  baseAmount: portalBase,
  eligibilityAmount,
  selectedPaymentMethods,
  isDomestic,
  cabin,
  flightAirlineName: flight.airlineName,
  tripType,
  passengers,
  allOffers: offers,
});

      if (!ev.ok) continue;

      matchingCandidates.push({
        offer,
        finalPrice: ev.discounted,
        offerKind: ev.offerKind,
        offerTypeLabel: ev.offerTypeLabel,
        channelLabel: ev.channelLabel,
        maxDiscountAmount: ev.maxDiscountAmount ?? null,
      });
    }

       matchingCandidates.sort((a, b) => {
      if (a.finalPrice !== b.finalPrice) return a.finalPrice - b.finalPrice;

      const aRank =
        a.offerKind === "payment" ? 0 :
        a.offerKind === "airline" ? 1 : 2;

      const bRank =
        b.offerKind === "payment" ? 0 :
        b.offerKind === "airline" ? 1 : 2;

      return aRank - bRank;
    });

    const best = matchingCandidates.length > 0 ? matchingCandidates[0] : null;
    const otherMatchedOffers = matchingCandidates.slice(1);
const matchedPaymentLabel =
  best && best.offerKind === "payment"
    ? (getMatchedSelectedPaymentLabel(best.offer, selectedPaymentMethods) || null)
    : null;

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
      offerTypeLabel: best.offerTypeLabel || null,
      channelLabel: best.channelLabel || null,
    }
  : null;

const bestOfferId =
  best?.offer?._id?.toString?.() ||
  best?.offer?.couponCode ||
  best?.offer?.code ||
  null;

const otherMatchedOffersClean = otherMatchedOffers.filter((row) => {
  const id =
    row.offer?._id?.toString?.() ||
    row.offer?.couponCode ||
    row.offer?.code ||
    null;

  return id !== bestOfferId;
});

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
  paymentLabel: best
    ? (
        best.offerKind === "payment"
          ? (matchedPaymentLabel || paymentLabelFromSelection(selectedPaymentMethods) || "Payment required")
          : "No payment restriction"
      )
    : null,
  offerTypeLabel: bestDeal?.offerTypeLabel || null,
  channelLabel: bestDeal?.channelLabel || null,
  explain: best
    ? `Applied ${bestDeal?.code || "an offer"} on ${portal} to reduce price from ₹${portalBase} to ₹${best.finalPrice}`
    : null,
        infoOffers: [
    ...buildInfoOffersForPortal(
  offers,
  portal,
  selectedPaymentMethods,
  cabin,
  isDomestic,
  best?.offer?.couponCode ||
    best?.offer?.code ||
    best?.offer?.parsedFields?.couponCode ||
    best?.offer?.parsedFields?.code ||
    null,
  5
),
    ...otherMatchedOffersClean.map((row) => ({
      title: row.offer?.title || null,
      couponCode:
        row.offer?.couponCode ||
        row.offer?.code ||
        row.offer?.parsedFields?.couponCode ||
        row.offer?.parsedFields?.code ||
        null,
      rawDiscount: row.offer?.rawDiscount || row.offer?.parsedFields?.rawDiscount || null,
      offerSummary: row.offer?.offerSummary || row.offer?.parsedFields?.offerSummary || null,
      terms: row.offer?.terms || row.offer?.parsedFields?.terms || null,
      paymentHint: getMatchedSelectedPaymentLabel(row.offer, selectedPaymentMethods) || null,
      sourcePortal: row.offer?.sourceMetadata?.sourcePortal || row.offer?.sourcePortal || null,
      requiresSpecificCardType: false,
      infoLabel: "Another applicable offer",
    })),
  ],
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
offerTypeLabel: bestPortal.offerTypeLabel || null,
channelLabel: bestPortal.channelLabel || null,
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
function canonicalTypeToUiLabel(bucket) {
  if (bucket === "CreditCard") return "Credit Card";
  if (bucket === "DebitCard") return "Debit Card";
  if (bucket === "NetBanking") return "Net Banking";
  return bucket;
}

function normalizeBankDisplayName(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;

  const u = s.toUpperCase().replace(/\s+/g, " ").trim();

  // Strong bank canonicalization for dropdown labels
  if (u.includes("FLIPKART") && u.includes("AXIS")) return "Flipkart Axis Bank";
  if (u.includes("AMAZON") && u.includes("ICICI")) return "Amazon Pay ICICI Bank";

  if (u === "AXIS" || u === "AXIS BANK") return "Axis Bank";
  if (u === "HDFC" || u === "HDFC BANK") return "HDFC Bank";
  if (u === "ICICI" || u === "ICICI BANK") return "ICICI Bank";
  if (u === "HSBC" || u === "HSBC BANK" || u === "HSBC CREDIT") return "HSBC";
  if (u === "SBI" || u === "STATE BANK OF INDIA") return "SBI";
  if (u === "KOTAK" || u === "KOTAK BANK" || u === "KOTAK MAHINDRA BANK" || u === "KOTAK BANK LTD") return "Kotak Bank";
  if (u === "YES" || u === "YES BANK" || u === "YES BANK LTD" || u === "YES BANK CREDIT CARD") return "Yes Bank";
  if (u === "RBL" || u === "RBL BANK" || u === "RBL BANK LTD") return "RBL Bank";
  if (u === "FEDERAL" || u === "FEDERAL BANK" || u === "FEDERAL BANK LTD" || u === "FEDERAL BANK CREDIT CARD") return "Federal Bank";
  if (u === "IDFC FIRST" || u === "IDFC FIRST BANK" || u === "IDFC FIRST BANK LTD" || u === "IDFC") return "IDFC First Bank";
  if (u === "AU" || u === "AU BANK" || u === "AU SMALL FINANCE BANK" || u === "AU SMALL BANK") return "AU Bank";
  if (u === "BOB" || u === "BANK OF BARODA" || u === "BOBCARD" || u === "BOBCARD LTD") return "Bank of Baroda";
  if (u === "AMERICAN EXPRESS" || u === "AMEX") return "American Express";
  if (u === "ONE" || u === "ONECARD" || u === "ONE CARD") return "OneCard";
  if (u === "CENTRAL BANK OF INDIA") return "Central Bank of India";
  if (u === "CANARA BANK") return "Canara Bank";
  if (u === "J&K BANK" || u === "J AND K BANK") return "J&K Bank";
  if (u === "BANK OF INDIA") return "Bank of India";
  if (u === "DBS") return "DBS";
    if (u === "CRED UPI") return "CRED";
  if (u === "UPI PAYMENTS" || u === "UPI") return "UPI";
    if (u === "RUPAY" || u === "RUPAY SELECT" || u === "RUPAY PLATINUM") return "RuPay";

  // Reject obvious non-bank / instruction-like junk
  if (
    /transaction only/i.test(s) ||
    /debit\/credit card/i.test(s) ||
    /net banking/i.test(s) ||
    /wallets?/i.test(s) ||
    /upi/i.test(s) ||
    /master cards?/i.test(s) ||
    /eligible cards?/i.test(s) ||
    /payment option/i.test(s)
  ) {
    return null;
  }

  return s.replace(/\s+/g, " ").trim();
}

function pickDisplayBankName(pm) {
  const raw =
    pm?.bank ||
    pm?.name ||
    pm?.bankCanonical ||
    pm?.raw ||
    "";

  const out = normalizeBankDisplayName(raw);
  return out || null;
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
  "Credit Card": Array.from(buckets.CreditCard).sort(),
  "Debit Card": Array.from(buckets.DebitCard).sort(),
  "Net Banking": Array.from(buckets.NetBanking).sort(),
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
    const q = req.query.q ? String(req.query.q).trim() : null;
const limit = Math.min(parseInt(req.query.limit || "10", 10), 200);

    if (!portal) {
  return res.status(400).json({ error: "Missing portal" });
}

    const selectedPaymentMethods =
  bank && type ? [{ type, name: bank }] : [];

    const col = await getOffersCollection();
    const offers = await col.find(
      { "sourceMetadata.sourcePortal": portal },
      { projection: { _id: 0 } }
    ).toArray();
    const filteredOffers = q
  ? offers.filter((o) => {
      const blob = `${o?.title || ""} ${o?.rawDiscount || ""} ${o?.couponCode || o?.code || ""} ${o?.offerSummary?.headline || ""}`;
      return blob.toLowerCase().includes(q.toLowerCase());
    })
  : offers;

    const stats = {
      portal,
      portalTotal: offers.length,
      total: filteredOffers.length,
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
      inferredOnly: 0,
    };

    const samples = [];

    for (const offer of filteredOffers) {
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
      const roundTripBlocked = offerRequiresRoundTrip(offer);
if (roundTripBlocked) failReasons.push("ROUND_TRIP_ONLY");
      
      if (scope) stats.scopeOK++;
      else failReasons.push("SCOPE_MISMATCH");

      const pay = offerMatchesSelectedPayment(offer, selectedPaymentMethods);
      if (pay) stats.matchesPayment++;
      else failReasons.push("PAYMENT_MISMATCH");
      const offerPMs = extractOfferPaymentMethods(offer);
      const inferredOnly = Array.isArray(offerPMs) && offerPMs.length > 0 && offerPMs.every((pm) => pm?.inferred === true);
      if (inferredOnly) stats.inferredOnly++;
      if (inferredOnly) failReasons.push("PAYMENT_INFERRED_ONLY");

      const minTxn = getMinTxnValue(offer);
      const paxRestriction = getPassengerRestrictionResult(offer, 1);
      if (!paxRestriction.ok) failReasons.push(paxRestriction.reason || "PASSENGER_COUNT_RESTRICTED");
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

      if (samples.length < limit && (wouldApplyNow || ok || expired)) { 
        samples.push({
          title: offer?.title || null,
          code: offer?.couponCode || offer?.code || null,
          rawDiscount: offer?.rawDiscount || null,
          minTransactionValue: minTxn || 0,
          expired: !!expired,
          isFlight: !!flight,
                inferredOnly: 0,
          hotelOnly: !!hotelOnly,
          inferredOnly: inferredOnly,
          roundTripBlocked: !!roundTripBlocked,
          wouldApplyNow,
          failReasons,
        });
      }
    }

    res.json({
  selectedPaymentMethods,
  baseAmount: amount,
  q,
  evaluatedCount: filteredOffers.length,
  stats,
  samples
});
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

        const routeIsDomestic = isDomesticRoute(from, to);

    const outboundFlights = [];
    for (const f of outFlightsLimited) {
      outboundFlights.push(
        await applyOffersToFlight(
          f,
          selectedPaymentMethods,
          offers,
          adults,
          cabin,
          tripType,
          routeIsDomestic
        )
      );
    }

    // Return
       let returnFlights = [];
    if (tripType === "round-trip" && retDate) {
      const retRes = await fetchOneWayTrip({
        from: to,
        to: from,
        date: retDate,
        adults,
        cabin,
        currency
      });
      meta.retStatus = retRes.status;
      meta.request.retTried = retRes.tried;

      const retFlightsRaw = mapFlightsFromFlightAPI(retRes.data);
      const retFlightsLimited = limitAndSortFlights(retFlightsRaw);

      const returnRouteIsDomestic = isDomesticRoute(to, from);

      const enriched = [];
      for (const f of retFlightsLimited) {
        enriched.push(
          await applyOffersToFlight(
            f,
            selectedPaymentMethods,
            offers,
            adults,
            cabin,
            tripType,
            returnRouteIsDomestic
          )
        );
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

