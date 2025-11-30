// index.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { MongoClient } from 'mongodb';

const app = express();
app.use(cors());
app.use(express.json());

// ------------------------
// Env & Mongo
// ------------------------
const PORT = process.env.PORT || 10000;
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || '';
const MONGODB_DB = process.env.MONGODB_DB || 'skydeal';
const FLIGHTAPI_KEY = process.env.FLIGHTAPI_KEY || process.env.FLIGHTAPI || '';
const FLIGHTAPI_BASE = 'https://api.flightapi.io';

let mongo, db;
async function connectDB() {
  if (!MONGO_URI) {
    console.error('❌ Missing MONGO_URI');
    return;
  }
  mongo = new MongoClient(MONGO_URI);
  await mongo.connect();
  db = mongo.db(MONGODB_DB);
  console.log(`✅ Connected to MongoDB (${MONGODB_DB})`);
}
connectDB().catch(err => console.error('❌ MongoDB Connection Error:', err));

// ------------------------
// Helpers
// ------------------------
function money(n) { return Math.round(Number(n || 0)); }

function airlineNameFromCarrier(carriers, id) {
  const c = carriers.find(x => String(x.id) === String(id));
  return c?.name || 'Unknown';
}

function buildPortalPrices(base) {
  const basePrice = money(base);
  const final = basePrice + 250; // ₹250 markup
  const portals = ['MakeMyTrip', 'Goibibo', 'EaseMyTrip', 'Yatra', 'Cleartrip'];
  return portals.map(p => ({
    portal: p,
    basePrice,
    finalPrice: final,
    source: 'carrier+markup'
  }));
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toTimeString().slice(0,5); // "HH:MM"
}

// Extract both outbound and return from a round-trip response
function extractFlights(payload) {
  const out = [];
  const ret = [];
  if (!payload || !Array.isArray(payload.itineraries)) return { outbound: out, returns: ret };

  const legsById = new Map((payload.legs || []).map(l => [String(l.id), l]));
  const segsById = new Map((payload.segments || []).map(s => [String(s.id), s]));

  payload.itineraries.forEach(it => {
    // price from the first pricing option (carrier)
    const amount = it?.pricing_options?.[0]?.price?.amount;
    const legIds = it?.leg_ids || [];
    if (legIds.length === 0) return;

    // Leg 0: outbound
    const leg0 = legsById.get(String(legIds[0]));
    if (leg0) {
      const seg0 = segsById.get(String(leg0.segment_ids?.[0]));
      const carrierId = seg0?.marketing_carrier_id;
      const airlineName = airlineNameFromCarrier(payload.carriers || [], carrierId);
      out.push({
        flightNumber: `${carrierId || ''}${seg0?.number ? ' ' + seg0.number : ''}`,
        airlineName,
        departure: formatTime(leg0.departure),
        arrival: formatTime(leg0.arrival),
        price: String(money(amount)),
        stops: (leg0.segment_ids?.length || 1) - 1,
        carrierCode: String(carrierId || ''),
        portalPrices: buildPortalPrices(amount)
      });
    }

    // Leg 1: return (when present)
    const leg1 = legIds[1] ? legsById.get(String(legIds[1])) : null;
    if (leg1) {
      const seg1 = segsById.get(String(leg1.segment_ids?.[0]));
      const carrierId1 = seg1?.marketing_carrier_id;
      const airlineName1 = airlineNameFromCarrier(payload.carriers || [], carrierId1);
      ret.push({
        flightNumber: `${carrierId1 || ''}${seg1?.number ? ' ' + seg1.number : ''}`,
        airlineName: airlineName1,
        departure: formatTime(leg1.departure),
        arrival: formatTime(leg1.arrival),
        price: String(money(amount)),
        stops: (leg1.segment_ids?.length || 1) - 1,
        carrierCode: String(carrierId1 || ''),
        portalPrices: buildPortalPrices(amount)
      });
    }
  });

  return { outbound: out, returns: ret };
}

