// index.js — SkyDeal backend (Express, ESM, Mongo + FlightAPI)
// RUN: node index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// ---------- CORS & JSON ----------
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));
app.use(express.json());

// ---------- ENV ----------
const FLIGHTAPI_KEY = process.env.FLIGHTAPI_KEY;
const MONGO_URI     = process.env.MONGO_URI;
const MONGO_DB      = process.env.MONGODB_DB || "skydeal";
const MONGO_COL     = process.env.MONGO_COL  || "offers";
const CURRENCY      = "INR";

// ---------- Mongo (singleton) ----------
let mongoClient;
let offersColl;
async function ensureMongo() {
  if (offersColl) return offersColl;
  if (!MONGO_URI) throw new Error("MONGO_URI missing");
  mongoClient = new MongoClient(MONGO_URI, { maxPoolSize: 5 });
  await mongoClient.connect();
  const db = mongoClient.db(MONGO_DB);
  offersColl = db.collection(MONGO_COL);
  return offersColl;
}

// ---------- Helpers ----------
const toMoney = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.round(v);
};

// canonical category names (5 tabs)
const CAT_MAP = {
  "credit card": "Credit Card",
  "credit_card": "Credit Card",
  "debit card": "Debit Card",
  "debit_card": "Debit Card",
  "netbanking": "Net Banking",
  "net banking": "Net Banking",
  "internet banking": "Net Banking",
  "upi": "UPI",
  "wallet": "Wallet",
  "emi": "Credit Card",     // treat EMI under Credit Card tab
  "other": null
};
const norm = (s) => String(s || "").trim();
const normBank = (s) =>
  norm(s)
    .replace(/\s+Bank(?:ing)?$/i, " Bank")
    .replace(/^IDFC\s*First$/i, "IDFC First Bank")
    .replace(/^AU\s*Small\s*(Finance)?/i, "AU Small Bank")
    .replace(/HDFC\s*Bank/i, "HDFC Bank")
    .replace(/ICICI\s*Bank/i, "ICICI Bank")
    .replace(/Axis\s*Bank/i, "Axis Bank")
    .replace(/Kotak\s*Bank/i, "Kotak Bank")
    .replace(/Yes\s*Bank/i, "Yes Bank")
    .replace(/RBL\s*Bank/i, "RBL Bank")
    .replace(/HSBC/i, "HSBC")
    .trim();

// ---------- Offers from Mongo ----------
/**
 * Expected flexible fields in each offer doc:
 * portal, paymentCategory (e.g., "credit_card","upi","wallet","emi"...),
 * bankName (e.g., "HDFC Bank"), type ("percent"|"flat"), value (number),
 * minAmount (number, optional), code (string, optional), isExpired (bool)
 */
async function fetchActiveOffers() {
  const col = await ensureMongo();
  // Only non-expired, non-deleted
  const q = { $or: [{ isExpired: { $exists: false } }, { isExpired: false }] };
  const cur = col.find(q, { projection: {
    portal: 1, paymentCategory: 1, bankName: 1, type: 1, value: 1,
    minAmount: 1, code: 1
  }});
  const rows = await cur.toArray();

  // Normalize + keep only offers that can be applied
  return rows.map(r => {
    const catRaw = String(r.paymentCategory || "").toLowerCase();
    const mapped = CAT_MAP[catRaw] ?? null;
    return {
      portal: norm(r.portal),
      applyTo: mapped,                      // one of 5 tabs (or null to ignore)
      bank: mapped ? normBank(r.bankName || "") : "",
      type: (r.type === "flat" ? "flat" : "percent"),
      value: Number(r.value) || 0,
      min: Number(r.minAmount) || 0,
      code: norm(r.code || "")
    };
  }).filter(o => o.applyTo && o.portal && (o.value > 0));
}

// Build Payment Tabs (5) from active offers (dedup banks)
async function buildPaymentTabs() {
  const offers = await fetchActiveOffers();
  const tabs = {
    "Credit Card": new Set(),
    "Debit Card": new Set(),
    "Net Banking": new Set(),
    "UPI": new Set(),
    "Wallet": new Set()
  };
  for (const o of offers) {
    if (o.applyTo === "UPI") {
      tabs["UPI"].add("Any UPI");
    } else if (o.bank) {
      tabs[o.applyTo]?.add(o.bank);
    }
  }
  // Convert to arrays (sorted)
  const out = {};
  for (const [k, v] of Object.entries(tabs)) {
    out[k] = Array.from(v).sort((a, b) => a.localeCompare(b));
  }
  return out;
}

// ---------- Apply offers ----------
const OTAS = ["MakeMyTrip", "Goibibo", "EaseMyTrip", "Yatra", "Cleartrip"];

