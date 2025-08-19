// index.js  — SkyDeal backend (ESM)
// --------------------------------------------------
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { MongoClient, ServerApiVersion } from "mongodb";

const app = express();
app.use(cors());
app.use(express.json());

// -------------------- CONFIG -----------------------
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB  = process.env.MONGODB_DB || "skydeal";

// OTA portals we price/compare
const PORTALS = ["MakeMyTrip", "Goibibo", "EaseMyTrip", "Yatra", "Cleartrip"];

// Canonical payment types (left pane in UI)
const PAYMENT_TYPES = ["Credit Card", "Debit Card", "EMI", "NetBanking", "Wallet", "UPI"];

// -------------------- MONGO ------------------------
let mongoClient;
let db;
async function initMongo() {
  if (db) return db;
  mongoClient = new MongoClient(MONGODB_URI, {
    serverApi: ServerApiVersion.v1,
  });
  await mongoClient.connect();
  db = mongoClient.db(MONGODB_DB);
  console.log("✅ Mongo connected:", MONGODB_DB);
  return db;
}

// -------------------- HELPERS ----------------------

// Coerce to price number
function asMoney(x) {
  if (x == null) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// Parse date-ish string to ISO yyyy-mm-dd (conservative)
function toISODateStr(d) {
  try {
    if (!d) return null;
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return null;
    return dt.toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

// Check if an offer is *active* for a given travel date
function isOfferActiveForDate(offer, travelISO) {
  // If offer explicitly expired, skip
  if (offer.isExpired === true) return false;

  // Accept many shapes of validity
  const end =
    offer?.validityPeriod?.end ??
    offer?.validityPeriod?.to ??
    offer?.validityPeriod?.endDate ??
    offer?.validityPeriod?.till ??
    offer?.validityPeriod?.until ??
    null;

  const endISO = toISODateStr(end);
  if (!endISO) return true; // if no end date, assume active
  return travelISO <= endISO;
}

// Normalize payment choice sent by frontend (array of strings)
function normalizeUserPaymentChoices(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr
    .map((s) => String(s || "").trim().toLowerCase())
    .filter(Boolean);
}

// Does this offer’s paymentMethods match any selected payment choice?
function offerMatchesPayment(offer, selected) {
  if (!selected || selected.length === 0) return true; // no filter applied

  // Payment may be string list OR structured objects
  const list = Array.isArray(offer.paymentMethods)
    ? offer.paymentMethods
    : [];

  const labels = list
    .map((pm) => {
      if (typeof pm === "string") return pm.toLowerCase().trim();
      if (pm && (pm.bank || pm.type || pm.cardNetwork)) {
        return [pm.bank, pm.type, pm.cardNetwork]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .trim();
      }
      return "";
    })
    .filter(Boolean);

  // simple containment / partial match
  return selected.some((sel) =>
    labels.some((l) => l.includes(sel) || sel.includes(l))
  );
}

// ---- Friendlier label for a payment method (for UI)
function extractPaymentMethodLabel(offerDoc) {
  if (offerDoc.paymentMethodLabel) return offerDoc.paymentMethodLabel;

  if (Array.isArray(offerDoc.paymentMethods) && offerDoc.paymentMethods.length) {
    const first = offerDoc.paymentMethods[0];
    if (typeof first === "string") return first.trim();
    if (first && (first.bank || first.type || first.cardNetwork)) {
      const parts = [first.bank, first.type, first.cardNetwork]
        .filter(Boolean)
        .map((s) => String(s).trim());
      if (parts.length) return parts.join(" ");
    }
  }

  const text = `${offerDoc.title || ""} ${offerDoc.rawDiscount || ""}`;
  if (/wallet/i.test(text)) return "Wallet";
  if (/upi/i.test(text)) return "UPI";
  if (/net\s*bank/i.test(text) || /netbank/i.test(text)) return "Netbanking";
  if (/debit/i.test(text)) return "Debit Card";
  if (/credit|emi/i.test(text)) return "Credit Card"; // treat EMI as Credit
  return "—";
}

// Choose best applicable offer for a single price & portal
function applyBestOfferForPortal({
  basePrice,
  portal,
  offers,
  travelISO,
  selectedPayments,
}) {
  let best = {
    finalPrice: basePrice,
    discountApplied: 0,
    appliedOffer: null,
  };

  for (const offer of offers) {
    // must have coupon (per your rule) & be active & payment match
    if (!offer.couponCode) continue;
    if (!isOfferActiveForDate(offer, travelISO)) continue;
    if (!offerMatchesPayment(offer, selectedPayments)) continue;

    const minTxn = asMoney(offer.minTransactionValue) ?? 0;
    if (basePrice < minTxn) continue;

    const pct = offer.discountPercent != null ? Number(offer.discountPercent) : null;
    const cap = asMoney(offer.maxDiscountAmount);

    // percent mandatory per current rule
    if (pct == null || !Number.isFinite(pct) || pct <= 0) continue;

    let discount = Math.floor((basePrice * pct) / 100);
    if (cap != null && cap > 0) discount = Math.min(discount, cap);
    if (discount <= 0) continue;

    const finalPrice = basePrice - discount;
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

  if (best.appliedOffer) {
    console.log(
      `✅ Offer: portal=${portal} base=${basePrice} final=${best.finalPrice} code=${best.appliedOffer.couponCode} pm=${best.appliedOffer.paymentMethodLabel}`
    );
  } else {
    console.log(`— No offer: portal=${portal} base=${basePrice}`);
  }

  return best;
}

// -------------------- AMADEUS TOKEN ----------------
let cachedToken = null;
let tokenExpiry = 0;

async function getAmadeusToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry - 30_000) return cachedToken;

  const res = await fetch("https://test.api.amadeus.com/v1/security/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.AMADEUS_API_KEY,
      client_secret: process.env.AMADEUS_API_SECRET,
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Amadeus token error: ${res.status} ${t}`);
  }
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in || 1800) * 1000;
  return cachedToken;
}

// -------------------- FLIGHT SEARCH ----------------
function mapAmadeusToUI(itin, dictionaries) {
  const seg = itin?.itineraries?.[0]?.segments?.[0];
  const carrierCode = seg?.carrierCode || itin?.validatingAirlineCodes?.[0] || "NA";
  const airlineName = dictionaries?.carriers?.[carrierCode] || carrierCode;

  const departure = seg?.departure?.at ? new Date(seg.departure.at).toTimeString().slice(0,5) : "--:--";
  const arrival   = seg?.arrival?.at   ? new Date(seg.arrival.at).toTimeString().slice(0,5)   : "--:--";
  const flightNum = `${carrierCode} ${seg?.number || ""}`.trim();
  const stops = (itin?.itineraries?.[0]?.segments?.length || 1) - 1;

  const price = Number(itin?.price?.grandTotal || itin?.price?.total || 0) || 0;

  return {
    flightNumber: flightNum,
    airlineName,
    departure,
    arrival,
    price: price.toFixed(2),
    stops,
  };
}

async function fetchAmadeusOffers({ from, to, date, adults, travelClass }) {
  const token = await getAmadeusToken();
  const url = new URL("https://test.api.amadeus.com/v2/shopping/flight-offers");
  url.search = new URLSearchParams({
    originLocationCode: from,
    destinationLocationCode: to,
    departureDate: date,
    adults: String(adults || 1),
    travelClass: travelClass || "ECONOMY",
    currencyCode: "INR",
    max: "20",
  });

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Amadeus search error: ${res.status} ${t}`);
  }
  const json = await res.json();
  const dict = json?.dictionaries || {};
  const flights = (json?.data || []).map((d) => mapAmadeusToUI(d, dict));
  return flights;
}

// -------------------- OFFERS LOOKUP ----------------
async function loadActiveCouponOffersByPortal({ travelISO }) {
  const collection = (await initMongo()).collection("offers");

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
    // offerCategories: { $in: ["Flights", "Flight"] } // optional
  });

  const byPortal = new Map(PORTALS.map((p) => [p, []]));
  for await (const doc of cursor) {
    const portal = doc?.sourceMetadata?.sourcePortal;
    if (byPortal.has(portal)) byPortal.get(portal).push(doc);
  }
  return byPortal; // Map(portal -> offers[])
}

