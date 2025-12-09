// index.js — SkyDeal backend (FULL FILE)
// Node 18+ native fetch (no node-fetch import)
// Env: PORT, MONGO_URI, FLIGHTAPI_KEY, REGION (e.g., "IN"), CURRENCY (e.g., "INR")

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const MONGO_URI = process.env.MONGO_URI;
const CURRENCY = process.env.CURRENCY || "INR";
const REGION = process.env.REGION || "IN";
const FLIGHTAPI_KEY = process.env.FLIGHTAPI_KEY;

// ===== DB =====
let db = null;
async function connectDB() {
  if (db) return db;
  const client = new MongoClient(MONGO_URI, { maxPoolSize: 10 });
  await client.connect();
  db = client.db(); // default DB from URI
  return db;
}
await connectDB().catch(e => {
  console.error("✖ MongoDB Connection Error:", e);
});

// ===== Small utilities =====
const MARKUP = 100; // +₹100 per portal (unchanged)

function toDateSafe(v) {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}
function pickFirstDate(obj, keys) {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    const d = toDateSafe(v);
    if (d) return d;
  }
  return null;
}
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/ bank(s)?/g, "");
}

// === Booking window: now must be within validityPeriod.booking{startDate,endDate}
// Fallback to validityPeriod{startDate|from, endDate|to}. If neither, treat as valid.
function isWithinBookingWindow(ofr, now) {
  const start =
    pickFirstDate(ofr?.validityPeriod?.booking, ["startDate", "from", "start"]) ||
    pickFirstDate(ofr?.validityPeriod, ["startDate", "from", "start"]);
  const end =
    pickFirstDate(ofr?.validityPeriod?.booking, ["endDate", "to", "end"]) ||
    pickFirstDate(ofr?.validityPeriod, ["endDate", "to", "end"]);

  if (!start && !end) return true;
  if (start && now < start) return false;
  if (end && now > end) return false;
  return true;
}

// === Flight-only classifier (unchanged logic spirit)
function isFlightOffer(ofr) {
  if (Array.isArray(ofr.offerCategories)) {
    if (ofr.offerCategories.map(norm).includes("flight")) return true;
  }
  const t = `${ofr.title || ""} ${ofr.rawText || ""}`.toLowerCase();
  if (/(flight|airline|one-way|round[- ]?trip)/.test(t)) return true;
  if (/(hotel|stay|visa|bus|train)/.test(t)) return false;
  return true;
}

// ====== Portals base ======
function buildDefaultPortalPrices(base) {
  const portals = ["MakeMyTrip", "Goibibo", "EaseMyTrip", "Yatra", "Cleartrip"];
  return portals.map((p) => ({
    portal: p,
    basePrice: base,
    finalPrice: base + MARKUP,
    source: "carrier+markup",
    reasons: []
  }));
}
function offerMatchesPortal(ofr, portalName) {
  const list = ofr.parsedApplicablePlatforms;
  if (!Array.isArray(list) || list.length === 0) return true;
  const norm = (s) => String(s || "").trim().toLowerCase();
  return list.map(norm).includes(norm(portalName));
}

// ====== Offers -> per-portal pricing ======
function applyOffersToPortals(base, applicable) {
  const portals = buildDefaultPortalPrices(base);

  for (const ofr of (applicable || [])) {
    for (const p of portals) {
      if (!offerMatchesPortal(ofr, p.portal)) continue;

      const pct = Number(ofr.discountPercent) || 0;
      const flat = Number(ofr.flatDiscountAmount) || 0;

      const candidates = [p.finalPrice];
      if (pct > 0) {
        const cut = Math.floor((p.finalPrice * pct) / 100);
        const capped = ofr.maxDiscountAmount
          ? Math.min(cut, Number(ofr.maxDiscountAmount))
          : cut;
        if (capped > 0) candidates.push(p.finalPrice - capped);
      }
      if (flat > 0) candidates.push(Math.max(0, p.finalPrice - flat));

      const bestAfter = Math.min(...candidates);
      if (bestAfter < p.finalPrice) {
        p.finalPrice = bestAfter;
        p.source = "carrier+offer+markup";
        const bits = [];
        if (pct) bits.push(`${pct}%`);
        if (ofr.maxDiscountAmount) bits.push(`cap ₹${ofr.maxDiscountAmount}`);
        if (flat) bits.push(`₹${flat} off`);
        const bank = ofr.paymentMethods?.[0]?.bank;
        if (bank) bits.push(bank);
        const code = ofr.code || ofr.offerCode || "";
        if (code) bits.push(`code ${code}`);
        p.reasons = [{ title: ofr.title || "Offer", summary: bits.join(" • ") }];
      }
    }
  }

  let best = portals[0];
  for (const p of portals) {
    if (p.finalPrice < best.finalPrice) best = p;
  }
  const bestDeal = {
    portal: best.portal,
    finalPrice: best.finalPrice,
    note: "Best price after applicable offers (if any)",
    reason: best.reasons?.[0] || null
  };
  return { portalPrices: portals, bestDeal };
}

