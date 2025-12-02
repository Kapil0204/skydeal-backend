// index.js — SkyDeal backend (with return-leg retry + flight-only offer filtering + meta counts)
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

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/ bank$/, '');
}

// Offer validity by booking window
function isOfferCurrentlyValid(ofr) {
  if (ofr.isExpired === true) return false;
  const end =
    ofr?.validityPeriod?.endDate ||
    ofr?.validityPeriod?.to ||
    ofr?.validityPeriod?.end ||
    null;
  if (!end) return true;
  const now = new Date();
  const endDt = new Date(end);
  return now <= endDt;
}

// Flight-only filter: rely on offerCategories (preferred), then keywords
function isFlightOffer(ofr) {
  const cats = Array.isArray(ofr.offerCategories) ? ofr.offerCategories.map(norm) : [];
  if (cats.some(c => /flight/.test(c))) return true;

  const raw = (
    (ofr.rawText || '') + ' ' +
    (ofr.title || '') + ' ' +
    (ofr?.validityPeriod?.raw || '')
  ).toLowerCase();

  return /(flight|airfare|domestic flight|international flight)/.test(raw);
}

function pickApplicableOffers(allOffers, selectedLabels) {
  if (!Array.isArray(selectedLabels) || selectedLabels.length === 0) return [];
  const wanted = new Set(selectedLabels.map(norm));

  const res = [];
  for (const ofr of allOffers) {
    if (!isOfferCurrentlyValid(ofr)) continue;
    if (!isFlightOffer(ofr)) continue;

    const pms = Array.isArray(ofr.paymentMethods) ? ofr.paymentMethods : [];
    const tags = new Set();

    for (const pm of pms) {
      ['bank', 'type', 'method', 'category', 'mode', 'wallet'].forEach((k) => {
        if (pm?.[k]) tags.add(norm(pm[k]));
      });
    }
    if (Array.isArray(ofr.parsedApplicablePlatforms)) {
      for (const p of ofr.parsedApplicablePlatforms) tags.add(norm(p));
    }

    let match = false;
    for (const w of wanted) {
      if (tags.has(w)) { match = true; break; }
    }
    if (match) res.push(ofr);
  }
  return res;
}

function computeDiscountedPrice(base, ofr) {
  const b = Number(base) || 0;

  const pct = Number(ofr?.discountPercent);
  const flat = Number(ofr?.maxDiscountAmountFlat ?? ofr?.flatDiscountAmount);
  const cap  = Number(ofr?.maxDiscountAmount);

  let discount = 0;

  if (!Number.isNaN(flat) && flat > 0) {
    discount = flat;
  } else if (!Number.isNaN(pct) && pct > 0) {
    discount = (pct / 100) * b;
  }

  if (!Number.isNaN(cap) && cap > 0) {
    discount = Math.min(discount, cap);
  }
  if (discount < 0) discount = 0;
  return Math.max(0, Math.round(b - discount));
}

function applyOffersToPortals(base, applicableOffers) {
  const portals = buildDefaultPortalPrices(base);

  if (!applicableOffers || applicableOffers.length === 0) {
    return { portalPrices: portals, bestDeal: null };
  }

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
      for (const p of portals) {
        const discounted = computeDiscountedPrice(p.basePrice, ofr) + MARKUP;
        p.finalPrice = Math.min(p.finalPrice, discounted);
        p.source = 'carrier+offer+markup';
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
    note: 'Best price after applicable offers (if any)',
  };

  return { portalPrices: portals, bestDeal };
}

// ---------- FlightAPI calling ----------
function buildRoundtripUrl({ from, to, departureDate, returnDate, adults = 1, cabin = 'economy' }) {
  return `https://api.flightapi.io/roundtrip/${FLIGHTAPI_KEY}/${from}/${to}/${departureDate}/${returnDate}/${adults}/0/0/${cabin}/${CURRENCY}?region=${REGION}`;
}
function buildOnewayUrl({ from, to, date, adults = 1, cabin = 'economy' }) {
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
    try { json = JSON.parse(text); } catch { json = null; }
    return { status, json, raw: text };
  } finally {
    clearTimeout(t);
  }
}

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
    });
  }
  return flights;
}

// ---------- routes ----------
app.get('/health', async (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), dbConnected: !!db });
});

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

