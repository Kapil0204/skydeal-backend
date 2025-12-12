// index.js — SkyDeal backend (Express, ESM, real Mongo + FlightAPI)
// RUN: node index.js

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({
  origin: "*",
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));
app.use(express.json());

// ---- ENV ----
const MONGO_URI  = process.env.MONGO_URI;           // e.g. mongodb://user:pass@13.233.155.88:27017/skyde...
const MONGODB_DB = process.env.MONGODB_DB || "skydeal";
const MONGO_COL  = process.env.MONGO_COL  || "offers";

const FLIGHTAPI_KEY = process.env.FLIGHTAPI_KEY;
const CURRENCY = "INR";
const REGION   = "IN";
const MARKUP   = 100; // OTA markup to show each portal’s price base+markup (before offer)
const OTAS     = ["MakeMyTrip","Goibibo","EaseMyTrip","Yatra","Cleartrip"];

if (!FLIGHTAPI_KEY) {
  console.warn("[boot] FLIGHTAPI_KEY missing - /search will return 200 with 0 flights");
}

let mongoClient;
let offersCol;

// connect to Mongo **on demand**, keep one client
async function ensureMongo() {
  if (!MONGO_URI) throw new Error("MONGO_URI missing");
  if (offersCol) return offersCol;
  mongoClient = new MongoClient(MONGO_URI, { maxPoolSize: 5 });
  await mongoClient.connect();
  const db = mongoClient.db(MONGODB_DB);
  offersCol = db.collection(MONGO_COL);
  console.log(`[mongo] connected. db=${MONGODB_DB} col=${MONGO_COL}`);
  return offersCol;
}

// ---------- Utils ----------
const money = (n)=> Math.max(0, Math.round(Number(n||0)));
const norm  = (s)=> String(s||"").toLowerCase().replace(/\s+/g,"").replace(/bank$/,"");

// Build OTA price rows (base + markup). Offers will be applied on top.
function buildDefaultPortalPrices(base) {
  return OTAS.map(p => ({
    portal: p,
    basePrice: base,
    finalPrice: base + MARKUP,
    source: "carrier+markup"
  }));
}

function bestDealFrom(portals) {
  let best = portals[0];
  for (const p of portals) if (p.finalPrice < best.finalPrice) best = p;
  return {
    portal: best.portal,
    finalPrice: best.finalPrice,
    note: best._why || "Best price after applicable offers (if any)"
  };
}

// -------------------- OFFERS (Mongo) --------------------
// We expect each offer doc to contain something like (flexible):
// {
//   sourcePortal: "MakeMyTrip",
//   parsedFields: {
//     discountPercent: 10,          // or
//     maxDiscountAmount: 600,       // optional ceiling
//     flatDiscountAmount: 400,      // if flat
//     minTransactionValue: 3000
//   },
//   paymentMethods: [ { type:"Credit Card", bank:"ICICI Bank" }, ... ],
//   couponRequired: true,
//   couponCode: "ICICI10"  // optional
// }
// We support both parsedFields.* and older top-level fields if present.

function extractDiscountAndType(o) {
  const p = o.parsedFields || {};
  const percent = Number(p.discountPercent ?? o.discountPercent ?? NaN);
  const flat    = Number(p.flatDiscountAmount ?? o.flatDiscountAmount ?? NaN);
  const maxAmt  = Number(p.maxDiscountAmount ?? o.maxDiscountAmount ?? NaN);
  const minAmt  = Number(p.minTransactionValue ?? o.minTransactionValue ?? 0);

  if (!Number.isNaN(percent)) {
    return { kind:"percent", percent, maxAmt: Number.isNaN(maxAmt) ? undefined : maxAmt, minAmt };
  }
  if (!Number.isNaN(flat)) {
    return { kind:"flat", flat, minAmt };
  }
  return null;
}

function matchesPayment(selectionSet, offer) {
  const list = Array.isArray(offer.paymentMethods) ? offer.paymentMethods : [];
  // Any one method from list matching selected banks/categories is OK
  for (const pm of list) {
    const cat = norm(pm.type || pm.category || "");
    const bank = norm(pm.bank || "");
    if ((cat && selectionSet.has(cat)) && (bank ? selectionSet.has(bank) : true)) return true;
  }
  return false;
}

async function fetchActiveOffers() {
  try {
    const col = await ensureMongo();
    const cursor = col.find({ isExpired: { $ne: true } });
    const docs = await cursor.toArray();
    return docs;
  } catch (e) {
    console.error("[offers] fetch error:", e.message);
    return [];
  }
}

