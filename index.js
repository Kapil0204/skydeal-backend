// index.js — SkyDeal backend (real-only, resilient)
// RUN: node index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// ===== CORS (single declaration) =====
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));
app.use(express.json());

// ===== ENV =====
const {
  MONGODB_URI,
  MONGODB_DB        = "skydeal",
  MONGODB_COLLECTION= "offers",
  FLIGHTAPI_KEY,
} = process.env;

// ===== Helpers =====
const money = (n) => Math.max(0, Math.round(Number(n || 0)));
const todayISO = () => new Date().toISOString().slice(0,10);
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");

let _mongoClient = null;
async function getDb() {
  if (!_mongoClient) {
    _mongoClient = new MongoClient(MONGODB_URI, { ignoreUndefined: true });
    await _mongoClient.connect();
  }
  return _mongoClient.db(MONGODB_DB);
}

// ===== Payment catalog from Mongo =====
// Expects offers to have a field like paymentMethods[] with objects:
//   { type: "Credit Card"|"Debit Card"|"Net Banking"|"UPI"|"Wallet"|"EMI", bank: "HDFC Bank", ... }
async function computePaymentCatalogFromOffers() {
  try {
    if (!MONGODB_URI) throw new Error("MONGODB_URI missing");
    const db = await getDb();
    const col = db.collection(MONGODB_COLLECTION);

    const cursor = col.aggregate([
      { $match: { isExpired: { $ne: true } } },
      { $unwind: "$paymentMethods" },
      {
        $group: {
          _id: { type: "$paymentMethods.type", bank: "$paymentMethods.bank" }
        }
      }
    ]);

    const byType = new Map(); // Map<string, Set<string>>
    for await (const d of cursor) {
      const type = d._id?.type || "Other";
      const bank = d._id?.bank || "Unknown";
      if (!byType.has(type)) byType.set(type, new Set());
      byType.get(type).add(bank);
    }

    // Normalize to object of arrays (stable tab order expected by frontend)
    const TAB_ORDER = ["Credit Card", "Debit Card", "Net Banking", "UPI", "Wallet", "EMI"];
    const out = {};
    for (const t of TAB_ORDER) {
      out[t] = Array.from(byType.get(t) || []);
    }
    // include any extra types we might have skipped
    for (const [t, set] of byType.entries()) {
      if (!(t in out)) out[t] = Array.from(set);
    }
    return out;
  } catch (err) {
    console.error("[/payment-options] compute error:", err.message);
    // Return empty catalog rather than throwing (prevents 502)
    return {};
  }
}

// ===== Offer fetcher (only what we need for matching) =====
// We match by portal and by selected payment method(s)
async function fetchOffersFor(portalList = [], selectedBanks = []) {
  try {
    if (!MONGODB_URI) throw new Error("MONGODB_URI missing");
    const db = await getDb();
    const col = db.collection(MONGODB_COLLECTION);

    // We match if ANY of a flight's portal exists in the offer portals,
    // and the payment method (bank) is present (by bank or generic like UPI/Wallet).
    const query = {
      isExpired: { $ne: true },
      parsedApplicablePlatforms: { $in: portalList } // e.g. ["MakeMyTrip","Goibibo",...]
    };

    // If user picked payment options, we filter offers that mention those banks OR have generic matches
    // We look inside paymentMethods[].bank and paymentMethods[].type
    if (selectedBanks.length) {
      query.$or = [
        { "paymentMethods.bank": { $in: selectedBanks } },
        { "paymentMethods.type": { $in: selectedBanks } } // for generic "UPI"/"Wallet" picks
      ];
    }

    const fields = {
      title: 1,
      portal: 1,
      parsedApplicablePlatforms: 1,
      paymentMethods: 1,
      discountPercent: 1,
      flatAmount: 1,
      maxDiscountAmount: 1,
      minTransactionValue: 1,
      couponRequired: 1,
      couponCode: 1,
    };

    const docs = await col.find(query, { projection: fields }).limit(500).toArray();

    // Flatten to a per-portal bucket
    const byPortal = {};
    for (const doc of docs) {
      const portals = Array.isArray(doc.parsedApplicablePlatforms) ? doc.parsedApplicablePlatforms : [];
      for (const p of portals) {
        if (!byPortal[p]) byPortal[p] = [];
        byPortal[p].push(doc);
      }
    }
    return byPortal;
  } catch (err) {
    console.error("[/search] fetchOffersFor error:", err.message);
    return {}; // do not throw
  }
}