// Payment options from Mongo, normalized + de-duped
// ===========================
// /payment-options (REPLACE)
// ===========================
app.get('/payment-options', async (req, res) => {
  try {
    const db = mongoClient.db();
    const col = db.collection('offers');

    // Helper: normalize bank to a nice display label
    function normalizeBankLabel(raw) {
      if (!raw) return null;
      let s = String(raw).trim().toLowerCase();
      // common fixes
      s = s.replace(/\s+bank$/, ''); // drop trailing " bank"
      // canonical map first (explicit beats heuristics)
      const map = {
        'hdfc': 'HDFC Bank',
        'hdfc bank': 'HDFC Bank',
        'icici': 'ICICI Bank',
        'icici bank': 'ICICI Bank',
        'axis': 'Axis Bank',
        'axis bank': 'Axis Bank',
        'idfc first': 'IDFC First Bank',
        'idfc first bank': 'IDFC First Bank',
        'rbl': 'RBL Bank',
        'rbl bank': 'RBL Bank',
        'yes': 'Yes Bank',
        'yes bank': 'Yes Bank',
        'hsbc': 'HSBC',
        'hsbc bank': 'HSBC',
        'federal': 'Federal Bank',
        'federal bank': 'Federal Bank',
        'kotak': 'Kotak Bank',
        'kotak bank': 'Kotak Bank',
        'sbi': 'SBI Bank',
        'sbi bank': 'SBI Bank',
        'au small': 'AU Small Finance Bank',
        'au small bank': 'AU Small Finance Bank',
        'bobcard ltd': 'BOBCARD Ltd',
        'canara': 'Canara Bank',
        'canara bank': 'Canara Bank',
        'central bank of india': 'Central Bank Of India',
        'mobikwik': 'Mobikwik'
      };
      if (map[s]) return map[s];

      // heuristic title-case + append " Bank" for likely banks
      const needsBankSuffix = /^(hdfc|icici|axis|rbl|yes|federal|kotak|sbi|idfc first|canara|central bank of india|au small)$/i.test(s);
      // title-case
      const titled = s.replace(/\b\w/g, c => c.toUpperCase());
      return needsBankSuffix ? `${titled} Bank` : titled;
    }

    // Helper: normalize type into our tabs
    function normalizeType(tRaw, m, c, mo) {
      const t = (tRaw || '').toLowerCase();
      const method = (m || '').toLowerCase();
      const cat = (c || '').toLowerCase();
      const mode = (mo || '').toLowerCase();

      const isCredit = /(credit[_\s-]?card|credit)\b/.test(t);
      const isDebit  = /(debit[_\s-]?card|debit)\b/.test(t);
      const isNet    = /(net[_\s-]?banking|internet[_\s-]?banking)/.test(t);
      const isUPI    = /upi/.test(t) || /upi/.test(method) || /upi/.test(cat) || /upi/.test(mode);
      const isWallet = /wallet/.test(t) || /wallet/.test(method) || /wallet/.test(cat) || /wallet/.test(mode);
      const isEmi    = /emi/.test(t) || /emi/.test(method) || /emi/.test(cat) || /emi/.test(mode);

      if (isEmi) return 'EMI';
      if (isCredit) return 'CreditCard';
      if (isDebit)  return 'DebitCard';
      if (isNet)    return 'NetBanking';
      if (isUPI)    return 'UPI';
      if (isWallet) return 'Wallet';
      return 'Other';
    }

    // Pull all active offers relevant to flights (same filters you and I used in probes)
    const offers = await col.aggregate([
      { $match: { isExpired: { $ne: true } } },
      { $addFields: {
          _end:  { $ifNull: ['$validityPeriod.endDate', '$validityPeriod.to'] },
          _cats: { $ifNull: ['$offerCategories', []] },
          _blob: {
            $concat: [
              { $ifNull: ['$rawText', ''] }, ' ',
              { $ifNull: ['$title', ''] }, ' ',
              { $ifNull: ['$validityPeriod.raw', ''] }
            ]
          }
      }},
      { $match: {
          $or: [
            { _cats: { $elemMatch: { $regex: /flight/i } } },
            { _blob: /flight|airfare|domestic flight|international flight/i }
          ],
          $or: [
            { _end: null },
            { _end: { $gte: new Date() } }
          ]
      }},
      { $unwind: '$paymentMethods' },
      { $project: {
          type: '$paymentMethods.type',
          method: { $ifNull: ['$paymentMethods.method', ''] },
          category: { $ifNull: ['$paymentMethods.category', ''] },
          mode: { $ifNull: ['$paymentMethods.mode', ''] },
          bank: '$paymentMethods.bank'
      }}
    ]).toArray();

    // Build sets per tab
    const sets = {
      CreditCard: new Set(),
      DebitCard: new Set(),
      NetBanking: new Set(),
      UPI: new Set(),
      Wallet: new Set(),
      EMI: new Set()
    };

    for (const p of offers) {
      const bankLabel = normalizeBankLabel(p.bank);
      if (!bankLabel) continue;
      const tab = normalizeType(p.type, p.method, p.category, p.mode);
      if (tab === 'Other') continue;
      sets[tab]?.add(bankLabel);

      // If an offer is explicitly EMI AND also a credit card EMI, it should also appear in CreditCard
      if (tab === 'EMI') {
        // Heuristic: if the bank label ends with 'Bank' (i.e., CC EMI), include under CreditCard too
        if (/bank$/i.test(bankLabel)) sets.CreditCard.add(bankLabel);
      }
    }

    // Convert to sorted arrays
    const options = Object.fromEntries(
      Object.entries(sets).map(([k, v]) => [k, Array.from(v).sort()])
    );

    res.json({ usedFallback: false, options });
  } catch (e) {
    console.error('payment-options error:', e);
    // Fallback to whatever you had before if needed
    res.json({
      usedFallback: true,
      options: {
        CreditCard: [],
        DebitCard: [],
        Wallet: [],
        UPI: [],
        NetBanking: [],
        EMI: []
      }
    });
  }
});


