// index.js — SkyDeal backend (drop-in)
// Node >=18 (uses global fetch). ESM module.
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const FLIGHTAPI_KEY = process.env.FLIGHTAPI_KEY || process.env.FLIGHT_API_KEY; // support both names
const REGION = 'IN';
const CURRENCY = 'INR';
const MARKUP = 250;

// ---------- Mongo ----------
const MONGO_URI = process.env.MONGO_URI;
let mongo, db, offersCol;

async function connectDB() {
  if (!MONGO_URI) {
    console.error('❌ Missing MONGO_URI');
    return;
  }
  if (db) return;
  mongo = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  await mongo.connect();
  db = mongo.db('skydeal');
  offersCol = db.collection('offers');
  console.log('✅ Connected to MongoDB (EC2)');
}

await connectDB().catch((e) => {
  console.error('❌ MongoDB Connection Error:', e);
});

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toTime(t) {
  // '2025-12-20T23:30:00' -> '23:30'
  if (!t) return '';
  const m = t.match(/T(\d{2}:\d{2})/);
  return m ? m[1] : t;
}

function pickCarrierName(carriersMap, seg) {
  const id = String(seg?.marketing_carrier_id ?? '');
  const name = carriersMap.get(id);
  return name || 'Unknown';
}

function buildDefaultPortalPrices(base) {
  return [
    { portal: 'MakeMyTrip', basePrice: base, finalPrice: base + MARKUP, source: 'carrier+markup' },
    { portal: 'Goibibo',    basePrice: base, finalPrice: base + MARKUP, source: 'carrier+markup' },
    { portal: 'EaseMyTrip', basePrice: base, finalPrice: base + MARKUP, source: 'carrier+markup' },
    { portal: 'Yatra',      basePrice: base, finalPrice: base + MARKUP, source: 'carrier+markup' },
    { portal: 'Cleartrip',  basePrice: base, finalPrice: base + MARKUP, source: 'carrier+markup' },
  ];
}

// very defensive normalizer
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/ bank$/, '');
}

// Offer eligibility (booking validity only; you can later add travel windows, weekday, minAmount, etc.)
function isOfferCurrentlyValid(ofr) {
  // explicit boolean wins
  if (ofr.isExpired === true) return false;

  const end =
    ofr?.validityPeriod?.endDate ||
    ofr?.validityPeriod?.to ||
    ofr?.validityPeriod?.end ||
    null;

  if (!end) {
    // if no end date provided, assume usable unless explicitly expired
    return true;
  }
  const now = new Date();
  const endDt = new Date(end);
  return now <= endDt;
}

// returns a minimal “applicable” offer bundle for the selected banks/types
function pickApplicableOffers(allOffers, selectedLabels) {
  if (!Array.isArray(selectedLabels) || selectedLabels.length === 0) return [];
  const wanted = new Set(selectedLabels.map(norm));

  const res = [];
  for (const ofr of allOffers) {
    if (!isOfferCurrentlyValid(ofr)) continue;

    const pms = Array.isArray(ofr.paymentMethods) ? ofr.paymentMethods : [];
    // Consider any bank/type/method/category/mode fields we stored
    const tags = new Set();
    for (const pm of pms) {
      ['bank', 'type', 'method', 'category', 'mode', 'wallet'].forEach((k) => {
        if (pm?.[k]) tags.add(norm(pm[k]));
      });
    }
    // also consider parsedApplicablePlatforms if present (e.g., 'MakeMyTrip', etc.)
    if (Array.isArray(ofr.parsedApplicablePlatforms)) {
      for (const p of ofr.parsedApplicablePlatforms) tags.add(norm(p));
    }

    // If any selection matches, we keep it
    let match = false;
    for (const w of wanted) {
      if (tags.has(w)) {
        match = true;
        break;
      }
    }
    if (match) res.push(ofr);
  }
  return res;
}

