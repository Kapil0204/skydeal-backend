// index.js — SkyDeal backend (ESM)
// SWITCHED to FlightAPI.io only; Amadeus + Kiwi disabled.
//
// Env needed on Render:
// - PORT                (optional; defaults 3000)
// - FLIGHTAPI_KEY       (REQUIRED)
// - MONGODB_URI         (for offers)
// - MONGODB_DB          (default "skydeal")

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { MongoClient, ServerApiVersion } from "mongodb";

const app = express();

/* ===== CORS (unchanged) ===== */
app.use((req, res, next) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
const corsConfig = {
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false,
  maxAge: 86400
};
app.use(cors(corsConfig));
app.options("*", cors(corsConfig));

app.use(express.json());

/* Health check */
app.get("/health", (req, res) =>
  res.json({ ok: true, source: "flightapi", time: new Date().toISOString() })
);

// -------------------- CONFIG -----------------------
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "skydeal";
const FLIGHTAPI_KEY = process.env.FLIGHTAPI_KEY;
const CURRENCY = "INR"; // we stick to INR for now

// Portals for comparison
const PORTALS = ["MakeMyTrip", "Goibibo", "EaseMyTrip", "Yatra", "Cleartrip"];
const PAYMENT_TYPES = ["Credit Card", "Debit Card", "EMI", "NetBanking", "Wallet", "UPI"];

// -------------------- MONGO ------------------------
let mongoClient;
let db;
async function initMongo() {
  if (db) return db;
  if (!MONGODB_URI) {
    console.warn("⚠️  MONGODB_URI not set; offers/filters will not work.");
    return null;
  }
  mongoClient = new MongoClient(MONGODB_URI, { serverApi: ServerApiVersion.v1 });
  await mongoClient.connect();
  db = mongoClient.db(MONGODB_DB);
  console.log("✅ Mongo connected:", MONGODB_DB);
  return db;
}

// -------------------- HELPERS ----------------------
function asMoney(x) {
  if (x == null) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function toISODateStr(d) {
  try {
    if (!d) return null;
    const s = String(d).trim();
    const m1 = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m1) { const [, dd, mm, yyyy] = m1; return `${yyyy}-${mm}-${dd}`; }
    const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m2) return s;
    const dt = new Date(s);
    if (Number.isNaN(dt.getTime())) return null;
    return dt.toISOString().slice(0, 10);
  } catch { return null; }
}
function isOfferActiveForDate(offer, travelISO) {
  if (offer?.isExpired === true) return false;
  const end =
    offer?.validityPeriod?.end ??
    offer?.validityPeriod?.to ??
    offer?.validityPeriod?.endDate ??
    offer?.validityPeriod?.till ??
    offer?.validityPeriod?.until ?? null;
  const endISO = toISODateStr(end);
  if (!endISO) return true;
  return travelISO <= endISO;
}
function normTypeKey(t) {
  const x = String(t || "").toLowerCase();
  if (!x) return null;
  if (/\bemi\b/.test(x)) return "emi";
  if (/credit|cc/.test(x)) return "credit";
  if (/debit/.test(x)) return "debit";
  if (/net\s*bank|netbank/.test(x)) return "netbanking";
  if (/wallet/.test(x)) return "wallet";
  if (/\bupi\b/.test(x)) return "upi";
  return null;
}
function normalizeBankName(raw) {
  if (!raw) return "";
  let s = String(raw).trim().replace(/\s+/g, " ").toLowerCase();
  s = s.replace(/\bltd\.?\b/g, "").replace(/\blimited\b/g, "").replace(/\bplc\b/g, "").trim();
  const map = [
    [/amazon\s*pay\s*icici/i, "ICICI Bank"], [/^icici\b/i, "ICICI Bank"],
    [/flipkart\s*axis/i, "Axis Bank"], [/^axis\b/i, "Axis Bank"],
    [/\bau\s*small\s*finance\b/i, "AU Small Finance Bank"],
    [/\bbobcard\b/i, "Bank of Baroda"], [/bank\s*of\s*baroda|^bob\b/i, "Bank of Baroda"],
    [/\bsbi\b|state\s*bank\s*of\s*india/i, "State Bank of India"],
    [/hdfc/i, "HDFC Bank"], [/kotak/i, "Kotak"], [/yes\s*bank/i, "YES Bank"],
    [/idfc/i, "IDFC First Bank"], [/indusind/i, "IndusInd Bank"], [/federal/i, "Federal Bank"],
    [/rbl/i, "RBL Bank"], [/standard\s*chartered/i, "Standard Chartered"],
    [/hsbc/i, "HSBC"], [/canara/i, "Canara Bank"],
  ];
  for (const [rx, canon] of map) { if (rx.test(raw) || rx.test(s)) return canon; }
  const cleaned = String(s).replace(/\b(bank|card|cards)\b/gi, "").trim();
  return cleaned ? cleaned.replace(/\b[a-z]/g, c => c.toUpperCase()) : String(raw).trim();
}
function titleCase(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
function looksComplete(bank) {
  return /(card|emi|net ?bank|wallet|upi)/i.test(bank || "");
}
const DISPLAY = {
  "credit card": "Credit Card",
  "debit card": "Debit Card",
  "emi": "Credit Card EMI",
  "netbanking": "NetBanking",
  "wallet": "Wallet",
  "upi": "UPI",
};
function makePaymentLabel(bank, type) {
  if (/^(all|any)$/i.test(bank)) return DISPLAY[type?.toLowerCase()] || type || "";
  if (looksComplete(bank)) return titleCase(bank);
  return `${titleCase(bank)} ${DISPLAY[type?.toLowerCase()] || type || ""}`.trim();
}
function extractPaymentMethodLabel(offerDoc) {
  if (offerDoc.paymentMethodLabel) return offerDoc.paymentMethodLabel;
  if (Array.isArray(offerDoc.paymentMethods) && offerDoc.paymentMethods.length) {
    const first = offerDoc.paymentMethods[0];
    if (typeof first === "string") return first.trim();
    if (first && (first.bank || first.type || first.cardNetwork)) {
      const bank = normalizeBankName(first.bank || "");
      const type = first.type || "";
      return makePaymentLabel(bank, type);
    }
  }
  const text = `${offerDoc.title || ""} ${offerDoc.rawDiscount || ""}`;
  if (/wallet/i.test(text)) return "Wallet";
  if (/\bupi\b/i.test(text)) return "UPI";
  if (/net\s*bank|netbank/i.test(text)) return "NetBanking";
  if (/debit/i.test(text)) return "Debit Card";
  if (/credit|emi/i.test(text)) return "Credit Card";
  return "—";
}

// -------------------- Selected payment parsing --------------------
function normalizeUserPaymentChoices(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const out = [];
  for (const it of arr) {
    if (it && typeof it === "object") {
      const bank = normalizeBankName(it.bank || "");
      const type = normTypeKey(it.type);
      if (bank) out.push({ bank: bank.toLowerCase(), type: type || null });
    } else if (typeof it === "string") {
      const type = normTypeKey(it);
      const bank = normalizeBankName(
        String(it).replace(/credit\s*card|debit\s*card|\bemi\b|net\s*bank(?:ing)?|upi|wallet/gi, "")
      );
      if (bank) out.push({ bank: bank.toLowerCase(), type: type || null });
    }
  }
  return out.length ? out : null;
}

// -------------------- FLIGHTAPI (NEW) ----------------------
// Minimal mapper from FlightAPI.io result to our UI fields.
// We will display price and basic timing when available; if
// timing/airline are missing, we fill placeholders (frontend-safe).

function safeTimeStr(isoLike) {
  try {
    if (!isoLike) return "--:--";
    const d = new Date(isoLike);
    if (isNaN(d.getTime())) return "--:--";
    return d.toTimeString().slice(0,5);
  } catch { return "--:--"; }
}

function mapFlightApiToUI(json) {
  // FlightAPI returns Skyscanner-like structures; we’ll take each itinerary’s
  // cheapest pricing option as the base price.
  // Some responses include legs/segments; if missing, we use fallbacks.
  const itins = Array.isArray(json?.itineraries) ? json.itineraries : [];
  const legs = Array.isArray(json?.legs) ? json.legs : [];
  const segments = Array.isArray(json?.segments) ? json.segments : [];
  const carriers = json?.carriers || {}; // sometimes a map of id->name

  const legsById = new Map(legs.map(l => [String(l?.id ?? ""), l]));
  const segById = new Map(segments.map(s => [String(s?.id ?? ""), s]));

  return itins.map(it => {
    // price
    const po = Array.isArray(it.pricing_options) && it.pricing_options.length
      ? it.pricing_options[0]
      : null;
    const baseAmount = asMoney(po?.price?.amount) ?? 0;

    // times/airline (best effort)
    let departure = "--:--";
    let arrival = "--:--";
    let airlineName = "—";
    let flightNumber = "";
    let stops = 0;

    // Try legs -> first & last segment
    const firstLegId = Array.isArray(it.leg_ids) ? it.leg_ids[0] : null;
    const lastLegId  = Array.isArray(it.leg_ids) ? it.leg_ids[it.leg_ids.length - 1] : null;
    const firstLeg = firstLegId ? legsById.get(String(firstLegId)) : null;
    const lastLeg  = lastLegId ? legsById.get(String(lastLegId)) : null;

    if (firstLeg?.departure?.time) departure = safeTimeStr(firstLeg.departure.time);
    if (lastLeg?.arrival?.time) arrival = safeTimeStr(lastLeg.arrival.time);
    if (Array.isArray(firstLeg?.segment_ids) && firstLeg.segment_ids.length) {
      const seg0 = segById.get(String(firstLeg.segment_ids[0]));
      const cc = seg0?.marketing_carrier_id || seg0?.operating_carrier_id;
      const num = seg0?.flight_number || "";
      const name = cc != null ? (carriers[String(cc)] || String(cc)) : null;
      if (name) airlineName = name;
      if (cc) flightNumber = `${cc} ${num}`.trim();
    }
    // stops
    if (Array.isArray(firstLeg?.segment_ids)) {
      stops = Math.max(0, firstLeg.segment_ids.length - 1);
    }

    return {
      flightNumber: flightNumber || "—",
      airlineName: airlineName || "—",
      departure,
      arrival,
      price: baseAmount.toFixed(2),
      stops,
      stopCodes: [], // can be filled if segments carry via iata codes
      carrierCode: "", // optional, not always present in this API
    };
  });
}

// Build URLs per FlightAPI schema (path params)
// Round trip
function flightApiRoundTripURL({ apiKey, from, to, depISO, retISO, adults, children, infants, cabin, currency }) {
  return [
    "https://api.flightapi.io/roundtrip",
    encodeURIComponent(apiKey),
    encodeURIComponent(from),
    encodeURIComponent(to),
    encodeURIComponent(depISO),
    encodeURIComponent(retISO),
    String(adults),
    String(children),
    String(infants),
    encodeURIComponent(cabin),
    encodeURIComponent(currency),
  ].join("/");
}
// Oneway
function flightApiOnewayURL({ apiKey, from, to, depISO, adults, children, infants, cabin, currency }) {
  return [
    "https://api.flightapi.io/onewaytrip",
    encodeURIComponent(apiKey),
    encodeURIComponent(from),
    encodeURIComponent(to),
    encodeURIComponent(depISO),
    String(adults),
    String(children),
    String(infants),
    encodeURIComponent(cabin),
    encodeURIComponent(currency),
  ].join("/");
}

async function fetchFlightApiOffers({ from, to, date, adults, travelClass, roundTripReturnDate }) {
  if (!FLIGHTAPI_KEY) throw new Error("Missing FLIGHTAPI_KEY");
  const ORG = String(from || "").trim().toUpperCase();
  const DST = String(to || "").trim().toUpperCase();
  const CLASS = (String(travelClass || "ECONOMY").toUpperCase() === "PREMIUM_ECONOMY")
    ? "Premium_Economy"
    : (String(travelClass || "ECONOMY").toUpperCase()); // per docs

  // Children/Infants default 0 for now; can be extended later.
  const adultsN = Number(adults || 1);
  const childrenN = 0;
  const infantsN = 0;

  const depISO = date;
  const url = roundTripReturnDate
    ? flightApiRoundTripURL({
        apiKey: FLIGHTAPI_KEY, from: ORG, to: DST, depISO,
        retISO: roundTripReturnDate, adults: adultsN, children: childrenN, infants: infantsN,
        cabin: CLASS[0].toUpperCase() + CLASS.slice(1).toLowerCase(), currency: CURRENCY
      })
    : flightApiOnewayURL({
        apiKey: FLIGHTAPI_KEY, from: ORG, to: DST, depISO,
        adults: adultsN, children: childrenN, infants: infantsN,
        cabin: CLASS[0].toUpperCase() + CLASS.slice(1).toLowerCase(), currency: CURRENCY
      });

  const res = await fetch(url);
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`FlightAPI search error: ${res.status} ${t}`);
  }
  const json = await res.json();
  return mapFlightApiToUI(json);
}

