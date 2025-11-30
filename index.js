// SkyDeal backend — FlightAPI.io (carrier price only) + Mongo offers for payment options
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { MongoClient, ServerApiVersion } from "mongodb";

// -------------------- ENV --------------------
const PORT = process.env.PORT || 10000;
const MONGO_URI = process.env.MONGO_URI || "";
const DB_NAME = process.env.MONGO_DB || "skydeal";

// FlightAPI
const FLIGHTAPI_KEY = process.env.FLIGHTAPI_API_KEY || "";
const FLIGHTAPI_BASE = "https://api.flightapi.io";
const FLIGHTAPI_TIMEOUT_MS = Number(process.env.FLIGHTAPI_TIMEOUT_MS || 20000);
const FLIGHTAPI_REGION = process.env.FLIGHTAPI_REGION || "IN";

// Pricing rule
const PER_PORTAL_MARKUP = Number(process.env.PORTAL_MARKUP || 250);

// Static portals list (we show same carrier price + markup on all)
const PORTALS = ["MakeMyTrip", "Goibibo", "EaseMyTrip", "Yatra", "Cleartrip"];

// -------------------- APP/HARDENED CORS --------------------
const app = express();
app.use((req, res, next) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

// -------------------- MONGO (offers -> payment options) --------------------
let mongo;
let db;

async function connectDB() {
  if (db) return db;
  if (!MONGO_URI) {
    console.error("❌ Missing MONGO_URI");
    return null;
  }
  try {
    mongo = new MongoClient(MONGO_URI, { serverApi: ServerApiVersion.v1 });
    await mongo.connect();
    db = mongo.db(DB_NAME);
    console.log("✅ Connected to MongoDB (EC2)");
    return db;
  } catch (e) {
    console.error("❌ MongoDB Connection Error:", e);
    return null;
  }
}

function normTypeKey(raw) {
  const s = String(raw || "").toLowerCase();
  if (/emi/.test(s)) return "EMI";
  if (/credit|cc/.test(s)) return "CreditCard";
  if (/debit/.test(s)) return "DebitCard";
  if (/net\s*bank/.test(s)) return "NetBanking";
  if (/wallet/.test(s)) return "Wallet";
  if (/\bupi\b/.test(s)) return "UPI";
  return null;
}
function titleCase(x) {
  return String(x || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b[a-z]/g, c => c.toUpperCase());
}
function cleanBankName(raw) {
  if (!raw) return "";
  let s = String(raw).trim();
  s = s.replace(/\b(ltd\.?|limited|bank|cards?)\b/gi, "").trim();
  if (!s) return "";
  return titleCase(s);
}

// Build distinct payment options by type from Mongo offers
async function loadPaymentOptions() {
  const database = await connectDB();
  if (!database) {
    return {
      CreditCard: [],
      DebitCard: [],
      EMI: [],
      NetBanking: [],
      Wallet: [],
      UPI: [],
    };
  }
  const col = database.collection("offers");

  // only active or no validity recorded
  const today = new Date().toISOString().slice(0, 10);
  const activeOr = [
    { validityPeriod: { $exists: false } },
    {
      $and: [
        { "validityPeriod.end": { $exists: false } },
        { "validityPeriod.to": { $exists: false } },
        { "validityPeriod.endDate": { $exists: false } },
        { "validityPeriod.till": { $exists: false } },
        { "validityPeriod.until": { $exists: false } },
      ],
    },
    { "validityPeriod.end": { $gte: today } },
    { "validityPeriod.to": { $gte: today } },
    { "validityPeriod.endDate": { $gte: today } },
    { "validityPeriod.till": { $gte: today } },
    { "validityPeriod.until": { $gte: today } },
  ];

  const cursor = col.find(
    { isExpired: { $ne: true }, $or: activeOr },
    { projection: { paymentMethods: 1 }, limit: 5000 }
  );

  const sets = {
    CreditCard: new Set(),
    DebitCard: new Set(),
    EMI: new Set(),
    NetBanking: new Set(),
    Wallet: new Set(),
    UPI: new Set(),
  };

  for await (const doc of cursor) {
    const pm = Array.isArray(doc.paymentMethods) ? doc.paymentMethods : [];
    for (const entry of pm) {
      if (!entry) continue;
      if (typeof entry === "object") {
        const t = normTypeKey(entry.type || entry.method || entry.mode || entry.category);
        const bank = cleanBankName(entry.bank || entry.cardBank || entry.issuer || entry.provider);
        if (!t || !bank) continue;
        // EMI contributes to CreditCard as well
        if (t === "EMI") {
          sets.EMI.add(`${bank} (Credit Card EMI)`);
          sets.CreditCard.add(bank);
        } else {
          sets[t]?.add(bank);
        }
      } else if (typeof entry === "string") {
        const t = normTypeKey(entry);
        const bank = cleanBankName(entry.replace(/credit\s*card|debit\s*card|\bemi\b|net\s*bank(?:ing)?|upi|wallet/gi, ""));
        if (!bank) continue;
        if (t === "EMI") {
          sets.EMI.add(`${bank} (Credit Card EMI)`);
          sets.CreditCard.add(bank);
        } else if (t) {
          sets[t].add(bank);
        }
      }
    }
  }

  const out = {};
  for (const k of Object.keys(sets)) out[k] = Array.from(sets[k]).sort((a, b) => a.localeCompare(b));
  return out;
}

// -------------------- HEALTH --------------------
app.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// -------------------- PAYMENT OPTIONS --------------------
app.get("/payment-options", async (_req, res) => {
  try {
    const options = await loadPaymentOptions();
    res.json({ options });
  } catch (e) {
    console.error("payment-options error:", e.message);
    res.status(200).json({ options: { CreditCard: [], DebitCard: [], EMI: [], NetBanking: [], Wallet: [], UPI: [] } });
  }
});

// -------------------- FLIGHTAPI HELPERS --------------------
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, r) => setTimeout(() => r(new Error("timeout")), ms)),
  ]);
}

