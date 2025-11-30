// index.js — SkyDeal backend (FlightAPI + Mongo) — FULL FILE (ESM)

import express from "express";
import cors from "cors";
import { MongoClient, ServerApiVersion } from "mongodb";

// -------------------- CONFIG -----------------------
const app = express();
const PORT = process.env.PORT || 10000;

const FLIGHTAPI_KEY = process.env.FLIGHTAPI_KEY || "";
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || "";
const MONGODB_DB = process.env.MONGODB_DB || "skydeal";
const OFFER_COLLECTIONS = process.env.OFFER_COLLECTIONS || "offers";

// Portals shown in UI (we’ll add ₹250 to carrier price for each)
const PORTALS = ["MakeMyTrip", "Goibibo", "EaseMyTrip", "Yatra", "Cleartrip"];
const PORTAL_MARKUP_INR = 250;

// ---------------------------------------------------
// CORS (always set headers, even preflight)
app.use((req, res, next) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(cors({ origin: true, credentials: false }));
app.use(express.json());

// Health
app.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// -------------------- MONGO ------------------------
let mongoClient;
let db;

async function initMongo() {
  if (!MONGO_URI) {
    console.warn("⚠️  MONGO_URI not set — /payment-options will return minimal data.");
    return null;
  }
  if (db) return db;
  mongoClient = new MongoClient(MONGO_URI, {
    serverApi: ServerApiVersion.v1,
  });
  await mongoClient.connect();
  db = mongoClient.db(MONGODB_DB);
  console.log("✅ Mongo connected:", MONGODB_DB);
  return db;
}

// -------------------- HELPERS ----------------------
function titleCase(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
function normalizeBankName(raw) {
  if (!raw) return "";
  let s = String(raw).trim().replace(/\s+/g, " ").toLowerCase();
  s = s.replace(/\bltd\.?\b/g, "").replace(/\blimited\b/g, "").replace(/\bplc\b/g, "").trim();
  const map = [
    [/amazon\s*pay\s*icici/i, "ICICI Bank"], [/^icici\b/i, "ICICI Bank"],
    [/flipkart\s*axis/i, "Axis Bank"], [/^axis\b/i, "Axis Bank"],
    [/\bau\s*small\s*finance\b/i, "AU Small Finance Bank"],
    [/\bbobcard\b/i, "Bank of Baroda"], [/bank\s*of\s*baroda|^bob\b/i, "Bank of Baroda"],
    [/\bsbi\b|state\s*bank\s*of\s*india/i, "State Bank of India"],
    [/hdfc/i, "HDFC Bank"], [/kotak/i, "Kotak"], [/yes\s*bank/i, "YES Bank"],
    [/idfc/i, "IDFC First Bank"], [/indusind/i, "IndusInd Bank"], [/federal/i, "Federal Bank"],
    [/rbl/i, "RBL Bank"], [/standard\s*chartered/i, "Standard Chartered"],
    [/hsbc/i, "HSBC"], [/canara/i, "Canara Bank"],
  ];
  for (const [rx, canon] of map) if (rx.test(raw) || rx.test(s)) return canon;
  const cleaned = String(s).replace(/\b(bank|card|cards)\b/gi, "").trim();
  return cleaned ? cleaned.replace(/\b[a-z]/g, c => c.toUpperCase()) : String(raw).trim();
}
function normTypeKey(t) {
  const x = String(t || "").toLowerCase();
  if (!x) return null;
  if (/\bemi\b/.test(x)) return "emi";
  if (/credit|cc/.test(x)) return "credit";
  if (/debit/.test(x)) return "debit";
  if (/net\s*bank|netbank/.test(x)) return "netbanking";
  if (/wallet/.test(x)) return "wallet";
  if (/\bupi\b/.test(x)) return "upi";
  return null;
}

function toISODateStr(d) {
  try {
    if (!d) return null;
    const s = String(d).trim();
    const m1 = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/); // dd/mm/yyyy
    if (m1) { const [, dd, mm, yyyy] = m1; return `${yyyy}-${mm}-${dd}`; }
    const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m2) return s;
    const dt = new Date(s);
    if (Number.isNaN(dt.getTime())) return null;
    return dt.toISOString().slice(0, 10);
  } catch { return null; }
}

