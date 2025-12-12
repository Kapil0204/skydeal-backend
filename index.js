// index.js — SkyDeal backend (Express, ESM, real data only)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// --- CORS (once) ---
app.use(cors({
  origin: "*",
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));
app.use(express.json());

// --- env (accept both MONGO_URI and MONGODB_URI) ---
const MONGO_URI   = (process.env.MONGO_URI || process.env.MONGODB_URI || "").trim();
const MONGO_DB    = (process.env.MONGODB_DB || "skydeal").trim();
const MONGO_COL   = (process.env.MONGO_COL   || "offers").trim();
const FLIGHTAPI_KEY = (process.env.FLIGHTAPI_KEY || "").trim();

// --- constants ---
const CURRENCY = "INR";
const REGION   = "IN";      // for FlightAPI
const PORTALS  = ["MakeMyTrip","Goibibo","EaseMyTrip","Yatra","Cleartrip"];
const OTA_MARKUP = 100;     // +₹100 per portal (business rule)

// --- mongo singleton ---
let mongoClient = null;
let offersCol = null;

async function ensureMongo() {
  if (!MONGO_URI) throw new Error("MONGO_URI missing");
  if (offersCol) return offersCol;
  if (!mongoClient) {
    mongoClient = new MongoClient(MONGO_URI, { ignoreUndefined: true });
    await mongoClient.connect();
  }
  const db = mongoClient.db(MONGO_DB);
  offersCol = db.collection(MONGO_COL);
  return offersCol;
}

// --- helpers ---
const money = (n) => Math.max(0, Math.round(Number(n || 0)));
const norm  = (s) => String(s || "").toLowerCase().replace(/\s+/g,"").replace(/bank$/,"");

// Build portal rows with markup first; discounts applied on top of that
function buildPortalRows(base) {
  return PORTALS.map(p => ({
    portal: p,
    basePrice: base,
    finalPrice: base + OTA_MARKUP,
    source: "carrier+markup"
  }));
}

// Compute best deal
function bestDealFrom(portals) {
  let best = portals[0];
  for (const p of portals) if (p.finalPrice < best.finalPrice) best = p;
  return {
    portal: best.portal,
    finalPrice: best.finalPrice,
    note: best._why || "Best price after applicable offers (if any)"
  };
}

// Apply real Mongo offers to portal rows
function applyOffersFromMongo({ base, offers, selectedBanks, debugBag }) {
  const selectedNorm = new Set(selectedBanks.map(norm));
  const rows = buildPortalRows(base);
  const applied = [];

  for (const row of rows) {
    // Pick the best single offer for this portal that matches any selected bank/method
    const candidates = (offers || []).filter(o => {
      if (o.portal !== row.portal) return false;
      // normalize applicability
      const applyTo = Array.isArray(o.applyTo) ? o.applyTo : (o.applyTo ? [o.applyTo] : []);
      const banks   = Array.isArray(o.banks) ? o.banks : (o.banks ? [o.banks] : []);
      const catHit  = applyTo.some(a => selectedNorm.has(norm(a)));
      const bankHit = banks.length === 0 ? false : banks.some(b => selectedNorm.has(norm(b)) || norm(b) === "anyupi");
      return catHit && bankHit && !o.isExpired;
    });

    if (!candidates.length) continue;

    // pick the best (max discount) that meets min txn
    let best = null;
    for (const c of candidates) {
      const min = Number(c.minTransactionValue || c.min || 0);
      if (base < min) continue;

      let discount = 0;
      if (String(c.type).toLowerCase() === "percent") {
        discount = Math.round((Number(c.value || c.discountPercent || 0) / 100) * base);
      } else {
        discount = Number(c.value || c.maxDiscountAmount || c.flat || 0);
      }
      // respect max cap if provided
      const cap = Number(c.maxDiscountAmount || c.max || 0);
      if (cap > 0) discount = Math.min(discount, cap);

      if (!best || discount > best.discount) {
        best = {
          discount,
          label: c.label || c.title || "",
          code: c.code || c.coupon || "",
          raw: c
        };
      }
    }

    if (best && best.discount > 0) {
      row.finalPrice = Math.max(0, row.basePrice + OTA_MARKUP - best.discount);
      row.source = "carrier+offer+markup";
      row._why = `${best.label}${best.code ? ` (code ${best.code})` : ""}`;
      applied.push({ portal: row.portal, why: row._why, discount: best.discount });
    }
  }

  if (debugBag) debugBag.applied = applied;
  return { portalPrices: rows, bestDeal: bestDealFrom(rows) };
}

// --- FlightAPI (real only, no fallback) ---
async function fetchFlightsReal({ from, to, departureDate, returnDate, adults, cabin }) {
  if (!FLIGHTAPI_KEY) {
    const err = new Error("FLIGHTAPI_KEY missing");
    err.status = 500;
    throw err;
  }

  const url = `https://api.flightapi.io/roundtrip/${FLIGHTAPI_KEY}/${from}/${to}/${departureDate}/${returnDate}/${adults}/0/0/${cabin}/${CURRENCY}?region=${REGION}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);

  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    const status = resp.status;
    const data = await resp.json().catch(() => null);

    if (status !== 200 || !data) {
      const e = new Error(`FlightAPI non-200 (${status})`);
      e.status = status || 502;
      throw e;
    }

    // Map + sort by price asc + cap at 25
    const items = (data.itineraries || [])
      .map((it, i) => ({
        id: `R${i+1}`,
        airlineName: (data.carriers?.find(c => c.id === data?.segments?.find(s => s.id === data?.legs?.find(l => l.id === it.leg_ids?.[0])?.segment_ids?.[0])?.marketing_carrier_id)?.name) || "Airline",
        flightNumber: it.id || `F${1000+i}`,
        departure: "—",
        arrival: "—",
        basePrice: money(it.price),
        stops: 0
      }))
      .filter(x => x.basePrice > 0)
      .sort((a,b) => a.basePrice - b.basePrice)
      .slice(0, 25);

    return { items, meta: { outStatus: 200, used: "flightapi" } };
  } finally {
    clearTimeout(t);
  }
}

// --- routes ---

// Payment options are derived from real offers present in Mongo
app.get("/payment-options", async (_req, res) => {
  try {
    const col = await ensureMongo();
    // Only active, payment-method-related offers
    const offers = await col.find({ isExpired: { $ne: true } }, { projection: {
      portal: 1, applyTo: 1, banks: 1
    }}).toArray();

    // Build catalog by category using only names found in offers
    const catalog = {};
    for (const o of offers) {
      const cats = Array.isArray(o.applyTo) ? o.applyTo : (o.applyTo ? [o.applyTo] : []);
      const banks = Array.isArray(o.banks) ? o.banks : (o.banks ? [o.banks] : []);
      for (const cat of cats) {
        if (!catalog[cat]) catalog[cat] = new Set();
        banks.forEach(b => catalog[cat].add(b));
      }
    }
    const out = {};
    Object.entries(catalog).forEach(([k, set]) => out[k] = Array.from(set));

    res.json({ usedFallback: false, options: out });
  } catch (e) {
    console.error("[/payment-options] error:", e.message);
    // Return 200 with empty options so UI shows "No options"
    res.json({ usedFallback: false, options: {} });
  }
});

app.post("/search", async (req, res) => {
  const {
    from = "BOM",
    to   = "DEL",
    departureDate,
    returnDate,
    tripType = "one-way",
    passengers = 1,
    travelClass = "economy",
    paymentMethods = []          // array of human strings from UI
  } = req.body || {};

  const retDate = (tripType === "round-trip" ? (returnDate || departureDate) : departureDate);

  // Fetch active offers once
  let activeOffers = [];
  let offerDebug = {};
  try {
    const col = await ensureMongo();
    activeOffers = await col.find({ isExpired: { $ne: true } }).toArray();
  } catch (e) {
    console.error("[/search] offers error:", e.message);
  }

  try {
    const real = await fetchFlightsReal({
      from, to, departureDate, returnDate: retDate,
      adults: passengers, cabin: travelClass
    });

    const decorate = (f) => {
      const { portalPrices, bestDeal } = applyOffersFromMongo({
        base: money(f.basePrice),
        offers: activeOffers,
        selectedBanks: paymentMethods,
        debugBag: offerDebug
      });
      return { ...f, portalPrices, bestDeal };
    };

    // Outbound and (optionally) return; (for now use same list for both)
    const outboundFlights = real.items.map(decorate);
    const returnFlights   = tripType === "round-trip" ? real.items.map(decorate) : [];

    return res.json({
      meta: {
        source: "flightapi",
        outStatus: real.meta.outStatus,
        outCount: outboundFlights.length,
        retCount: returnFlights.length,
        offerDebug
      },
      outboundFlights,
      returnFlights
    });
  } catch (e) {
    const status = e.status || 502;
    return res.status(status).json({ error: e.message || "flight search failed" });
  }
});

app.get("/", (_req, res) => res.send("SkyDeal backend OK"));

app.listen(PORT, () => {
  console.log(`SkyDeal backend listening on ${PORT}`);
});
