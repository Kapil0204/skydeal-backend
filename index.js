// index.js (ESM)
// Node 18+ has global fetch; no need for node-fetch.
// Make sure your Render runtime is Node 18+ (it is currently Node 25 per logs).

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------
// Env / Config
// ---------------------------
const PORT = process.env.PORT || 10000;
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || "";
const FLIGHTAPI_KEY = process.env.FLIGHTAPI_KEY || process.env.FLIGHT_API_KEY || ""; // support both names
const FLIGHTAPI_BASE = "https://api.flightapi.io";
const INR_MARKUP = 250;

// Simple reusable Mongo connection helper
async function withMongo(fn) {
  if (!MONGO_URI) throw new Error("MONGO_URI not set");
  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    const db = client.db("skydeal"); // safe even though db is in URI
    return await fn(db, client);
  } finally {
    await client.close().catch(() => {});
  }
}

// ---------------------------
/** Utilities */
// ---------------------------
function titleCase(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\bHdfc\b/g, "HDFC")
    .replace(/\bIcici\b/g, "ICICI")
    .replace(/\bIdfc\b/g, "IDFC")
    .replace(/\bSbi\b/g, "SBI")
    .replace(/\bAu\b/g, "AU");
}

function pad2(n) {
  return n.toString().padStart(2, "0");
}

function formatTime(iso) {
  // iso like 2025-12-20T23:30:00
  if (!iso || typeof iso !== "string") return "";
  const t = iso.split("T")[1];
  if (!t) return "";
  const [hh, mm] = t.split(":");
  return `${hh}:${mm}`;
}

// pick real "carrier site" name from carrier record
function getCarrierName(car) {
  if (!car) return "Unknown";
  return car.name || car.display_code || car.alternate_id || "Unknown";
}

// For “carrier website” mapping (basic keyword list per airline to show intent)
const CARRIER_KEYWORDS = {
  // keys are airline IATA-ish marketing code strings we’ll derive later if available
  // fallback list stays generic; real linking isn’t implemented yet—only labeling "carrier+markup"
};

// Build the outbound API URL
function buildFlightapiRoundtripUrl({
  apiKey,
  from,
  to,
  departureDate,
  returnDate,
  passengers,
  travelClass,
}) {
  const cabin = (travelClass || "economy").toLowerCase(); // economy | business | etc.
  // FlightAPI format:
  // /roundtrip/<APIKEY>/<FROM>/<TO>/<DEPART>/<RETURN>/<adults>/<children>/<infants>/<cabin>/<currency>?region=IN
  return `${FLIGHTAPI_BASE}/roundtrip/${apiKey}/${from}/${to}/${departureDate}/${returnDate}/${passengers || 1}/0/0/${cabin}/INR?region=IN`;
}

async function safeFetchJson(url, { timeoutMs = 20000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal });
    const status = r.status;
    let data = null;
    try {
      data = await r.json();
    } catch {
      // sometimes FlightAPI throws HTML error—bubble up
      const txt = await r.text();
      throw new Error(`Non-JSON response (status ${status}): ${txt.slice(0, 200)}`);
    }
    return { status, data };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Extract simplified flights from FlightAPI response:
 * We:
 * - Join itineraries → legs → first segment → marketing carrier
 * - Take first pricing option’s amount
 * - Create 5 “portalPrices” = base + ₹250 (carrier+markup)
 */
function extractFlights(fa) {
  if (!fa || !fa.itineraries || !fa.legs || !fa.segments || !fa.carriers) return [];

  const byId = (arr = []) => {
    const m = new Map();
    for (const it of arr) m.set(String(it.id), it);
    return m;
  };

  const legsById = byId(fa.legs);
  const segById = byId(fa.segments);
  const carriersById = byId(fa.carriers);

  const portals = ["MakeMyTrip", "Goibibo", "EaseMyTrip", "Yatra", "Cleartrip"];

  const flights = [];

  for (const it of fa.itineraries) {
    if (!it || !it.leg_ids || !it.leg_ids.length) continue;

    const leg = legsById.get(String(it.leg_ids[0]));
    if (!leg || !leg.segment_ids || !leg.segment_ids.length) continue;

    const seg0 = segById.get(String(leg.segment_ids[0]));
    if (!seg0) continue;

    const carrier = carriersById.get(String(seg0.marketing_carrier_id));
    const airlineName = getCarrierName(carrier);
    const number = seg0.number != null ? String(seg0.number) : "";
    const flightNumber = `${airlineName} ${number}`.trim();

    // First price (FlightAPI shape often has pricing_options[])
    let basePrice = null;
    if (Array.isArray(it.pricing_options) && it.pricing_options[0]?.price?.amount != null) {
      basePrice = Number(it.pricing_options[0].price.amount);
    } else if (it.price?.amount != null) {
      basePrice = Number(it.price.amount);
    }

    if (basePrice == null || Number.isNaN(basePrice)) continue;

    const portalPrices = portals.map((p) => ({
      portal: p,
      basePrice,
      finalPrice: basePrice + INR_MARKUP,
      source: "carrier+markup", // explicitly indicate we used carrier price + markup
    }));

    flights.push({
      flightNumber, // e.g., "IndiGo 6E123" or "Air India 123"
      airlineName,
      departure: formatTime(leg.departure),
      arrival: formatTime(leg.arrival),
      price: String(basePrice),
      stops: Math.max(0, (leg.segment_ids?.length || 1) - 1),
      carrierCode: String(seg0.marketing_carrier_id || ""),
      portalPrices,
    });
  }

  return flights;
}