function computeDiscountedPrice(base, ofr) {
  // support % off and flat amounts, with optional cap
  const b = Number(base) || 0;

  const pct = Number(ofr?.discountPercent);
  const flat = Number(ofr?.maxDiscountAmountFlat ?? ofr?.flatDiscountAmount);
  const cap = Number(ofr?.maxDiscountAmount);

  let discount = 0;

  if (!Number.isNaN(flat) && flat > 0) {
    discount = flat;
  } else if (!Number.isNaN(pct) && pct > 0) {
    discount = (pct / 100) * b;
  }

  if (!Number.isNaN(cap) && cap > 0) {
    discount = Math.min(discount, cap);
  }
  // guard
  if (discount < 0) discount = 0;
  return Math.max(0, Math.round(b - discount));
}

function applyOffersToPortals(base, applicableOffers) {
  // Start with the default (carrier+markup) prices
  const portals = buildDefaultPortalPrices(base);

  if (!applicableOffers || applicableOffers.length === 0) {
    return {
      portalPrices: portals,
      bestDeal: null,
    };
  }

  // If offers specify a portal, apply there; otherwise, apply to all portals (conservative)
  for (const ofr of applicableOffers) {
    const targetedPortals =
      (Array.isArray(ofr.parsedApplicablePlatforms) && ofr.parsedApplicablePlatforms.length > 0)
        ? ofr.parsedApplicablePlatforms
        : null;

    if (targetedPortals) {
      for (const p of portals) {
        if (targetedPortals.map(norm).includes(norm(p.portal))) {
          const discounted = computeDiscountedPrice(p.basePrice, ofr) + MARKUP;
          p.finalPrice = Math.min(p.finalPrice, discounted);
          p.source = 'carrier+offer+markup';
        }
      }
    } else {
      // apply to all portals
      for (const p of portals) {
        const discounted = computeDiscountedPrice(p.basePrice, ofr) + MARKUP;
        p.finalPrice = Math.min(p.finalPrice, discounted);
        p.source = 'carrier+offer+markup';
      }
    }
  }

  // best deal = min finalPrice across portals
  let best = portals[0];
  for (const p of portals) {
    if (p.finalPrice < best.finalPrice) best = p;
  }
  const bestDeal = {
    portal: best.portal,
    finalPrice: best.finalPrice,
    note: 'Best price after applicable offers (if any)',
  };

  return { portalPrices: portals, bestDeal };
}

// ---------- FlightAPI calling ----------
function buildRoundtripUrl({ from, to, departureDate, returnDate, adults = 1, cabin = 'economy' }) {
  return `https://api.flightapi.io/roundtrip/${FLIGHTAPI_KEY}/${from}/${to}/${departureDate}/${returnDate}/${adults}/0/0/${cabin}/${CURRENCY}?region=${REGION}`;
}
function buildOnewayUrl({ from, to, date, adults = 1, cabin = 'economy' }) {
  // documented one-way endpoint is "onewaytrip"
  return `https://api.flightapi.io/onewaytrip/${FLIGHTAPI_KEY}/${from}/${to}/${date}/${adults}/0/0/${cabin}/${CURRENCY}?region=${REGION}`;
}

async function fetchJson(url, timeoutMs = 28000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const status = r.status;
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status, json, raw: text };
  } finally {
    clearTimeout(t);
  }
}

