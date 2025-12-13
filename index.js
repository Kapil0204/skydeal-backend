// index.js — SkyDeal backend (lock: two one-way calls + real offer application)
// DO NOT change your index.html — this file fixes the backend only.

import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// --------- ENV you must have set on Render -----------
const MONGO_URI       = process.env.MONGO_URI || process.env.MONGODB_URI; // allow either name
const MONGODB_DB      = process.env.MONGODB_DB || "skydeal";
const MONGO_COL       = process.env.MONGO_COL || "offers";

const FLIGHTAPI_KEY   = process.env.FLIGHTAPI_KEY;
// If your working URL format differs, keep it in FLIGHTAPI_ONEWAY_TEMPLATE.
// Example template below matches typical flightapi.io one-way style.
// Replace only the template if your working URL is different.
const FLIGHTAPI_ONEWAY_TEMPLATE =
  process.env.FLIGHTAPI_ONEWAY_TEMPLATE ||
  "https://api.flightapi.io/oneway/{KEY}/{FROM}/{TO}/{DATE}/{ADULTS}/INR?cabinClass={CABIN}";
// -----------------------------------------------------

app.use(cors());               // allow your Vercel UI
app.use(express.json());

// ---------- Mongo (single connection, reused) ----------
let mongoClient;
async function ensureMongo() {
  if (!MONGO_URI) throw new Error("MONGO_URI missing");
  if (!mongoClient) {
    mongoClient = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
    await mongoClient.connect();
  }
  return mongoClient.db(MONGODB_DB).collection(MONGO_COL);
}

// ---------- Payment options (deduped) ----------
app.get("/payment-options", async (req, res) => {
  try {
    const col = await ensureMongo();

    // Gather from both legacy `paymentMethods` and `parsedFields.paymentMethods`
    const cursor = col.aggregate([
      { $match: { $or: [ { isExpired: { $exists: false } }, { isExpired: false } ] } },
      {
        $project: {
          _id: 0,
          pmA: "$paymentMethods",
          pmB: "$parsedFields.paymentMethods"
        }
      }
    ]);

    const seen = {
      "Credit Card": new Set(),
      "Debit Card": new Set(),
      "Net Banking": new Set(),
      "UPI": new Set(),
      "Wallet": new Set()
    };

    const normalizeType = (t = "") => {
      const s = String(t).toLowerCase();
      if (s.includes("credit")) return "Credit Card";
      if (s.includes("debit"))  return "Debit Card";
      if (s.includes("net"))    return "Net Banking";
      if (s.includes("upi"))    return "UPI";
      if (s.includes("wallet")) return "Wallet";
      if (s.includes("internet")) return "Net Banking";
      return null;
    };

    const add = (arr = []) => {
      for (const pm of arr) {
        const type = normalizeType(pm.type);
        const bank = (pm.bank || pm.raw || "").toString().trim();
        if (!type || !bank) continue;
        // Keep only bank names (no duplicates, case-insensitive)
        const key = bank.toLowerCase();
        if (![...seen[type]].some(x => x.toLowerCase() === key)) {
          seen[type].add(bank);
        }
      }
    };

    // Collect banks
    // eslint-disable-next-line no-await-in-loop
    for await (const doc of cursor) {
      add(Array.isArray(doc.pmA) ? doc.pmA : []);
      add(Array.isArray(doc.pmB) ? doc.pmB : []);
    }

    // Convert sets to arrays
    const options = Object.fromEntries(
      Object.entries(seen).map(([k, set]) => [k, [...set].sort()])
    );

    res.json({ usedFallback: false, options });
  } catch (err) {
    console.error("[/payment-options] error:", err.message);
    // Minimal safe fallback (keeps modal alive even if Mongo hiccups)
    res.json({
      usedFallback: true,
      options: { "Credit Card": [], "Debit Card": [], "Net Banking": [], "UPI": [], "Wallet": [] }
    });
  }
});

