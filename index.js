// index.js — SkyDeal backend (FlightAPI-only, ESM)

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { MongoClient, ServerApiVersion } from "mongodb";

dotenv.config();

console.log("🔧 SkyDeal FLIGHTAPI-ONLY backend starting…");

const app = express();

/* ===== CORS ===== */
app.use((req, res, next) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(cors({ origin: true }));
app.use(express.json());

/* ===== Health ===== */
app.get("/health", (_req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

/* ===== CONFIG ===== */
const PORT = Number(process.env.PORT || 10000);

const MONGODB_URI = process.env.MONGODB_URI || "";
const MONGODB_DB = process.env.MONGODB_DB || "skydeal";

const FLIGHTAPI_KEY = process.env.FLIGHTAPI_KEY || ""; // << must be set on Render
const FLIGHTAPI_BASE = (process.env.FLIGHTAPI_BASE || "https://api.flightapi.io").replace(/\/+$/, "");

const PORTALS = ["MakeMyTrip", "Goibibo", "EaseMyTrip", "Yatra", "Cleartrip"];
const PRICE_MARKUP = 250; // flat display markup (₹)

/* ===== Mongo (for offers) ===== */
let mongoClient;
let db;
async function initMongo() {
  if (db) return db;
  if (!MONGODB_URI) {
    console.warn("⚠️  MONGODB_URI not set; offers will be empty.");
    return null;
  }
  mongoClient = new MongoClient(MONGODB_URI, { serverApi: ServerApiVersion.v1 });
  await mongoClient.connect();
  db = mongoClient.db(MONGODB_DB);
  console.log("✅ Mongo connected:", MONGODB_DB);
  return db;
}

/* ===== Utils ===== */
const asMoney = (x) => {
  if (x == null) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};
const toISO = (d) => {
  if (!d) return null;
  const s = String(d).trim();
  const m1 = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m1) {
    const [, dd, mm, yyyy] = m1;
    return `${yyyy}-${mm}-${dd}`;
  }
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m2) return s;
  const dt = new Date(s);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
};
const titleCase = (s) =>
  String(s || "").replace(/\s+/g, " ").trim().toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/* ===== Offers helpers ===== */
function isOfferActiveForDate(offer, travelISO) {
  if (offer?.isExpired === true) return false;
  const end =
    offer?.validityPeriod?.end ??
    offer?.validityPeriod?.to ??
    offer?.validityPeriod?.endDate ??
    offer?.validityPeriod?.till ??
    offer?.validityPeriod?.until ??
    null;
  if (!end) return true;
  const endISO = toISO(end);
  if (!endISO) return true;
  return travelISO <= endISO;
}

async function loadActiveCouponOffersByPortal({ travelISO }) {
  const database = await initMongo();
  const byPortal = new Map(PORTALS.map((p) => [p, []]));
  if (!database) return byPortal;

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

  for await (const doc of cursor) {
    const portal = doc?.sourceMetadata?.sourcePortal;
    if (byPortal.has(portal)) byPortal.get(portal).push(doc);
  }
  return byPortal;
}

function applyBestOfferForPortal({ basePrice, portal, offers, travelISO }) {
  let best = { finalPrice: basePrice, discountApplied: 0, appliedOffer: null };
  for (const offer of offers) {
    if (!offer.couponCode) continue;
    if (!isOfferActiveForDate(offer, travelISO)) continue;

    const pct = offer.discountPercent != null ? Number(offer.discountPercent) : null;
    const cap = asMoney(offer.maxDiscountAmount);
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
          minTransactionValue: asMoney(offer.minTransactionValue) ?? null,
          validityPeriod: offer.validityPeriod || null,
          rawDiscount: offer.rawDiscount || null,
          title: offer.title || null,
          offerId: String(offer._id),
          paymentMethodLabel:
            (Array.isArray(offer.paymentMethods) && offer.paymentMethods[0]) ? titleCase(String(offer.paymentMethods[0]?.bank || offer.paymentMethods[0])) : "—",
        },
      };
    }
  }
  return best;
}

