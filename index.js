// index.js (ESM)
import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// ---------- Mongo helpers ----------
let mongoClient, offersCol;
async function ensureMongo() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI missing");
  const dbName = process.env.MONGODB_DB || "skydeal";
  const colName = process.env.MONGO_COL || "offers";
  if (!mongoClient) {
    mongoClient = new MongoClient(uri, { ignoreUndefined: true });
    await mongoClient.connect();
  }
  offersCol = mongoClient.db(dbName).collection(colName);
}

const titleFix = (s) => (s || "").replace(/\s+/g, " ").trim();
const dedupeClean = (arr) => {
  const out = [], seen = new Set();
  for (const v0 of arr || []) {
    const v = titleFix(v0);
    if (!v) continue;
    const k = v.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(v); }
  }
  return out;
};

// ---------- /payment-options ----------
app.get("/payment-options", async (_req, res) => {
  try {
    await ensureMongo();
    const cursor = offersCol.aggregate([
      { $match: { $or: [ {isExpired: {$exists:false}}, {isExpired:false} ] } },
      { $project: { pm1: "$paymentMethods", pm2: "$parsedFields.paymentMethods" } },
      { $project: { merged: { $concatArrays: [ {$ifNull:["$pm1",[]]}, {$ifNull:["$pm2",[]]} ] } } }
    ]);

    const buckets = { "Credit Card": [], "Debit Card": [], "Net Banking": [], "UPI": [], "Wallet": [] };
    const isBanky = (s) =>
      /bank|card|visa|master|rupay|amex|axis|hdfc|icici|kotak|idfc|hsbc|rbl|bob|au/i.test(s||"") &&
      !/not applicable|3rd party|gift card/i.test(s||"");

    for await (const doc of cursor) {
      for (const pm of doc.merged || []) {
        const type = titleFix(pm?.type || "");
        const bank = titleFix(pm?.bank || pm?.raw || "");
        if (!type) continue;
        if (/credit/i.test(type))        { if (isBanky(bank)) buckets["Credit Card"].push(bank || "Credit Card"); }
        else if (/debit/i.test(type))    { if (isBanky(bank)) buckets["Debit Card"].push(bank || "Debit Card"); }
        else if (/net.*bank|internet.*bank/i.test(type)) {
          if (isBanky(bank)) buckets["Net Banking"].push(bank || "Net Banking");
        }
        else if (/upi/i.test(type))      { buckets["UPI"].push(bank || "UPI"); }
        else if (/wallet/i.test(type))   { buckets["Wallet"].push(bank || "Wallet"); }
      }
    }

    const options = Object.fromEntries(Object.entries(buckets).map(([k,v]) => [k, dedupeClean(v)]));
    res.json({ usedFallback:false, options });
  } catch (e) {
    res.json({
      usedFallback: true,
      options: {
        "Credit Card": ["HDFC Bank","ICICI Bank","Axis Bank","Kotak Bank"],
        "Debit Card": ["HDFC Bank"],
        "Net Banking": ["ICICI Bank"],
        "UPI": ["CRED UPI","Mobikwik"],
        "Wallet": []
      },
      error: e.message || String(e)
    });
  }
});

// ---------- FlightAPI helpers ----------
function toYYYYMMDD(s) {
  if (!s) return s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;           // already normalized
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);       // DD/MM/YYYY
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return s;
}
function normIata(x) { return titleFix(x).toUpperCase(); }
function normCabin(x) {
  const t = (x || "").toString().toLowerCase();
  if (t.startsWith("eco")) return "ECONOMY";
  if (t.startsWith("pre")) return "PREMIUM_ECONOMY";
  if (t.startsWith("bus")) return "BUSINESS";
  if (t.startsWith("fir")) return "FIRST";
  return "ECONOMY";
}

// Build an expanded set of URL candidates (covers both common hosts and param styles).
function buildCandidates({ from, to, date, adults=1, travelClass="ECONOMY", currency="INR" }) {
  const key = process.env.FLIGHTAPI_KEY;
  if (!key) throw new Error("FLIGHTAPI_KEY missing");

  const hosts = [
    process.env.FLIGHTAPI_HOST || "https://api.flightapi.io",
    "https://flightapi.io" // some accounts are mapped here
  ];

  const qs = (obj) =>
    Object.entries(obj).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");

  const make = [];
  for (const h of hosts) {
    // path style
    make.push(`${h}/oneway/${encodeURIComponent(key)}/${from}/${to}/${date}/${adults}/${travelClass}?currency=${currency}`);
    // query apikey
    make.push(`${h}/oneway?${qs({ apikey:key, from, to, date, adults, travelClass, currency })}`);
    // query api_key
    make.push(`${h}/oneway?${qs({ api_key:key, from, to, date, adults, travelClass, currency })}`);
  }
  return make;
}

