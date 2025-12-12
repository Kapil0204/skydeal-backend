// SkyDeal backend — real FlightAPI + Mongo offers
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// ---- CORS first
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
  })
);
app.use(express.json());

// ---- ENV
// Support either MONGO_URI or MONGODB_URI to avoid naming drift
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || "";
const MONGODB_DB = process.env.MONGODB_DB || process.env.MONGO_DB || "skydeal";
const MONGO_COL = process.env.MONGO_COL || "offers";
const FLIGHTAPI_KEY = process.env.FLIGHTAPI_KEY;

// ---- Mongo client (lazy, cached)
let mongoClient = null;
let mongoDb = null;
async function ensureMongo() {
  if (mongoDb) return mongoDb;
  if (!MONGO_URI) throw new Error("MONGO_URI missing");
  mongoClient = new MongoClient(MONGO_URI, { connectTimeoutMS: 10000 });
  await mongoClient.connect();
  mongoDb = mongoClient.db(MONGODB_DB);
  return mongoDb;
}

// ---- Helpers
const money = (n) => Math.max(0, Math.round(Number(n || 0)));
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "").replace(/bank$/, "");

// ---- Pull ACTIVE (non-expired) offers from Mongo, shaped for quick matching
async function fetchActiveOffers() {
  try {
    const db = await ensureMongo();
    const col = db.collection(MONGO_COL);

    // Be generous with field names based on your schema evolution.
    const cursor = col.find({
      $or: [{ isExpired: { $exists: false } }, { isExpired: false }]
    });

    const raw = await cursor.toArray();

    // Normalize into a simple array the matcher understands
    // Expected flexible fields: portal, paymentMethods[], discountPercent/flatAmount,
    // minTransactionValue, coupon/code, etc.
    const offers = raw.map((o) => {
      const portal = o.portal || o.sourcePortal || "";
      const pm = Array.isArray(o.paymentMethods) ? o.paymentMethods : [];
      // Support both percent & flat (₹)
      const percent =
        o.discountPercent ??
        o.parsedFields?.discountPercent ??
        o.rawFields?.discountPercent ??
        null;
      const flat =
        o.maxDiscountAmount ??
        o.flatAmount ??
        o.parsedFields?.maxDiscountAmount ??
        null;

      const valueType =
        percent != null
          ? "percent"
          : flat != null
          ? "flat"
          : null;

      const value = percent != null ? Number(percent) : flat != null ? Number(flat) : 0;

      const min =
        o.minTransactionValue ??
        o.parsedFields?.minTransactionValue ??
        o.rawFields?.minTransactionValue ??
        0;

      const code =
        o.couponCode ??
        o.code ??
        o.parsedFields?.couponCode ??
        o.rawFields?.couponCode ??
        null;

      // derive [ {type:'Credit Card', bank:'HDFC Bank'} ... ]
      const pairs = pm
        .map((p) => {
          const type = p.type || p.category || p.method || "";
          const bank = p.bank || p.issuer || p.provider || "";
          if (!type || !bank) return null;
          return { type, bank };
        })
        .filter(Boolean);

      return {
        portal,
        pairs, // [{type, bank}]
        valueType, // 'percent' | 'flat' | null
        value: Number(value || 0),
        min: Number(min || 0),
        code: code || undefined,
        label:
          o.title ||
          o.rawDiscount ||
          o.parsedFields?.rawDiscount ||
          "Offer applied"
      };
    });

    return offers.filter((x) => x.portal && x.valueType && x.value > 0);
  } catch (e) {
    console.warn("[offers] fallback due to error:", e.message);
    return []; // no throw — frontend will just see no options/offers
  }
}

// Build payment-options from offers in Mongo
function buildPaymentOptionsFromOffers(offers) {
  // { 'Credit Card': Set('HDFC Bank', 'ICICI Bank'), 'UPI': Set('Any UPI') ...}
  const byCat = new Map();
  for (const ofr of offers) {
    for (const pr of ofr.pairs) {
      const cat = pr.type;
      const bank = pr.bank;
      if (!cat || !bank) continue;
      if (!byCat.has(cat)) byCat.set(cat, new Set());
      byCat.get(cat).add(bank);
    }
  }
  const out = {};
  for (const [cat, set] of byCat.entries()) {
    out[cat] = Array.from(set).sort();
  }
  return out;
}

// Apply best offer per portal given selected categories/banks
function applyOffersToPortals(base, portals, offers, selectedCats, selectedBanks) {
  const catSet = new Set((selectedCats || []).map(norm));
  const bankSet = new Set((selectedBanks || []).map(norm));

  const priced = portals.map((p) => ({ ...p })); // clone
  for (const p of priced) {
    let bestFinal = p.finalPrice;
    let bestWhy = null;

    for (const ofr of offers) {
      if (norm(ofr.portal) !== norm(p.portal)) continue;

      // check any pair matches selected
      const matches = ofr.pairs.some(
        ({ type, bank }) => catSet.has(norm(type)) && bankSet.has(norm(bank))
      );
      if (!matches) continue;

      if (base < ofr.min) continue;

      const discount =
        ofr.valueType === "percent"
          ? Math.round((Number(ofr.value) / 100) * base)
          : Number(ofr.value);

      const candidate = Math.max(0, base + p.markup - discount);
      if (candidate < bestFinal) {
        bestFinal = candidate;
        const codeStr = ofr.code ? ` (code ${ofr.code})` : "";
        bestWhy = `${ofr.label}${codeStr}`;
      }
    }

    p.finalPrice = bestFinal;
    if (bestWhy) {
      p.source = "carrier+offer+markup";
      p._why = bestWhy;
    }
  }

  // best deal
  let best = priced[0];
  for (const q of priced) if (q.finalPrice < best.finalPrice) best = q;

  return {
    portalPrices: priced,
    bestDeal: {
      portal: best.portal,
      finalPrice: best.finalPrice,
      note: best._why || "Best price after applicable offers (if any)"
    }
  };
}