// Main search: one-way always; round-trip = 2 one-way calls (with retry on return leg)
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
    const toCode   = (to   || '').slice(0, 3).toUpperCase();

    // 1) outbound
    const urlOut = buildOnewayUrl({ from: fromCode, to: toCode, date: departureDate, adults: passengers, cabin: travelClass });
    const outResp = await fetchJson(urlOut);
    const outboundFlights = extractFlightsOneWay(outResp);

    // 2) return (with single retry if empty)
    let returnFlights = [];
    let retResp = null;
    let retStatus = null;
    if (tripType !== 'one-way' && returnDate) {
      const urlRet = buildOnewayUrl({ from: toCode, to: fromCode, date: returnDate, adults: passengers, cabin: travelClass });
      await sleep(220); // brief gap for throttling
      retResp = await fetchJson(urlRet);
      retStatus = retResp.status;
      returnFlights = extractFlightsOneWay(retResp);

      // retry once if empty or status not 200
      if ((!Array.isArray(returnFlights) || returnFlights.length === 0) || retStatus !== 200) {
        await sleep(650);
        const retry = await fetchJson(urlRet);
        retStatus = retry.status;
        const again = extractFlightsOneWay(retry);
        if (Array.isArray(again) && again.length > 0) {
          returnFlights = again;
          retResp = retry;
        }
      }
    }

    // 3) offers (active + flight-only)
    let applicable = [];
    if (Array.isArray(paymentMethods) && paymentMethods.length > 0) {
      const allActive = await offersCol.find({ isExpired: { $ne: true } }).toArray();
      applicable = pickApplicableOffers(allActive, paymentMethods);
    }

    // 4) decorate with portal prices & bestDeal (always keep carrier base)
    function decorate(f) {
      const base = Number(f.price) || 0;
      const { portalPrices, bestDeal } = applyOffersToPortals(base, applicable);
      return { ...f, portalPrices, bestDeal };
    }

    const outboundDecorated = outboundFlights.map(decorate);
    const returnDecorated  = returnFlights.map(decorate);

    // meta debug counts
    const meta = {
      source: 'flightapi',
      outStatus: outResp?.status ?? null,
      outCount: Array.isArray(outboundFlights) ? outboundFlights.length : 0,
      retStatus: retResp?.status ?? null,
      retCount: Array.isArray(returnFlights) ? returnFlights.length : 0,
    };

    return res.json({
      outboundFlights: outboundDecorated,
      returnFlights: returnDecorated,
      meta,
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