// -------------------- DB LOOKUP --------------------
async function loadActiveCouponOffersByPortal({ travelISO }) {
  const database = await initMongo();
  if (!database) return new Map(PORTALS.map(p => [p, []]));

  const collection = database.collection("offers");
  const today = travelISO;
  const orValidity = [
    { validityPeriod: { $exists: false } },
    {
      $and: [
        { "validityPeriod.end": { $exists: false } },
        { "validityPeriod.to": { $exists: false } },
        { "validityPeriod.endDate": { $exists: false } },
        { "validityPeriod.till": { $exists: false } },
        { "validityPeriod.until": { $exists: false } },
      ],
    },
    { "validityPeriod.end": { $gte: today } },
    { "validityPeriod.to": { $gte: today } },
    { "validityPeriod.endDate": { $gte: today } },
    { "validityPeriod.till": { $gte: today } },
    { "validityPeriod.until": { $gte: today } },
  ];

  const cursor = collection.find({
    couponCode: { $exists: true, $ne: "" },
    isExpired: { $ne: true },
    "sourceMetadata.sourcePortal": { $in: PORTALS },
    $or: orValidity,
  });

  const byPortal = new Map(PORTALS.map((p) => [p, []]));
  for await (const doc of cursor) {
    const portal = doc?.sourceMetadata?.sourcePortal;
    if (byPortal.has(portal)) byPortal.get(portal).push(doc);
  }
  return byPortal;
}