async function fetchJson(url) {
  const r = await withTimeout(fetch(url, { method: "GET" }), FLIGHTAPI_TIMEOUT_MS);
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status} ${t.slice(0, 200)}`);
  }
  return r.json();
}

// small retry with jitter
async function fetchJsonRetry(url, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchJson(url);
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 300 + Math.random() * 500));
    }
  }
  throw lastErr;
}

// Extract a single “carrier price” from FlightAPI result:
// We prefer itinerary’s first pricing option; if agents/prices exist, we pick the one
// whose agent name seems to be the **airline / carrier site** (IndiGo, Air India, etc.)
function buildCarrierNameDict(root) {
  // root.carriers is array with id + name
  const dict = {};
  if (Array.isArray(root?.carriers)) {
    for (const c of root.carriers) {
      if (c?.id != null && c?.name) dict[String(c.id)] = c.name;
    }
  }
  return dict;
}

function firstItineraryLeg(root, itin) {
  const legId = itin?.leg_ids?.[0];
  if (!legId) return null;
  return root?.legs?.find(l => l?.id === legId) || null;
}

function firstSegmentForLeg(root, leg) {
  const segId = leg?.segment_ids?.[0];
  if (segId == null) return null;
  return root?.segments?.find(s => s?.id === segId) || null;
}

function pickCarrierSitePrice(root, itin, carriersDict) {
  // price candidates from pricing_options[0]
  const po = Array.isArray(itin?.pricing_options) ? itin.pricing_options[0] : null;
  const baseAmount = Number(po?.price?.amount || 0);

  // Try to map marketing carrier to human airline name
  const leg = firstItineraryLeg(root, itin);
  const seg0 = firstSegmentForLeg(root, leg);
  const carrierId = seg0?.marketing_carrier_id;
  const airlineName = carriersDict[String(carrierId)] || "Airline";

  // If agents exist and one matches airline name, prefer that price
  // (FlightAPI’s schema includes agents[] with id/name and quotes[] mapping;
  // here we keep it simple: use baseAmount; airline-only selection can be expanded later.)
  return { airlineName, amount: baseAmount };
}

function timeHHMM(iso) {
  if (!iso) return "--:--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  return d.toTimeString().slice(0, 5);
}

function mapToUI(root, itin, carriersDict) {
  const leg = firstItineraryLeg(root, itin);
  const seg0 = firstSegmentForLeg(root, leg);
  const priceObj = pickCarrierSitePrice(root, itin, carriersDict);

  const carrierCode = seg0?.marketing_carrier_id ? String(seg0.marketing_carrier_id) : "";
  const flightNum = `${carrierCode} ${seg0?.number ?? ""}`.trim();
  const departure = timeHHMM(leg?.departure);
  const arrival = timeHHMM(leg?.arrival);

  // stops count as segments-1
  const segCount = Array.isArray(leg?.segment_ids) ? leg.segment_ids.length : 1;
  const stops = Math.max(0, segCount - 1);

  return {
    flightNumber: flightNum,
    airlineName: priceObj.airlineName,
    departure,
    arrival,
    price: String(priceObj.amount || 0),
    stops,
    carrierCode,
  };
}

function decorateWithPortals(basePrice) {
  const b = Number(basePrice || 0);
  return PORTALS.map(portal => ({
    portal,
    basePrice: b,
    finalPrice: b + PER_PORTAL_MARKUP,
    source: "carrier+markup",
  }));
}

function buildUrlRT({ from, to, depISO, retISO, adults, cabin, currency }) {
  // FlightAPI expects lower-case cabin (“economy|business|first|premium_economy”)
  const c = String(cabin || "economy").toLowerCase();
  // Round-trip endpoint
  const path = [
    "roundtrip",
    FLIGHTAPI_KEY,
    from,
    to,
    depISO,
    retISO,
    String(adults || 1),
    "0", // children
    "0", // infants
    c,
    currency || "INR",
  ].join("/");

  const url = `${FLIGHTAPI_BASE}/${path}?region=${encodeURIComponent(FLIGHTAPI_REGION)}`;
  return url;
}

// -------------------- DEBUG (build URL / fetch) --------------------
app.post("/debug-flightapi", async (req, res) => {
  try {
    const { from, to, departureDate, returnDate, passengers = 1, travelClass = "economy" } = req.body || {};
    if (!FLIGHTAPI_KEY) return res.status(200).json({ ok: false, error: "no-api-key" });

    const depISO = String(departureDate || "").slice(0, 10);
    const retISO = String(returnDate || "").slice(0, 10);

    const url = buildUrlRT({
      from: String(from || "").toUpperCase(),
      to: String(to || "").toUpperCase(),
      depISO,
      retISO,
      adults: passengers,
      cabin: travelClass,
      currency: "INR",
    });

    // dry=1 -> don’t call upstream, just show URL
    if ("dry" in req.query) return res.json({ ok: true, url, mode: "dry" });

    const json = await fetchJsonRetry(url, 2);
    const keys = Object.keys(json || {});
    const hasItin = Array.isArray(json?.itineraries) && json.itineraries.length > 0;

    res.json({ ok: true, status: 200, url, keys, hasItin });
  } catch (e) {
    res.json({ ok: false, status: 0, keys: [], hasItin: false, error: e.message || "error" });
  }
});

// -------------------- SEARCH --------------------
app.post("/search", async (req, res) => {
  try {
    // quick dry path
    if ("dry" in req.query) {
      return res.json({
        outboundFlights: [{
          flightNumber: "6E 123",
          airlineName: "IndiGo",
          departure: "10:00",
          arrival: "12:15",
          price: "12345",
          stops: 0,
          carrierCode: "32213",
          portalPrices: decorateWithPortals(12345),
        }],
        returnFlights: [],
        meta: { source: "dry" }
      });
    }

    const { from, to, departureDate, returnDate, passengers = 1, travelClass = "economy", tripType = "round-trip" } = req.body || {};
    if (!from || !to || !departureDate) {
      return res.status(400).json({ error: "missing-params" });
    }
    if (!FLIGHTAPI_KEY) {
      return res.status(200).json({ outboundFlights: [], returnFlights: [], meta: { source: "flightapi", reason: "no-key" } });
    }

    const ORG = String(from).toUpperCase();
    const DST = String(to).toUpperCase();
    const depISO = String(departureDate).slice(0, 10);
    const retISO = String(returnDate || "").slice(0, 10);

    // Build URL and fetch
    const url = buildUrlRT({
      from: ORG, to: DST, depISO, retISO,
      adults: passengers,
      cabin: travelClass,
      currency: "INR"
    });

    let data;
    try {
      data = await fetchJsonRetry(url, 2);
    } catch (e) {
      // If whole RT call fails, return empty but with meta
      return res.json({ outboundFlights: [], returnFlights: [], meta: { source: "flightapi", reason: e.message || "fetch-failed" } });
    }

    if (!Array.isArray(data?.itineraries) || data.itineraries.length === 0) {
      return res.json({ outboundFlights: [], returnFlights: [], meta: { source: "flightapi", reason: "no-itineraries" } });
    }

    const carriersDict = buildCarrierNameDict(data);
    const flights = [];
    for (const it of data.itineraries) {
      try {
        const ui = mapToUI(data, it, carriersDict);
        if (Number(ui.price) > 0) {
          flights.push({ ...ui, portalPrices: decorateWithPortals(ui.price) });
        }
      } catch {
        // skip malformed itinerary
      }
      if (flights.length >= 50) break; // sanity cap
    }

    // We don’t presently split outbound/return; FlightAPI’s RT result is a mix.
    // To keep UI moving, return everything under outboundFlights.
    return res.json({ outboundFlights: flights, returnFlights: [], meta: { source: "flightapi" } });
  } catch (e) {
    console.error("❌ Search error:", e);
    res.status(200).json({ outboundFlights: [], returnFlights: [], error: "search-failed" });
  }
});

// -------------------- START --------------------
app.listen(PORT, async () => {
  await connectDB();
  console.log(`🚀 SkyDeal backend running on ${PORT}`);
});
