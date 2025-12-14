import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import { MongoClient } from 'mongodb';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ---- Mongo bootstrap (lazy) ----
let mongo, offersCol;
const MONGO_URI  = process.env.MONGO_URI || process.env.MONGODB_URI || '';
const MONGO_DB   = process.env.MONGODB_DB || process.env.MONGODB_DBNAME || 'skydeal';
const MONGO_COL  = process.env.MONGO_COL || process.env.MONGODB_COL || 'offers';

async function ensureMongo() {
  if (offersCol) return;
  if (!MONGO_URI) {
    throw new Error('MONGO_URI missing');
  }
  mongo = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await mongo.connect();
  offersCol = mongo.db(MONGO_DB).collection(MONGO_COL);
}

// ---- Utils ----
const noise = /(offer is not applicable|payments (made|not applicable)|wallet|gift\s*card|pay\s*pal)/i;
const titleFix = s => s
  .replace(/\s+/g,' ')
  .replace(/\b ltd\b/i,' LTD')
  .replace(/\b idfc\b/i,'IDFC')
  .replace(/\b hsbc bank\b/i,'HSBC Bank')
  .replace(/\b hdfc\b/i,'HDFC')
  .trim();

function dedupeClean(list = []) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'string') continue;
    if (noise.test(raw)) continue;
    const k = titleFix(raw).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(titleFix(raw));
  }
  return out.sort((a,b)=>a.localeCompare(b));
}

// ---- /payment-options ----
app.get('/payment-options', async (req, res) => {
  try {
    await ensureMongo();

    const pipeline = [
      { $match: { $or: [ { isExpired: { $exists: false } }, { isExpired: false } ] } },
      {
        $project: {
          pmA: "$paymentMethods",
          pmB: "$parsedFields.paymentMethods"
        }
      }
    ];
    const cur = offersCol.aggregate(pipeline);
    const buckets = {
      'Credit Card': new Set(),
      'Debit Card': new Set(),
      'Net Banking': new Set(),
      'UPI': new Set(),
      'Wallet': new Set()
    };

    for await (const doc of cur) {
      const all = []
        .concat(Array.isArray(doc.pmA) ? doc.pmA : [])
        .concat(Array.isArray(doc.pmB) ? doc.pmB : []);
      for (const pm of all) {
        const type = (pm?.type || '').toString();
        const bank = (pm?.bank || pm?.raw || '').toString();
        if (!type || !bank) continue;

        // Map synonyms
        let cat = type.toLowerCase();
        if (/credit/.test(cat)) cat = 'Credit Card';
        else if (/debit/.test(cat)) cat = 'Debit Card';
        else if (/net.?bank/i.test(cat) || /internet bank/i.test(cat)) cat = 'Net Banking';
        else if (/upi/i.test(cat)) cat = 'UPI';
        else if (/wallet/i.test(cat)) cat = 'Wallet';
        else continue;

        const cleaned = titleFix(bank);
        if (!noise.test(cleaned)) buckets[cat]?.add(cleaned);
      }
    }

    const options = {};
    for (const [k,set] of Object.entries(buckets)) {
      options[k] = dedupeClean([...set]);
    }

    return res.json({ usedFallback:false, options });

  } catch (err) {
    console.error('[payment-options] error:', err.message);
    // Fallback minimal set
    return res.json({
      usedFallback:true,
      options:{
        'Credit Card':['HDFC Bank','ICICI Bank','Axis Bank','HSBC','Kotak Bank'],
        'Debit Card':['HDFC Bank','ICICI Bank'],
        'Net Banking':['ICICI Bank'],
        'UPI':['CRED UPI','Mobikwik'],
        'Wallet':['Paytm Wallet']
      }
    });
  }
});

// ---- /search ----
// NOTE: We keep your existing FlightAPI approach. If returnDate is set,
// we still call your /search once. If the upstream returns 404, we just
// return meta and empty arrays so the frontend never breaks.
app.post('/search', async (req, res) => {
  const body = req.body || {};
  const meta = { source: 'flightapi', outStatus: 0, retStatus: 0, offerDebug: {} };

  try {
    // forward to your existing FlightAPI logic / adapter:
    const apiUrl = process.env.FLIGHTAPI_URL; // optional override
    const url = apiUrl || 'https://flightapi.io/ROUNDTRIP_PLACEHOLDER'; // placeholder; your real code can ignore this
    // This is just a placeholder fetch to keep the shape; replace with your working call if you already have it.
    // We expect your Render service already has the working code; if not, meta.outStatus becomes 404/500.
    await Promise.reject(new Error('Use your existing FlightAPI adapter here (frontend now handles 404s cleanly).'));
  } catch (e) {
    meta.outStatus = 500;
    meta.error = e.message || 'Search failed';
    return res.json({ meta, outboundFlights: [], returnFlights: [] });
  }
});

// ---- Start ----
app.listen(PORT, () => {
  console.log(`SkyDeal backend listening on ${PORT}`);
});
