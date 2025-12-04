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
  db = mongo.db('skydeal');            // unchanged: use 'skydeal'
  offersCol = db.collection('offers'); // convenience handle
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
  // 1) category says flight (preferred)
  const cats = Array.isArray(ofr.offerCategories) ? ofr.offerCategories.map(norm) : [];
  if (cats.some(c => /flight/.test(c))) return true;

  // 2) text signals flight
  const raw = (
    (ofr.rawText || '') + ' ' +
    (ofr.title || '') + ' ' +
    (ofr?.validityPeriod?.raw || '')
  ).toLowerCase();
  if (/(flight|airfare|one\-way|round[-\s]?trip|pnr|domestic flight|international flight)/.test(raw)) {
    return true;
  }

  // 3) metadata path/URL suggests this came from a flights page (new!)
  const meta = [
    ofr?.sourceUrl,
    ofr?.sourceFileName,
    ofr?.sourcePortal, // sometimes portals include 'flights' in path names we stored
  ].map(s => String(s || '').toLowerCase()).join(' ');

  if (
    /\/flights?\/|flights[-_]offers|domestic[-_]?flights|international[-_]?flights|flight[-_]offers/.test(meta)
  ) {
    return true;
  }

  // 4) platforms sometimes hint mode; keep as soft signal only
  const plats = Array.isArray(ofr.parsedApplicablePlatforms)
    ? ofr.parsedApplicablePlatforms.map(norm).join(' ')
    : '';
  if (/flight/.test(plats)) return true;

  return false;
}

// --- booking day/dow helpers + platform normalization ---
const DOW = ['sun','mon','tue','wed','thu','fri','sat'];

function dowIdx(s) {
  if (!s) return null;
  const m = String(s).toLowerCase().slice(0,3);
  return DOW.indexOf(m); // -1 if not found
}

function expandRange(a, b) {
  // a..b over week, supports wrap (e.g., fri-sun)
  const ai = dowIdx(a), bi = dowIdx(b);
  if (ai < 0 || bi < 0) return [];
  const out = [];
  let i = ai;
  for (;;) {
    out.push(i);
    if (i === bi) break;
    i = (i + 1) % 7;
  }
  return out;
}

function parseDaysSpec(spec) {
  // Accepts strings like "Mon-Fri", "Fri–Sun", "Sat,Sun", "Mon, Wed, Fri"
  // or arrays of strings. Returns Set of allowed day indexes {0..6}
  if (!spec) return null;
  const add = (acc, i) => { if (i >= 0) acc.add(i); };

  const set = new Set();
  const str = Array.isArray(spec) ? spec.join(',') : String(spec);
  const cleaned = str.replace(/[–—]/g, '-'); // normalize en-dash/em-dash to '-'
  for (const token of cleaned.split(/[,/|]+/)) {
    const t = token.trim();
    if (!t) continue;
    const m = t.match(/\b([A-Za-z]{3})\s*-\s*([A-Za-z]{3})\b/);
    if (m) {
      for (const i of expandRange(m[1], m[2])) add(set, i);
    } else {
      add(set, dowIdx(t));
    }
  }
  return set.size ? set : null;
}

function isBookingDayAllowed(ofr, now = new Date()) {
  // Try multiple common fields; treat missing as "no restriction"
  const candidates = [
    ofr?.bookingDayRule,
    ofr?.bookingDays,
    ofr?.validDays,
    ofr?.validBookingDays,
    ofr?.applicableDays,
    ofr?.dayOfWeek,
    ofr?.daysOfWeek,
  ].filter(Boolean);

  if (!candidates.length) return true;

  // Combine all specs (logical OR: if any spec includes today, allow)
  const today = now.getDay(); // 0..6
  for (const c of candidates) {
    const set = parseDaysSpec(c);
    if (set && set.has(today)) return true;
  }

  // Last-chance: infer from raw text (loose). Example: "Valid Fri–Sun"
  const raw = (ofr?.rawText || ofr?.title || '').toLowerCase();
  const hint = raw.match(/\b(mon|tue|wed|thu|fri|sat|sun)\b(?:\s*[-–—]\s*\b(mon|tue|wed|thu|fri|sat|sun)\b)?/);
  if (hint) {
    const set = hint[2] ? new Set(expandRange(hint[1], hint[2])) : new Set([dowIdx(hint[1])]);
    if (set.has(today)) return true;
    return false;
  }

  // If there were explicit fields but none matched today, disallow
  return false;
}

function normalizePortalName(s) {
  const x = norm(s);
  if (/^mmt|make ?my ?trip$/.test(x)) return 'MakeMyTrip';
  if (/^goibibo$/.test(x)) return 'Goibibo';
  if (/^emt|ease ?my ?trip$/.test(x)) return 'EaseMyTrip';
  if (/^yatra$/.test(x)) return 'Yatra';
  if (/^clear ?trip$/.test(x)) return 'Cleartrip';
  // Keep original (title-cased) if unknown
  return s && s.trim() ? s.trim() : null;
}



