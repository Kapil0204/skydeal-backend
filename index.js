// index.js — SkyDeal backend (Express, ESM)
// RUN: node index.js

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// ---------- CORS ----------
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));
app.use(express.json());

// ---------- ENV ----------
const FLIGHTAPI_KEY = process.env.FLIGHTAPI_KEY;
const MONGO_URI     = process.env.MONGO_URI || process.env.MONGODB_URI; // support either name
const MONGODB_DB    = process.env.MONGODB_DB || "skydeal";
const MONGO_COL     = process.env.MONGO_COL || "offers";

// ---------- CONSTANTS ----------
const CURRENCY = "INR";
const REGION   = "IN";
const OTAS     = ["MakeMyTrip", "Goibibo", "EaseMyTrip", "Yatra", "Cleartrip"];

// ---------- MONGO ----------
let mongoClient;
let offersCol;

async function ensureMongo() {
  if (offersCol) return;
  if (!MONGO_URI) throw new Error("MONGO_URI missing");
  mongoClient = new MongoClient(MONGO_URI, { maxPoolSize: 5 });
  await mongoClient.connect();
  const db = mongoClient.db(MONGODB_DB);
  offersCol = db.collection(MONGO_COL);
}

// ---------- PAYMENT METHOD NORMALIZATION ----------
function normalizePaymentMethod(raw) {
  if (!raw) return null;
  const v = String(raw).toLowerCase().replace(/[_-]/g, " ").trim();
  if (v.includes("credit")) return "Credit Card";
  if (v.includes("debit")) return "Debit Card";
  if (v.includes("net") || v.includes("internet")) return "Net Banking";
  if (v.includes("upi")) return "UPI";
  if (v.includes("wallet")) return "Wallet";
  return null; // ignore things like "any", "online", "bank offer", etc.
}

const CANON_METHODS = ["Credit Card", "Debit Card", "Net Banking", "UPI", "Wallet"];

// ---------- FETCH ACTIVE OFFERS FROM MONGO ----------
async function fetchActiveOffers() {
  await ensureMongo();

  // Flexible match for active offers. Adjust if you store expiry flags differently.
  const now = new Date();
  const q = {
    $and: [
      { isExpired: { $in: [false, null] } },
      {
        $or: [
          { validityPeriod: { $exists: false } },
          { "validityPeriod.parsedEnd": { $exists: false } },
          { "validityPeriod.parsedEnd": { $gte: now } }
        ]
      }
    ]
  };

  // Only fetch the fields we actually use
  const proj = {
    title: 1,
    portal: 1,
    code: 1,
    paymentMethods: 1,    // may be strings or structured objects
    bank: 1,              // some docs keep a single bank field
    banks: 1,             // some docs keep array
    rawDiscount: 1,
    discountPercent: 1,
    maxDiscountAmount: 1,
    minTransactionValue: 1,
    flatDiscountAmount: 1
  };

  const docs = await offersCol.find(q, { projection: proj }).toArray();

  // Normalise into a unified offer object list
  const normalised = [];
  for (const d of docs) {
    // Figure out bank(s)
    const bankSet = new Set();
    if (Array.isArray(d.banks)) d.banks.forEach(b => b && bankSet.add(String(b).trim()));
    if (d.bank) bankSet.add(String(d.bank).trim());

    // Figure out methods (strings or objects)
    const rawPM = Array.isArray(d.paymentMethods) ? d.paymentMethods : [];
    const methodSet = new Set();
    for (const pm of rawPM) {
      if (!pm) continue;
      if (typeof pm === "string") {
        const m = normalizePaymentMethod(pm);
        if (m) methodSet.add(m);
      } else if (typeof pm === "object") {
        const m = normalizePaymentMethod(pm.type || pm.method || pm.name);
        if (m) methodSet.add(m);
      }
    }

    // If no method is derivable, skip
    if (methodSet.size === 0) continue;

    // Discount parsing
    // Prefer explicit fields; fall back to readable raw fields
    const percent = Number(d.discountPercent || 0);             // 10 means 10%
    const flat    = Number(d.flatDiscountAmount || 0);
    const maxAmt  = Number(d.maxDiscountAmount || 0);           // optional cap for percent
    const minTx   = Number(d.minTransactionValue || 0);

    normalised.push({
      portal: d.portal && String(d.portal).trim(),
      code: d.code && String(d.code).trim(),
      banks: [...bankSet],
      methods: [...methodSet],        // Canonical five values only
      percent,
      flat,
      maxAmt,
      minTx,
      label: d.title || d.rawDiscount || d.code || "Offer"
    });
  }
  return normalised;
}

