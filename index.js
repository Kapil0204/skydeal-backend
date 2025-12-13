// index.js
import express from "express";
import cors from "cors";
import axios from "axios";
import { MongoClient } from "mongodb";

const {
  PORT = 10000,
  MONGO_URI,
  MONGODB_DB = "skydeal",
  MONGO_COL = "offers",
  FLIGHTAPI_KEY,
} = process.env;

if (!MONGO_URI) throw new Error("MONGO_URI missing");
if (!FLIGHTAPI_KEY) console.warn("[warn] FLIGHTAPI_KEY is not set");

const app = express();
app.use(express.json());

// CORS: allow your Vercel frontend and local dev
const allowlist = [
  "https://skydeal-frontend-git-main-kapils-projects-0b446913.vercel.app",
  "http://localhost:5500",
  "http://localhost:5173",
];
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (allowlist.includes(origin)) return cb(null, true);
      return cb(null, true); // keep permissive during bring-up
    },
  })
);

// ---------- Mongo bootstrap ----------
let db, offersCol, mongoClient;
async function ensureMongo() {
  if (db) return;
  mongoClient = new MongoClient(MONGO_URI, { maxPoolSize: 5 });
  await mongoClient.connect();
  db = mongoClient.db(MONGODB_DB);
  offersCol = db.collection(MONGO_COL);
  console.log(`[mongo] connected -> ${MONGODB_DB}.${MONGO_COL}`);
}
ensureMongo().catch((e) => {
  console.error("[mongo] connect error:", e.message);
  process.exit(1);
});

// ---------- Helpers ----------
const TYPE_MAP = {
  credit_card: "Credit Card",
  "Credit Card": "Credit Card",
  debit_card: "Debit Card",
  "Debit Card": "Debit Card",
  net_banking: "Net Banking",
  "Net Banking": "Net Banking",
  upi: "UPI",
  UPI: "UPI",
  wallet: "Wallet",
  Wallet: "Wallet",
};

function normType(t) {
  if (!t) return null;
  const k = String(t).trim();
  return TYPE_MAP[k] || null;
}

function cleanBankName(name) {
  if (!name) return null;
  return String(name).trim().replace(/\s+bank$/i, " Bank");
}

// Build “best deal” for a base price and chosen payment filters
function pickBestDeal(priceINR, offers = []) {
  if (!Array.isArray(offers) || !offers.length) {
    return { portal: "MakeMyTrip", finalPrice: priceINR, note: "No eligible offer" };
  }

  // Example evaluator:
  // Prefer percentage if available else flat, cap by maxDiscountAmount.
  let best = { portal: "MakeMyTrip", finalPrice: priceINR, note: "No eligible offer" };

  for (const off of offers) {
    const portal = off.portal || "MakeMyTrip";
    const pct = Number(off.discountPercent ?? 0);
    const flat = Number(off.flatDiscountAmount ?? 0);
    const cap = Number(off.maxDiscountAmount ?? 0) || Infinity;

    let discount = 0;
    if (pct > 0) discount = Math.min((priceINR * pct) / 100, cap);
    else if (flat > 0) discount = Math.min(flat, cap);

    const candidate = Math.max(0, Math.round(priceINR - discount));
    if (candidate < best.finalPrice) {
      best = {
        portal,
        finalPrice: candidate,
        note:
          pct > 0
            ? `-${pct}% (${discount.toFixed(0)})`
            : flat > 0
            ? `-₹${discount.toFixed(0)}`
            : "No eligible offer",
      };
    }
  }
  return best;
}

// Find applicable offers for filters + price
async function findApplicableOffers({ paymentFilters, basePrice }) {
  await ensureMongo();

  // Normalize filters: [{type:'Credit Card', bank:'HDFC Bank'}...]
  const wants = Array.isArray(paymentFilters) ? paymentFilters : [];

  if (!wants.length) return []; // user didn’t pick any payment methods

  const bankRegexes = [];
  const typeRegexes = [];

  for (const w of wants) {
    if (w.bank) bankRegexes.push(new RegExp(`^${w.bank}$`, "i"));
    if (w.type) {
      const t = normType(w.type);
      if (t) typeRegexes.push(new RegExp(`^${t}$`, "i"));
    }
  }

  const match = {
    $and: [
      { $or: [{ isExpired: { $exists: false } }, { isExpired: false }] },
      {
        $or: [
          { "paymentMethods.bank": { $in: bankRegexes } },
          { "parsedFields.paymentMethods.bank": { $in: bankRegexes } },
        ],
      },
      {
        $or: [
          { "paymentMethods.type": { $in: typeRegexes } },
          { "parsedFields.paymentMethods.type": { $in: typeRegexes } },
        ],
      },
      {
        $or: [
          { minTransactionValue: { $exists: false } },
          { minTransactionValue: { $lte: basePrice } },
        ],
      },
      {
        $or: [
          { offerCategories: { $exists: false } },
          { offerCategories: { $size: 0 } },
          { offerCategories: /flight/i }, // prefer flight-related
        ],
      },
    ],
  };

  const projection = {
    portal: 1,
    title: 1,
    discountPercent: 1,
    maxDiscountAmount: 1,
    flatDiscountAmount: 1,
    minTransactionValue: 1,
  };

  const found = await offersCol.find(match).project(projection).limit(50).toArray();
  return found;
}