// ---------- FlightAPI helpers (two one-way calls) ----------
function buildOneWayUrl({ from, to, date, adults, cabin }) {
  // Replace placeholders in template
  return FLIGHTAPI_ONEWAY_TEMPLATE
    .replace("{KEY}", encodeURIComponent(FLIGHTAPI_KEY))
    .replace("{FROM}", encodeURIComponent(from))
    .replace("{TO}", encodeURIComponent(to))
    .replace("{DATE}", encodeURIComponent(date))
    .replace("{ADULTS}", String(adults))
    .replace("{CABIN}", encodeURIComponent(cabin || "economy"));
}

async function fetchOneWay({ from, to, date, passengers, cabin }) {
  if (!FLIGHTAPI_KEY) throw new Error("FLIGHTAPI_KEY missing");
  const url = buildOneWayUrl({
    from,
    to,
    date,                   // YYYY-MM-DD expected by your working endpoint/template
    adults: passengers || 1,
    cabin: (cabin || "economy").toLowerCase()
  });

  const resp = await axios.get(url, { timeout: 20000 });
  return resp.data; // We'll map to a uniform structure below
}

// Normalize FlightAPI response to {flights:[{airlineName, flightNumber, depart, arrive, price, stops}]}
function mapFlightApi(data) {
  // This mapper is intentionally forgiving. Adjust ONLY if needed.
  // Try common shapes:
  const flights = [];
  if (!data) return flights;

  // Pattern 1: data.data[] style
  if (Array.isArray(data.data)) {
    for (const it of data.data) {
      flights.push({
        airlineName: it.airline || it.airlineName || it.validating_airline || it.carrier || "Airline",
        flightNumber: it.flight_number || it.number || it.id || "",
        depart: it.departure_time || it.departure || it.depart || "",
        arrive: it.arrival_time || it.arrival || it.arrive || "",
        price: Math.round(Number(it.price || it.total || it.amount || 0)),
        stops: it.stops ?? (Array.isArray(it.segments) ? Math.max(0, it.segments.length - 1) : 0)
      });
    }
  }

  // Pattern 2: data.flights[]
  if (Array.isArray(data.flights) && flights.length === 0) {
    for (const f of data.flights) {
      flights.push({
        airlineName: f.airlineName || f.airline || "Airline",
        flightNumber: f.flightNumber || f.number || "",
        depart: f.departure || f.depart || "",
        arrive: f.arrival || f.arrive || "",
        price: Math.round(Number(f.price || 0)),
        stops: f.stops ?? 0
      });
    }
  }

  return flights.filter(f => Number.isFinite(f.price) && f.price > 0);
}

// ---------- Offer engine ----------
function calcDiscount({ price, offer }) {
  // Inputs may come from either parsedFields.* or root fields
  const pct  = offer.discountPercent ?? offer.parsedFields?.discountPercent ?? null;
  const flat = offer.flatAmount ?? offer.parsedFields?.flatAmount ?? null;
  const max  = offer.maxDiscountAmount ?? offer.parsedFields?.maxDiscountAmount ?? null;

  let disc = 0;
  if (typeof flat === "number" && flat > 0) {
    disc = flat;
  } else if (typeof pct === "number" && pct > 0) {
    disc = price * (pct / 100);
  }
  if (typeof max === "number" && max > 0) {
    disc = Math.min(disc, max);
  }
  disc = Math.floor(Math.max(0, disc));
  const finalPrice = Math.max(0, Math.floor(price - disc));
  return { discount: disc, finalPrice };
}

function normalizeType(t = "") {
  const s = String(t).toLowerCase();
  if (s.includes("credit")) return "Credit Card";
  if (s.includes("debit"))  return "Debit Card";
  if (s.includes("net"))    return "Net Banking";
  if (s.includes("upi"))    return "UPI";
  if (s.includes("wallet")) return "Wallet";
  if (s.includes("internet")) return "Net Banking";
  return null;
}

function pmMatches(offerPM, selected) {
  // selected: [{type:"Credit Card", bank:"HDFC Bank"}, ...]
  const type = normalizeType(offerPM.type);
  const bank = (offerPM.bank || offerPM.raw || "").toString().trim();
  if (!type || !bank) return false;
  return selected.some(s =>
    normalizeType(s.type) === type &&
    bank.toLowerCase() === s.bank.toLowerCase()
  );
}

