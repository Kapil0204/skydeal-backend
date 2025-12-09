// index.js — SkyDeal backend (layout-safe; only pricing/offer logic touched)

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { MongoClient, ObjectId } from 'mongodb';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// ---- Env
const FLIGHTAPI_KEY = process.env.FLIGHTAPI_KEY || '';
const REGION = process.env.REGION || 'IN';
const CURRENCY = process.env.CURRENCY || 'INR';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/skydeal';

// ---- App
app.use(cors());
app.use(express.json());

// ---- DB
let client = null;
let db = null;
let offersCol = null;

async function connectDB() {
  if (db) return db;
  client = new MongoClient(MONGO_URI, { directConnection: true });
  await client.connect();
  db = client.db();
  offersCol = db.collection('offers');
  return db;
}

connectDB().catch((e) => console.error('✖ MongoDB Connection Error:', e));

// ---------- helpers ----------
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
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/ bank$/, '');
}

// --- Booking window check (Milestone 2)
function isWithinBookingWindow(ofr, now) {
  const B = ofr?.validityPeriod?.booking || {};
  const outer = ofr?.validityPeriod || {};

  const start =
    pickFirstDate(B, ['startDate', 'from']) ||
    pickFirstDate(outer, ['startDate', 'from']);
  const end =
    pickFirstDate(B, ['endDate', 'to']) ||
    pickFirstDate(outer, ['endDate', 'to']);

  const t = now.getTime();
  if (start && end) return t >= start.getTime() && t <= end.getTime();
  if (start && !end) return t >= start.getTime();
  if (!start && end) return t <= end.getTime();
  return true; // no dates => allow
}

// ---------- Flight-only filter ----------
function isFlightOffer(ofr) {
  // Prefer explicit categorization
  if (Array.isArray(ofr.offerCategories) && ofr.offerCategories.length) {
    const hit = ofr.offerCategories.some((c) =>
      /flight|airfare/i.test(String(c))
    );
    if (hit) return true;
  }
  // fallback to rawText/title
  const hay =
    (ofr.title || '') +
    ' ' +
    (ofr.rawText || '') +
    ' ' +
    (ofr.sourcePortal || '');
  return /flight|airfare|air\s?lines?|book.*flight/i.test(hay);
}

// ---- Payment matching (loose match on bank names)
function matchesPayment(ofr, wantedBanksLower) {
  if (!Array.isArray(ofr.paymentMethods) || ofr.paymentMethods.length === 0)
    return false;
  const banks = ofr.paymentMethods
    .map((p) => norm(p.bank))
    .filter(Boolean);
  if (banks.length === 0) return false;
  return banks.some((b) => wantedBanksLower.has(b));
}

// ---- Portal price scaffolding
const MARKUP = 250; // keep as your previous working value
function buildDefaultPortalPrices(base) {
  return [
    { portal: 'MakeMyTrip', basePrice: base, finalPrice: base + MARKUP, source: 'carrier+markup' },
    { portal: 'Goibibo',    basePrice: base, finalPrice: base + MARKUP, source: 'carrier+markup' },
    { portal: 'EaseMyTrip', basePrice: base, finalPrice: base + MARKUP, source: 'carrier+markup' },
    { portal: 'Yatra',      basePrice: base, finalPrice: base + MARKUP, source: 'carrier+markup' },
    { portal: 'Cleartrip',  basePrice: base, finalPrice: base + MARKUP, source: 'carrier+markup' },
  ];
}

// --- Portal helpers (canonicalization + membership)
const PORTAL_CANON = {
  'makemytrip': 'MakeMyTrip',
  'goibibo': 'Goibibo',
  'easemytrip': 'EaseMyTrip',
  'yatra': 'Yatra',
  'cleartrip': 'Cleartrip',
};
function canonPortalName(s) {
  if (!s) return null;
  const k = String(s).toLowerCase().replace(/\s+/g, '');
  return PORTAL_CANON[k] || null;
}
function offerAllowsPortal(ofr, portalName) {
  const list = ofr?.parsedApplicablePlatforms;
  if (Array.isArray(list) && list.length) {
    const target = canonPortalName(portalName);
    for (const p of list) {
      if (canonPortalName(p) === target) return true;
    }
    return false;
  }
  return true; // no list => treat as all portals
}