function pickApplicableOffers(allOffers, selectedLabels) {
  if (!Array.isArray(selectedLabels) || selectedLabels.length === 0) return [];
  const wanted = new Set(selectedLabels.map(norm));

  const res = [];
  for (const ofr of allOffers) {
    if (!isOfferCurrentlyValid(ofr)) continue;
    if (!isFlightOffer(ofr)) continue;
    if (!isBookingDayAllowed(ofr)) continue; // NEW: enforce booking day / DOW constraints

    // collect tags from paymentMethods + applicablePlatforms
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

    // Guard: minimum transaction (booking) amount
  const minTxn = Number(ofr?.minTransactionValue);
  if (!Number.isNaN(minTxn) && minTxn > 0 && b < minTxn) {
    // Not eligible — return base unchanged (no discount)
    return Math.max(0, Math.round(b));
  }



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
  // === PRICE MATH =============================================================
function computeDiscountedPrice(base, ofr) {
  const b = Number(base) || 0;

  // --- Min transaction guard ---
  const minTxn = Number(ofr?.minTransactionValue);
  if (!Number.isNaN(minTxn) && minTxn > 0 && b < minTxn) {
    return Math.max(0, Math.round(b)); // no discount if below threshold
  }

  const pct  = Number(ofr?.discountPercent);
  const flat = Number(ofr?.maxDiscountAmountFlat ?? ofr?.flatDiscountAmount);
  const cap  = Number(ofr?.maxDiscountAmount);

  let discount = 0;
  if (!Number.isNaN(flat) && flat > 0) {
    discount = flat;
  } else if (!Number.isNaN(pct) && pct > 0) {
    discount = (pct / 100) * b;
  }
  if (!Number.isNaN(cap) && cap > 0) discount = Math.min(discount, cap);

  return Math.max(0, Math.round(b - discount));
}

  const portals = buildDefaultPortalPrices(base);

  if (!applicableOffers || applicableOffers.length === 0) {
    return { portalPrices: portals, bestDeal: null };
  }

    for (const ofr of applicableOffers) {
    // Normalize any platform targeting to our 5 known portals
    let targeted = null;
    if (Array.isArray(ofr.parsedApplicablePlatforms) && ofr.parsedApplicablePlatforms.length > 0) {
      const set = new Set();
      for (const p of ofr.parsedApplicablePlatforms) {
        const normName = normalizePortalName(p);
        if (normName) set.add(normName);
      }
      if (set.size) targeted = set;
    }

    if (targeted) {
      for (const p of portals) {
        if (targeted.has(p.portal)) {
          const discounted = computeDiscountedPrice(p.basePrice, ofr) + MARKUP;
          p.finalPrice = Math.min(p.finalPrice, discounted);
          p.source = 'carrier+offer+markup';
        }
      }
    } else {
      // No specific platform targeting — apply to all portals
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

// ---- Payment options (pull distinct banks by normalized method) ----
// Payment options from Mongo, normalized + de-duped (flight-only; not-expired)
// ---- Payment options (distinct banks by bucket) ----
app.get('/payment-options', async (req, res) => {
  try {
    if (!offersCol) {
      return res.json({
        usedFallback: true,
        options: { CreditCard: [], DebitCard: [], Wallet: [], UPI: [], NetBanking: [], EMI: [] }
      });
    }

    const now = new Date();

    // Helper to title-case + canonicalize common banks
    const canon = (s) => {
      const t = String(s || '').toLowerCase().trim();
      if (!t) return '';
      if (t === 'hdfc' || t === 'hdfc bank') return 'HDFC Bank';
      if (t === 'icici' || t === 'icici bank') return 'ICICI Bank';
      if (t === 'axis' || t === 'axis bank') return 'Axis Bank';
      if (t === 'rbl' || t === 'rbl bank') return 'RBL Bank';
      if (t === 'sbi' || t === 'sbi bank') return 'SBI Bank';
      if (t === 'hsbc' || t === 'hsbc bank') return 'HSBC Bank';
      if (t === 'federal' || t === 'federal bank') return 'Federal Bank';
      if (t === 'yes' || t === 'yes bank') return 'Yes Bank';
      if (t === 'idfc first' || t === 'idfc first bank') return 'IDFC First Bank';
      if (t === 'kotak' || t === 'kotak bank') return 'Kotak Bank';
      if (t === 'au small' || t === 'au small bank') return 'AU Small Bank';
      // generic Title Case
      return t.replace(/\b\w/g, c => c.toUpperCase());
    };

    // Common pre-filter: flight-relevant + not-expired
    const prelude = [
      { $match: { isExpired: { $ne: true } } },
      {
        $addFields: {
          _end: { $ifNull: ["$validityPeriod.endDate", "$validityPeriod.to"] },
          _cats: { $ifNull: ["$offerCategories", []] },
          _blob: {
            $concat: [
              { $ifNull: ["$rawText", ""] }, " ",
              { $ifNull: ["$title", ""] }, " ",
              { $ifNull: ["$validityPeriod.raw", ""] }
            ]
          }
        }
      },
      {
        $match: {
          $or: [
            { _cats: { $elemMatch: { $regex: /flight/i } } },
            { _blob: /flight|airfare|domestic flight|international flight/i }
          ],
          $or: [
            { _end: null },
            { _end: { $gte: now } }
          ]
        }
      },
      { $unwind: "$paymentMethods" },
      {
        $addFields: {
          _bank: { $trim: { input: { $toLower: { $ifNull: ["$paymentMethods.bank", ""] } } } },
          _type: { $toLower: { $ifNull: ["$paymentMethods.type", ""] } },
          _method: { $toLower: { $ifNull: ["$paymentMethods.method", ""] } },
          _cat: { $toLower: { $ifNull: ["$paymentMethods.category", ""] } },
          _mode: { $toLower: { $ifNull: ["$paymentMethods.mode", ""] } }
        }
      },
      { $match: { _bank: { $ne: "" } } }
    ];

    // Buckets:
    // 1) CreditCard / DebitCard / NetBanking / UPI / Wallet: from 'type'
    const baseBucket = [
      {
        $addFields: {
          bucket: {
            $switch: {
              branches: [
                { case: { $in: ["$_type", ["credit card", "credit_card", "credit"]] }, then: "CreditCard" },
                { case: { $in: ["$_type", ["debit card", "debit_card", "debit"]] }, then: "DebitCard" },
                { case: { $in: ["$_type", ["net banking", "net_banking", "internet banking", "internet_banking"]] }, then: "NetBanking" },
                { case: { $regexMatch: { input: "$_type", regex: /upi/ } }, then: "UPI" },
                { case: { $regexMatch: { input: "$_type", regex: /wallet/ } }, then: "Wallet" }
              ],
              default: null
            }
          }
        }
      },
      { $match: { bucket: { $ne: null } } },
      { $group: { _id: { bucket: "$bucket", bank: "$_bank" } } },
      { $group: { _id: "$_id.bucket", banks: { $addToSet: "$_id.bank" } } }
    ];

    // 2) EMI: detected by any of type/method/category/mode/title/rawText containing "emi"
    const emiBucket = [
      {
        $match: {
          $or: [
            { _type: /emi/ },
            { _method: /emi/ },
            { _cat: /emi/ },
            { _mode: /emi/ },
            { title: /\bemi\b/i },
            { rawText: /\bemi\b/i }
          ]
        }
      },
      { $group: { _id: "EMI", banks: { $addToSet: "$_bank" } } }
    ];

    const rowsBase = await offersCol.aggregate([...prelude, ...baseBucket]).toArray();
    const rowsEmi  = await offersCol.aggregate([...prelude, ...emiBucket]).toArray();

    // Assemble final structure
    const out = { CreditCard: [], DebitCard: [], Wallet: [], UPI: [], NetBanking: [], EMI: [] };

    for (const r of rowsBase) {
      const bucket = r._id;
      const list = (r.banks || []).map(canon).sort();
      if (out[bucket]) out[bucket] = list;
    }
    if (rowsEmi[0]?.banks?.length) {
      out.EMI = Array.from(new Set(rowsEmi[0].banks.map(canon))).sort();
    }

    return res.json({ usedFallback: false, options: out });
  } catch (err) {
    console.error('payment-options error:', err);
    return res.json({
      usedFallback: true,
      options: { CreditCard: [], DebitCard: [], Wallet: [], UPI: [], NetBanking: [], EMI: [] }
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
    // 1) outbound  (now with single retry + logging)
const urlOut = buildOnewayUrl({
  from: fromCode, to: toCode, date: departureDate,
  adults: passengers, cabin: travelClass
});

let outResp = await fetchJson(urlOut);
let outboundFlights = extractFlightsOneWay(outResp);

// retry once if non-200 or empty itineraries
if ((outResp?.status !== 200) || !Array.isArray(outboundFlights) || outboundFlights.length === 0) {
  await sleep(650);
  const retry = await fetchJson(urlOut);

  // log first 400 chars of body to see why FlightAPI failed
  if (retry?.status !== 200) {
    console.error('FlightAPI outbound non-200', {
      status: retry.status,
      body: String(retry.raw || '').slice(0, 400)
    });
  }

  const again = extractFlightsOneWay(retry);
  if (Array.isArray(again) && again.length > 0) {
    outResp = retry;
    outboundFlights = again;
  }
}


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
    if (Array.isArray(paymentMethods) && paymentMethods.length > 0 && offersCol) {
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
