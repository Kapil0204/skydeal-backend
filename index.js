// index.js — SkyDeal backend (Express + Mongo + FlightAPI, ESM)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// ====== ENV ======
const MONGO_URI  = process.env.MONGO_URI;      // e.g. mongodb://user:pass@host:27017/skydeal?authSource=admin
const MONGODB_DB = process.env.MONGODB_DB;     // e.g. skydeal
const MONGO_COL  = process.env.MONGO_COL;      // e.g. offers
const FLIGHTAPI_KEY = process.env.FLIGHTAPI_KEY; // FlightAPI.io API key
const CURRENCY = "INR";
const REGION   = "IN";
const OTA_MARKUP = 100; // fixed ₹ markup per OTA, as requested
const OTAS = ["MakeMyTrip","Goibibo","EaseMyTrip","Yatra","Cleartrip"];

// ====== APP MIDDLEWARE ======
app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type"] }));
app.use(express.json());

// ====== MONGO CLIENT ======
let mongoClient;
let offersCol;

async function ensureMongo() {
  if (!MONGO_URI) throw new Error("MONGO_URI missing");
  if (!MONGODB_DB) throw new Error("MONGODB_DB missing");
  if (!MONGO_COL)  throw new Error("MONGO_COL missing");
  if (offersCol) return;

  mongoClient = new MongoClient(MONGO_URI, { ignoreUndefined: true });
  await mongoClient.connect();
  const db = mongoClient.db(MONGODB_DB);
  offersCol = db.collection(MONGO_COL);

  console.log("[mongo] connected",
    { db: MONGODB_DB, col: MONGO_COL, uriHost: new URL(MONGO_URI.replace("mongodb://","mongodb://x:x@")).host });
}