// ===== FlightAPI helpers (same shape you already use) =====
function buildRoundtripURL({ from, to, departureDate, returnDate, adults = 1, cabin = "economy" }) {
  return `https://api.flightapi.io/roundtrip/${FLIGHTAPI_KEY}/${from}/${to}/${departureDate}/${returnDate}/${adults}/0/0/${cabin}/${CURRENCY}?region=${REGION}`;
}
function buildOnewayURL({ from, to, date, adults = 1, cabin = "economy" }) {
  return `https://api.flightapi.io/onewaytrip/${FLIGHTAPI_KEY}/${from}/${to}/${date}/${adults}/0/0/${cabin}/${CURRENCY}?region=${REGION}`;
}
async function fetchJson(url, timeoutMs = 28000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const status = res.status;
    let json = null;
    try { json = await res.json(); } catch (_) {}
    return { status, json };
  } finally { clearTimeout(t); }
}

// ====== /payment-options (unchanged shape) ======
app.get("/payment-options", async (_req, res) => {
  const options = {
    CreditCard: [
      "Axis Bank","Federal Bank","HDFC Bank","HSBC Bank","ICICI Bank",
      "IDFC First Bank","Kotak Bank","RBL Bank","Yes Bank","BOB"
    ],
    DebitCard: ["HDFC Bank","ICICI Bank","SBI","Axis Bank","Kotak Bank"],
    NetBanking: ["HDFC Bank","ICICI Bank","SBI","Axis Bank","Kotak Bank"],
    UPI: ["GPAY","PhonePe","Paytm"],
    Wallet: ["Amazon Pay","Paytm Wallet","Mobikwik"],
    EMI: ["Axis Bank","Federal Bank","HDFC Bank","Kotak Bank","RBL Bank","Yes Bank"]
  };
  res.json({ usedFallback: false, options });
});

// ====== /search ======
app.post('/search', async (req, res) => {
  const {
    from, to, departureDate, returnDate = '',
    tripType = 'round-trip', passengers = 1, travelClass = 'economy',
    paymentMethods = []
  } = req.body || {};

  const nowForChecks = new Date();

  async function callFlightApi() {
    try {
      const url = tripType === 'round-trip'
        ? buildRoundtripUrl(from, to, departureDate, returnDate, passengers, travelClass)
        : buildOnewayUrl(from, to, departureDate, passengers, travelClass);

      const { status, json } = await fetchJson(url, 28000);
      const { outboundFlights, returnFlights } = mapFlightApiToSkyDeal(json); // your existing mapper
      return { status, outboundFlights, returnFlights };
    } catch (e) {
      console.error('FlightAPI error:', e.message);
      return { status: 500, outboundFlights: [], returnFlights: [] };
    }
  }

  // 1) primary call
  let { status: outStatus, outboundFlights, returnFlights } = await callFlightApi();

  // 2) retry once if both empty
  let usedFallback = false;
  if ((outboundFlights?.length ?? 0) === 0 && (returnFlights?.length ?? 0) === 0) {
    const retry = await callFlightApi();
    outStatus = retry.status;
    outboundFlights = retry.outboundFlights;
    returnFlights = retry.returnFlights;
  }

  // 3) minimal mock (optional) if still empty → keeps UI alive
  if ((outboundFlights?.length ?? 0) === 0 && (returnFlights?.length ?? 0) === 0) {
    usedFallback = true;
    outboundFlights = [{
      title: `${from} → ${to}`,
      airlineName: 'Air India',
      base: 8200,
      portalPrices: buildDefaultPortalPrices(8200),
      bestDeal: { portal: 'MakeMyTrip', finalPrice: 8200 + MARKUP, note: 'carrier+markup (no offers matched)' },
      offerReasons: {}
    }];
    returnFlights = tripType === 'round-trip' ? [{
      title: `${to} → ${from}`,
      airlineName: 'Air India',
      base: 8400,
      portalPrices: buildDefaultPortalPrices(8400),
      bestDeal: { portal: 'MakeMyTrip', finalPrice: 8400 + MARKUP, note: 'carrier+markup (no offers matched)' },
      offerReasons: {}
    }] : [];
  }

  // 4) offers (active + flight-only + valid)
  let applicable = [];
  let offerDebug = { checked: 0, applied: 0, skipped: {}, examples: {} };
  if (Array.isArray(paymentMethods) && paymentMethods.length > 0 && offersCol) {
    const allActive = await offersCol.find({ isExpired: { $ne: true } }).toArray();
    const out = pickApplicableOffersWithReasons(allActive, paymentMethods, nowForChecks); // your function
    applicable = out.list;
    offerDebug = out.debug;
  }

  // 5) decorate with portal prices & best deal (preserve base-only card)
  function decorate(f) {
    const base = Number(f.base) || 0;
    const { portalPrices, bestDeal } = applyOffersToPortals(base, applicable);
    return { ...f, portalPrices, bestDeal };
  }
  const outboundDecorated = (outboundFlights || []).map(decorate);
  const returnDecorated = (returnFlights || []).map(decorate);

  const meta = {
    source: 'flightapi',
    outStatus, outCount: outboundDecorated.length,
    retCount: returnDecorated.length,
    offerDebug,
    usedFallback,
    nowUsed: nowForChecks.toISOString(),
  };

  res.json({
    meta,
    outboundFlights: outboundDecorated,
    returnFlights: returnDecorated
  });
});


app.listen(PORT, () => {
  console.log(`SkyDeal backend up on :${PORT}`);
});