/* ===== FlightAPI client ===== */
// Maps the provider’s object into our UI item
function normalizeFlightApiItems(json) {
  const data = Array.isArray(json?.itineraries) ? json.itineraries : [];
  const out = [];

  for (const it of data) {
    const legs =
      (Array.isArray(it?.legs) && it.legs) ||
      (Array.isArray(it?.segments) && it.segments) ||
      (Array.isArray(it?.routes) && it.routes) ||
      (Array.isArray(it?.route) && it.route) ||
      [];

    const first = legs[0] || it;
    const last = legs[legs.length - 1] || first;

    const airlineName =
      first?.carrier?.name ??
      first?.marketingCarrier?.name ??
      first?.airlineName ??
      it?.carrierName ??
      "Airline";

    const carrierCode =
      first?.carrier?.code ??
      first?.marketingCarrier?.code ??
      first?.carrierCode ??
      it?.carrierCode ??
      "";

    const number =
      first?.number ??
      first?.flightNumber ??
      it?.flightNumber ??
      "";

    const depISO =
      first?.departureTime ??
      first?.departure_at ??
      first?.local_departure ??
      first?.departure ??
      null;

    const arrISO =
      last?.arrivalTime ??
      last?.arrival_at ??
      last?.local_arrival ??
      last?.arrival ??
      null;

    const hhmm = (v) =>
      v ? (/\d{2}:\d{2}/.test(v) ? v.slice(0, 5) : new Date(v).toTimeString().slice(0, 5)) : "--:--";

    const rawPrice =
      it?.price?.grandTotal ??
      it?.price?.total ??
      it?.price?.amount ??
      it?.pricing_options?.price ??
      it?.totalFare ??
      it?.fare ??
      it?.total ??
      0;

    const priceNum = Number(String(rawPrice).replace(/[^\d.]/g, "")) || 0;
    const stops = Math.max(0, legs.length - 1);

    out.push({
      airlineName: String(airlineName),
      flightNumber: `${carrierCode || ""} ${number || ""}`.trim(),
      departure: hhmm(depISO),
      arrival: hhmm(arrISO),
      price: priceNum.toFixed(2),
      stops,
      carrierCode: String(carrierCode || ""),
      stopCodes: [], // placeholder if you later decide to show via codes
    });
  }

  return out;
}

async function fetchFlightApiOffers({ from, to, date, adults = 1, cabin = "economy", currency = "INR" }) {
  if (!FLIGHTAPI_KEY) throw new Error("FLIGHTAPI_KEY not set");

  const url = `${FLIGHTAPI_BASE}/onewaytrip/${encodeURIComponent(FLIGHTAPI_KEY)}/${encodeURIComponent(from)}/${encodeURIComponent(to)}/${encodeURIComponent(date)}/${encodeURIComponent(adults)}/0/0/${encodeURIComponent(cabin)}/${encodeURIComponent(currency)}`;

  // === DEBUG ADDITION (masked key) ===
  const masked = url.replace(FLIGHTAPI_KEY, FLIGHTAPI_KEY.slice(0, 6) + "…");
  console.log("FlightAPI URL =>", masked);

  const r = await fetch(url);
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`FlightAPI search error: ${r.status} ${text || ""}`.trim());
  }
  return r.json();
}

