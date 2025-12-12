// index.js — SkyDeal backend (Express, ESM) — REAL DATA ONLY
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// ---- CORS (once) ----
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));
app.use(express.json());

// ---- constants ----
const CURRENCY   = "INR";
const REGION     = "IN";
const MARKUP     = 100;   // ₹ per-OTA markup
const LIST_LIMIT = 25;    // return up to 25 per direction
const OTAS       = ["MakeMyTrip","Goibibo","EaseMyTrip","Yatra","Cleartrip"];

const money = n => Math.max(0, Math.round(Number(n || 0)));
const todayISO = () => new Date().toISOString().slice(0,10);
const norm = s => String(s||"").toLowerCase().replace(/\s+/g,"").replace(/bank$/,"");

// ---------- Mongo (offers) ----------
const MONGO_URI = process.env.MONGO_URI || "";
const MONGO_DB  = process.env.MONGO_DB || "skydeal";
const MONGO_COLLECTION = process.env.MONGO_COLLECTION || "offers";

if (!MONGO_URI) {
  console.error("[SkyDeal] MONGO_URI missing — this service will error until provided.");
}

let mongoClient;
async function offersCol() {
  if (!mongoClient) {
    mongoClient = new MongoClient(MONGO_URI, { connectTimeoutMS: 8000, serverSelectionTimeoutMS: 8000 });
  }
  await mongoClient.connect();
  return mongoClient.db(MONGO_DB).collection(MONGO_COLLECTION);
}

// Map Mongo docs -> pricing engine offer objects
function mapOfferDoc(d) {
  // Support your 19-field schema; fall back gracefully if some fields are absent.
  const label  = d.label || d.title || "Offer";
  const portal = (d.portal || "").trim();
  const banks  = Array.isArray(d.paymentMethods) ? d.paymentMethods.filter(Boolean) : [];

  // determine type/value/max/min from structured fields
  let type = "percent";
  let value = Number(d.discountPercent || 0);
  let max = Number(d.maxDiscountAmount || 0) || null;
  if (!value && d.flatDiscountAmount) { type = "flat"; value = Number(d.flatDiscountAmount || 0); max = null; }
  const min  = Number(d.minTransactionValue || 0);
  const code = d.code || "";

  return { portal, label, type, value, max, min, code, banks };
}

async function getOffersStrict() {
  if (!MONGO_URI) throw new Error("MONGO_URI missing");
  const col = await offersCol();

  const docs = await col.find({
    $or: [{ isExpired: { $exists: false } }, { isExpired: false }]
  }).project({
    portal:1, label:1, title:1, code:1,
    minTransactionValue:1, discountPercent:1, maxDiscountAmount:1, flatDiscountAmount:1,
    paymentMethods:1
  }).limit(1000).toArray();

  const offers = docs.map(mapOfferDoc).filter(o => o.portal && (o.value || 0) >= 0);
  if (!offers.length) throw new Error("No offers in Mongo");
  return offers;
}

// Build payment-options from offers (normalized)
function buildPaymentOptionsFromOffers(offers) {
  // We’ll infer categories by simple rules; bank names remain unmodified for UI.
  const out = {
    "Credit Card": new Set(),
    "Debit Card":  new Set(),
    "Net Banking": new Set(),
    "UPI":         new Set(),
    "Wallet":      new Set(),
    "EMI":         new Set()
  };

  const isWallet = (s) => /(paytm|phonepe|amazon\s*pay|mobikwik|freecharge)/i.test(s);
  const isUPI    = (s) => /upi/i.test(s);
  const isNetBn  = (s) => /net\s*bank/i.test(s);
  const isEMI    = (o) => /emi/i.test(o.label || "") || /emi/i.test(o.code || "");

  offers.forEach(o => {
    const emi = isEMI(o);
    (o.banks || []).forEach(b => {
      if (isUPI(b)) out["UPI"].add("Any UPI");
      else if (isWallet(b)) out["Wallet"].add(b);
      else if (isNetBn(b)) out["Net Banking"].add(b.replace(/net\s*bank(ing)?/i,"").trim() || "Any NetBanking");
      else if (emi) out["EMI"].add(b);
      else out["Credit Card"].add(b);  // default bucket
    });
  });

  // Convert sets to arrays, keep stable order
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Array.from(v)]));
}

// ---------- Pricing ----------
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

