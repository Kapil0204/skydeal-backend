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

// ---- Payment options (types + subtypes) ----
// ===== Payment options (DB-first with normalization + debug) =====
app.get('/payment-options', async (req, res) => {
  try {
    const client = global.mongoClient || mongoClient;
    if (!client) throw new Error('mongo-not-connected');

    const dbName = process.env.MONGODB_DB || 'skydeal';
    const colName = process.env.OFFER_COLLECTIONS || 'offers';
    const col = client.db(dbName).collection(colName);

    // Tab names used by the UI
    const TABS = ['CreditCard','DebitCard','Wallet','UPI','NetBanking','EMI'];

    // --- Normalizers ---
    const normalizeType = (t) => {
      if (!t) return null;
      const s = String(t).toLowerCase().replace(/\s+/g,'');
      if (['credit','creditcard','cc','cardcredit'].includes(s)) return 'CreditCard';
      if (['debit','debitcard','dc','carddebit'].includes(s))     return 'DebitCard';
      if (['wallet','wallets'].includes(s))                        return 'Wallet';
      if (['upi'].includes(s))                                     return 'UPI';
      if (['netbanking','net-banking','internetbanking','nb'].includes(s)) return 'NetBanking';
      if (['emi','paylater','bnpl'].includes(s))                   return 'EMI';
      return null;
    };

    // Bank/brand dictionary (extend anytime)
    const BANK_MAP = [
      [/^hdfc\b/i, 'HDFC Bank'],
      [/^icici\b/i, 'ICICI Bank'],
      [/^axis\b/i, 'Axis Bank'],
      [/^kotak/i, 'Kotak'],
      [/^bob|bank\s*of\s*baroda|bobcard/i, 'Bank of Baroda'],
      [/^au(\s|$)|^au\s*small/i, 'AU Small Finance Bank'],
      [/^sbi|state\s*bank\s*of\s*india/i, 'SBI'],
      [/^idfc/i, 'IDFC FIRST Bank'],
      [/^hsbc/i, 'HSBC'],
      [/^rbl/i, 'RBL Bank'],
    ];
    const prettyName = (raw) => {
      if (!raw) return null;
      const s = String(raw).trim();
      for (const [re, nice] of BANK_MAP) if (re.test(s)) return nice;
      // Title-case fallback
      return s.replace(/\b\w/g, c => c.toUpperCase());
    };

    // Hard fallback (only if you opt in)
    const DEFAULTS = {
      CreditCard: ['HDFC Bank','ICICI Bank','Axis Bank','Kotak','AU Small Finance Bank'],
      DebitCard:  ['HDFC Bank','ICICI Bank'],
      Wallet:     ['Amazon Pay','Paytm'],
      UPI:        ['PhonePe','Google Pay','Mobikwik'],
      NetBanking: ['HDFC Bank','ICICI Bank'],
      EMI:        ['HDFC Bank EMI']
    };

    // --- Aggregation: explode paymentMethods and collect labels by type
    const rows = await col.aggregate([
      { $match: { isExpired: { $ne: true } } },
      { $project: { paymentMethods: 1 } },
      { $unwind: '$paymentMethods' },
      {
        $project: {
          rawType: '$paymentMethods.type',
          bank: { $ifNull: ['$paymentMethods.bank', null] },
          method: { $ifNull: ['$paymentMethods.method', null] },
          wallet: { $ifNull: ['$paymentMethods.wallet', null] },
          category: { $ifNull: ['$paymentMethods.category', null] },
          mode: { $ifNull: ['$paymentMethods.mode', null] }
        }
      },
      // Prefer bank → method → wallet → category → mode for display label
      {
        $addFields: {
          name: {
            $ifNull: [
              '$bank',
              { $ifNull: [
                  '$method',
                  { $ifNull: ['$wallet', { $ifNull: ['$category', '$mode'] }] }
              ]}
            ]
          }
        }
      },
      { $match: { name: { $type: 'string', $ne: '' } } },
      {
        $group: {
          _id: { t: '$rawType', n: { $toLower: { $trim: { input: '$name' } } } },
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } }
    ]).toArray();

    const buckets = Object.fromEntries(TABS.map(t => [t, new Map()])); // name -> count
    const rawSeen = []; // for debug

    for (const r of rows) {
      const typ = normalizeType(r._id.t);
      if (!typ) continue;
      const pretty = prettyName(r._id.n);
      if (!pretty) continue;
      rawSeen.push({ typeRaw: r._id.t, nameRaw: r._id.n, type: typ, name: pretty, count: r.count });
      buckets[typ].set(pretty, (buckets[typ].get(pretty) || 0) + r.count);
    }

    // Convert to sorted arrays (by frequency desc, then A–Z)
    const toSorted = (m) =>
      Array.from(m.entries())
        .sort((a,b) => (b[1]-a[1]) || a[0].localeCompare(b[0]))
        .map(([k]) => k);

    let options = Object.fromEntries(TABS.map(t => [t, toSorted(buckets[t])]));

    // Optional fallback if you want to pad (via env or query)
    const useFallback = !!(+req.query.fallback || +process.env.PAYMENT_OPTIONS_FALLBACK || 0);
    if (useFallback) {
      for (const t of TABS) {
        const s = new Set(options[t]);
        (DEFAULTS[t] || []).forEach(v => s.add(v));
        options[t] = Array.from(s).sort((a,b)=>a.localeCompare(b));
      }
    }

    // Debug mode shows counts/raw
    if (req.query.debug === '1') {
      return res.json({
        options,
        counts: Object.fromEntries(TABS.map(t => [t, Array.from(buckets[t].entries())])),
        rawSeenSample: rawSeen.slice(0, 50),
        usedFallback: useFallback
      });
    }

    res.json({ options });
  } catch (err) {
    console.error('payment-options error:', err);
    res.status(200).json({ options: { CreditCard:[],DebitCard:[],Wallet:[],UPI:[],NetBanking:[],EMI:[] }, error: 'payment-options-failed' });
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