/* ===== Debug probe (NEW) ===== */
app.post("/flightapi/probe", async (req, res) => {
  try {
    const { from, to, date, adults = 1, cabin = "economy", currency = "INR" } = req.body || {};
    if (!from || !to || !date) return res.status(400).json({ error: "from,to,date required" });

    const url = `${FLIGHTAPI_BASE}/onewaytrip/${encodeURIComponent(FLIGHTAPI_KEY)}/${encodeURIComponent(from)}/${encodeURIComponent(to)}/${encodeURIComponent(date)}/${encodeURIComponent(adults)}/0/0/${encodeURIComponent(cabin)}/${encodeURIComponent(currency)}`;
    const masked = url.replace(FLIGHTAPI_KEY, FLIGHTAPI_KEY.slice(0, 6) + "…");

    const r = await fetch(url);
    const body = await r.text();
    res.json({ url: masked, status: r.status, body: body.slice(0, 4000) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/* ===== Main search (FlightAPI + offers decoration) ===== */
app.post("/search", async (req, res) => {
  try {
    const {
      from,
      to,
      departureDate,
      tripType = "one-way",
      returnDate,
      passengers = 1,
      travelClass = "ECONOMY",
    } = req.body || {};

    const depISO = toISO(departureDate);
    const retISO = toISO(returnDate);

    const missing = [];
    if (!from) missing.push("from");
    if (!to) missing.push("to");
    if (!depISO) missing.push("departureDate (invalid)");
    if (missing.length) return res.status(400).json({ error: "Missing", missing });

    const ORG = String(from).trim().toUpperCase();
    const DST = String(to).trim().toUpperCase();
    const cabin = String(travelClass || "ECONOMY").toLowerCase();

    // Fetch outbound
    const rawOut = await fetchFlightApiOffers({
      from: ORG,
      to: DST,
      date: depISO,
      adults: passengers,
      cabin,
      currency: "INR",
    });
    const outbound = normalizeFlightApiItems(rawOut);

    // Fetch return (if round-trip)
    let retFlights = [];
    if (tripType === "round-trip" && retISO) {
      const rawRet = await fetchFlightApiOffers({
        from: DST,
        to: ORG,
        date: retISO,
        adults: passengers,
        cabin,
        currency: "INR",
      });
      retFlights = normalizeFlightApiItems(rawRet);
    }

    // Offers
    const offersByPortal = await loadActiveCouponOffersByPortal({ travelISO: depISO });

    function decorate(flight, travelISO) {
      const base = asMoney(flight.price) || 0;
      const prices = PORTALS.map((portal) => {
        const portalOffers = offersByPortal.get(portal) || [];
        const best = applyBestOfferForPortal({
          basePrice: base,
          portal,
          offers: portalOffers,
          travelISO,
        });
        return {
          portal,
          basePrice: base,
          markedUpPrice: base + PRICE_MARKUP,
          finalPrice: best.finalPrice,
          ...(best.discountApplied > 0 ? { discountApplied: best.discountApplied } : {}),
          appliedOffer: best.appliedOffer,
        };
      });
      return { ...flight, portalPrices: prices };
    }

    const outboundDecorated = outbound.map((f) => decorate(f, depISO));
    const returnDecorated = retFlights.map((f) => decorate(f, retISO || depISO));

    res.json({
      outboundFlights: outboundDecorated,
      returnFlights: returnDecorated,
      meta: { source: "flightapi" },
    });
  } catch (err) {
    console.error("X /search error:", err.message);
    res.status(502).json({ error: "flightapi_failed", message: err.message });
  }
});

/* ===== Payment options (stub via DB if present) ===== */
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
      { projection: { paymentMethods: 1 }, limit: 4000 }
    );

    const sets = {
      "Credit Card": new Set(),
      "Debit Card": new Set(),
      EMI: new Set(),
      NetBanking: new Set(),
      Wallet: new Set(),
      UPI: new Set(),
    };

    for await (const doc of cursor) {
      const arr = Array.isArray(doc.paymentMethods) ? doc.paymentMethods : [];
      for (const p of arr) {
        const s = typeof p === "string" ? p : p?.bank || "";
        if (!s) continue;
        const bank = titleCase(String(s).replace(/\b(bank|card|cards)\b/gi, "").trim());
        if (!bank) continue;
        // naive bucketing (good enough for listing)
        if (/emi/i.test(String(p))) sets.EMI.add(`${bank} (Credit Card EMI)`);
        else if (/debit/i.test(String(p))) sets["Debit Card"].add(bank);
        else if (/net\s*bank/i.test(String(p))) sets.NetBanking.add(bank);
        else if (/wallet/i.test(String(p))) sets.Wallet.add(bank);
        else if (/\bupi\b/i.test(String(p))) sets.UPI.add(bank);
        else sets["Credit Card"].add(bank);
      }
    }

    const out = {};
    Object.keys(sets).forEach((k) => (out[k] = Array.from(sets[k]).sort((a, b) => a.localeCompare(b))));
    res.json({ options: out });
  } catch (e) {
    console.error("X /payment-options error:", e);
    res.status(500).json({ options: {} });
  }
});

/* ===== Optional route lister (handy locally) ===== */
app.get("/__routes", (_req, res) => {
  const routes = [];
  app._router?.stack?.forEach((m) => {
    if (m.route?.path) routes.push(`${Object.keys(m.route.methods).join(",").toUpperCase()} ${m.route.path}`);
  });
  res.type("text/plain").send(routes.sort().join("\n"));
});

/* ===== Start server ===== */
app.listen(PORT, async () => {
  try {
    await initMongo();
  } catch (e) {
    console.error("Mongo init failed:", e.message);
  }
  console.log(`🚀 SkyDeal backend (FlightAPI) listening on :${PORT}`);
});