// ---- Apply offers per-portal (portal-aware)
function applyOffersToPortals(base, applicable) {
  const portals = buildDefaultPortalPrices(base);

  for (const p of portals) {
    let bestCut = 0;
    let bestOffer = null;

    for (const ofr of applicable || []) {
      if (!offerAllowsPortal(ofr, p.portal)) continue;

      let cut = 0;
      if (typeof ofr.discountPercent === 'number' && ofr.discountPercent > 0) {
        cut = Math.floor((p.basePrice * ofr.discountPercent) / 100);
      }
      if (typeof ofr.maxDiscountAmount === 'number' && ofr.maxDiscountAmount > 0) {
        cut = Math.min(cut, ofr.maxDiscountAmount);
      }
      if (typeof ofr.minTransactionValue === 'number' && ofr.minTransactionValue > 0) {
        if (p.basePrice < ofr.minTransactionValue) cut = 0;
      }

      if (cut > bestCut) {
        bestCut = cut;
        bestOffer = ofr;
      }
    }

    if (bestCut > 0 && bestOffer) {
      p.finalPrice = Math.max(0, p.basePrice - bestCut);
      p.source = 'carrier+offer+markup';
      const pct = (bestOffer.discountPercent ? `${bestOffer.discountPercent}%` : '');
      const cap = (bestOffer.maxDiscountAmount ? ` (max ₹${bestOffer.maxDiscountAmount})` : '');
      const bank = (bestOffer.paymentMethods?.[0]?.bank || '').trim();
      p.offerTag = `${bank || 'Offer'} ${pct}${cap}`.trim();
      p.offerId = String(bestOffer._id || '');
      p.offerTitle = bestOffer.title || '';
    } else {
      p.finalPrice = p.basePrice;
      p.source = 'carrier+markup';
      p.offerTag = null;
      p.offerId = '';
      p.offerTitle = '';
    }
  }

  let best = portals[0];
  for (const q of portals) {
    if (q.finalPrice < best.finalPrice) best = q;
  }
  const bestDeal = {
    portal: best.portal,
    finalPrice: best.finalPrice,
    note: 'Best price after applicable offers (if any)',
    offerTag: best.offerTag,
    offerId: best.offerId,
    offerTitle: best.offerTitle,
  };

  return { portalPrices: portals, bestDeal };
}

// ---------- FlightAPI
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
    const res = await fetch(url, { signal: ctrl.signal });
    const status = res.status;
    let json = null;
    try { json = await res.json(); } catch (_e) { json = null; }
    return { status, json };
  } catch (e) {
    return { status: 599, json: { error: String(e) } };
  } finally {
    clearTimeout(t);
  }
}

// ---- Public endpoints
app.get('/health', async (_req, res) => {
  const ok = !!db;
  res.json({ ok, time: new Date().toISOString(), dbConnected: ok });
});

app.get('/payment-options', async (_req, res) => {
  // Same shape as before; frontend uses it for modal chips
  res.json({
    usedFallback: false,
    options: {
      CreditCard: [
        'Axis Bank','Federal Bank','HDFC Bank','HDFC Bank','HSBC Bank','ICICI Bank','IDFC First Bank','Kotak Bank','RBL Bank','Yes Bank'
      ],
      DebitCard: ['Axis Bank','HDFC Bank','ICICI Bank','Kotak Bank'],
      NetBanking: ['Axis Bank','HDFC Bank','ICICI Bank','Kotak Bank'],
      UPI: ['HDFC Bank','ICICI Bank','Kotak Bank'],
      Wallet: ['Paytm','PhonePe'],
      EMI: ['Axis Bank','Federal Bank','HDFC Bank','Kotak Bank','RBL Bank','Yes Bank']
    }
  });
});

app.post('/debug-flightapi', async (req, res) => {
  const { from, to, departureDate, returnDate, tripType = 'round-trip', passengers = 1, travelClass = 'economy' } = req.body || {};
  const dry = String(req.query.dry || '0') === '1';
  if (tripType === 'round-trip') {
    const url = buildRoundtripUrl({ from, to, departureDate, returnDate, adults: passengers, cabin: travelClass.toLowerCase() });
    return res.json({ ok: true, url, mode: dry ? 'dry' : 'live' });
  } else {
    const url = buildOnewayUrl({ from, to, date: departureDate, adults: passengers, cabin: travelClass.toLowerCase() });
    return res.json({ ok: true, url, mode: dry ? 'dry' : 'live' });
  }
});