// -------------------- ROUTES -----------------------

// Health
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    now: new Date().toISOString(),
  });
});

// === Dynamic Payment Type -> Banks (for the 2‑pane selector)
app.get("/payment-options", async (req, res) => {
  try {
    const collection = (await initMongo()).collection("offers");
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
      {
        isExpired: { $ne: true },
        "sourceMetadata.sourcePortal": { $in: PORTALS },
        $or: activeValidityOr,
      },
      { projection: { paymentMethods: 1, title: 1, rawDiscount: 1 } }
    );

    const TYPES = PAYMENT_TYPES;
    const KNOWN_BANKS = [
      "ICICI Bank","HDFC Bank","Axis Bank","State Bank of India","SBI","Kotak",
      "YES Bank","IDFC First Bank","IndusInd Bank","Bank of Baroda","RBL Bank",
      "HSBC","Standard Chartered","AU Small Finance Bank","Federal Bank","IDBI Bank"
    ];

    const norm = (s) => String(s || "").trim();
    const normLower = (s) => norm(s).toLowerCase();

    function normalizeType(t) {
      const x = normLower(t);
      if (!x) return null;
      if (/(^|[^a-z])(cc|credit)([^a-z]|$)/i.test(t) || /credit\s*card/i.test(t)) return "Credit Card";
      if (/debit/i.test(t)) return "Debit Card";
      if (/\bemi\b/i.test(t)) return "EMI";
      if (/net\s*bank/i.test(t) || /netbank/i.test(t)) return "NetBanking";
      if (/wallet/i.test(t)) return "Wallet";
      if (/\bupi\b/i.test(t)) return "UPI";
      return null;
    }

    function banksFromText(text) {
      const res = new Set();
      const t = norm(text);
      if (!t) return res;
      KNOWN_BANKS.forEach((b) => {
        const rx = new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
        if (rx.test(t)) res.add(b);
      });
      if (res.has("SBI") && !res.has("State Bank of India")) {
        res.delete("SBI");
        res.add("State Bank of India");
      }
      return res;
    }

    const options = Object.fromEntries(TYPES.map((t) => [t, new Set()]));

    for await (const doc of cursor) {
      const pm = Array.isArray(doc.paymentMethods) ? doc.paymentMethods : [];

      // Structured entries
      for (const entry of pm) {
        if (typeof entry === "string") {
          const bankHit = [...banksFromText(entry)];
          const typeHit = normalizeType(entry);
          if (typeHit && bankHit.length) bankHit.forEach((b) => options[typeHit].add(b));
          continue;
        }

        const bank =
          norm(entry.bank) ||
          norm(entry.cardBank) ||
          norm(entry.issuer) ||
          norm(entry.cardIssuer) ||
          norm(entry.provider) ||
          "";

        const type =
          normalizeType(entry.type) ||
          normalizeType(entry.method) ||
          normalizeType(entry.category) ||
          normalizeType(entry.mode) ||
          null;

        if (type && bank) options[type].add(bank);
        // If an offer is EMI, it can also be considered a credit-card bank
        if (type === "EMI" && bank) options["Credit Card"].add(bank);
      }

      // Fallback from title/rawDiscount
      if (!pm?.length) {
        const banks = new Set([
          ...banksFromText(doc.title),
          ...banksFromText(doc.rawDiscount),
        ]);
        const text = `${doc.title || ""} ${doc.rawDiscount || ""}`;

        const hits = new Set();
        const rxMap = {
          "Credit Card": /(credit|cc)/i,
          "Debit Card": /debit/i,
          "EMI": /\bemi\b/i,
          "NetBanking": /net\s*bank|netbank/i,
          "Wallet": /wallet/i,
          "UPI": /\bupi\b/i,
        };
        Object.entries(rxMap).forEach(([k, rx]) => { if (rx.test(text)) hits.add(k); });
        if (hits.has("EMI")) hits.add("Credit Card");

        if (banks.size && hits.size) {
          for (const t of hits) banks.forEach((b) => options[t].add(b));
        }
      }
    }

    const out = {};
    TYPES.forEach((t) => { out[t] = Array.from(options[t]).sort((a,b)=>a.localeCompare(b)); });
    res.json({ options: out });
  } catch (e) {
    console.error("X /payment-options error:", e);
    res.status(500).json({ options: {} });
  }
});

