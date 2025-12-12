// index.js — SkyDeal backend (Express, ESM, real FlightAPI + Mongo offers)
// RUN: node index.js

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 10000;

// ---------- CORS (explicit & permissive, incl. OPTIONS) ----------
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type"] }));
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ---------- constants ----------
const CURRENCY = "INR";
const REGION   = "IN";
const OTAS     = ["MakeMyTrip", "Goibibo", "EaseMyTrip", "Yatra", "Cleartrip"];
const MARKUP   = 100; // per-OTA markup you asked to keep for the price table

// ---------- utils ----------
const money    = (n) => Math.max(0, Math.round(Number(n || 0)));
const todayISO = () => new Date().toISOString().slice(0, 10);
const norm     = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");

// ---------- Mongo (offers) ----------
const MONGO_URI = process.env.MONGO_URI;          // e.g. mongodb://user:pass@host:27017
const MONGO_DB  = process.env.MONGO_DB  || "skydeal";
const MONGO_COL = process.env.MONGO_COL || "offers";

let mongoClient;
let offersCol;

/** connect once (lazy) */
async function ensureMongo() {
  if (offersCol) return;
  if (!MONGO_URI) throw new Error("MONGO_URI missing");
  mongoClient = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await mongoClient.connect();
  offersCol = mongoClient.db(MONGO_DB).collection(MONGO_COL);
}

/**
 * Load all *active* flight offers we care about.
 * Expected schema (compatible with your 18+ field design):
 *  - sourcePortal: "MakeMyTrip" | "Goibibo" | ...
 *  - paymentMethods: [{ type: "Credit Card"|"Debit Card"|"Net Banking"|"UPI"|"Wallet"|"EMI", bank: "HDFC Bank"|... }]
 *  - discountPercent?: number
 *  - flatAmount?: number
 *  - maxDiscountAmount?: number
 *  - minTransactionValue?: number
 *  - couponCode?: string
 *  - isExpired?: boolean
 */
async function fetchActiveOffers() {
  await ensureMongo();
  // Basic filters; tweak if you store platform/type fields
  const q = { isExpired: { $ne: true }, sourcePortal: { $in: OTAS } };
  const docs = await offersCol.find(q, { projection: { _id: 0 } }).toArray();
  return docs.map((o) => ({
    portal: o.sourcePortal,
    paymentMethods: Array.isArray(o.paymentMethods) ? o.paymentMethods : [],
    discountPercent: Number(o.discountPercent || 0),
    flatAmount: Number(o.flatAmount || 0),
    maxDiscountAmount: Number(o.maxDiscountAmount || 0),
    minTransactionValue: Number(o.minTransactionValue || 0),
    couponCode: o.couponCode || "",
    title: o.title || "",
  }));
}

/** build payment catalog from offers (types → banks) */
async function computePaymentCatalogFromOffers() {
  const offers = await fetchActiveOffers();
  const map = {}; // { "Credit Card": Set(["HDFC Bank", ...]) }
  for (const o of offers) {
    for (const pm of o.paymentMethods) {
      const type = pm?.type?.trim();
      const bank = pm?.bank?.trim();
      if (!type || !bank) continue;
      map[type] ??= new Set();
      map[type].add(bank);
    }
  }
  // convert Set → Array and sort
  const out = {};
  for (const [type, set] of Object.entries(map)) {
    out[type] = Array.from(set).sort();
  }
  return out;
}

// ---------- Offer application ----------
/**
 * Apply offers for a flight base price for each OTA,
 * using the user's selected payment types & banks.
 */