// -------------------- PAYMENT OPTIONS (unchanged) -----------------------
app.get("/payment-options", async (_req, res) => {
  try {
    const database = await initMongo();
    if (!database) return res.json({ options: {} });

    const collection = database.collection("offers");
    const today = new Date().toISOString().slice(0, 10);
    const activeValidityOr = [
      { validityPeriod: { $exists: false } },
      {
        $and: [
          { "validityPeriod.end": { $exists: false } },
          { "validityPeriod.to": { $exists: false } },
          { "validityPeriod.endDate": { $exists: false } },
          { "validityPeriod.till": { $exists: false } },
          { "validityPeriod.until": { $exists: false } },
        ],
      },
      { "validityPeriod.end": { $gte: today } },
      { "validityPeriod.to": { $gte: today } },
      { "validityPeriod.endDate": { $gte: today } },
      { "validityPeriod.till": { $gte: today } },
      { "validityPeriod.until": { $gte: today } },
    ];

    const cursor = collection.find(
      { isExpired: { $ne: true }, $or: activeValidityOr },
      { projection: { paymentMethods: 1, title: 1, rawDiscount: 1 }, limit: 4000 }
    );

    const optionsSets = Object.fromEntries(PAYMENT_TYPES.map((t) => [t, new Set()]));

    for await (const doc of cursor) {
      const pm = Array.isArray(doc.paymentMethods) ? doc.paymentMethods : [];

      for (const entry of pm) {
        if (entry && typeof entry === "object") {
          const typeKey = normTypeKey(entry.type || entry.method || entry.category || entry.mode);
          const bank = titleCase(normalizeBankName(
            entry.bank || entry.cardBank || entry.issuer || entry.cardIssuer || entry.provider || ""
          ));
          if (!typeKey || !bank) continue;

          if (typeKey === "emi") {
            optionsSets["EMI"].add(`${bank} (Credit Card EMI)`);
            optionsSets["Credit Card"].add(bank);
          } else if (typeKey === "credit") {
            optionsSets["Credit Card"].add(bank);
          } else if (typeKey === "debit") {
            optionsSets["Debit Card"].add(bank);
          } else if (typeKey === "netbanking") {
            optionsSets["NetBanking"].add(bank);
          } else if (typeKey === "wallet") {
            optionsSets["Wallet"].add(bank);
          } else if (typeKey === "upi") {
            optionsSets["UPI"].add(bank);
          }
        } else if (typeof entry === "string") {
          const typeKey = normTypeKey(entry);
          const bank = titleCase(normalizeBankName(
            entry.replace(/credit\s*card|debit\s*card|\bemi\b|net\s*bank(?:ing)?|upi|wallet/gi, "")
          ));
          if (!bank) continue;

          if (typeKey === "emi") {
            optionsSets["EMI"].add(`${bank} (Credit Card EMI)`);
            optionsSets["Credit Card"].add(bank);
          } else if (typeKey === "credit") optionsSets["Credit Card"].add(bank);
          else if (typeKey === "debit") optionsSets["Debit Card"].add(bank);
          else if (typeKey === "netbanking") optionsSets["NetBanking"].add(bank);
          else if (typeKey === "wallet") optionsSets["Wallet"].add(bank);
          else if (typeKey === "upi") optionsSets["UPI"].add(bank);
        }
      }
    }

    const out = {};
    PAYMENT_TYPES.forEach((t) => {
      out[t] = Array.from(optionsSets[t]).sort((a, b) => a.localeCompare(b));
    });
    res.json({ options: out });
  } catch (e) {
    console.error("X /payment-options error:", e);
    res.status(500).json({ options: {} });
  }
});