// ---------------------------
// Routes
// ---------------------------

// Health
app.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Payment options (LIVE from Mongo, normalized)
const TYPE_MAP = new Map([
  // CreditCard
  ["credit card", "CreditCard"],
  ["credit_card", "CreditCard"],
  ["creditcards", "CreditCard"],
  ["credit", "CreditCard"],
  // DebitCard
  ["debit card", "DebitCard"],
  ["debit_card", "DebitCard"],
  ["debit", "DebitCard"],
  // Wallet
  ["wallet", "Wallet"],
  ["wallets", "Wallet"],
  // UPI
  ["upi", "UPI"],
  // NetBanking
  ["internet banking", "NetBanking"],
  ["net banking", "NetBanking"],
  ["net_banking", "NetBanking"],
  ["netbanking", "NetBanking"],
  ["online", "NetBanking"],
  // EMI
  ["emi", "EMI"],
  // Ignore
  ["bank offer", null],
  ["any", null],
  ["other", null],
]);

function normType(raw) {
  if (!raw) return null;
  const k = String(raw).trim().toLowerCase();
  if (TYPE_MAP.has(k)) return TYPE_MAP.get(k);
  const loose = k.replace(/[_\s]+/g, " ");
  if (TYPE_MAP.has(loose)) return TYPE_MAP.get(loose);
  return null;
}