function applyMongoOffers(base, paymentSelections, allOffers, debugBag) {
  const sel = (Array.isArray(paymentSelections) ? paymentSelections : []).map(norm);
  const selSet = new Set(sel);

  const portals = buildDefaultPortalPrices(base);
  const applied = [];

  for (const p of portals) {
    // pick the **best** applicable offer per portal
    let bestPrice = p.finalPrice;
    let bestWhy   = null;

    for (const offer of allOffers) {
      const portal = offer.sourcePortal || offer.portal || offer.parsedFields?.sourcePortal;
      if ((portal || "").toLowerCase() !== p.portal.toLowerCase()) continue;

      const rule = extractDiscountAndType(offer);
      if (!rule) continue;

      if (!matchesPayment(selSet, offer)) continue;

      // compute discount
      let discount = 0;
      if (rule.kind === "percent") {
        discount = Math.round((rule.percent/100) * base);
        if (rule.maxAmt && discount > rule.maxAmt) discount = rule.maxAmt;
      } else if (rule.kind === "flat") {
        discount = rule.flat;
      }

      const minOK = base >= (rule.minAmt || 0);
      if (!minOK || !(discount > 0)) continue;

      const candidate = Math.max(0, base + MARKUP - discount);
      if (candidate < bestPrice) {
        bestPrice = candidate;
        const code = offer.couponCode || offer.parsedFields?.couponCode || "";
        const label = offer.title || offer.parsedFields?.title || `${offer.sourcePortal} offer`;
        bestWhy = `${label}${code ? ` (code ${code})` : ""}`;
      }
    }

    if (bestPrice !== p.finalPrice) {
      p.finalPrice = bestPrice;
      p.source = "carrier+offer+markup";
      p._why = bestWhy || "Best applicable offer";
      applied.push({ portal: p.portal, why: p._why });
    }
  }

  if (debugBag) debugBag.applied = applied;
  return { portalPrices: portals, bestDeal: bestDealFrom(portals) };
}

// -------------------- PAYMENT OPTIONS (Mongo) --------------------
async function buildPaymentCatalogFromOffers() {
  const docs = await fetchActiveOffers();
  // catalog shape: { "Credit Card": [...banks], "Debit Card":[...], "UPI":[...], ... }
  const catalog = {};
  for (const o of docs) {
    const list = Array.isArray(o.paymentMethods) ? o.paymentMethods : [];
    for (const pm of list) {
      const cat = pm.type || pm.category || "Other";
      const bank = pm.bank || "Any";
      if (!catalog[cat]) catalog[cat] = new Set();
      catalog[cat].add(bank);
    }
  }
  // convert sets -> arrays sorted
  const out = {};
  for (const [k, set] of Object.entries(catalog)) out[k] = Array.from(set).sort();
  return out;
}

// -------------------- FLIGHTS (FlightAPI.io) --------------------
async function fetchFlightsReal({ from, to, depart, ret, adults = 1, cabin = "economy" }) {
  if (!FLIGHTAPI_KEY) {
    return { items: [], meta: { used: "flightapi", outStatus: 200 } };
  }
  const url = `https://api.flightapi.io/roundtrip/${FLIGHTAPI_KEY}/${from}/${to}/${depart}/${ret || depart}/${adults}/0/0/${cabin}/${CURRENCY}?region=${REGION}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);

  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    const status = resp.status;
    let json = null;
    try { json = await resp.json(); } catch {}
    if (status !== 200 || !json) {
      return { items: [], meta: { used: "flightapi", outStatus: status } };
    }

    // Map safely; some days may actually return very few or zero itineraries
    const itins = Array.isArray(json.itineraries) ? json.itineraries : [];
    // Show up to 25 as requested
    const items = itins.slice(0, 25).map((it, i) => ({
      id: `R${i+1}`,
      airlineName: (json.carriers?.[0]?.name) || "Airline",
      flightNumber: it?.id || `F${1000+i}`,
      departure: "—",
      arrival: "—",
      basePrice: money(it?.price || 0),
      stops: 0
    }));
    return { items, meta: { used: "flightapi", outStatus: status } };
  } finally {
    clearTimeout(t);
  }
}

// -------------------- ROUTES --------------------
app.get("/payment-options", async (_req, res) => {
  try {
    const options = await buildPaymentCatalogFromOffers(); // never throws (handles empty)
    res.json({ usedFallback: false, options });
  } catch (e) {
    console.error("[/payment-options] error:", e.message);
    // Never 502 just because offers are empty — return empty catalog
    res.json({ usedFallback: true, options: {} });
  }
});

app.post("/search", async (req, res) => {
  const {
    from = "BOM",
    to   = "DEL",
    departureDate = new Date(Date.now()+86400000).toISOString().slice(0,10),
    returnDate    = departureDate,
    tripType = "one-way",
    passengers = 1,
    travelClass = "economy",
    paymentMethods = []           // from UI: array of selected bank names (and/or categories normalized)
  } = req.body || {};

  const retDate = (tripType === "round-trip") ? (returnDate || departureDate) : departureDate;

  // pull offers once per request
  const offerDebug = {};
  const allOffers = await fetchActiveOffers();

  const real = await fetchFlightsReal({
    from, to, depart: departureDate, ret: retDate, adults: passengers, cabin: travelClass
  });

  // decorate + apply offers from Mongo
  const decorate = (f) => {
    const base = money(f.basePrice);
    const { portalPrices, bestDeal } = applyMongoOffers(base, paymentMethods, allOffers, offerDebug);
    return { ...f, portalPrices, bestDeal };
  };

  const outboundFlights = (real.items || []).slice(0, 25).sort((a,b)=> (a.basePrice||0)-(b.basePrice||0)).map(decorate);
  const returnFlights   = (tripType === "round-trip")
    ? (real.items || []).slice(0, 25).sort((a,b)=> (a.basePrice||0)-(b.basePrice||0)).map(decorate)
    : [];

  return res.json({
    meta: {
      source: real.meta.used,
      outStatus: real.meta.outStatus,
      outCount: outboundFlights.length,
      retCount: returnFlights.length,
      offerDebug
    },
    outboundFlights,
    returnFlights
  });
});

app.get("/", (_req, res) => res.send("SkyDeal backend OK"));

app.listen(PORT, () => {
  console.log(`SkyDeal backend listening on ${PORT}`);
});
