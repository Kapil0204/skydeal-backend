// index.js — SkyDeal backend (Express, ESM, Mongo + FlightAPI, schema-tolerant)
// RUN: node index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type"] }));
app.use(express.json());

// ----- ENV -----
const FLIGHTAPI_KEY = process.env.FLIGHTAPI_KEY;
const MONGO_URI     = process.env.MONGO_URI;
const MONGO_DB      = process.env.MONGODB_DB || "skydeal";
const MONGO_COL     = process.env.MONGO_COL  || "offers";
const CURRENCY      = "INR";

// ----- Mongo singleton -----
let client, offersColl;
async function ensureMongo() {
  if (offersColl) return offersColl;
  if (!MONGO_URI) throw new Error("MONGO_URI missing");
  client = new MongoClient(MONGO_URI, { maxPoolSize: 5 });
  await client.connect();
  offersColl = client.db(MONGO_DB).collection(MONGO_COL);
  return offersColl;
}

// ----- Helpers -----
const money = (n) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
};

const CAT_MAP = {
  "credit card":"Credit Card","credit_card":"Credit Card","cc":"Credit Card","emi":"Credit Card",
  "debit card":"Debit Card","debit_card":"Debit Card","dc":"Debit Card",
  "net banking":"Net Banking","netbanking":"Net Banking","internet banking":"Net Banking","nb":"Net Banking",
  "upi":"UPI",
  "wallet":"Wallet","paytm wallet":"Wallet","phonepe wallet":"Wallet"
};

const toTab = (raw) => {
  const k = String(raw||"").trim().toLowerCase();
  return CAT_MAP[k] || null;
};

const norm = (s) => String(s||"").trim();
const normBank = (s) =>
  norm(s)
  .replace(/\s+Bank(?:ing)?$/i, " Bank")
  .replace(/^IDFC\s*First(?:\s*Bank)?$/i, "IDFC First Bank")
  .replace(/^AU\s*Small.*$/i, "AU Small Bank")
  .replace(/HDFC\s*Bank/i, "HDFC Bank")
  .replace(/ICICI\s*Bank/i, "ICICI Bank")
  .replace(/Axis\s*Bank/i, "Axis Bank")
  .replace(/Kotak\s*Bank/i, "Kotak Bank")
  .replace(/Yes\s*Bank/i, "Yes Bank")
  .replace(/RBL\s*Bank/i, "RBL Bank")
  .replace(/HSBC$/i, "HSBC");

// ----- Read offers (schema-tolerant) -----
/*
 Accepts any of these shapes:
 1) {
      portal, paymentCategory, bankName, type, value, minAmount, code, isExpired
    }
 2) {
      portal, type, value, minAmount, code, isExpired,
      paymentMethods: [{ type|category|method, bank|bankName|name }]
    }
*/
async function readOffersRaw() {
  const col = await ensureMongo();
  // allow both: no isExpired or isExpired=false
  const q = { $or: [{ isExpired: { $exists:false } }, { isExpired:false }] };
  return col.find(q).toArray();
}

function explodeDocToOffers(doc) {
  const base = {
    portal: norm(doc.portal),
    type: (doc.type === "flat" ? "flat" : "percent"),
    value: Number(doc.value) || 0,
    min: Number(doc.minAmount) || 0,
    code: norm(doc.code || "")
  };

  const out = [];

  // Case 2: nested paymentMethods[]
  if (Array.isArray(doc.paymentMethods) && doc.paymentMethods.length) {
    for (const pm of doc.paymentMethods) {
      const rawCat = pm.type || pm.category || pm.method || pm.name;
      const mapped = toTab(rawCat);
      if (!mapped) continue;

      let bank = pm.bank || pm.bankName || pm.name || "";
      bank = mapped === "UPI" ? "Any UPI" : normBank(bank);
      if (!base.portal || !bank || base.value <= 0) continue;

      out.push({ ...base, applyTo: mapped, bank });
    }
    return out;
  }

  // Case 1: top-level fields
  const rawCat = doc.paymentCategory || doc.category || doc.methodType || doc.method;
  const mapped = toTab(rawCat);
  if (!mapped) return out;

  const bank = mapped === "UPI" ? "Any UPI" : normBank(doc.bank || doc.bankName || doc.cardBank || doc.issuer || "");
  if (!base.portal || !bank || base.value <= 0) return out;

  out.push({ ...base, applyTo: mapped, bank });
  return out;
}

async function fetchActiveOffersExpanded() {
  const docs = await readOffersRaw();
  const exploded = docs.flatMap(explodeDocToOffers);
  // Keep valid only
  return exploded.filter(o => o.portal && o.applyTo && o.bank && o.value > 0);
}

// Build the 5 tabs from offers
async function buildPaymentTabs() {
  const offers = await fetchActiveOffersExpanded();
  const tabs = { "Credit Card": new Set(), "Debit Card": new Set(), "Net Banking": new Set(), "UPI": new Set(), "Wallet": new Set() };
  for (const o of offers) {
    if (o.applyTo === "UPI") tabs.UPI.add("Any UPI");
    else tabs[o.applyTo]?.add(o.bank);
  }
  const out = {};
  for (const [k, v] of Object.entries(tabs)) out[k] = Array.from(v).sort((a,b)=>a.localeCompare(b));
  return { tabs: out, offersCount: offers.length };
}