// ====== HEALTH ======
app.get("/health", async (_req, res) => {
  try {
    await ensureMongo();
    const ping = await mongoClient.db(MONGODB_DB).command({ ping: 1 });
    res.json({ ok: true, mongo: ping.ok === 1, flightapiKey: !!FLIGHTAPI_KEY });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ====== PAYMENT OPTIONS (from Mongo) ======
// Expected doc shape (flexible):
// {
//   ...,
//   isExpired: false,
//   paymentMethods: [
//     { type: "Credit Card"|"Debit Card"|"Net Banking"|"UPI"|"Wallet"|"EMI", bank: "HDFC Bank" | "Any UPI" | ... },
//     ...
//   ],
//   portal: "MakeMyTrip" | ...
// }
app.get("/payment-options", async (_req, res) => {
  try {
    await ensureMongo();

    // Pull all active (non-expired) payment method pairs and group by type
    const pipeline = [
      { $match: { isExpired: { $ne: true } } },
      { $unwind: "$paymentMethods" },
      { $match: { "paymentMethods.type": { $in: ["Credit Card","Debit Card","Net Banking","UPI","Wallet","EMI"] } } },
      { $group: {
          _id: "$paymentMethods.type",
          banks: { $addToSet: "$paymentMethods.bank" }
      }},
      { $project: { _id: 0, type: "$_id", banks: 1 } }
    ];

    const rows = await offersCol.aggregate(pipeline).toArray();

    const options = {};
    for (const r of rows) {
      // Clean + sort
      const unique = (r.banks || []).filter(Boolean).sort((a,b)=>a.localeCompare(b));
      options[r.type] = unique;
    }

    console.log("[/payment-options]", {
      types: Object.keys(options).length,
      paymentTypesCount: Object.keys(options).length,
    });

    return res.json({ usedFallback: false, options });
  } catch (e) {
    console.error("[/payment-options] error:", e.message);
    return res.status(502).json({ error: "Failed to load payment options", detail: e.message });
  }
});

// ====== FLIGHTAPI ======
function iso(d) { return (d || "").slice(0,10); }

async function fetchFlightAPI({ from, to, departureDate, returnDate, tripType, adults, cabin }) {
  if (!FLIGHTAPI_KEY) throw new Error("FLIGHTAPI_KEY missing");

  const dep = iso(departureDate);
  const ret = iso(returnDate || departureDate);
  const a = adults || 1;
  const cab = (cabin || "economy").toLowerCase();

  let url;
  if (tripType === "round-trip") {
    url = `https://api.flightapi.io/roundtrip/${FLIGHTAPI_KEY}/${from}/${to}/${dep}/${ret}/${a}/0/0/${cab}/${CURRENCY}?region=${REGION}`;
  } else {
    // one-way
    url = `https://api.flightapi.io/oneway/${FLIGHTAPI_KEY}/${from}/${to}/${dep}/${a}/0/0/${cab}/${CURRENCY}?region=${REGION}`;
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);

  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const status = r.status;
    let j = null;
    try { j = await r.json(); } catch {}
    if (status !== 200 || !j) throw new Error(`flightapi ${status}`);

    // Normalize (be lenient with shapes that FlightAPI returns)
    const its = Array.isArray(j.itineraries) ? j.itineraries : [];
    const carriersIndex = (j.carriers || []).reduce((acc, c) => {
      if (c && typeof c.id !== "undefined") acc[String(c.id)] = c.name || "Airline";
      return acc;
    }, {});

    // Build list (price asc), cap 25
    const items = its
      .map((it, i) => {
        const legId = (it.leg_ids && it.leg_ids[0]) || "";
        const leg = (j.legs || []).find(L => L.id === legId) || {};
        const segId = (leg.segment_ids && leg.segment_ids[0]) || "";
        const seg = (j.segments || []).find(S => S.id === segId) || {};
        const carrierName = carriersIndex[String(seg.marketing_carrier_id)] || "Airline";

        const price = Number(it.price || it.booking_price || 0);
        const depTime = (leg.departure_time || "").slice(11,16) || "00:00";
        const arrTime = (leg.arrival_time || "").slice(11,16) || "00:00";
        const stops = Math.max(0, (leg.stop_count ?? (leg.segment_ids ? leg.segment_ids.length - 1 : 0)));

        return {
          id: `F${i+1}`,
          airlineName: carrierName,
          flightNumber: String(it.id || seg.flight_number || ""),
          departure: depTime,
          arrival: arrTime,
          basePrice: Math.round(price) || 0,
          stops
        };
      })
      .filter(x => x.basePrice > 0)
      .sort((a,b) => a.basePrice - b.basePrice)
      .slice(0, 25);

    return { items, meta: { used: "flightapi", outStatus: 200 } };
  } finally {
    clearTimeout(t);
  }
}

// ====== OFFERS (Mongo) ======
const norm = s => String(s||"").toLowerCase().replace(/\s+/g, "").replace(/bank$/,"");

async function fetchApplicableOffers({ banksSelected = [] }) {
  await ensureMongo();

  // match if ANY of the selected banks appears in paymentMethods.bank (case-insensitive)
  const bankSet = new Set(banksSelected.map(b => norm(b)));
  const matchStage = bankSet.size
    ? { $match: { isExpired: { $ne: true }, "paymentMethods.bank": { $exists: true, $ne: null } } }
    : { $match: { _id: { $exists: true }, isExpired: { $ne: true } } }; // no selection; returns all active

  const rows = await offersCol.aggregate([
    matchStage,
    { $project: {
        portal: 1,
        title: 1,
        minTransactionValue: { $ifNull: ["$minTransactionValue", 0] },
        discountPercent: { $ifNull: ["$discountPercent", 0] },
        maxDiscountAmount: { $ifNull: ["$maxDiscountAmount", 0] },
        discountFlat: { $ifNull: ["$discountFlat", 0] },
        paymentMethods: 1
    }},
  ]).toArray();

  // Filter again in JS for bank names (lenient)
  const filtered = rows.filter(doc => {
    if (!bankSet.size) return true;
    const pms = Array.isArray(doc.paymentMethods) ? doc.paymentMethods : [];
    const banks = pms.map(x => norm(x?.bank));
    return banks.some(b => bankSet.has(b) || bankSet.has("anyupi") && b === norm("Any UPI"));
  });

  return filtered;
}

function applyOffers(base, offers) {
  const portals = OTAS.map(p => ({
    portal: p,
    basePrice: base,
    finalPrice: base + OTA_MARKUP,
    source: "carrier+markup"
  }));

  for (const p of portals) {
    const pot = offers.filter(o => (o.portal || "").toLowerCase() === p.portal.toLowerCase());
    for (const ofr of pot) {
      const minOk = base >= (Number(ofr.minTransactionValue) || 0);
      if (!minOk) continue;

      const pct = Number(ofr.discountPercent) || 0;
      const flat = Number(ofr.discountFlat) || 0;
      let discount = 0;

      if (pct > 0) {
        discount = Math.round((pct / 100) * base);
        const cap = Number(ofr.maxDiscountAmount) || 0;
        if (cap > 0) discount = Math.min(discount, cap);
      }
      if (flat > 0) discount = Math.max(discount, flat); // take stronger one (simple rule)

      if (discount > 0) {
        p.finalPrice = Math.max(0, base + OTA_MARKUP - discount);
        p.source = "carrier+offer+markup";
      }
    }
  }

  // pick best
  let best = portals[0];
  for (const x of portals) if (x.finalPrice < best.finalPrice) best = x;
  return { portalPrices: portals, bestDeal: { portal: best.portal, finalPrice: best.finalPrice, note: "Best price after applicable offers (if any)" } };
}

// ====== SEARCH ======
app.post("/search", async (req, res) => {
  try {
    const {
      from = "BOM",
      to = "DEL",
      departureDate,
      returnDate,
      tripType = "one-way",
      passengers = 1,
      travelClass = "economy",
      paymentMethods = [] // array of selected BANK NAMES from frontend
    } = req.body || {};

    console.log("[search] req", {
      from, to, departureDate, returnDate, passengers, travelClass, tripType,
      paymentBanks: Array.isArray(paymentMethods) ? paymentMethods.length : 0
    });

    const flights = await fetchFlightAPI({
      from: String(from).toUpperCase(),
      to: String(to).toUpperCase(),
      departureDate,
      returnDate,
      tripType,
      adults: passengers,
      cabin: travelClass
    });

    // fetch offers from Mongo only once per search
    const offers = await fetchApplicableOffers({ banksSelected: paymentMethods });

    const decorate = (f) => {
      const base = Number(f.basePrice) || 0;
      const { portalPrices, bestDeal } = applyOffers(base, offers);
      return { ...f, portalPrices, bestDeal };
    };

    // same list used for both directions (FlightAPI returns combined pricing).
    const outboundFlights = (flights.items || []).map(decorate);
    const returnFlights   = (tripType === "round-trip") ? (flights.items || []).map(decorate) : [];

    return res.json({
      meta: {
        source: flights.meta.used,
        outStatus: flights.meta.outStatus,
        outCount: outboundFlights.length,
        retCount: returnFlights.length,
        offerDebug: { offersMatched: offers.length }
      },
      outboundFlights,
      returnFlights
    });
  } catch (e) {
    console.error("[/search] error:", e.message);
    res.status(502).json({ error: "Search failed", detail: e.message });
  }
});

app.get("/", (_req, res) => res.send("SkyDeal backend OK"));

app.listen(PORT, () => {
  console.log(`SkyDeal backend listening on ${PORT}`);
});
