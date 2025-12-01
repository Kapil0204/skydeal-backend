import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const PORT = process.env.PORT || 10000;
const FLIGHTAPI_KEY = process.env.FLIGHTAPI_KEY || "";
const MONGO_URI = process.env.MONGO_URI || ""; // e.g. mongodb://user:pass@host:27017/skydeal?authSource=skydeal&tls=false

// -------------------------
// App / middleware
// -------------------------
const app = express();
app.use(cors());
app.use(express.json());

// -------------------------
// Mongo (non-blocking boot)
// -------------------------
let mongoClient = null;
let offersColl = null;

async function connectDB() {
  if (!MONGO_URI) {
    console.warn("⚠️  MONGO_URI not set. DB features will be disabled.");
    return;
  }
  mongoClient = new MongoClient(MONGO_URI, {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
  });
  await mongoClient.connect();
  const db = mongoClient.db(); // db name is in the URI
  offersColl = db.collection("offers");
  console.log("✅ Mongo connected");
}

function dbReady() {
  return !!offersColl;
}

// kick it off in the background (don’t block server start)
connectDB().catch((err) =>
  console.error("Mongo background connect failed:", err?.message || err)
);

// -------------------------
// Helpers
// -------------------------

// Normalize types/labels coming from GPT scraped offers
const TYPE_MAP = new Map(
  [
    ["credit card", "CreditCard"],
    ["credit_card", "CreditCard"],
    ["Credit Card", "CreditCard"],
    ["Debit Card", "DebitCard"],
    ["debit card", "DebitCard"],
    ["debit_card", "DebitCard"],
    ["UPI", "UPI"],
    ["upi", "UPI"],
    ["wallet", "Wallet"],
    ["Wallet", "Wallet"],
    ["Internet Banking", "NetBanking"],
    ["net banking", "NetBanking"],
    ["net_banking", "NetBanking"],
    ["online", "Other"],
    ["other", "Other"],
    ["any", "Other"],
    ["Bank offer", "Other"],
    ["EMI", "EMI"],
  ].map(([a, b]) => [a.toLowerCase(), b])
);

function normType(t) {
  if (!t || typeof t !== "string") return null;
  const key = t.trim().toLowerCase();
  return TYPE_MAP.get(key) || null;
}