// -------------------- MATCHING (unchanged) -----------------------
function offerHasPaymentRestriction(offer) {
  const arr = Array.isArray(offer?.paymentMethods) ? offer.paymentMethods : [];
  return arr.length > 0;
}
function offerMatchesPayment(offer, selected) {
  if (!selected || selected.length === 0) {
    return !offerHasPaymentRestriction(offer);
  }
  const pairs = [];
  const list = Array.isArray(offer.paymentMethods) ? offer.paymentMethods : [];
  for (const pm of list) {
    if (typeof pm === "string") {
      const typeKey = normTypeKey(pm);
      const bank = normalizeBankName(
        pm.replace(/credit\s*card|debit\s*card|\bemi\b|net\s*bank(?:ing)?|upi|wallet/gi, "")
      ).toLowerCase();
      if (bank) pairs.push({ bank, type: typeKey });
    } else if (pm && typeof pm === "object") {
      const typeKey = normTypeKey(pm.type || pm.method || pm.category || pm.mode);
      const bank = normalizeBankName(pm.bank || pm.cardBank || pm.issuer || pm.cardIssuer || pm.provider || "").toLowerCase();
      if (bank) pairs.push({ bank, type: typeKey });
    }
  }
  return selected.some(sel => {
    const wantBank = (sel.bank || "").toLowerCase();
    const wantType = sel.type || null;
    if (!wantBank) return false;
    return pairs.some(p => {
      if (p.bank !== wantBank) return false;
      if (!p.type && wantType) return false;
      if (!wantType) return true;
      if (wantType === "emi") return p.type === "emi";
      return p.type === wantType;
    });
  });
}