function applyOffersToPortals(basePrice, allOffers, selectedTypes, selectedBanks) {
  const base = money(basePrice);

  // default rows (no offer applied)
  const rows = OTAS.map((portal) => ({
    portal,
    basePrice: base,
    finalPrice: base + MARKUP,
    source: "carrier+markup",
    _why: "",
  }));

  // Filter offers by selection
  const selTypeSet  = new Set((selectedTypes || []).map((x) => x?.trim()));
  const selBankSet  = new Set((selectedBanks || []).map((x) => x?.trim()));
  const applicable  = allOffers.filter((o) => {
    if (!selTypeSet.size && !selBankSet.size) return false;
    if (!OTAS.includes(o.portal)) return false;
    if (o.minTransactionValue && base < o.minTransactionValue) return false;

    // At least one payment method matches (type+bank)
    return o.paymentMethods?.some((pm) => {
      const typeOk = selTypeSet.has(pm?.type?.trim());
      const bankOk = selBankSet.has(pm?.bank?.trim());
      // require both: the UI selects a bank under a type tab
      return typeOk && bankOk;
    });
  });

  // For each portal, pick best discount among applicable offers for that portal
  for (const row of rows) {
    const os = applicable.filter((o) => o.portal === row.portal);
    let best = null;
    let bestFinal = row.finalPrice;

    for (const o of os) {
      let discount = 0;
      if (o.discountPercent > 0) {
        discount = Math.round((o.discountPercent / 100) * base);
        if (o.maxDiscountAmount > 0) discount = Math.min(discount, o.maxDiscountAmount);
      } else if (o.flatAmount > 0) {
        discount = o.flatAmount;
      }
      const candidateFinal = Math.max(0, base + MARKUP - money(discount));
      if (candidateFinal < bestFinal) {
        bestFinal = candidateFinal;
        best = o;
      }
    }

    if (best) {
      row.finalPrice = bestFinal;
      row.source = "carrier+offer+markup";
      const label = best.title || (best.discountPercent ? `${best.discountPercent}% off` : `₹${best.flatAmount} off`);
      row._why   = best.couponCode ? `${label} (code ${best.couponCode})` : label;
    }
  }

  // best deal
  let bestRow = rows[0];
  for (const r of rows) if (r.finalPrice < bestRow.finalPrice) bestRow = r;

  return {
    portalPrices: rows.map(({ portal, finalPrice, source }) => ({ portal, finalPrice, source })),
    bestDeal: { portal: bestRow.portal, finalPrice: bestRow.finalPrice, note: bestRow._why || "Best price after applicable offers (if any)" }
  };
}