// ---------- Payment options endpoint ----------
app.get("/payment-options", async (req, res) => {
  try {
    await ensureMongo();

    const cursor = offersCol.find(
      { $or: [{ isExpired: { $exists: false } }, { isExpired: false }] },
      { projection: { paymentMethods: 1, parsedFields: 1 } }
    );

    const buckets = {
      "Credit Card": new Set(),
      "Debit Card": new Set(),
      "Net Banking": new Set(),
      UPI: new Set(),
      Wallet: new Set(),
    };

    const push = (t, b) => {
      const T = normType(t);
      const B = cleanBankName(b);
      if (T && B && buckets[T]) buckets[T].add(B);
    };

    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      for (const arrName of ["paymentMethods", "parsedFields.paymentMethods"]) {
        const arr =
          arrName === "paymentMethods"
            ? doc.paymentMethods
            : doc?.parsedFields?.paymentMethods;
        if (!Array.isArray(arr)) continue;
        for (const pm of arr) {
          push(pm.type, pm.bank);
        }
      }
    }

    const out = Object.fromEntries(
      Object.entries(buckets).map(([k, set]) => [k, Array.from(set).sort()])
    );

    return res.json({ usedFallback: false, options: out });
  } catch (e) {
    console.error("[/payment-options] error:", e.message);
    return res.status(500).json({ error: "payment options failed" });
  }
});

// ---------- Flight search (FlightAPI.io) ----------
async function flightapiSearch({ from, to, dateFrom, dateTo, tripType, passengers, cabin }) {
  if (!FLIGHTAPI_KEY) return { meta: { outStatus: 500, retStatus: 0 }, outbound: [], ret: [] };

  // FlightAPI.io expects ISO dates. You’ve already picked ISO at the frontend now.
  // Replace with your real endpoint + params that worked previously.
  // Below is a generic round-trip pattern; if one-way, skip the return leg.
  const base = "https://api.flightapi.io/roundtrip";

  const qs = new URLSearchParams({
    cabinClass: cabin || "economy",
    passengers: String(passengers || 1),
    from,
    to,
    date: dateFrom, // yyyy-mm-dd
    ...(tripType === "round-trip" ? { returnDate: dateTo } : {}),
    currency: "INR",
    apiKey: FLIGHTAPI_KEY,
  });

  const url = `${base}?${qs.toString()}`;

  try {
    const { data } = await axios.get(url, { timeout: 18000 });

    // You may adapt mapping according to your actual payload
    const mapLeg = (item) => {
      const airlineName =
        item?.legs?.[0]?.segments?.[0]?.operatingCarrier?.name ||
        item?.legs?.[0]?.segments?.[0]?.marketingCarrier?.name ||
        "Unknown";
      const dep = item?.legs?.[0]?.departure?.time || "";
      const arr = item?.legs?.[0]?.arrival?.time || "";
      const nonStop = (item?.legs?.[0]?.segments?.length || 1) === 1;
      const stops = nonStop ? 0 : (item?.legs?.[0]?.segments?.length || 2) - 1;

      return {
        airlineName,
        departure: dep.slice(11, 16),
        arrival: arr.slice(11, 16),
        stops,
        price: Math.round(Number(item?.price?.total || 0)),
        raw: item,
      };
    };

    const outbound = Array.isArray(data?.outbound) ? data.outbound.map(mapLeg) : [];
    const ret = Array.isArray(data?.return) ? data.return.map(mapLeg) : [];

    return {
      meta: {
        outStatus: 200,
        retStatus: 200,
        outCount: outbound.length,
        retCount: ret.length,
        source: "flightapi",
      },
      outbound,
      ret,
    };
  } catch (e) {
    console.error("[flightapi] error:", e.message);
    return {
      meta: { outStatus: 500, retStatus: 0, source: "flightapi", error: e.message },
      outbound: [],
      ret: [],
    };
  }
}

app.post("/search", async (req, res) => {
  try {
    const {
      from,
      to,
      departureDate, // yyyy-mm-dd
      returnDate, // yyyy-mm-dd or empty
      tripType = "one-way",
      passengers = 1,
      travelClass = "economy",
      paymentFilters = [], // [{type:'Credit Card', bank:'HDFC Bank'}, ...]
    } = req.body || {};

    // 1) flights
    const r = await flightapiSearch({
      from,
      to,
      dateFrom: departureDate,
      dateTo: returnDate,
      tripType,
      passengers,
      cabin: travelClass,
    });

    // 2) apply offers per flight
    const apply = async (arr) => {
      const out = [];
      for (const f of arr) {
        const offers = await findApplicableOffers({
          paymentFilters,
          basePrice: Number(f.price || 0),
        });
        const bestDeal = pickBestDeal(Number(f.price || 0), offers);
        out.push({
          ...f,
          bestDeal,
        });
      }
      return out;
    };

    const outboundFlights = await apply(r.outbound || []);
    const returnFlights = tripType === "round-trip" ? await apply(r.ret || []) : [];

    return res.json({
      meta: r.meta,
      outboundFlights,
      returnFlights,
    });
  } catch (e) {
    console.error("[/search] error:", e.message);
    return res.status(500).json({ error: "search failed" });
  }
});

app.get("/", (_req, res) => res.send("SkyDeal backend OK"));
app.listen(PORT, () => console.log(`SkyDeal backend listening on ${PORT}`));