// ------------------------
// Routes
// ------------------------
app.get('/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/payment-options', async (_req, res) => {
  try {
    // Build options list from offers collection (distinct banks by type)
    const offers = db ? db.collection('offers') : null;
    const byType = { CreditCard: [], DebitCard: [], Wallet: [], UPI: [], NetBanking: [], EMI: [] };

    if (offers) {
      const cursor = offers.aggregate([
        { $match: { isExpired: { $ne: true } } },
        { $unwind: '$paymentMethods' },
        {
          $project: {
            type: { $ifNull: ['$paymentMethods.type', ''] },
            bank: { $ifNull: ['$paymentMethods.bank', ''] },
            method: { $ifNull: ['$paymentMethods.method', ''] }
          }
        }
      ]);
      const seen = new Set();
      for await (const d of cursor) {
        const t = (d.type || '').toLowerCase(); // credit/debit/wallet/upi/netbanking/emi
        const mapKey =
          t === 'credit' ? 'CreditCard' :
          t === 'debit' ? 'DebitCard' :
          t === 'wallet' ? 'Wallet' :
          t === 'upi' ? 'UPI' :
          t === 'netbanking' ? 'NetBanking' :
          t === 'emi' ? 'EMI' : null;

        if (!mapKey) continue;
        const label = d.bank || d.method;
        if (!label) continue;
        const sig = `${mapKey}::${label}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        byType[mapKey].push(label);
      }
    }

    res.json({ options: byType });
  } catch (e) {
    console.error('payment-options error', e);
    res.json({ options: { CreditCard: [], DebitCard: [], Wallet: [], UPI: [], NetBanking: [], EMI: [] } });
  }
});

// Dry/diagnostic endpoint
app.post('/debug-flightapi', async (req, res) => {
  try {
    const { from, to, departureDate, returnDate, passengers, travelClass, tripType } = req.body || {};
    if (req.query.dry === '1') {
      const url = `${FLIGHTAPI_BASE}/roundtrip/${FLIGHTAPI_KEY}/${from}/${to}/${departureDate}/${returnDate}/${passengers || 1}/0/0/${(travelClass || 'economy').toLowerCase()}/INR?region=IN`;
      return res.json({ ok: true, url, mode: 'dry' });
    }
    if (!FLIGHTAPI_KEY) return res.json({ ok: false, status: null, keys: null, hasItin: null, error: 'no-api-key' });

    const url = `${FLIGHTAPI_BASE}/roundtrip/${FLIGHTAPI_KEY}/${from}/${to}/${departureDate}/${returnDate}/${passengers || 1}/0/0/${(travelClass || 'economy').toLowerCase()}/INR?region=IN`;
    const r = await fetch(url, { timeout: 22000 });
    const status = r.status;
    const json = await r.json().catch(() => ({}));

    const keys = Object.keys(json || {});
    const hasItin = Array.isArray(json?.itineraries) && json.itineraries.length > 0;
    res.json({ ok: status === 200, status, keys, hasItin, sample: hasItin ? json.itineraries[0] : null });
  } catch (e) {
    const msg = String(e.message || e);
    res.json({ ok: false, status: 0, keys: [], hasItin: false, error: msg.includes('timed out') ? 'timeout' : msg });
  }
});

app.post('/search', async (req, res) => {
  try {
    const { from, to, departureDate, returnDate, passengers, travelClass, tripType } = req.body || {};
    if (req.query.dry === '1') {
      // deterministic sample
      return res.json({
        outboundFlights: [{
          flightNumber: '6E 123',
          airlineName: 'IndiGo',
          departure: '10:00',
          arrival: '12:15',
          price: '12345',
          stops: 0,
          carrierCode: '32213',
          portalPrices: buildPortalPrices(12345)
        }],
        returnFlights: [{
          flightNumber: 'AI 456',
          airlineName: 'Air India',
          departure: '19:30',
          arrival: '21:45',
          price: '14210',
          stops: 0,
          carrierCode: '32672',
          portalPrices: buildPortalPrices(14210)
        }],
        meta: { source: 'dry' }
      });
    }

    if (!FLIGHTAPI_KEY) return res.json({ outboundFlights: [], returnFlights: [], meta: { source: 'flightapi', reason: 'no-key' } });

    const cabin = (travelClass || 'economy').toLowerCase();
    const pax = passengers || 1;
    const url = `${FLIGHTAPI_BASE}/roundtrip/${FLIGHTAPI_KEY}/${from}/${to}/${departureDate}/${returnDate || departureDate}/${pax}/0/0/${cabin}/INR?region=IN`;

    const r = await fetch(url, { timeout: 22000 });
    if (!r.ok) {
      return res.json({ outboundFlights: [], returnFlights: [], meta: { source: 'flightapi', reason: `http-${r.status}` } });
    }
    const data = await r.json();
    const { outbound, returns } = extractFlights(data);

    res.json({
      outboundFlights: outbound,
      returnFlights: (tripType === 'round-trip' || returnDate) ? returns : [],
      meta: { source: 'flightapi' }
    });
  } catch (e) {
    console.error('❌ Search error:', e);
    res.json({ outboundFlights: [], returnFlights: [], error: 'search-failed' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 SkyDeal backend running on ${PORT}`);
});