app.post('/search', async (req, res) => {
  await connectDB();
  const {
    from, to,
    departureDate,
    returnDate,
    tripType = 'one-way',
    passengers = 1,
    travelClass = 'economy',
    paymentMethods = []
  } = req.body || {};

  const nowUsed = req.query.now ? new Date(String(req.query.now)) : new Date();
  const nowForChecks = toDateSafe(nowUsed) || new Date();

  // --------- call FlightAPI
  let outResp = null, retResp = null;
  if (tripType === 'round-trip') {
    const url = buildRoundtripUrl({ from, to, departureDate, returnDate, adults: passengers, cabin: travelClass.toLowerCase() });
    const r = await fetchJson(url);
    outResp = { status: r.status, data: r.json };
    // split out/ret client-side from your current logic (keep as before)
  } else {
    const url = buildOnewayUrl({ from, to, date: departureDate, adults: passengers, cabin: travelClass.toLowerCase() });
    const r = await fetchJson(url);
    outResp = { status: r.status, data: r.json };
  }

  // --------- transform FlightAPI data to minimal flight items
  function mapFlights(apiJson) {
    // Keep your previous working mapping; here is a safe minimal fallback:
    const items = [];
    const list = apiJson?.itineraries || apiJson?.data || [];
    for (const it of list.slice(0, 200)) {
      const price = String(it?.price || it?.price_total || it?.price?.total || it?.pricing_options?.[0]?.price?.amount || 0).replace(/[^\d]/g,'');
      items.push({
        airlineName: it?.airline || it?.carrier_name || 'Air India',
        flightNumber: it?.flight_number || it?.id || '',
        departure: it?.departure_time || '',
        arrival: it?.arrival_time || '',
        stops: it?.stops ?? 0,
        price
      });
    }
    return items;
  }

  const outboundFlights = mapFlights(outResp?.data || {});
  const returnFlights = tripType === 'round-trip' ? mapFlights(outResp?.data || {}) : []; // keep behavior same as your last working

  // --------- offers: filter (active + flightOnly + bookingWindow + payment match)
  let applicable = [];
  let offerDebug = { checked: 0, applied: 0, skipped: { expired:0, notFlight:0, bookingDay:0, bookingWindow:0, paymentMismatch:0 }, examples: { applied:[], expired:[], notFlight:[], bookingWindow:[], paymentMismatch:[] } };

  const banksLower = new Set(
    (Array.isArray(paymentMethods) ? paymentMethods : []).map(norm)
  );

  if (offersCol) {
    const allActive = await offersCol.find({ isExpired: { $ne: true } }).toArray();
    for (const ofr of allActive) {
      offerDebug.checked++;
      if (ofr.isExpired === true) { offerDebug.skipped.expired++; offerDebug.examples.expired.push(ofr.title || ofr._id); continue; }
      if (!isFlightOffer(ofr)) { offerDebug.skipped.notFlight++; offerDebug.examples.notFlight.push(ofr.title || ofr._id); continue; }
      if (!isWithinBookingWindow(ofr, nowForChecks)) { offerDebug.skipped.bookingWindow++; offerDebug.examples.bookingWindow.push(ofr.title || ofr._id); continue; }
      if (banksLower.size > 0 && !matchesPayment(ofr, banksLower)) { offerDebug.skipped.paymentMismatch++; offerDebug.examples.paymentMismatch.push(ofr.title || ofr._id); continue; }

      applicable.push(ofr);
      if (offerDebug.examples.applied.length < 5) offerDebug.examples.applied.push(ofr.title || ofr._id);
      offerDebug.applied++;
    }
  }

  // --------- decorate each flight: per-portal price + bestDeal (+ used offers list)
  function decorate(f) {
    const base = Number(f.price) || 0;
    const { portalPrices, bestDeal } = applyOffersToPortals(base, applicable);

    const used = [];
    for (const p of portalPrices) {
      if (p.source === 'carrier+offer+markup' && p.offerTitle) used.push(p.offerTitle);
    }
    const offersUsed = Array.from(new Set(used));

    return { ...f, portalPrices, bestDeal, offersUsed };
  }

  const outboundDecorated = outboundFlights.map(decorate);
  const returnDecorated = returnFlights.map(decorate);

  const meta = {
    source: 'flightapi',
    outStatus: outResp?.status ?? null,
    outCount: Array.isArray(outboundFlights) ? outboundFlights.length : 0,
    retStatus: Array.isArray(returnFlights) ? outResp?.status ?? null : null,
    retCount: Array.isArray(returnFlights) ? returnFlights.length : 0,
    offerDebug,
    nowUsed: nowForChecks.toISOString()
  };

  res.json({ meta, outboundFlights: outboundDecorated, returnFlights: returnDecorated });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