function applyOffersToPortals(base, selectedBanks, activeOffers) {
  // No markup path anymore: show carrier price minus offer if eligible
  const portals = OTAS.map(p => ({
    portal: p,
    basePrice: base,
    finalPrice: base,
    source: "carrier"
  }));
  const selSet = new Set((selectedBanks || []).map(b => normBank(b).toLowerCase()));

  let best = portals[0];

  for (const p of portals) {
    // find all offers for this portal matching any selected bank & category
    const portalOffers = activeOffers.filter(o => o.portal.toLowerCase() === p.portal.toLowerCase());

    // choose max discount from eligible offers
    let bestDiscount = 0;
    let why = "";
    for (const o of portalOffers) {
      const bankOk = (o.applyTo === "UPI") ? true : selSet.has(o.bank.toLowerCase());
      if (!bankOk) continue;
      if (o.min && base < o.min) continue;

      const disc = (o.type === "percent") ? Math.floor((o.value / 100) * base) : o.value;
      if (disc > bestDiscount) {
        bestDiscount = disc;
        why = `${o.type === "percent" ? `${o.value}% off` : `₹${o.value} off`} on ${o.bank}${o.code ? ` (code ${o.code})` : ""}`;
      }
    }

    if (bestDiscount > 0) {
      p.finalPrice = Math.max(0, base - bestDiscount);
      p.source = "carrier+offer";
      p._why = why;
    }

    if (p.finalPrice < best.finalPrice) best = p;
  }

  return {
    portalPrices: portals,
    bestDeal: {
      portal: best.portal,
      finalPrice: best.finalPrice,
      note: best._why || "Best price after applicable offers (if any)"
    }
  };
}

// ---------- FlightAPI fetch ----------
async function fetchFlights({ from, to, departureDate, returnDate, adults = 1, cabin = "economy" }) {
  if (!FLIGHTAPI_KEY) throw new Error("FLIGHTAPI_KEY missing");

  const leg = async (d1, d2) => {
    const url = `https://api.flightapi.io/roundtrip/${FLIGHTAPI_KEY}/${from}/${to}/${d1}/${d2 || d1}/${adults}/0/0/${cabin}/${CURRENCY}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 25000);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      const status = r.status;
      let j = null;
      try { j = await r.json(); } catch {}
      if (status !== 200 || !j) {
        return { items: [], meta: { used: "flightapi", outStatus: status } };
      }

      // price extraction: try a few common fields
      const itins = Array.isArray(j.itineraries) ? j.itineraries : [];
      const items = [];
      for (let i = 0; i < itins.length; i++) {
        const it = itins[i];
        const priceCandidates = [
          it?.price, it?.total_amount, it?.pricing?.total, it?.priceBreakdown?.total, it?.amount
        ];
        const price = priceCandidates.map(toMoney).find(v => v !== null);
        if (!price) continue; // skip broken rows => prevents "₹100" glitch

        // simple placeholders for times (your downstream UI already shows text)
        const dep = "— → —";
        const arr = "— → —";

        items.push({
          id: String(it?.id || i + 1),
          airlineName: (j?.carriers?.[0]?.name) || "Air India",
          flightNumber: String(it?.id || `AI${1000 + i}`),
          departure: dep,
          arrival: arr,
          basePrice: price,
          stops: 0
        });
      }

      // sort by price asc, cap 25
      items.sort((a, b) => a.basePrice - b.basePrice);
      return { items: items.slice(0, 25), meta: { used: "flightapi", outStatus: status } };
    } finally {
      clearTimeout(t);
    }
  };

  const out = await leg(departureDate, returnDate);
  return out;
}

// ---------- ROUTES ----------
app.get("/payment-options", async (_req, res) => {
  try {
    const tabs = await buildPaymentTabs();
    res.json({ usedMongo: true, options: tabs });
  } catch (e) {
    console.error("[/payment-options] error:", e.message);
    res.status(502).json({ error: "Failed to load payment options" });
  }
});

app.post("/search", async (req, res) => {
  const {
    from = "BOM",
    to   = "DEL",
    departureDate = new Date(Date.now()+86400000).toISOString().slice(0,10),
    returnDate    = "",
    tripType = "one-way",
    passengers = 1,
    travelClass = "economy",
    paymentMethods = []          // array of bank names from UI
  } = req.body || {};

  // Fetch flights
  let data;
  try {
    data = await fetchFlights({
      from, to, departureDate,
      returnDate: (tripType === "round-trip" ? (returnDate || departureDate) : departureDate),
      adults: passengers, cabin: travelClass
    });
  } catch (e) {
    console.error("FlightAPI error:", e.message);
    return res.status(502).json({ meta: { source: "flightapi", outStatus: 502 }, outboundFlights: [], returnFlights: [] });
  }

  // Offers to apply
  let activeOffers = [];
  try {
    activeOffers = await fetchActiveOffers();
  } catch (e) {
    console.error("Offers fetch error:", e.message);
  }

  const decorate = (f) => {
    const base = toMoney(f.basePrice);
    if (!base) return null;
    const { portalPrices, bestDeal } = applyOffersToPortals(base, paymentMethods, activeOffers);
    return { ...f, portalPrices, bestDeal };
  };

  const outItems = data.items.map(decorate).filter(Boolean);
  const retItems = (tripType === "round-trip") ? data.items.map(decorate).filter(Boolean) : [];

  return res.json({
    meta: {
      source: data.meta.used,
      outStatus: data.meta.outStatus,
      outCount: outItems.length,
      retCount: retItems.length,
      offerDebug: { offersLoaded: activeOffers.length }
    },
    outboundFlights: outItems,
    returnFlights: retItems
  });
});

app.get("/", (_req, res) => res.send("SkyDeal backend OK"));

app.listen(PORT, () => {
  console.log(`SkyDeal backend listening on ${PORT}`);
});