// -------------------- SEARCH (FLIGHTAPI) -----------------------
const OTA_MARKUP_INR = 250;

function applyBestOfferForPortal({ basePortalPrice, portal, offers, travelISO, selectedPayments }) {
  let best = { finalPrice: basePortalPrice, discountApplied: 0, appliedOffer: null };
  for (const offer of offers) {
    if (!offer.couponCode) continue;
    if (!isOfferActiveForDate(offer, travelISO)) continue;
    if (!offerMatchesPayment(offer, selectedPayments)) continue;

    const minTxn = asMoney(offer.minTransactionValue) ?? 0;
    if (basePortalPrice < minTxn) continue;

    // Handle % and flat discounts (both supported)
    const pct = offer.discountPercent != null ? Number(offer.discountPercent) : null;
    const cap = asMoney(offer.maxDiscountAmount);
    const flat = asMoney(offer.flatDiscountAmount); // in case we stored flat offers

    let discount = 0;
    if (flat && flat > 0) discount = flat;
    else if (pct && pct > 0) {
      discount = Math.floor((basePortalPrice * pct) / 100);
      if (cap != null && cap > 0) discount = Math.min(discount, cap);
    }

    if (discount <= 0) continue;

    const finalPrice = Math.max(0, basePortalPrice - discount);
    if (finalPrice < best.finalPrice) {
      best = {
        finalPrice,
        discountApplied: discount,
        appliedOffer: {
          portal: offer?.sourceMetadata?.sourcePortal || portal,
          couponCode: offer.couponCode,
          discountPercent: Number.isFinite(pct) ? pct : null,
          maxDiscountAmount: cap ?? null,
          minTransactionValue: minTxn || null,
          validityPeriod: offer.validityPeriod || null,
          rawDiscount: offer.rawDiscount || null,
          title: offer.title || null,
          offerId: String(offer._id),
          paymentMethodLabel: extractPaymentMethodLabel(offer),
        },
      };
    }
  }
  return best;
}