// ----- Apply offers per-portal -----
const OTAS = ["MakeMyTrip","Goibibo","EaseMyTrip","Yatra","Cleartrip"];

function applyOffersToPortals(base, selectedBanks, activeOffers) {
  const portals = OTAS.map(p => ({ portal: p, basePrice: base, finalPrice: base, source: "carrier" }));
  const selSet = new Set((selectedBanks || []).map(b => normBank(b).toLowerCase()));

  let best = portals[0];

  for (const p of portals) {
    const po = activeOffers.filter(o => o.portal.toLowerCase() === p.portal.toLowerCase());
    let bestDisc = 0, why = "";

    for (const o of po) {
      const bankOK = (o.applyTo === "UPI") ? true : selSet.has(o.bank.toLowerCase());
      if (!bankOK) continue;
      if (o.min && base < o.min) continue;

      const d = o.type === "flat" ? o.value : Math.floor((o.value/100)*base);
      if (d > bestDisc) {
        bestDisc = d;
        why = `${o.type === "percent" ? `${o.value}% off` : `₹${o.value} off`} on ${o.bank}${o.code ? ` (code ${o.code})` : ""}`;
      }
    }

    if (bestDisc > 0) {
      p.finalPrice = Math.max(0, base - bestDisc);
      p.source = "carrier+offer";
      p._why = why;
    }
    if (p.finalPrice < best.finalPrice) best = p;
  }

  return {
    portalPrices: portals,
    bestDeal: { portal: best.portal, finalPrice: best.finalPrice, note: best._why || "Best price after applicable offers (if any)" }
  };
}

// ----- FlightAPI fetch -----
async function fetchFlights({ from, to, departureDate, returnDate, adults = 1, cabin = "economy" }) {
  if (!FLIGHTAPI_KEY) throw new Error("FLIGHTAPI_KEY missing");

  const url = `https://api.flightapi.io/roundtrip/${FLIGHTAPI_KEY}/${from}/${to}/${departureDate}/${returnDate || departureDate}/${adults}/0/0/${cabin}/${CURRENCY}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);

  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const status = r.status;
    let j = null; try { j = await r.json(); } catch {}
    if (status !== 200 || !j) return { items: [], meta: { used: "flightapi", outStatus: status } };

    const itins = Array.isArray(j.itineraries) ? j.itineraries : [];
    const items = [];
    for (let i=0; i<itins.length; i++) {
      const it = itins[i];
      const price = [it?.price, it?.total_amount, it?.pricing?.total, it?.priceBreakdown?.total, it?.amount].map(money).find(Boolean);
      if (!price) continue;

      items.push({
        id: String(it?.id || i+1),
        airlineName: (j?.carriers?.[0]?.name) || "Air India",
        flightNumber: String(it?.id || `AI${1000+i}`),
        departure: "— → —",
        arrival: "— → —",
        basePrice: price,
        stops: 0
      });
    }
    items.sort((a,b)=>a.basePrice-b.basePrice);
    return { items: items.slice(0,25), meta: { used: "flightapi", outStatus: status } };
  } finally { clearTimeout(t); }
}

// ----- Routes -----
app.get("/payment-options", async (_req, res) => {
  try {
    const { tabs, offersCount } = await buildPaymentTabs();
    res.json({ usedMongo: true, offersCount, options: tabs });
  } catch (e) {
    console.error("[/payment-options] error:", e);
    res.status(502).json({ error: "Failed to load payment options" });
  }
});

app.post("/search", async (req, res) => {
  const {
    from = "BOM", to = "DEL",
    departureDate = new Date(Date.now()+86400000).toISOString().slice(0,10),
    returnDate = "", tripType = "one-way",
    passengers = 1, travelClass = "economy",
    paymentMethods = []
  } = req.body || {};

  let data;
  try {
    data = await fetchFlights({
      from, to, departureDate,
      returnDate: (tripType === "round-trip" ? (returnDate || departureDate) : departureDate),
      adults: passengers, cabin: travelClass
    });
  } catch (e) {
    console.error("FlightAPI error:", e.message);
    return res.status(502).json({ meta: { source:"flightapi", outStatus:502 }, outboundFlights:[], returnFlights:[] });
  }

  let activeOffers = [];
  try {
    activeOffers = await fetchActiveOffersExpanded();
  } catch (e) {
    console.error("Offers fetch error:", e.message);
  }

  const decorate = (f) => {
    const base = money(f.basePrice);
    if (!base) return null;
    const { portalPrices, bestDeal } = applyOffersToPortals(base, paymentMethods, activeOffers);
    return { ...f, portalPrices, bestDeal };
  };

  const outItems = data.items.map(decorate).filter(Boolean);
  const retItems = (tripType === "round-trip") ? data.items.map(decorate).filter(Boolean) : [];

  res.json({
    meta: {
      source: data.meta.used, outStatus: data.meta.outStatus,
      outCount: outItems.length, retCount: retItems.length,
      offerDebug: { offersLoaded: activeOffers.length }
    },
    outboundFlights: outItems,
    returnFlights: retItems
  });
});

app.get("/", (_req,res) => res.send("SkyDeal backend OK"));
app.get("/health", async (_req,res) => {
  try {
    const col = await ensureMongo();
    const c = await col.estimatedDocumentCount();
    res.json({ ok:true, mongo:true, offerDocs:c });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.listen(PORT, () => console.log(`SkyDeal backend listening on ${PORT}`));
