// index.js (ESM)
// SkyDeal backend – dual-oneway strategy using FlightAPI "onewaytrip"
// - One-way:    single onewaytrip call
// - Round-trip: two onewaytrip calls (outbound + return)
// - Payment options come from MongoDB (normalized), with fallback list if Mongo empty

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import { MongoClient } from 'mongodb';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---- Config ----
const PORT = process.env.PORT || 10000;
const MONGO_URI = process.env.MONGO_URI;
const FLIGHTAPI_KEY = process.env.FLIGHTAPI_KEY; // <= your working key
const DB_NAME = 'skydeal';
const CARRIER_PORTALS = ['MakeMyTrip', 'Goibibo', 'EaseMyTrip', 'Yatra', 'Cleartrip'];
const PER_PORTAL_MARKUP = 250; // ₹ per portal

// ---- Mongo Connection ----
let mongoClient;
let offersColl;

async function connectDB() {
  if (!MONGO_URI) {
    console.error('❌ Missing MONGO_URI');
    return;
  }
  try {
    mongoClient = new MongoClient(MONGO_URI, { maxPoolSize: 5 });
    await mongoClient.connect();
    const db = mongoClient.db(DB_NAME);
    offersColl = db.collection('offers');
    console.log('✅ Connected to MongoDB (EC2)');
  } catch (e) {
    console.error('❌ MongoDB Connection Error:', e);
  }
}
await connectDB();

// ---- Utilities ----
const toIsoTime = (ts) => {
  try {
    return ts?.slice(11, 16) || ''; // "YYYY-MM-DDTHH:mm:ss" -> "HH:mm"
  } catch {
    return '';
  }
};

function safeNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// Map useful lookup dicts from a FlightAPI response
function buildLookups(r) {
  const legsById = {};
  const segById = {};
  const carriersById = {};
  (r?.legs || []).forEach((l) => (legsById[l.id] = l));
  (r?.segments || []).forEach((s) => (segById[s.id] = s));
  (r?.carriers || []).forEach((c) => (carriersById[String(c.id)] = c));
  return { legsById, segById, carriersById };
}

// Extract flights for a ONE-WAY response
function extractFlightsOneWay(r) {
  const out = [];
  if (!r || !Array.isArray(r.itineraries)) return out;

  const { legsById, segById, carriersById } = buildLookups(r);

  for (const itin of r.itineraries) {
    // one leg expected for onewaytrip
    if (!Array.isArray(itin.leg_ids) || itin.leg_ids.length < 1) continue;

    const leg = legsById[itin.leg_ids[0]];
    if (!leg || !Array.isArray(leg.segment_ids) || !leg.segment_ids.length) continue;

    const seg0 = segById[leg.segment_ids[0]];
    const carrier = carriersById[String(seg0?.marketing_carrier_id)] || {};

    const price = safeNumber(itin?.pricing_options?.[0]?.price?.amount);
    if (price == null) continue;

    const airlineName = carrier?.name || 'Unknown';
    const flightNumber = `${airlineName}`; // keep simple/clean; flight "number" field from this API can be messy
    const dep = toIsoTime(leg?.departure);
    const arr = toIsoTime(leg?.arrival);

    const portalPrices = CARRIER_PORTALS.map((p) => ({
      portal: p,
      basePrice: price,
      finalPrice: price + PER_PORTAL_MARKUP,
      source: 'carrier+markup'
    }));

    out.push({
      flightNumber,
      airlineName,
      departure: dep,
      arrival: arr,
      price: String(Math.round(price)),
      stops: (leg?.stop_count ?? 0),
      carrierCode: String(seg0?.marketing_carrier_id ?? ''),
      portalPrices
    });
  }

  return out;
}

// ---- FlightAPI callers ----
function buildOnewayUrl({ from, to, date, passengers, cabin, currency = 'INR', region = 'IN' }) {
  if (!FLIGHTAPI_KEY) return null;
  return `https://api.flightapi.io/onewaytrip/${FLIGHTAPI_KEY}/${from}/${to}/${date}/${passengers}/0/0/${encodeURIComponent(
    cabin
  )}/${currency}?region=${region}`;
}