function titleCase(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

// Build payment subtype label from multiple possible fields
function pickSubtype(pm = {}) {
  // prefer bank → method → wallet → category → mode
  const candidates = [
    pm.bank,
    pm.method,
    pm.wallet,
    pm.category,
    pm.mode,
  ].filter(Boolean);
  if (!candidates.length) return null;
  return titleCase(candidates[0]);
}

async function getPaymentOptionsFromMongo() {
  if (!dbReady()) throw new Error("DB not ready");

  // Flatten all paymentMethods
  const pipeline = [
    { $match: { isExpired: { $ne: true } } },
    { $unwind: "$paymentMethods" },
    {
      $project: {
        rawType: {
          $ifNull: ["$paymentMethods.type", "Other"],
        },
        bank: { $ifNull: ["$paymentMethods.bank", ""] },
        method: { $ifNull: ["$paymentMethods.method", ""] },
        wallet: { $ifNull: ["$paymentMethods.wallet", ""] },
        category: { $ifNull: ["$paymentMethods.category", ""] },
        mode: { $ifNull: ["$paymentMethods.mode", ""] },
      },
    },
    {
      $project: {
        type: {
          $toLower: {
            $trim: { input: "$rawType" },
          },
        },
        label: {
          $let: {
            vars: {
              bank: "$bank",
              method: "$method",
              wallet: "$wallet",
              category: "$category",
              mode: "$mode",
            },
            in: {
              $cond: [
                { $ne: ["$$bank", ""] },
                "$$bank",
                {
                  $cond: [
                    { $ne: ["$$method", ""] },
                    "$$method",
                    {
                      $cond: [
                        { $ne: ["$$wallet", ""] },
                        "$$wallet",
                        {
                          $cond: [
                            { $ne: ["$$category", ""] },
                            "$$category",
                            "$$mode",
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    },
    {
      $group: {
        _id: "$type",
        subtypes: { $addToSet: "$label" },
      },
    },
  ];

  const rows = await offersColl.aggregate(pipeline).toArray();

  // Normalize to our final buckets
  const buckets = {
    CreditCard: new Set(),
    DebitCard: new Set(),
    Wallet: new Set(),
    UPI: new Set(),
    NetBanking: new Set(),
    EMI: new Set(),
    Other: new Set(),
  };

  for (const row of rows) {
    const t = normType(row._id);
    if (!t) continue;
    for (const raw of row.subtypes || []) {
      const label = titleCase(raw);
      if (label) buckets[t].add(label);
    }
  }

  // Convert to arrays & sort
  const toList = (s) => Array.from(s).sort((a, b) => a.localeCompare(b));

  return {
    usedFallback: false,
    options: {
      CreditCard: toList(buckets.CreditCard),
      DebitCard: toList(buckets.DebitCard),
      Wallet: toList(buckets.Wallet),
      UPI: toList(buckets.UPI),
      NetBanking: toList(buckets.NetBanking),
      EMI: toList(buckets.EMI),
    },
  };
}

function fallbackPaymentOptions() {
  return {
    usedFallback: true,
    options: {
      CreditCard: [],
      DebitCard: [],
      Wallet: [],
      UPI: [],
      NetBanking: [],
      EMI: [],
    },
  };
}

// Build portal prices (simple +₹250 markup per the current milestone)
function portalPrices(base) {
  const portals = ["MakeMyTrip", "Goibibo", "EaseMyTrip", "Yatra", "Cleartrip"];
  const b = Math.max(0, Number(base) || 0);
  const final = b + 250;
  return portals.map((p) => ({
    portal: p,
    basePrice: b,
    finalPrice: final,
    source: "carrier+markup",
  }));
}

// -------------------------
// Endpoints
// -------------------------

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    dbConnected: dbReady(),
  });
});

app.get("/payment-options", async (req, res) => {
  try {
    if (!dbReady()) return res.json(fallbackPaymentOptions());
    const data = await getPaymentOptionsFromMongo();
    res.json(data);
  } catch (e) {
    console.error("payment-options error:", e?.message || e);
    res.json(fallbackPaymentOptions());
  }
});

// Simple diagnostics to see which source is active
app.post("/debug-flightapi", async (req, res) => {
  try {
    const {
      from,
      to,
      departureDate,
      returnDate,
      passengers = 1,
      travelClass = "economy",
      tripType = "round-trip",
    } = req.body || {};

    // DRY mode?
    if (req.query.dry) {
      const url = `https://api.flightapi.io/${
        tripType === "round-trip" ? "roundtrip" : "onewaytrip"
      }/${FLIGHTAPI_KEY}/${from}/${to}/${departureDate}${
        tripType === "round-trip" ? `/${returnDate}` : ""
      }/${passengers}/0/0/${travelClass}/INR?region=IN`;
      return res.json({ ok: true, url, mode: "dry" });
    }

    const url = `https://api.flightapi.io/${
      tripType === "round-trip" ? "roundtrip" : "onewaytrip"
    }/${FLIGHTAPI_KEY}/${from}/${to}/${departureDate}${
      tripType === "round-trip" ? `/${returnDate}` : ""
    }/${passengers}/0/0/${travelClass}/INR?region=IN`;

    const r = await axios.get(url, { timeout: 25000 });
    const keys = Object.keys(r.data || {});
    res.json({
      ok: true,
      status: 200,
      keys,
      hasItin: Array.isArray(r.data?.itineraries) && r.data.itineraries.length,
      error: null,
    });
  } catch (err) {
    res.json({
      ok: false,
      status: err.response?.status || 500,
      hasItin: false,
      error: err.message || "unknown",
    });
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
      tripType = "round-trip",
      paymentMethods = [],
    } = req.body || {};

    // Build URL (we use roundtrip for both one-way & round-trip;
    // for one-way we just omit leg 2 downstream)
    const isRound = tripType === "round-trip" && !!returnDate;
    const endpoint = isRound ? "roundtrip" : "onewaytrip";
    const url = `https://api.flightapi.io/${endpoint}/${FLIGHTAPI_KEY}/${from}/${to}/${departureDate}${
      isRound ? `/${returnDate}` : ""
    }/${passengers}/0/0/${travelClass}/INR?region=IN`;

    const r = await axios.get(url, { timeout: 30000 });
    const data = r.data || {};

    // Index carriers for name lookup
    const carriers = {};
    (data.carriers || []).forEach((c) => {
      carriers[String(c.id)] = c.name || c.display_code || c.alternate_di;
    });

    // Legs map
    const legsById = {};
    (data.legs || []).forEach((lg) => {
      legsById[String(lg.id)] = lg;
    });

    // Helper to render a leg into our UI model
    const legToCard = (leg) => {
      // marketing carrier for first segment
      const segId = leg.segment_ids?.[0];
      const seg = (data.segments || []).find((s) => s.id === segId);
      const carrierName =
        (seg && carriers[String(seg.marketing_carrier_id)]) || "Airline";

      // These times are ISO; take HH:MM
      const hhmm = (iso) =>
        (iso || "")
          .split("T")[1]
          ?.slice(0, 5) || "";

      // We don't have leg prices; use the **cheapest itinerary price** as base
      const cheapest =
        data.itineraries?.[0]?.pricing_options?.[0]?.price?.amount || 0;
      const basePrice = Math.round(Number(cheapest) || 0);

      return {
        flightNumber: carrierName, // keep legacy field name for UI
        airlineName: carrierName,
        departure: hhmm(leg.departure),
        arrival: hhmm(leg.arrival),
        price: String(basePrice),
        stops: (leg.stop_count ?? 0) | 0,
        carrierCode: `-${seg?.marketing_flight_number || ""}`.trim(),
        portalPrices: portalPrices(basePrice),
      };
    };

    // Collect two columns
    const outboundFlights = [];
    const returnFlights = [];

    // Strategy: take the first N (e.g., 80) itineraries, expand their legs
    const MAX_ITINS = 120;
    const itins = (data.itineraries || []).slice(0, MAX_ITINS);

    for (const it of itins) {
      const legIds = it.leg_ids || [];
      // Outbound is always first leg in the itinerary
      if (legIds[0] && legsById[legIds[0]]) {
        outboundFlights.push(legToCard(legsById[legIds[0]]));
      }
      // Return leg present for round-trip
      if (isRound && legIds[1] && legsById[legIds[1]]) {
        returnFlights.push(legToCard(legsById[legIds[1]]));
      }
    }

    // Simple de-dup: key by airline+dep+arr
    const dedup = (arr) => {
      const seen = new Set();
      const out = [];
      for (const f of arr) {
        const key = `${f.airlineName}|${f.departure}|${f.arrival}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(f);
        }
      }
      return out;
    };

    const oDedup = dedup(outboundFlights).slice(0, 60);
    const rDedup = dedup(returnFlights).slice(0, 60);

    res.json({
      meta: { source: "flightapi" },
      outboundFlights: oDedup,
      returnFlights: isRound ? rDedup : [],
    });
  } catch (err) {
    console.error("search error:", err?.message || err);
    res.status(500).json({ error: "Failed to fetch flights" });
  }
});

// -------------------------
// Start server
// -------------------------
app.listen(PORT, () => {
  console.log(`🚀 SkyDeal backend running on ${PORT}`);
});