// Extract flights from a one-way response
function extractFlightsOneWay(resp) {
  const r = resp?.json || {};
  const itins = Array.isArray(r.itineraries) ? r.itineraries : [];
  const legs = new Map();
  const segments = new Map();
  const carriers = new Map();

  (Array.isArray(r.legs) ? r.legs : []).forEach((L) => legs.set(L.id, L));
  (Array.isArray(r.segments) ? r.segments : []).forEach((S) => segments.set(S.id, S));
  (Array.isArray(r.carriers) ? r.carriers : []).forEach((C) => carriers.set(String(C.id), C.name));

  const flights = [];
  for (const it of itins) {
    // keep only itineraries with exactly 1 leg (pure one-way)
    if (!Array.isArray(it.leg_ids) || it.leg_ids.length !== 1) continue;

    const leg = legs.get(it.leg_ids[0]);
    if (!leg) continue;

    const seg0 = segments.get(leg.segment_ids?.[0]);
    const airlineName = pickCarrierName(carriers, seg0);
    const carrierCode = String(seg0?.marketing_carrier_id ?? '');
    const number = seg0?.number ? `${seg0.number}` : airlineName;

    const priceObj = it?.pricing_options?.[0]?.price;
    const basePrice = Math.round(Number(priceObj?.amount) || 0);
    if (!basePrice) continue;

    flights.push({
      flightNumber: number,
      airlineName,
      departure: toTime(leg.departure),
      arrival: toTime(leg.arrival),
      price: String(basePrice),
      stops: Array.isArray(leg.stop_ids) ? leg.stop_ids.length : 0,
      carrierCode,
      // portalPrices & bestDeal will be filled later depending on offers
    });
  }
  return flights;
}

// ---------- Routes ----------
app.get('/health', async (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), dbConnected: !!db });
});

// For debugging exact FlightAPI call
app.post('/debug-flightapi', async (req, res) => {
  try {
    const { from, to, departureDate, returnDate, passengers = 1, travelClass = 'economy', tripType = 'round-trip' } = req.body || {};
    if (req.query.dry === '1') {
      if (!FLIGHTAPI_KEY) return res.json({ ok: false, url: null, mode: null });
      if (tripType === 'one-way' || !returnDate) {
        return res.json({ ok: true, url: buildOnewayUrl({ from, to, date: departureDate, adults: passengers, cabin: travelClass }), mode: 'dry' });
      } else {
        return res.json({ ok: true, url: buildRoundtripUrl({ from, to, departureDate, returnDate, adults: passengers, cabin: travelClass }), mode: 'dry' });
      }
    }

    if (!FLIGHTAPI_KEY) return res.json({ ok: false, status: null, keys: null, hasItin: null, error: 'no-api-key' });

    const url =
      (tripType === 'one-way' || !returnDate)
        ? buildOnewayUrl({ from, to, date: departureDate, adults: passengers, cabin: travelClass })
        : buildRoundtripUrl({ from, to, departureDate, returnDate, adults: passengers, cabin: travelClass });

    const r = await fetchJson(url);
    const keys = r.json ? Object.keys(r.json) : [];
    const hasItin = Array.isArray(r.json?.itineraries) ? r.json.itineraries.length : 0;
    res.json({ ok: true, status: r.status, keys, hasItin, error: null });
  } catch (e) {
    const msg = (e?.name === 'AbortError') ? 'timeout' : (e?.message || 'error');
    res.json({ ok: false, status: 0, keys: [], hasItin: false, error: msg });
  }
});

