import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// ---- Config ----
const API_BASE = "https://api.flightapi.io";
const API_KEY = process.env.FLIGHTAPI_KEY || "6911e4d5a5228def37e369c0"; // your key already set
const CURRENCY = "INR";
const REGION = "IN";
const MARKUP = 250;

// ---- Mongo (for payment options) ----
const MONGO_URI = process.env.MONGO_URI;
let mongo, db;
async function initMongo() {
  if (!MONGO_URI) return;
  mongo = new MongoClient(MONGO_URI, { maxPoolSize: 5 });
  await mongo.connect();
  db = mongo.db("skydeal");
  console.log("✅ Mongo connected");
}
initMongo().catch((e) => console.error("Mongo error:", e.message));

// ---- Express ----
app.use(cors());
app.use(express.json());

// ---- Helpers ----
function onewayUrl({ from, to, date, adults, cabin }) {
  // /onewaytrip/{KEY}/{FROM}/{TO}/{DATE}/{adults}/{children}/{infants}/{cabin}/{currency}?region=IN
  return `${API_BASE}/onewaytrip/${API_KEY}/${from}/${to}/${date}/${adults}/0/0/${cabin}/${CURRENCY}?region=${REGION}`;
}

async function fetchJson(url) {
  const res = await axios.get(url, { timeout: 28000 });
  return res.data;
}
// ---- helpers (put near the top with other helpers) ----
function titleCase(s = "") {
  return s
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Normalize types to our 6 buckets
function normalizeType(t = "") {
  const x = t.toString().trim().toLowerCase();
  if (["credit card", "creditcard", "credit_card"].includes(x)) return "CreditCard";
  if (["debit card", "debitcard", "debit_card"].includes(x)) return "DebitCard";
  if (["net banking", "net_banking", "internet banking"].includes(x)) return "NetBanking";
  if (x === "upi") return "UPI";
  if (x === "wallet") return "Wallet";
  if (x === "emi") return "EMI";
  if (x === "bank offer") return "CreditCard"; // treat generic bank offer like card
  return null; // unknown/other gets dropped
}

// Canonicalize Indian bank / brand names (lowercased keys)
const BANK_CANON = new Map([
  ["hdfc", "HDFC Bank"], ["hdfc bank", "HDFC Bank"],
  ["icici", "ICICI Bank"], ["icici bank", "ICICI Bank"],
  ["axis", "Axis Bank"], ["axis bank", "Axis Bank"],
  ["kotak", "Kotak Bank"], ["kotak bank", "Kotak Bank"],
  ["idfc", "IDFC First Bank"], ["idfc bank", "IDFC First Bank"], ["idfc first bank", "IDFC First Bank"],
  ["au", "AU Small Bank"], ["au bank", "AU Small Bank"], ["au small bank", "AU Small Bank"],
  ["yes", "Yes Bank"], ["yes bank", "Yes Bank"],
  ["sbi", "SBI Bank"], ["state bank of india", "SBI Bank"], ["sbi bank", "SBI Bank"],
  ["hsbc", "HSBC Bank"], ["hsbc bank", "HSBC Bank"],
  ["federal", "Federal Bank"], ["federal bank", "Federal Bank"],
  ["rbl", "RBL Bank"], ["rbl bank", "RBL Bank"],
  ["canara bank", "Canara Bank"],
  ["central bank of india", "Central Bank Of India"],
  ["bobcard ltd", "Bobcard Ltd"],
  ["flipkart axis", "Flipkart Axis"],
  ["flipkart axis credit card", "Flipkart Axis Credit Card"],
]);

function canonicalBankOrLabel(s = "") {
  const key = s.toString().trim().toLowerCase();
  if (BANK_CANON.has(key)) return BANK_CANON.get(key);
  return titleCase(s);
}

// True if the payment method entry looks EMI-only or EMI-specific
function looksEMI(pm = {}) {
  const f = (v) => (v ? String(v).toLowerCase() : "");
  return (
    f(pm.type) === "emi" ||
    f(pm.category).includes("emi") ||
    f(pm.mode).includes("emi") ||
    f(pm.method).includes("emi")
  );
}


/** Map FlightAPI (onewaytrip) response to our flat flight cards */
function mapOneWayToCards(data) {
  if (!data || !data.itineraries || !data.legs || !data.segments || !data.carriers) return [];

  // index by id for quick lookup
  const legsById = new Map(data.legs.map((l) => [l.id, l]));
  const carriersById = new Map(data.carriers.map((c) => [String(c.id), c.name]));

  // keep only itineraries with 1 leg
  const itins = data.itineraries.filter((it) => Array.isArray(it.leg_ids) && it.leg_ids.length === 1);

  return itins.map((it) => {
    const leg = legsById.get(it.leg_ids[0]);
    // carrier
    let carrierName = "";
    try {
      const firstSegId = leg.segment_ids[0];
      const seg = data.segments.find((s) => s.id === firstSegId);
      carrierName = carriersById.get(String(seg.marketing_carrier_id)) || "";
    } catch (_) {}

    // price
    const amount = Number(it.pricing_options?.[0]?.price?.amount || 0);
    const dep = (leg?.departure || "").slice(11, 16);
    const arr = (leg?.arrival || "").slice(11, 16);

    return {
      flightNumber: carrierName || "Airline",
      airlineName: carrierName || "Airline",
      departure: dep || "--:--",
      arrival: arr || "--:--",
      price: String(Math.round(amount)), // card price (base)
      stops: Number(leg?.stops || 0),
      carrierCode: `-${leg?.id || ""}`,
      portalPrices: [
        { portal: "MakeMyTrip", basePrice: Math.round(amount), finalPrice: Math.round(amount) + MARKUP, source: "carrier+markup" },
        { portal: "Goibibo",    basePrice: Math.round(amount), finalPrice: Math.round(amount) + MARKUP, source: "carrier+markup" },
        { portal: "EaseMyTrip", basePrice: Math.round(amount), finalPrice: Math.round(amount) + MARKUP, source: "carrier+markup" },
        { portal: "Yatra",      basePrice: Math.round(amount), finalPrice: Math.round(amount) + MARKUP, source: "carrier+markup" },
        { portal: "Cleartrip",  basePrice: Math.round(amount), finalPrice: Math.round(amount) + MARKUP, source: "carrier+markup" },
      ],
    };
  });
}

// ---- Routes ----
app.get("/health", async (req, res) => {
  let dbConnected = false;
  try { dbConnected = !!(db && (await db.command({ ping: 1 }))); } catch (_) {}
  res.json({ ok: true, time: new Date().toISOString(), dbConnected });
});

/** Diagnostics to show the URL we will hit */
app.post("/debug-flightapi", async (req, res) => {
  try {
    const { from, to, departureDate, returnDate, passengers = 1, travelClass = "economy", tripType = "one-way" } = req.body || {};
    if (req.query.dry === "1") {
      if (tripType === "round-trip") {
        return res.json({
          ok: true,
          mode: "dry",
          urls: [
            onewayUrl({ from, to, date: departureDate, adults: passengers, cabin: travelClass }),
            onewayUrl({ from: to, to: from, date: returnDate, adults: passengers, cabin: travelClass }),
          ],
        });
      }
      return res.json({
        ok: true,
        mode: "dry",
        url: onewayUrl({ from, to, date: departureDate, adults: passengers, cabin: travelClass }),
      });
    }

    if (tripType === "round-trip") {
      const urls = [
        onewayUrl({ from, to, date: departureDate, adults: passengers, cabin: travelClass }),
        onewayUrl({ from: to, to: from, date: returnDate, adults: passengers, cabin: travelClass }),
      ];
      const [outJson, retJson] = await Promise.all(urls.map(fetchJson));
      return res.json({
        ok: true,
        status: 200,
        keysOutbound: Object.keys(outJson || {}),
        keysReturn: Object.keys(retJson || {}),
      });
    } else {
      const url = onewayUrl({ from, to, date: departureDate, adults: passengers, cabin: travelClass });
      const data = await fetchJson(url);
      return res.json({
        ok: true, status: 200, keys: Object.keys(data || {}),
      });
    }
  } catch (e) {
    res.status(400).json({ ok: false, status: 400, error: e.message });
  }
});

/** Payment options from Mongo (deduped & normalized). Falls back to empty lists if DB not present. */
// ==== REPLACE your /payment-options route with this one ====
app.get("/payment-options", async (req, res) => {
  try {
    let options = {
      CreditCard: [],
      DebitCard: [],
      Wallet: [],
      UPI: [],
      NetBanking: [],
      EMI: [],
    };

    if (!db) {
      return res.json({ usedFallback: true, options });
    }

    // Pull all active payment method rows we care about; we’ll classify in Node
    const rows = await db.collection("offers").aggregate([
      { $match: { isExpired: { $ne: true } } },
      { $unwind: "$paymentMethods" },
      {
        $project: {
          pm: {
            type: { $ifNull: ["$paymentMethods.type", ""] },
            bank: { $ifNull: ["$paymentMethods.bank", ""] },
            method: { $ifNull: ["$paymentMethods.method", ""] },
            wallet: { $ifNull: ["$paymentMethods.wallet", ""] },
            category: { $ifNull: ["$paymentMethods.category", ""] },
            mode: { $ifNull: ["$paymentMethods.mode", ""] },
          },
        },
      },
    ]).toArray();

    // Use Sets to dedupe
    const sets = {
      CreditCard: new Set(),
      DebitCard: new Set(),
      Wallet: new Set(),
      UPI: new Set(),
      NetBanking: new Set(),
      EMI: new Set(),
    };

    for (const r of rows) {
      const pm = r.pm || {};
      const bucket = normalizeType(pm.type) || ""; // our main bucket (if any)
      const subRaw =
        pm.bank || pm.method || pm.wallet || ""; // what we’ll display under each tab
      if (!subRaw) {
        // nothing to show for this row
        continue;
      }
      const label = canonicalBankOrLabel(subRaw);

      const isEMI = looksEMI(pm);

      // If EMI-specific → always include under EMI
      if (isEMI) {
        sets.EMI.add(label);
      }

      // If it maps to one of our main buckets, include there
      if (bucket) {
        sets[bucket].add(label);
      }

      // If an offer is both card & EMI (e.g., ICICI Credit Card EMI):
      // - looksEMI(pm) will have already added it to EMI
      // - normalizeType("credit card") adds it to CreditCard
      // So it shows in both tabs naturally.
    }

    // Convert Sets to sorted arrays
    for (const k of Object.keys(sets)) {
      options[k] = Array.from(sets[k]).sort((a, b) => a.localeCompare(b));
    }

    return res.json({ usedFallback: false, options });
  } catch (e) {
    console.error("payment-options error:", e.message);
    return res.status(500).json({ error: e.message });
  }
});


/** Main search */
app.post("/search", async (req, res) => {
  try {
    const {
      from, to, departureDate, returnDate,
      passengers = 1, travelClass = "economy",
      tripType = "one-way",
      paymentMethods = []
    } = req.body || {};

    if (!from || !to || !departureDate) {
      return res.status(400).json({ error: "Missing required params" });
    }

    if (tripType === "round-trip") {
      if (!returnDate) return res.status(400).json({ error: "returnDate required for round-trip" });

      const urlOut = onewayUrl({ from, to, date: departureDate, adults: passengers, cabin: travelClass });
      const urlRet = onewayUrl({ from: to, to: from, date: returnDate, adults: passengers, cabin: travelClass });

      const [jsonOut, jsonRet] = await Promise.all([fetchJson(urlOut), fetchJson(urlRet)]);

      const outboundFlights = mapOneWayToCards(jsonOut);
      const returnFlights   = mapOneWayToCards(jsonRet);

      return res.json({
        meta: { source: "flightapi" },
        outboundFlights,
        returnFlights
      });
    }

    // one-way
    const url = onewayUrl({ from, to, date: departureDate, adults: passengers, cabin: travelClass });
    const data = await fetchJson(url);
    const outboundFlights = mapOneWayToCards(data);

    return res.json({
      meta: { source: "flightapi" },
      outboundFlights,
      returnFlights: []
    });
  } catch (e) {
    console.error("Search error:", e.message);
    res.status(400).json({ error: e.message });
  }
});

// ---- Start ----
app.listen(PORT, () => {
  console.log(`🚀 SkyDeal backend running on ${PORT}`);
});