// ---------- Flights (FlightAPI.io) ----------
async function fetchFlightsReal({ from, to, departureDate, returnDate, adults = 1, cabin = "economy", roundTrip = false }) {
  const KEY = process.env.FLIGHTAPI_KEY;
  if (!KEY) throw new Error("FLIGHTAPI_KEY missing");

  const url = roundTrip
    ? `https://api.flightapi.io/roundtrip/${KEY}/${from}/${to}/${departureDate}/${returnDate || departureDate}/${adults}/0/0/${cabin}/${CURRENCY}?region=${REGION}`
    : `https://api.flightapi.io/onewaytrip/${KEY}/${from}/${to}/${departureDate}/${adults}/0/0/${cabin}/${CURRENCY}?region=${REGION}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);

  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    const status = resp.status;
    const data = await resp.json().catch(() => null);
    if (status !== 200 || !data) {
      return { itemsOut: [], itemsRet: [], meta: { used: "flightapi", outStatus: status } };
    }

    // The API shape varies; keep parsing very defensive.
    const carriersById = {};
    for (const c of data.carriers || []) carriersById[String(c.id)] = c.name;

    const segmentsById = {};
    for (const s of data.segments || []) segmentsById[String(s.id)] = s;

    const legsById = {};
    for (const l of data.legs || []) legsById[String(l.id)] = l;

    const items = (data.itineraries || []).map((it, i) => {
      // take the first leg’s first segment to infer carrier & times
      const legId = (it.leg_ids && it.leg_ids[0]) || null;
      const leg   = legsById[String(legId)] || {};
      const segId = (leg.segment_ids && leg.segment_ids[0]) || null;
      const seg   = segmentsById[String(segId)] || {};

      const carrier = carriersById[String(seg.marketing_carrier_id)] || "Unknown";
      const dep     = leg.departure_time || "";
      const arr     = leg.arrival_time   || "";
      const stops   = Math.max(0, (leg.stop_count ?? 0));

      // price field name varies; try price or it.price || it.pricing?.total
      const baseRaw = it.price ?? it.pricing?.total ?? it.price_total ?? it.min_price ?? 0;

      return {
        id: `I${i+1}`,
        airlineName: carrier,
        flightNumber: seg.marketing_carrier_code ? `${seg.marketing_carrier_code} ${seg.flight_number || ""}`.trim() : (seg.flight_number || `F${i+1}`),
        departure: dep ? dep.slice(11,16) : "",
        arrival:   arr ? arr.slice(11,16) : "",
        basePrice: money(baseRaw),
        stops
      };
    });

    // 25 results, sorted by *base* price (we’ll compute offer-applied price per flight later)
    const itemsSorted = items.sort((a, b) => a.basePrice - b.basePrice).slice(0, 25);

    // For round-trip, we don’t have separate “return itineraries” from this endpoint,
    // so reuse the same list for return (each card shows its own prices anyway).
    return {
      itemsOut: itemsSorted,
      itemsRet: itemsSorted,
      meta: { used: "flightapi", outStatus: status }
    };
  } finally {
    clearTimeout(t);
  }
}

// ---------- ROUTES ----------
app.get("/payment-options", async (_req, res) => {
  try {
    const catalog = await computePaymentCatalogFromOffers();
    return res.json({ usedFallback: false, options: catalog });
  } catch (e) {
    console.error("[/payment-options] error:", e.message);
    // Never fail the page on payments modal
    return res.json({ usedFallback: true, options: {} });
  }
});

/**
 * Body:
 * {
 *   from, to, departureDate, returnDate, tripType: "one-way"|"round-trip",
 *   passengers, travelClass,
 *   paymentTypes: ["Credit Card", ...],
 *   banks: ["HDFC Bank", ...]
 * }
 */
app.post("/search", async (req, res) => {
  const {
    from = "BOM",
    to = "DEL",
    departureDate = todayISO(),
    returnDate = "",
    tripType = "one-way",
    passengers = 1,
    travelClass = "economy",
    paymentTypes = [],
    banks = []
  } = req.body || {};

  console.log("[SkyDeal] search request:", {
    from, to, departureDate, returnDate, passengers, travelClass, tripType,
    paymentTypesCount: Array.isArray(paymentTypes) ? paymentTypes.length : 0,
    banksCount: Array.isArray(banks) ? banks.length : 0
  });

  // 1) real flights
  const roundTrip = tripType === "round-trip";
  const flights = await fetchFlightsReal({
    from, to, departureDate, returnDate, adults: passengers, cabin: travelClass, roundTrip
  });

  // 2) real offers
  const offers = await fetchActiveOffers();

  // 3) decorate with offers (and sort again by final price ascending)
  const decorate = (f) => {
    const applied = applyOffersToPortals(f.basePrice, offers, paymentTypes, banks);
    return { ...f, ...applied };
  };

  const outboundFlights = flights.itemsOut.map(decorate).sort((a, b) => a.bestDeal.finalPrice - b.bestDeal.finalPrice);
  const returnFlights   = roundTrip ? flights.itemsRet.map(decorate).sort((a, b) => a.bestDeal.finalPrice - b.bestDeal.finalPrice) : [];

  return res.json({
    meta: {
      source: flights.meta.used,
      outStatus: flights.meta.outStatus,
      outCount: outboundFlights.length,
      retCount: returnFlights.length
    },
    outboundFlights,
    returnFlights
  });
});

app.get("/", (_req, res) => res.send("SkyDeal backend OK"));

app.listen(PORT, () => console.log(`SkyDeal backend listening on ${PORT}`));