app.post("/search", async (req, res) => {
  try {
    const {
      from, to,
      departureDate, returnDate,
      passengers = 1,
      travelClass = "ECONOMY",
      tripType = "round-trip",
      paymentMethods = []
    } = req.body || {};

    const depISO = toISODateStr(departureDate);
    const retISO = toISODateStr(returnDate);

    const missing = [];
    if (!from) missing.push("from");
    if (!to) missing.push("to");
    if (!depISO) missing.push("departureDate (invalid format)");
    if (missing.length) {
      return res.status(400).json({ error: "Missing required fields", missing, depISO, retISO });
    }

    const ORG = String(from).trim().toUpperCase();
    const DST = String(to).trim().toUpperCase();

    const selectedPayments = normalizeUserPaymentChoices(paymentMethods);
    const offersByPortal = await loadActiveCouponOffersByPortal({ travelISO: depISO });

    // Outbound
    const outbound = await fetchFlightApiOffers({
      from: ORG, to: DST, date: depISO, adults: passengers, travelClass,
      roundTripReturnDate: (tripType === "round-trip" && retISO) ? retISO : null
    });

    // Return (if needed & not already included as round-trip items)
    const retFlights = (tripType === "round-trip" && retISO)
      ? await fetchFlightApiOffers({
          from: DST, to: ORG, date: retISO, adults: passengers, travelClass,
          roundTripReturnDate: null // we already did a round-trip above; fetch return separately
        })
      : [];

    function decorateWithPortalPrices(flight, travelISO) {
      const base = asMoney(flight.price) || 0;
      const prices = PORTALS.map((portal) => {
        const portalOffers = offersByPortal.get(portal) || [];
        const portalBase = base + OTA_MARKUP_INR; // ₹250 markup
        const best = applyBestOfferForPortal({
          basePortalPrice: portalBase, portal, offers: portalOffers,
          travelISO, selectedPayments
        });
        return {
          portal,
          basePrice: base,            // raw flight price
          markedUpPrice: portalBase,  // price after +₹250 portal markup
          finalPrice: best.finalPrice,
          ...(best.discountApplied > 0 ? { discountApplied: best.discountApplied } : {}),
          appliedOffer: best.appliedOffer,
        };
      });
      return { ...flight, portalPrices: prices };
    }

    const outboundDecorated = outbound.map((f) => decorateWithPortalPrices(f, depISO));
    const returnDecorated = retFlights.map((f) => decorateWithPortalPrices(f, retISO || depISO));

    res.json({
      outboundFlights: outboundDecorated,
      returnFlights: returnDecorated,
      meta: {
        source: "flightapi",
        portals: PORTALS,
      }
    });
  } catch (err) {
    console.error("X /search error:", err);
    res.status(502).json({ error: "flightapi_failed", message: err.message });
  }
});

// -------------------- DISABLED LEGACY PATHS -----------------------
// app.post("/kiwi/probe", ...)   // 🔕 Removed
// Amadeus token + fetch logic    // 🔕 Removed

// -------------------- START ------------------------
app.listen(PORT, async () => {
  try { await initMongo(); } catch (e) { console.error("Mongo init failed:", e.message); }
  console.log(`🚀 SkyDeal backend (FlightAPI) listening on :${PORT}`);
});