app.get("/payment-options", async (_req, res) => {
  if (!MONGO_URI) {
    return res.json({
      usedFallback: true,
      options: { CreditCard: [], DebitCard: [], Wallet: [], UPI: [], NetBanking: [], EMI: [] },
      error: "no-mongo-uri",
    });
  }

  try {
    const out = await withMongo(async (db) => {
      const coll = db.collection("offers");
      const cursor = coll.aggregate([
        { $match: { isExpired: { $ne: true } } },
        { $unwind: "$paymentMethods" },
        {
          $project: {
            type: { $toLower: { $ifNull: ["$paymentMethods.type", ""] } },
            bank: { $ifNull: ["$paymentMethods.bank", ""] },
            method: { $ifNull: ["$paymentMethods.method", ""] },
            wallet: { $ifNull: ["$paymentMethods.wallet", ""] },
            category: { $ifNull: ["$paymentMethods.category", ""] },
            mode: { $ifNull: ["$paymentMethods.mode", ""] },
          },
        },
        {
          $addFields: {
            rawSubtype: {
              $trim: {
                input: {
                  $ifNull: [
                    "$bank",
                    {
                      $ifNull: [
                        "$method",
                        { $ifNull: ["$wallet", { $ifNull: ["$category", "$mode"] }] },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
        { $match: { rawSubtype: { $type: "string", $ne: "" } } },
        {
          $group: {
            _id: { type: "$type", subtype: { $toLower: "$rawSubtype" } },
            count: { $sum: 1 },
          },
        },
      ]);

      const buckets = {
        CreditCard: new Map(),
        DebitCard: new Map(),
        Wallet: new Map(),
        UPI: new Map(),
        NetBanking: new Map(),
        EMI: new Map(),
      };

      for await (const doc of cursor) {
        const uiType = normType(doc?._id?.type);
        if (!uiType) continue;
        const subKey = doc?._id?.subtype || "";
        if (!subKey) continue;
        const prev = buckets[uiType].get(subKey) || 0;
        if (doc.count > prev) buckets[uiType].set(subKey, doc.count);
      }

      const options = {};
      for (const [k, map] of Object.entries(buckets)) {
        const arr = [...map.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([sub]) => titleCase(sub));
        options[k] = arr;
      }

      return { usedFallback: false, options };
    });

    res.json(out);
  } catch (e) {
    console.error("[/payment-options] error:", e);
    res.json({
      usedFallback: true,
      options: { CreditCard: [], DebitCard: [], Wallet: [], UPI: [], NetBanking: [], EMI: [] },
      error: "fallback",
    });
  }
});

// Debug FlightAPI (dry shows URL only; live hits API and returns top-level keys)
app.post("/debug-flightapi", async (req, res) => {
  try {
    const { from, to, departureDate, returnDate, passengers = 1, travelClass = "economy" } = req.body || {};
    const dry = String(req.query.dry || "").trim() === "1" || String(req.query.dry || "").trim().toLowerCase() === "true";

    if (!from || !to || !departureDate || !returnDate) {
      return res.json({ ok: false, error: "missing-params" });
    }

    if (!FLIGHTAPI_KEY) {
      return res.json({ ok: false, error: "no-api-key" });
    }

    const url = buildFlightapiRoundtripUrl({
      apiKey: FLIGHTAPI_KEY,
      from,
      to,
      departureDate,
      returnDate,
      passengers,
      travelClass,
    });

    if (dry) {
      return res.json({ ok: true, url, mode: "dry" });
    }

    const { status, data } = await safeFetchJson(url, { timeoutMs: 25000 });
    const keys = data ? Object.keys(data) : [];
    const hasItin = !!(data && Array.isArray(data.itineraries) && data.itineraries.length);
    return res.json({ ok: status === 200, status, keys, hasItin, error: null });
  } catch (e) {
    if (e.name === "AbortError") {
      return res.json({ ok: false, status: 0, keys: [], hasItin: false, error: "timeout" });
    }
    console.error("debug-flightapi error:", e);
    return res.json({ ok: false, status: null, keys: null, hasItin: null, error: e.message || "error" });
  }
});

// Main search
app.post("/search", async (req, res) => {
  try {
    const {
      from,
      to,
      departureDate,
      returnDate,
      passengers = 1,
      travelClass = "economy",
      paymentMethods = [],
    } = req.body || {};

    // dry mode (for UI testing)
    const isDry =
      String(req.query.dry || "").trim() === "1" ||
      String(req.query.dry || "").trim().toLowerCase() === "true";

    if (!from || !to || !departureDate || !returnDate) {
      return res.status(200).json({
        outboundFlights: [],
        returnFlights: [],
        meta: { source: "flightapi", reason: "missing-params" },
      });
    }

    if (isDry) {
      // fixed sample (stable for frontend testing)
      return res.json({
        outboundFlights: [
          {
            flightNumber: "6E 123",
            airlineName: "IndiGo",
            departure: "10:00",
            arrival: "12:15",
            price: "12345",
            stops: 0,
            carrierCode: "32213",
            portalPrices: ["MakeMyTrip", "Goibibo", "EaseMyTrip", "Yatra", "Cleartrip"].map((p) => ({
              portal: p,
              basePrice: 12345,
              finalPrice: 12345 + INR_MARKUP,
              source: "carrier+markup",
            })),
          },
        ],
        returnFlights: [],
        meta: { source: "dry" },
      });
    }

    if (!FLIGHTAPI_KEY) {
      return res.json({
        outboundFlights: [],
        returnFlights: [],
        meta: { source: "flightapi", reason: "no-key" },
      });
    }

    const url = buildFlightapiRoundtripUrl({
      apiKey: FLIGHTAPI_KEY,
      from,
      to,
      departureDate,
      returnDate,
      passengers,
      travelClass,
    });

    const { status, data } = await safeFetchJson(url, { timeoutMs: 25000 });
    if (status !== 200 || !data || !Array.isArray(data.itineraries) || !data.itineraries.length) {
      return res.json({
        outboundFlights: [],
        returnFlights: [],
        meta: { source: "flightapi", reason: "no-itineraries" },
      });
    }

    // Extract all flights (FlightAPI roundtrip returns combined list; we can later split by leg direction if needed)
    const flights = extractFlights(data);

    // Basic split by “is this likely outbound or return” using dates
    const depDateStr = String(departureDate);
    const retDateStr = String(returnDate);

    const outboundFlights = flights.filter((f) => f.departure && depDateStr && true /* keep all for now */);
    const returnFlights = flights.filter((f) => f.departure && retDateStr && false /* none for now */);

    return res.json({
      outboundFlights,
      returnFlights,
      meta: { source: "flightapi" },
    });
  } catch (e) {
    console.error("❌ Search error:", e);
    return res.status(200).json({
      outboundFlights: [],
      returnFlights: [],
      error: "search-failed",
    });
  }
});

// ---------------------------
// Startup
// ---------------------------
(async () => {
  // Mongo quick check (non-fatal if missing)
  if (!MONGO_URI) {
    console.warn("❌ Missing MONGO_URI");
  } else {
    try {
      await withMongo(async (db) => {
        const cnt = await db.collection("offers").countDocuments({});
        console.log(`✅ Connected to MongoDB (offers: ${cnt})`);
      });
    } catch (e) {
      console.error("❌ MongoDB Connection Error:", e);
    }
  }

  if (!FLIGHTAPI_KEY) {
    console.warn("⚠️  Missing FLIGHTAPI_KEY — /debug-flightapi(dry=1) and /search?dry=1 still work.");
  }

  app.listen(PORT, () => {
    console.log(`🚀 SkyDeal backend running on ${PORT}`);
  });
})();