// ===== Offer application =====
function applyOffersFromMongo(basePrice, portal, offersForPortal = [], selectedBanks = []) {
  // Pick the best single offer that the user qualifies for
  let best = { portal, finalPrice: money(basePrice), source: "carrier" };
  let why  = null;

  for (const o of offersForPortal) {
    // Check payment method match
    let qualifies = false;
    if (!selectedBanks.length) {
      qualifies = true; // if user didn't pick any payment method, don't apply any (but allow neutral offers)
    } else {
      const banks = (o.paymentMethods || []).map(x => x?.bank || x?.type).filter(Boolean);
      qualifies = banks.some(b => selectedBanks.includes(b));
    }
    if (!qualifies) continue;

    // Compute discount
    const minTxn = money(o.minTransactionValue);
    if (minTxn && basePrice < minTxn) continue;

    let discount = 0;
    if (o.discountPercent) {
      discount = Math.round((Number(o.discountPercent) / 100) * basePrice);
    } else if (o.flatAmount) {
      discount = money(o.flatAmount);
    }
    if (o.maxDiscountAmount) discount = Math.min(discount, money(o.maxDiscountAmount));

    const candidate = money(basePrice - discount);
    if (candidate < best.finalPrice) {
      best = {
        portal,
        finalPrice: candidate,
        source: "carrier+offer"
      };
      const code = o.couponRequired && o.couponCode ? ` (code ${o.couponCode})` : "";
      why = `${o.title || "Offer"}${code}`;
    }
  }

  return { best, why };
}

// ===== Real flight fetch via FlightAPI.io =====
async function fetchFlightsFlightAPI({ from, to, departureDate, returnDate, adults = 1, cabin = "economy" }) {
  if (!FLIGHTAPI_KEY) throw new Error("FLIGHTAPI_KEY missing");

  // NOTE: roundtrip endpoint; for one-way we’ll still pass same date twice so it works.
  const url = `https://api.flightapi.io/roundtrip/${FLIGHTAPI_KEY}/${from}/${to}/${departureDate}/${returnDate || departureDate}/${adults}/0/0/${cabin}/INR`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);

  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const status = r.status;
    let j = null;
    try { j = await r.json(); } catch {}
    if (status !== 200 || !j) throw new Error(`flightapi ${status}`);

    // Normalize (take up to 25)
    const items = (j.itineraries || []).slice(0, 25).map((it, i) => ({
      id: `F${i+1}`,
      airlineName: (j.carriers?.[0]?.name) || "Airline",
      flightNumber: it?.id || `FL${1000+i}`,
      departure: "—",
      arrival: "—",
      basePrice: money(it?.price ?? it?.pricing_options?.[0]?.price?.amount ?? 0),
      stops: 0
    }));

    return { items, meta: { used: "flightapi", outStatus: status } };
  } finally {
    clearTimeout(t);
  }
}

// ===== ROUTES =====

// Payment methods (from Mongo). 200 with {} if empty.
app.get("/payment-options", async (_req, res) => {
  const catalog = await computePaymentCatalogFromOffers();
  res.json({ usedFallback: false, options: catalog });
});

// Search flights + apply Mongo offers.
// Always 200 with arrays; never throw.
app.post("/search", async (req, res) => {
  const {
    from = "BOM",
    to   = "DEL",
    departureDate = todayISO(),
    returnDate    = "",
    tripType = "one-way",
    passengers = 1,
    travelClass = "economy",
    paymentMethods = []   // human names from frontend (e.g., "HDFC Bank", "UPI")
  } = req.body || {};

  const meta = { source: null, outStatus: null, outCount: 0, retCount: 0, offerDebug: {} };

  // 1) Flights
  let data = { items: [], meta: { used: "none", outStatus: 200 } };
  try {
    data = await fetchFlightsFlightAPI({
      from, to, departureDate,
      returnDate: tripType === "round-trip" ? (returnDate || departureDate) : departureDate,
      adults: passengers,
      cabin: travelClass
    });
  } catch (e) {
    console.error("[/search] flight fetch error:", e.message);
    // real-only: keep items empty but respond 200
    data = { items: [], meta: { used: "flightapi-error", outStatus: 200 } };
  }

  // 2) Offers (per-portal)
  const OTAS = ["MakeMyTrip", "Goibibo", "EaseMyTrip", "Yatra", "Cleartrip"];
  const offersByPortal = await fetchOffersFor(OTAS, paymentMethods);

  const decorate = (f) => {
    // price per portal using Mongo offers
    const portalRows = OTAS.map((p) => {
      const { best, why } = applyOffersFromMongo(f.basePrice, p, offersByPortal[p] || [], paymentMethods);
      return { portal: p, basePrice: f.basePrice, finalPrice: best.finalPrice, source: best.source, _why: why || "" };
    });
    // pick best
    let best = portalRows[0];
    for (const r of portalRows) if (r.finalPrice < best.finalPrice) best = r;

    return {
      ...f,
      portalPrices: portalRows,
      bestDeal: { portal: best.portal, finalPrice: best.finalPrice, note: best._why || "Best price after applicable offers (if any)" }
    };
  };

  const outboundFlights = data.items
    .sort((a,b) => a.basePrice - b.basePrice)
    .slice(0, 25)
    .map(decorate);

  const returnFlights = tripType === "round-trip"
    ? data.items
        .sort((a,b) => a.basePrice - b.basePrice)
        .slice(0, 25)
        .map(decorate)
    : [];

  meta.source   = data.meta.used;
  meta.outStatus= data.meta.outStatus;
  meta.outCount = outboundFlights.length;
  meta.retCount = returnFlights.length;

  res.json({ meta, outboundFlights, returnFlights });
});

app.get("/", (_req, res) => res.send("SkyDeal backend OK"));

app.listen(PORT, () => {
  console.log(`SkyDeal backend listening on ${PORT}`);
});