// Payment options: normalize from Mongo and de-dupe
app.get('/payment-options', async (_req, res) => {
  try {
    const active = { isExpired: { $ne: true } };
    const cursor = offersCol.find(active, { projection: { paymentMethods: 1 } });
    const buckets = {
      CreditCard: new Set(),
      DebitCard: new Set(),
      EMI: new Set(),
      NetBanking: new Set(),
      Wallet: new Set(),
      UPI: new Set(),
    };

    const mapType = (pm) => norm(pm?.type || '');
    for await (const doc of cursor) {
      const pms = Array.isArray(doc.paymentMethods) ? doc.paymentMethods : [];
      for (const pm of pms) {
        const t = mapType(pm);
        const labelBank = norm(pm.bank) || norm(pm.wallet) || norm(pm.method) || '';
        if (!labelBank) continue;

        if (t === 'credit card' || t === 'credit_card' || t === 'credit') buckets.CreditCard.add(labelBank);
        else if (t === 'debit card' || t === 'debit_card' || t === 'debit') buckets.DebitCard.add(labelBank);
        else if (t === 'emi') buckets.EMI.add(labelBank);
        else if (t === 'net banking' || t === 'net_banking' || t === 'internet banking') buckets.NetBanking.add(labelBank);
        else if (t === 'wallet') buckets.Wallet.add(labelBank);
        else if (t === 'upi') buckets.UPI.add(labelBank);
        // Some offers mention EMI inside credit cards explicitly; put under EMI too
        if (/emi/i.test(pm?.category || '') || /emi/i.test(pm?.method || '')) {
          buckets.EMI.add(labelBank);
        }
      }
    }

    const canon = (s) => {
      if (!s) return s;
      // Title Case basic canonicalization
      return s
        .split(' ')
        .map((w) => w ? w[0].toUpperCase() + w.slice(1) : w)
        .join(' ')
        .replace(/\bHdfc\b/gi, 'HDFC')
        .replace(/\bHsbc\b/gi, 'HSBC')
        .replace(/\bIcici\b/gi, 'ICICI')
        .replace(/\bIdfc\b/gi, 'IDFC')
        .replace(/\bRbl\b/gi, 'RBL')
        .replace(/\bSbi\b/gi, 'SBI');
    };

    const options = Object.fromEntries(
      Object.entries(buckets).map(([k, set]) => [k, Array.from(set).sort().map(canon)])
    );

    res.json({ usedFallback: false, options });
  } catch (e) {
    console.error('payment-options error', e);
    res.json({
      usedFallback: true,
      options: {
        CreditCard: [], DebitCard: [], EMI: [], NetBanking: [], Wallet: [], UPI: ['Mobikwik'],
      },
    });
  }
});

// Main search: one-way always; round-trip = 2 one-way calls
app.post('/search', async (req, res) => {
  try {
    const {
      from, to, departureDate, returnDate,
      passengers = 1, travelClass = 'economy',
      tripType = 'round-trip',
      paymentMethods = [],
    } = req.body || {};

    if (!FLIGHTAPI_KEY) {
      return res.json({ outboundFlights: [], returnFlights: [], meta: { source: 'flightapi', reason: 'no-key' } });
    }

    const fromCode = (from || '').slice(0, 3).toUpperCase();
    const toCode = (to || '').slice(0, 3).toUpperCase();

    // 1) Fetch outbound one-way
    const urlOut = buildOnewayUrl({ from: fromCode, to: toCode, date: departureDate, adults: passengers, cabin: travelClass });
    const outResp = await fetchJson(urlOut);
    const outboundFlights = extractFlightsOneWay(outResp);

    // 2) If round-trip, fetch return one-way
    let returnFlights = [];
    if (tripType !== 'one-way' && returnDate) {
      const urlRet = buildOnewayUrl({ from: toCode, to: fromCode, date: returnDate, adults: passengers, cabin: travelClass });
      // small pause to be kind to API
      await sleep(200);
      const retResp = await fetchJson(urlRet);
      returnFlights = extractFlightsOneWay(retResp);
    }

    // 3) Load offers once (active only)
    let applicable = [];
    if (Array.isArray(paymentMethods) && paymentMethods.length > 0) {
      const allActive = await offersCol.find({ isExpired: { $ne: true } }).toArray();
      applicable = pickApplicableOffers(allActive, paymentMethods);
    }

    // 4) Attach portalPrices/bestDeal for each flight (ALWAYS keep base prices)
    function decorate(f) {
      const base = Number(f.price) || 0;
      const { portalPrices, bestDeal } = applyOffersToPortals(base, applicable);
      return { ...f, portalPrices, bestDeal };
    }

    const outboundDecorated = outboundFlights.map(decorate);
    const returnDecorated = returnFlights.map(decorate);

    return res.json({
      outboundFlights: outboundDecorated,
      returnFlights: returnDecorated,
      meta: { source: 'flightapi' },
    });
  } catch (e) {
    console.error('❌ Search error:', e);
    res.json({ outboundFlights: [], returnFlights: [], error: 'search-failed' });
  }
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`🚀 SkyDeal backend running on ${PORT}`);
});