async function findBestDealForPrice({ price, selectedPM }) {
  const col = await ensureMongo();

  // Pull candidate offers once (avoid N:1 per flight)
  const candidates = await col
    .find({
      $and: [
        { $or: [ { isExpired: { $exists: false } }, { isExpired: false } ] },
        { $or: [
            { "paymentMethods.0": { $exists: true } },
            { "parsedFields.paymentMethods.0": { $exists: true } }
          ]
        },
        { $or: [
            { minTransactionValue: { $exists: false } },
            { minTransactionValue: { $lte: price } }
          ]
        }
      ]
    })
    .project({
      portal: 1,
      title: 1,
      discountPercent: 1,
      flatAmount: 1,
      maxDiscountAmount: 1,
      minTransactionValue: 1,
      "paymentMethods": 1,
      "parsedFields.paymentMethods": 1
    })
    .limit(500) // safety
    .toArray();

  let best = { portal: null, finalPrice: price, note: "No eligible offer" };

  for (const off of candidates) {
    const pmList = [
      ...(Array.isArray(off.paymentMethods) ? off.paymentMethods : []),
      ...(off.parsedFields?.paymentMethods ?? [])
    ];

    // must match at least one selected payment filter
    if (!pmList.some(pm => pmMatches(pm, selectedPM))) continue;

    const { finalPrice } = calcDiscount({ price, offer: off });
    if (finalPrice < best.finalPrice) {
      best = {
        portal: off.portal || "Portal",
        finalPrice,
        note: off.title || "Best offer"
      };
    }
  }

  return best;
}

// ---------- /search ----------
app.post("/search", async (req, res) => {
  const {
    from, to,
    departureDate, returnDate,
    passengers = 1,
    travelClass = "economy",
    tripType = "round-trip",
    paymentFilters = []   // [{type:"Credit Card", bank:"HDFC Bank"}, ...]
  } = req.body || {};

  const meta = { source: "flightapi", outStatus: 0, retStatus: 0, error: null, offerDebug: {} };

  try {
    // Outbound (one-way)
    const outRaw = await fetchOneWay({
      from, to, date: departureDate, passengers, cabin: travelClass
    });
    meta.outStatus = 200;
    const outFlights = mapFlightApi(outRaw);

    // Return (one-way) — only if round-trip
    let retFlights = [];
    if (tripType === "round-trip" && returnDate) {
      const retRaw = await fetchOneWay({
        from: to, to: from, date: returnDate, passengers, cabin: travelClass
      });
      meta.retStatus = 200;
      retFlights = mapFlightApi(retRaw);
    }

    // Apply offers per flight (only when user selected any paymentFilter)
    const withDeals = async (list) => {
      if (!Array.isArray(list) || list.length === 0) return [];
      if (!Array.isArray(paymentFilters) || paymentFilters.length === 0) {
        // No selection => show note but do not compute discounts
        return list.map(f => ({ ...f, bestDeal: { portal: null, finalPrice: f.price, note: "No payment method selected" } }));
      }
      const result = [];
      for (const f of list) {
        const best = await findBestDealForPrice({ price: f.price, selectedPM: paymentFilters });
        result.push({ ...f, bestDeal: best });
      }
      return result;
    };

    const outboundFlights = await withDeals(outFlights);
    const returnFlights  = await withDeals(retFlights);

    return res.json({ meta, outboundFlights, returnFlights });
  } catch (e) {
    console.error("[/search] error:", e.message);
    meta.error = e.message || "Search failed";
    if (!meta.outStatus) meta.outStatus = 500;
    return res.status(200).json({ meta, outboundFlights: [], returnFlights: [] });
  }
});

app.get("/", (_req, res) => res.send("SkyDeal backend OK"));
app.listen(PORT, () => console.log(`SkyDeal backend listening on ${PORT}`));