// ---------- COLLAPSE PAYMENT METHODS FOR MODAL ----------
function collapsePaymentsForModal(offers) {
  const buckets = {
    "Credit Card": new Set(),
    "Debit Card": new Set(),
    "Net Banking": new Set(),
    "UPI": new Set(),
    "Wallet": new Set()
  };

  for (const o of offers) {
    for (const m of o.methods) {
      if (!CANON_METHODS.includes(m)) continue;
      // push each bank, or if none present try to attach a generic label
      if (o.banks.length) {
        for (const b of o.banks) buckets[m].add(b);
      } else {
        // Some offers say "Any bank" — we can't enumerate, so skip adding banks
      }
    }
  }

  return {
    "Credit Card": [...buckets["Credit Card"]].sort(),
    "Debit Card": [...buckets["Debit Card"]].sort(),
    "Net Banking": [...buckets["Net Banking"]].sort(),
    "UPI": [...buckets["UPI"]].sort(),
    "Wallet": [...buckets["Wallet"]].sort()
  };
}

// ---------- FLIGHTAPI ----------
function money(n) {
  return Math.max(0, Math.round(Number(n || 0)));
}

async function fetchFlightsReal({ from, to, departureDate, returnDate, adults = 1, cabin = "economy", wantReturn }) {
  if (!FLIGHTAPI_KEY) throw new Error("FLIGHTAPI_KEY missing");

  // FlightAPI roundtrip endpoint returns combined itineraries; to keep UX simple
  // we call it once and split to outbound/return by duplicating the set
  const url = `https://api.flightapi.io/roundtrip/${FLIGHTAPI_KEY}/${from}/${to}/${departureDate}/${returnDate || departureDate}/${adults}/0/0/${cabin}/${CURRENCY}?region=${REGION}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);

  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    const status = resp.status;
    const json = await resp.json().catch(() => ({}));

    if (status !== 200 || !json || !Array.isArray(json.itineraries)) {
      return { items: [], meta: { used: "flightapi", outStatus: status || 500 } };
    }

    // Build maps for quick lookup
    const carriers = Object.fromEntries((json.carriers || []).map(c => [String(c.id), c.name]));
    const segments = Object.fromEntries((json.segments || []).map(s => [String(s.id), s]));
    const legs     = Object.fromEntries((json.legs || []).map(l => [String(l.id), l]));

    // Convert up to 25 itineraries
    const items = [];
    for (const it of json.itineraries.slice(0, 50)) {
      const legId = it.leg_ids?.[0];
      const leg = legId ? legs[String(legId)] : null;
      const segId = leg?.segment_ids?.[0];
      const seg = segId ? segments[String(segId)] : null;

      const carrierName = carriers[String(seg?.marketing_carrier_id)] || carriers[String(seg?.operating_carrier_id)] || "Unknown";
      const dep = leg?.departure_time?.slice(11, 16) || "00:00";
      const arr = leg?.arrival_time?.slice(11, 16) || "00:00";
      const stops = Math.max(0, (leg?.stop_count ?? 0));

      const price = it?.price || it?.pricing_options?.[0]?.price?.amount || it?.pricing_options?.[0]?.price || 0;

      items.push({
        id: String(it.id || cryptoRandom()),
        airlineName: carrierName,
        flightNumber: seg?.marketing_carrier_flight_number ? `${seg?.marketing_carrier_code || ""} ${seg?.marketing_carrier_flight_number}`.trim() : (seg?.id ? `F${seg.id}` : "NA"),
        departure: dep,
        arrival: arr,
        basePrice: money(price),
        stops
      });

      if (items.length >= 25) break;
    }

    // Sort ascending by price
    items.sort((a,b)=> a.basePrice - b.basePrice);

    // If no items, return empty
    return { items, meta: { used: "flightapi", outStatus: status } };

  } finally {
    clearTimeout(t);
  }
}

function cryptoRandom() {
  return Math.random().toString(36).slice(2);
}

// ---------- APPLY OFFERS ----------
function applyOffersToFlight(baseFare, selectedBanks, offersForAllPortals) {
  // For each portal, choose the single best offer (lowest final price)
  const banksNorm = new Set((selectedBanks || []).map(b => String(b).trim().toLowerCase()));

  const portalRows = OTAS.map(portal => {
    const candidates = offersForAllPortals.filter(o => o.portal && o.portal.toLowerCase() === portal.toLowerCase());

    let best = { finalPrice: baseFare, source: "carrier", _why: "" };

    for (const o of candidates) {
      // Bank match — if offer declares banks, require an intersection; if no banks declared, treat as generic
      const oBanks = (o.banks || []).map(b => String(b).trim().toLowerCase());
      const bankOk = oBanks.length ? oBanks.some(b => banksNorm.has(b)) : banksNorm.size > 0;

      if (!bankOk) continue;

      // Compute discount
      let discount = 0;
      if (o.percent && o.percent > 0) {
        discount = Math.round((o.percent / 100) * baseFare);
        if (o.maxAmt && o.maxAmt > 0) discount = Math.min(discount, o.maxAmt);
      }
      if (o.flat && o.flat > 0) {
        // if both exist, pick the larger discount
        discount = Math.max(discount, o.flat);
      }

      // Respect min transaction
      if (o.minTx && baseFare < o.minTx) continue;

      // Apply discount safely (no magic floors)
      const candidateFinal = Math.max(0, baseFare - discount);

      if (candidateFinal < best.finalPrice) {
        best = {
          finalPrice: candidateFinal,
          source: "carrier+offer",
          _why: `${o.label}${o.code ? ` (code ${o.code})` : ""}`
        };
      }
    }

    return {
      portal,
      basePrice: baseFare,
      finalPrice: best.finalPrice,
      source: best.source,
      _why: best._why || ""
    };
  });

  // Choose best deal among portals
  let best = portalRows[0];
  for (const r of portalRows) if (r.finalPrice < best.finalPrice) best = r;

  return {
    portalPrices: portalRows,
    bestDeal: {
      portal: best.portal,
      finalPrice: best.finalPrice,
      note: best._why || "Best price after applicable offers (if any)"
    }
  };
}

// ---------- ROUTES ----------

// Payment options (from Mongo offers → 5 categories of banks)
app.get("/payment-options", async (_req, res) => {
  try {
    const offers = await fetchActiveOffers();
    const tabs = collapsePaymentsForModal(offers);
    res.json({ usedFallback: false, options: tabs });
  } catch (e) {
    console.error("[/payment-options] error:", e.message);
    // Return empty but valid payload to keep UI stable
    res.status(200).json({ usedFallback: true, options: {
      "Credit Card": [], "Debit Card": [], "Net Banking": [], "UPI": [], "Wallet": []
    }});
  }
});

// Flight search
app.post("/search", async (req, res) => {
  const {
    from = "BOM",
    to   = "DEL",
    departureDate,
    returnDate,
    tripType = "one-way",
    passengers = 1,
    travelClass = "economy",
    paymentMethods = []      // Frontend sends selected BANKS only (array of strings)
  } = req.body || {};

  try {
    const wantReturn = tripType === "round-trip";
    const data = await fetchFlightsReal({
      from, to, departureDate, returnDate: wantReturn ? (returnDate || departureDate) : departureDate,
      adults: passengers, cabin: travelClass, wantReturn
    });

    // Pull all active offers (once) and feed into calculator
    const allOffers = await fetchActiveOffers();

    const decorate = (f) => {
      const calc = applyOffersToFlight(f.basePrice, paymentMethods, allOffers);
      return { ...f, ...calc };
    };

    const outboundFlights = (data.items || []).slice(0, 25).map(decorate);
    const returnFlights   = wantReturn ? (data.items || []).slice(0, 25).map(decorate) : [];

    res.json({
      meta: {
        source: data.meta?.used || "flightapi",
        outStatus: data.meta?.outStatus || 200,
        outCount: outboundFlights.length,
        retCount: returnFlights.length,
        offerDebug: { offersLoaded: allOffers.length }
      },
      outboundFlights,
      returnFlights
    });
  } catch (e) {
    console.error("[/search] error:", e.message);
    res.status(500).json({ error: "search-failed" });
  }
});

app.get("/", (_req, res) => res.send("SkyDeal backend OK"));

app.listen(PORT, () => {
  console.log(`SkyDeal backend listening on ${PORT}`);
});