// Returns unique, cleaned payment method labels (legacy simple list)
app.get("/payment-methods", async (req, res) => {
  try {
    const collection = (await initMongo()).collection("offers");

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
      {
        couponCode: { $exists: true, $ne: "" },
        isExpired: { $ne: true },
        $or: activeValidityOr,
        "sourceMetadata.sourcePortal": { $in: PORTALS },
      },
      { projection: { paymentMethods: 1, title: 1, rawDiscount: 1 } }
    );

    const set = new Map(); // canonical -> original
    for await (const doc of cursor) {
      const label = extractPaymentMethodLabel(doc);
      const canon = label.toLowerCase().replace(/\s+/g, " ").trim();
      if (canon && !set.has(canon)) set.set(canon, label);
    }

    const methods = Array.from(set.values()).sort((a, b) => a.localeCompare(b));
    methods.push("Other");
    res.json({ methods });
  } catch (e) {
    console.error("X /payment-methods error:", e.message);
    res.status(500).json({ methods: [] });
  }
});

// Main search endpoint used by the frontend
app.post("/search", async (req, res) => {
  try {
    const {
      from, to,
      departureDate, returnDate,
      passengers = 1,
      travelClass = "ECONOMY",
      tripType = "round-trip",
      paymentMethods = [],
    } = req.body || {};

    const depISO = toISODateStr(departureDate);
    const retISO = toISODateStr(returnDate);

    if (!from || !to || !depISO) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const selectedPayments = normalizeUserPaymentChoices(paymentMethods);

    // Load coupon offers once (by portal)
    const offersByPortal = await loadActiveCouponOffersByPortal({
      travelISO: depISO,
    });

    // Fetch Amadeus outward flights
    const outbound = await fetchAmadeusOffers({
      from, to, date: depISO, adults: passengers, travelClass,
    });

    // If round-trip, also fetch return flights
    let retFlights = [];
    if (tripType === "round-trip" && retISO) {
      retFlights = await fetchAmadeusOffers({
        from: to, to: from, date: retISO, adults: passengers, travelClass,
      });
    }

    // Build portalPrices for each flight
    function decorateWithPortalPrices(flight, travelISO) {
      const base = asMoney(flight.price) || 0;
      const prices = PORTALS.map((portal) => {
        const portalOffers = offersByPortal.get(portal) || [];
        const best = applyBestOfferForPortal({
          basePrice: base,
          portal,
          offers: portalOffers,
          travelISO,
          selectedPayments,
        });
        return {
          portal,
          basePrice: base,
          finalPrice: best.finalPrice,
          ...(best.discountApplied > 0 ? { discountApplied: best.discountApplied } : {}),
          appliedOffer: best.appliedOffer, // may be null
        };
      });
      return { ...flight, portalPrices: prices };
    }

    const outboundDecorated = outbound.map((f) =>
      decorateWithPortalPrices(f, depISO)
    );
    const returnDecorated = retFlights.map((f) =>
      decorateWithPortalPrices(f, retISO || depISO)
    );

    res.json({
      outboundFlights: outboundDecorated,
      returnFlights: returnDecorated,
    });
  } catch (err) {
    console.error("X /search error:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// -------------------- START ------------------------
app.listen(PORT, async () => {
  try {
    await initMongo();
  } catch (e) {
    console.error("Mongo init failed:", e.message);
  }
  console.log(`🚀 SkyDeal backend listening on :${PORT}`);
});