async function fetchOneWaySmart(params) {
  const tried = [];
  for (const url of buildCandidates(params)) {
    try {
      const r = await axios.get(url);
      tried.push({ url, status: r.status });
      return { data: r.data, status: r.status, tried };
    } catch (e) {
      const st = e?.response?.status || 0;
      const body = (typeof e?.response?.data === "string") ? e.response.data
                 : (e?.response?.data ? JSON.stringify(e.response.data) : "");
      tried.push({ url, status: st, error: e?.message, body });
    }
  }
  const err = new Error("All FlightAPI variants failed");
  err.tried = tried;
  throw err;
}

// ---- /search ----
app.post('/search', async (req, res) => {
  const body = req.body || {};
  const meta = {
    source: 'flightapi',
    outStatus: 0,
    retStatus: 0,
    error: '',
    offerDebug: {},
    request: { outTried: [], retTried: [] }
  };

  try {
    let { from, to, departureDate, returnDate, tripType, passengers, travelClass } = body;

    // 1) Normalize dates to YYYY-MM-DD (supports DD/MM/YYYY)
    const norm = (d) => {
      if (!d) return '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
      const m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      return m ? `${m[3]}-${m[2]}-${m[1]}` : d;
    };
    departureDate = norm(departureDate);
    returnDate   = norm(returnDate);

    // 2) Basic params
    from = (from || '').toUpperCase().slice(0,3);
    to   = (to   || '').toUpperCase().slice(0,3);
    passengers  = Number(passengers || 1);
    travelClass = (travelClass || 'economy').toLowerCase();

    // 3) Guard: API key
    const APIKEY = process.env.FLIGHTAPI_KEY;
    if (!APIKEY) {
      meta.error = 'FLIGHTAPI_KEY missing on backend';
      return res.json({ meta, outboundFlights: [], returnFlights: [] });
    }

    // 4) Build variant URLs
    const oneWayUrls = [
      // path-style
      `https://api.flightapi.io/oneway/${APIKEY}/${from}/${to}/${departureDate}/${passengers}/${travelClass}`,
      // query apikey
      `https://api.flightapi.io/oneway?apikey=${APIKEY}&from=${from}&to=${to}&date=${departureDate}&adults=${passengers}&travelClass=${travelClass}`,
      // query api_key (some accounts use this param)
      `https://api.flightapi.io/oneway?api_key=${APIKEY}&from=${from}&to=${to}&date=${departureDate}&adults=${passengers}&travelClass=${travelClass}`,
    ];

    const retUrls = returnDate ? [
      `https://api.flightapi.io/oneway/${APIKEY}/${to}/${from}/${returnDate}/${passengers}/${travelClass}`,
      `https://api.flightapi.io/oneway?apikey=${APIKEY}&from=${to}&to=${from}&date=${returnDate}&adults=${passengers}&travelClass=${travelClass}`,
      `https://api.flightapi.io/oneway?api_key=${APIKEY}&from=${to}&to=${from}&date=${returnDate}&adults=${passengers}&travelClass=${travelClass}`,
    ] : [];

    // helper to attempt a list of URLs and record tries
    const tryUrls = async (urls, bucketName) => {
      for (const url of urls) {
        try {
          const r = await axios.get(url, { headers: { 'Content-Type': 'application/json' }, timeout: 20000 });
          meta[bucketName === 'out' ? 'outStatus' : 'retStatus'] = r.status;
          meta.request[bucketName === 'out' ? 'outTried' : 'retTried'].push({
            url, status: r.status, body: String(r.data).slice(0, 180)
          });
          return r.data; // success
        } catch (e) {
          const status = e.response?.status || 0;
          const body   = e.response?.data ? String(e.response.data).slice(0, 180) : (e.message || '').slice(0,180);
          meta.request[bucketName === 'out' ? 'outTried' : 'retTried'].push({ url, status, body });
          // continue to next URL
        }
      }
      return null;
    };

    // 5) Do calls
    const outData = await tryUrls(oneWayUrls, 'out');
    const retData = (tripType === 'round-trip' && returnDate) ? await tryUrls(retUrls, 'ret') : null;

    const outboundFlights = outData?.data?.flights || outData?.flights || [];
    const returnFlights   = retData?.data?.flights || retData?.flights || [];

    if (!outboundFlights.length && meta.outStatus === 0) meta.outStatus = 404;
    if (tripType === 'round-trip' && !returnFlights.length && meta.retStatus === 0) meta.retStatus = 404;

    if (!outboundFlights.length && (tripType !== 'round-trip' || !returnFlights.length)) {
      meta.error = 'All FlightAPI variants failed';
    }

    return res.json({ meta, outboundFlights, returnFlights });
  } catch (e) {
    meta.error = e.message || 'search failed';
    meta.outStatus ||= 500;
    return res.json({ meta, outboundFlights: [], returnFlights: [] });
  }
});


// ---------- start ----------
app.listen(PORT, () => {
  console.log(`SkyDeal backend listening on ${PORT}`);
});