// Single request to onewaytrip
async function fetchOneWay({ from, to, date, passengers, cabin }) {
  const url = buildOnewayUrl({ from, to, date, passengers, cabin });
  if (!url) return { ok: false, error: 'no-key' };

  try {
    const { data, status } = await axios.get(url, { timeout: 25000, maxContentLength: Infinity, maxBodyLength: Infinity });
    if (status !== 200) return { ok: false, status, error: 'non-200' };
    return { ok: true, status, data };
  } catch (err) {
    return { ok: false, status: err.response?.status ?? 0, error: err.message || 'fetch-failed' };
  }
}

// ---- Routes ----
app.get('/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Normalize/aggregate payment options from Mongo (active offers only).
// Falls back to a static list if Mongo missing/empty.
app.get('/payment-options', async (_req, res) => {
  try {
    let usedFallback = false;
    const result = {
      CreditCard: [],
      DebitCard: [],
      Wallet: [],
      UPI: [],
      NetBanking: [],
      EMI: []
    };

    if (offersColl) {
      // Collect normalized buckets from your live data (same logic we audited)
      const cursor = offersColl.aggregate([
        { $match: { isExpired: { $ne: true } } },
        { $unwind: "$paymentMethods" },
        {
          $project: {
            type: {
              $toLower: {
                $ifNull: ["$paymentMethods.type", ""]
              }
            },
            bank: {
              $concat: [
                { $toUpper: { $substrCP: [{ $ifNull: ["$paymentMethods.bank", ""] }, 0, 1] } },
                {
                  $toLower: {
                    $substrCP: [
                      { $ifNull: ["$paymentMethods.bank", ""] },
                      1,
                      { $subtract: [{ $strLenCP: { $ifNull: ["$paymentMethods.bank", ""] } }, 1] }
                    ]
                  }
                }
              ]
            },
            method: { $ifNull: ["$paymentMethods.method", ""] },
            wallet: { $ifNull: ["$paymentMethods.wallet", ""] },
            category: { $ifNull: ["$paymentMethods.category", ""] },
            mode: { $ifNull: ["$paymentMethods.mode", ""] }
          }
        }
      ]);

      const buckets = {
        'credit card': new Set(),
        'credit_card': new Set(),
        'debit card': new Set(),
        'debit_card': new Set(),
        UPI: new Set(),
        upi: new Set(),
        'net banking': new Set(),
        net_banking: new Set(),
        'internet banking': new Set(),
        Wallet: new Set(),
        wallet: new Set(),
        EMI: new Set()
      };

      for await (const doc of cursor) {
        const subtype =
          doc.bank ||
          doc.method ||
          doc.wallet ||
          doc.category ||
          doc.mode ||
          null;
        if (!subtype) continue;

        const t = doc.type;
        if (t in buckets) {
          buckets[t].add(subtype);
        }
      }

      // Merge/lift into final shape
      const cc = new Set([
        ...buckets['credit card'],
        ...buckets['credit_card']
      ]);
      const dc = new Set([
        ...buckets['debit card'],
        ...buckets['debit_card']
      ]);
      const upi = new Set([
        ...buckets['UPI'],
        ...buckets['upi']
      ]);
      const nb = new Set([
        ...buckets['net banking'],
        ...buckets['net_banking'],
        ...buckets['internet banking']
      ]);
      const wl = new Set([
        ...buckets['Wallet'],
        ...buckets['wallet']
      ]);
      const emi = new Set([...buckets['EMI']]);

      result.CreditCard = Array.from(cc).sort();
      result.DebitCard = Array.from(dc).sort();
      result.UPI = Array.from(upi).sort();
      result.NetBanking = Array.from(nb).sort();
      result.Wallet = Array.from(wl).sort();
      result.EMI = Array.from(emi).sort();
    }

    // Fallback if all empty
    const isEmpty =
      !result.CreditCard.length &&
      !result.DebitCard.length &&
      !result.UPI.length &&
      !result.NetBanking.length &&
      !result.Wallet.length &&
      !result.EMI.length;

    if (isEmpty) {
      usedFallback = true;
      Object.assign(result, {
        CreditCard: [
          'HDFC Bank', 'ICICI Bank', 'Axis Bank', 'Kotak Bank', 'IDFC First Bank',
          'Yes Bank', 'RBL Bank', 'Federal Bank', 'SBI Bank', 'HSBC'
        ],
        DebitCard: ['HDFC Bank', 'ICICI Bank', 'Axis Bank', 'Federal Bank', 'AU Small Bank'],
        Wallet: [],
        UPI: ['Mobikwik'],
        NetBanking: ['HDFC Bank', 'ICICI Bank'],
        EMI: []
      });
    }

    res.json({ usedFallback, options: result });
  } catch (e) {
    console.error('❌ /payment-options error:', e.message);
    res.status(500).json({ error: 'Failed loading payment options' });
  }
});

// Debug helper – supports both dry and real calls
app.post('/debug-flightapi', async (req, res) => {
  try {
    const { from, to, departureDate, returnDate, passengers, travelClass, tripType } = req.body || {};
    const cabin = (travelClass || 'economy').toLowerCase();
    const dry = String(req.query.dry || '') === '1';

    if (!FLIGHTAPI_KEY) {
      return res.json({ ok: false, error: 'no-api-key' });
    }

    if (dry) {
      if (tripType === 'round-trip') {
        return res.json({
          ok: true,
          mode: 'dry-two-oneway',
          urls: [
            buildOnewayUrl({ from, to, date: departureDate, passengers, cabin }),
            buildOnewayUrl({ from: to, to: from, date: returnDate, passengers, cabin })
          ]
        });
      }
      return res.json({
        ok: true,
        mode: 'dry-oneway',
        url: buildOnewayUrl({ from, to, date: departureDate, passengers, cabin })
      });
    }

    if (tripType === 'round-trip') {
      const [out, ret] = await Promise.all([
        fetchOneWay({ from, to, date: departureDate, passengers, cabin }),
        fetchOneWay({ from: to, to: from, date: returnDate, passengers, cabin })
      ]);
      return res.json({
        ok: out.ok && ret.ok,
        outStatus: out.status ?? null,
        retStatus: ret.status ?? null,
        outKeys: out.data ? Object.keys(out.data) : [],
        retKeys: ret.data ? Object.keys(ret.data) : [],
        outHasItin: !!out.data?.itineraries?.length,
        retHasItin: !!ret.data?.itineraries?.length,
        error: (!out.ok && out.error) || (!ret.ok && ret.error) || null
      });
    }

    // one-way
    const one = await fetchOneWay({ from, to, date: departureDate, passengers, cabin });
    return res.json({
      ok: one.ok,
      status: one.status ?? null,
      keys: one.data ? Object.keys(one.data) : [],
      hasItin: !!one.data?.itineraries?.length,
      error: one.ok ? null : one.error
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'debug-failed' });
  }
});

// Main search
app.post('/search', async (req, res) => {
  try {
    const {
      from, to, departureDate, returnDate,
      passengers = 1,
      travelClass = 'economy',
      tripType = 'one-way',
      paymentMethods = []
    } = req.body || {};

    const cabin = String(travelClass || 'economy').toLowerCase();

    // ROUND-TRIP => two onewaytrip calls
    if (tripType === 'round-trip') {
      const [outResp, retResp] = await Promise.all([
        fetchOneWay({ from, to, date: departureDate, passengers, cabin }),
        fetchOneWay({ from: to, to: from, date: returnDate, passengers, cabin })
      ]);

      if (!outResp.ok && !retResp.ok) {
        return res.json({ outboundFlights: [], returnFlights: [], meta: { source: 'flightapi-oneway-dual', reason: 'both-failed' } });
      }

      const outboundFlights = outResp.ok ? extractFlightsOneWay(outResp.data).slice(0, 40) : [];
      const returnFlights = retResp.ok ? extractFlightsOneWay(retResp.data).slice(0, 40) : [];

      return res.json({
        outboundFlights,
        returnFlights,
        meta: { source: 'flightapi-oneway-dual' }
      });
    }

    // ONE-WAY => single onewaytrip call
    const one = await fetchOneWay({ from, to, date: departureDate, passengers, cabin });
    if (!one.ok) {
      return res.json({ outboundFlights: [], returnFlights: [], meta: { source: 'flightapi-oneway', reason: one.error || 'failed' } });
    }

    const outboundFlights = extractFlightsOneWay(one.data).slice(0, 50);
    return res.json({
      outboundFlights,
      returnFlights: [],
      meta: { source: 'flightapi-oneway' }
    });
  } catch (e) {
    console.error('❌ /search error:', e);
    res.status(200).json({ outboundFlights: [], returnFlights: [], error: 'search-failed' });
  }
});

// ---- Start ----
app.listen(PORT, () => {
  console.log(`🚀 SkyDeal backend running on ${PORT}`);
});