// -------------------- FlightAPI helpers ----------------------
function buildFlightApiUrl({ key, from, to, depISO, retISO, adults = 1, cabin = "economy", currency = "INR" }) {
  const c = String(cabin || "economy").toLowerCase();
  const base = "https://api.flightapi.io";
  // region=IN is REQUIRED for India routes, else you often get empty data
  return `${base}/roundtrip/${key}/${from}/${to}/${depISO}/${retISO}/${adults}/0/0/${c}/${currency}?region=IN`;
}

function extractFlights(fa) {
  const itins = Array.isArray(fa?.itineraries) ? fa.itineraries : [];
  const legs  = Array.isArray(fa?.legs) ? fa.legs : [];
  const segs  = Array.isArray(fa?.segments) ? fa.segments : [];
  const carriers = Array.isArray(fa?.carriers) ? fa.carriers : [];

  const carrierById = new Map(carriers.map(c => [String(c?.id ?? ""), c?.name || ""]));
  const legById = new Map(legs.map(l => [String(l?.id ?? ""), l]));
  const segById = new Map(segs.map(s => [String(s?.id ?? ""), s]));

  const out = [];
  itins.forEach(it => {
    const legId = (Array.isArray(it?.leg_ids) && it.leg_ids[0]) ? String(it.leg_ids[0]) : null;
    const leg = legId ? legById.get(legId) : null;
    if (!leg || !Array.isArray(leg.segment_ids) || leg.segment_ids.length === 0) return;

    const seg0 = segById.get(String(leg.segment_ids[0]));
    if (!seg0) return;

    const carrierId = String(seg0?.marketing_carrier_id ?? "");
    const airlineName = carrierById.get(carrierId) || carrierId || "—";

    const price = Number(it?.pricing_options?.[0]?.price?.amount ?? 0);
    const dep = leg?.departure || "";
    const arr = leg?.arrival || "";
    const depT = dep ? new Date(dep).toTimeString().slice(0,5) : "--:--";
    const arrT = arr ? new Date(arr).toTimeString().slice(0,5) : "--:--";

    out.push({
      flightNumber: `${carrierId}${seg0?.number ? " " + seg0.number : ""}`.trim(),
      airlineName,
      departure: depT,
      arrival: arrT,
      price: price ? price.toFixed(2) : "0.00",
      stops: Math.max(0, Array.isArray(leg?.segment_ids) ? leg.segment_ids.length - 1 : 0),
      carrierCode: carrierId
    });
  });
  return out;
}

// -------------------- PAYMENT OPTIONS (Mongo) -----------------------
app.get("/payment-options", async (_req, res) => {
  try {
    const database = await initMongo();
    if (!database) {
      // minimal fallback – nothing in Mongo
      return res.json({ options: { CreditCard: [], DebitCard: [], EMI: [], NetBanking: [], Wallet: [], UPI: [] } });
    }

    const col = database.collection(OFFER_COLLECTIONS);
    const today = new Date().toISOString().slice(0, 10);
    const activeValidityOr = [
      { validityPeriod: { $exists: false } },
      { $and: [
        { "validityPeriod.end": { $exists: false } },
        { "validityPeriod.to": { $exists: false } },
        { "validityPeriod.endDate": { $exists: false } },
        { "validityPeriod.till": { $exists: false } },
        { "validityPeriod.until": { $exists: false } },
      ]},
      { "validityPeriod.end": { $gte: today } },
      { "validityPeriod.to": { $gte: today } },
      { "validityPeriod.endDate": { $gte: today } },
      { "validityPeriod.till": { $gte: today } },
      { "validityPeriod.until": { $gte: today } },
    ];

    const cur = col.find(
      { isExpired: { $ne: true }, $or: activeValidityOr },
      { projection: { paymentMethods: 1 }, limit: 5000 }
    );

    const setMap = {
      "CreditCard": new Set(),
      "DebitCard": new Set(),
      "EMI": new Set(),
      "NetBanking": new Set(),
      "Wallet": new Set(),
      "UPI": new Set(),
    };

    const pick = (o, keys) => keys.map(k => o?.[k]).find(v => v != null && v !== "");

    for await (const doc of cur) {
      const arr = Array.isArray(doc?.paymentMethods) ? doc.paymentMethods : [];
      for (const pm of arr) {
        let typeKey, bankRaw;

        if (typeof pm === "string") {
          typeKey = normTypeKey(pm);
          bankRaw = pm.replace(/credit\s*card|debit\s*card|\bemi\b|net\s*bank(?:ing)?|upi|wallet/gi, "").trim();
        } else if (pm && typeof pm === "object") {
          typeKey = normTypeKey(pick(pm, ["type", "method", "category", "mode"]));
          bankRaw = pick(pm, ["bank","cardBank","issuer","cardIssuer","provider","wallet","upi"]) || "";
        } else continue;

        const bank = titleCase(normalizeBankName(bankRaw));
        if (!typeKey || !bank) continue;

        if (typeKey === "emi") {
          setMap["EMI"].add(`${bank} (Credit Card EMI)`);
          setMap["CreditCard"].add(bank);
        } else if (typeKey === "credit") setMap["CreditCard"].add(bank);
        else if (typeKey === "debit") setMap["DebitCard"].add(bank);
        else if (typeKey === "netbanking") setMap["NetBanking"].add(bank);
        else if (typeKey === "wallet") setMap["Wallet"].add(bank);
        else if (typeKey === "upi") setMap["UPI"].add(bank);
      }
    }

    const options = Object.fromEntries(Object.entries(setMap).map(([k, v]) => [k, Array.from(v).sort()]));
    return res.json({ options });
  } catch (e) {
    console.error("X /payment-options error:", e);
    return res.status(200).json({ error: "Failed loading payment options" });
  }
});