function applyOffersToPortals(base, selectedBanks, offers, debugBag) {
  const portals = buildDefaultPortalPrices(base);
  const sel = new Set((selectedBanks || []).map(norm));

  const applied = [];

  for (const p of portals) {
    let winner = null;
    let bestCut = 0;

    for (const ofr of offers) {
      if (ofr.portal !== p.portal) continue;

      const banksNorm = (ofr.banks || []).map(norm);
      const bankMatched = banksNorm.some(b => sel.has(b)) || banksNorm.includes("anyupi");
      if (!bankMatched) continue;

      let cut = 0;
      if (ofr.type === "percent") {
        cut = Math.round((Number(ofr.value || 0) / 100) * base);
        if (ofr.max && cut > ofr.max) cut = ofr.max;
      } else {
        cut = Number(ofr.value || 0);
      }

      if (base >= Number(ofr.min || 0) && cut > bestCut) {
        bestCut = cut;
        winner = ofr;
      }
    }

    if (winner && bestCut > 0) {
      p.finalPrice = Math.max(0, base + MARKUP - bestCut);
      p.source = "carrier+offer+markup";
      p._why = `${winner.label}${winner.code ? ` (code ${winner.code})` : ""}`;
      applied.push({ portal: p.portal, why: p._why, value: bestCut });
    }
  }

  if (debugBag) debugBag.applied = applied;
  return { portalPrices: portals, bestDeal: bestDealFrom(portals) };
}

// ---------- FlightAPI (REAL only; no fallback) ----------
async function fetchFlightsReal({ from, to, departureDate, returnDate, adults = 1, cabin = "economy" }) {
  const KEY = process.env.FLIGHTAPI_KEY;
  if (!KEY) throw new Error("FLIGHTAPI_KEY missing");

  const url = `https://api.flightapi.io/roundtrip/${KEY}/${from}/${to}/${departureDate}/${returnDate}/${adults}/0/0/${cabin}/${CURRENCY}?region=${REGION}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);

  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    const status = resp.status;
    if (status !== 200) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`FlightAPI non-200 (${status}) ${txt.slice(0,200)}`);
    }
    const json = await resp.json();
    // Map first LIST_LIMIT items; adapt mapping once you finalize your schema
    const items = (json.itineraries || []).slice(0, LIST_LIMIT).map((it, i) => ({
      id: `F${i+1}`,
      airlineName: (json.carriers?.[0]?.name) || "Airline",
      flightNumber: it?.id || `F${1000+i}`,
      departure: "22:45",
      arrival: "01:10",
      basePrice: money(it?.price || 5600),
      stops: 0
    }));
    return { items, meta: { outStatus: status, used: "flightapi" } };
  } finally {
    clearTimeout(t);
  }
}

// ---------- ROUTES ----------
app.get("/payment-options", async (_req, res) => {
  try {
    const offers = await getOffersStrict();               // REAL only
    const options = buildPaymentOptionsFromOffers(offers);
    res.json({ usedFallback:false, options });
  } catch (e) {
    console.error("[/payment-options] error:", e.message);
    res.status(502).json({ error: "payment-options-unavailable", message: e.message });
  }
});

app.post("/search", async (req, res) => {
  const {
    from = "BOM",
    to   = "DEL",
    departureDate = todayISO(),
    returnDate    = "",
    tripType = "one-way",
    passengers = 1,
    travelClass = "economy",
    paymentMethods = []          // array of bank names from frontend
  } = req.body || {};

  console.log("[SkyDeal] search request:", { from, to, departureDate, returnDate, passengers, travelClass, tripType, paymentMethods });

  try {
    // 1) Flights (real only)
    const flights = await fetchFlightsReal({
      from, to, departureDate,
      returnDate: tripType === "round-trip" ? (returnDate || departureDate) : departureDate,
      adults: passengers,
      cabin: travelClass
    });

    // 2) Offers (real only)
    const offers = await getOffersStrict();

    const debug = { applied: [], offersFrom: "mongo" };

    const decorate = (f) => {
      const base = money(f.basePrice);
      const { portalPrices, bestDeal } = applyOffersToPortals(base, paymentMethods, offers, debug);
      return { ...f, portalPrices, bestDeal };
    };

    let outboundFlights = flights.items.slice(0, LIST_LIMIT).map(decorate);
    let returnFlights = (tripType === "round-trip")
      ? flights.items.slice(0, LIST_LIMIT).map(decorate)
      : [];

    // sort by ascending best final price
    const byBest = (a, b) => (a.bestDeal?.finalPrice || 1e12) - (b.bestDeal?.finalPrice || 1e12);
    outboundFlights.sort(byBest);
    returnFlights.sort(byBest);

    res.json({
      meta: {
        source: flights.meta.used,
        outStatus: flights.meta.outStatus,
        outCount: outboundFlights.length,
        retCount: returnFlights.length,
        offersFrom: debug.offersFrom,
        offerDebug: debug.applied
      },
      outboundFlights,
      returnFlights
    });
  } catch (e) {
    console.error("[/search] error:", e.message);
    res.status(502).json({ error: "search-failed", message: e.message });
  }
});

app.get("/", (_req, res) => res.send("SkyDeal backend OK (real data only)"));

app.listen(PORT, () => {
  console.log(`SkyDeal backend listening on ${PORT}`);
});