// Portals list + markup policy
const OTAS = ["MakeMyTrip", "Goibibo", "EaseMyTrip", "Yatra", "Cleartrip"];
const MARKUP = 100;
function defaultPortalRows(base) {
  return OTAS.map((portal) => ({
    portal,
    basePrice: base,
    markup: MARKUP,
    finalPrice: base + MARKUP,
    source: "carrier+markup"
  }));
}

// ---- FlightAPI: roundtrip call
async function fetchFlightsFlightAPI({ from, to, departureDate, returnDate, adults, cabin }) {
  if (!FLIGHTAPI_KEY) {
    return { items: [], meta: { used: "flightapi", outStatus: 500 } };
  }

  // cabin should be economy/business/premium_economy/first
  const url = `https://api.flightapi.io/roundtrip/${FLIGHTAPI_KEY}/${from}/${to}/${departureDate}/${returnDate || departureDate}/${adults}/0/0/${cabin}/INR`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 25000);
  try {
    const r = await fetch(url, { signal: controller.signal });
    const status = r.status;
    let data = null;
    try {
      data = await r.json();
    } catch {}
    if (status !== 200 || !data) {
      return { items: [], meta: { used: "flightapi", outStatus: status } };
    }

    const carriers = (data.carriers || []).reduce((acc, c) => {
      acc[String(c.id)] = c.name;
      return acc;
    }, {});

    // Build items from itineraries, keep up to 25, sort by price asc
    const itemsRaw = (data.itineraries || []).map((it, i) => {
      const price = money(it?.price || it?.pricing_options?.[0]?.price?.amount || 0);
      // naive pick of first leg/segment for display
      const legIds = it.leg_ids || [];
      const leg = (data.legs || []).find((L) => String(L.id) === String(legIds[0]));
      const segId = leg?.segment_ids?.[0];
      const seg = (data.segments || []).find((S) => String(S.id) === String(segId));

      const airline = carriers[String(seg?.marketing_carrier_id)] || "Airline";
      const fn = seg?.marketing_carrier_flight_number
        ? `${airline.split(" ")[0]} ${seg.marketing_carrier_flight_number}`
        : "—";

      return {
        id: `I${i + 1}`,
        airlineName: airline,
        flightNumber: fn,
        departure: leg?.departure_time || "",
        arrival: leg?.arrival_time || "",
        basePrice: price,
        stops: (leg?.stop_count ?? 0)
      };
    });

    const items = itemsRaw
      .filter((x) => x.basePrice > 0)
      .sort((a, b) => a.basePrice - b.basePrice)
      .slice(0, 25);

    return { items, meta: { used: "flightapi", outStatus: status } };
  } catch (e) {
    return { items: [], meta: { used: "flightapi", outStatus: 500 } };
  } finally {
    clearTimeout(t);
  }
}

// ---- Routes

// Payment options from Mongo
app.get("/payment-options", async (_req, res) => {
  try {
    const offers = await fetchActiveOffers();
    const options = buildPaymentOptionsFromOffers(offers);
    res.json({ usedFallback: false, options, counts: { offers: offers.length } });
  } catch (e) {
    // Never throw to client; show empty set
    res.json({ usedFallback: true, options: {}, error: e.message });
  }
});

// Main search
app.post("/search", async (req, res) => {
  const {
    from = "BOM",
    to = "DEL",
    departureDate,
    returnDate,
    tripType = "one-way",
    passengers = 1,
    travelClass = "economy",
    // expect from frontend:
    paymentCategories = [],
    paymentBanks = []
  } = req.body || {};

  // flights
  const real = await fetchFlightsFlightAPI({
    from,
    to,
    departureDate,
    returnDate: tripType === "round-trip" ? (returnDate || departureDate) : "",
    adults: passengers,
    cabin: travelClass
  });

  // offers + decorate (no throw if Mongo absent)
  const offers = await fetchActiveOffers();

  const outboundFlights = real.items
    .map((f) => {
      const base = money(f.basePrice);
      const defaultRows = defaultPortalRows(base);
      const { portalPrices, bestDeal } = applyOffersToPortals(
        base,
        defaultRows,
        offers,
        paymentCategories,
        paymentBanks
      );
      return { ...f, portalPrices, bestDeal };
    })
    .sort((a, b) => a.bestDeal.finalPrice - b.bestDeal.finalPrice);

  const returnFlights =
    tripType === "round-trip"
      ? outboundFlights.slice(0, 25) // mirror list for now; if you fetch separate returns, apply here
      : [];

  res.json({
    meta: {
      source: real.meta.used,
      outStatus: real.meta.outStatus,
      outCount: outboundFlights.length,
      retCount: returnFlights.length
    },
    outboundFlights,
    returnFlights
  });
});

app.get("/", (_req, res) => res.send("SkyDeal backend OK"));

app.listen(PORT, () => {
  console.log(`SkyDeal backend listening on ${PORT}`);
});