// -------------------- SEARCH -----------------------
app.post("/search", async (req, res) => {
  try {
    const {
      from, to,
      departureDate, returnDate,
      passengers = 1,
      travelClass = "economy",
      tripType = "round-trip",
    } = req.body || {};

    const depISO = toISODateStr(departureDate);
    const retISO = toISODateStr(returnDate);
    const missing = [];
    if (!from) missing.push("from");
    if (!to) missing.push("to");
    if (!depISO) missing.push("departureDate (invalid format)");
    if (!FLIGHTAPI_KEY) missing.push("FLIGHTAPI_KEY (env)");
    if (missing.length) {
      return res.status(400).json({ error: "Missing required fields", missing });
    }

    const ORG = String(from).trim().toUpperCase();
    const DST = String(to).trim().toUpperCase();
    const url = buildFlightApiUrl({
      key: FLIGHTAPI_KEY,
      from: ORG, to: DST,
      depISO,
      retISO: tripType === "round-trip" ? (retISO || depISO) : depISO,
      adults: passengers,
      cabin: travelClass,
      currency: "INR"
    });

    let faJson;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`flightapi_http_${r.status}`);
      const text = await r.text();
      if (text.trim().startsWith("<")) throw new Error("flightapi_html");
      faJson = JSON.parse(text);
    } catch (e) {
      console.error("X flightapi fetch failed:", e.message);
      return res.status(200).json({ outboundFlights: [], returnFlights: [], meta: { source: "flightapi", reason: "fetch-failed" } });
    }

    const flights = extractFlights(faJson);
    if (!flights.length) {
      return res.status(200).json({ outboundFlights: [], returnFlights: [], meta: { source: "flightapi", reason: "no-itineraries" } });
    }

    // Decorate with portal markup (use carrier website price as base)
    const withPortals = flights.map(f => {
      const base = Number(f.price) || 0;
      const portalPrices = PORTALS.map(portal => ({
        portal,
        basePrice: base,
        finalPrice: base + PORTAL_MARKUP_INR,
        source: "carrier+markup"
      }));
      return { ...f, portalPrices };
    });

    // We do not split outbound/return here because FlightAPI combined response
    // doesn’t separate them like Amadeus; return everything as outbound.
    return res.json({
      outboundFlights: withPortals,
      returnFlights: [],
      meta: { source: "flightapi" }
    });

  } catch (err) {
    console.error("X /search error:", err);
    res.status(200).json({ outboundFlights: [], returnFlights: [], error: "search-failed" });
  }
});

// -------------------- START ------------------------
app.listen(PORT, async () => {
  try { await initMongo(); } catch (e) { console.error("Mongo init failed:", e.message); }
  if (!FLIGHTAPI_KEY) console.error("❌ Missing FLIGHTAPI_KEY");
  if (!MONGO_URI) console.warn("⚠️  MONGO_URI not set (only /payment-options will be limited)");
  console.log(`🚀 SkyDeal backend running on ${PORT}`);
});
