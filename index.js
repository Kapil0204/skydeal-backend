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

// ---------- /search (two one-way calls; never break the UI) ----------
app.post("/search", async (req, res) => {
  const body = req.body || {};
  const meta = { source: "flightapi", outStatus: 0, retStatus: 0, offerDebug: {}, request: {} };

  try {
    const from = normIata(body.from);
    const to = normIata(body.to);
    const dep = toYYYYMMDD(body.departureDate);
    const ret = toYYYYMMDD(body.returnDate);
    const tripType = body.tripType || "one-way";
    const adults = Number(body.passengers || 1);
    const cabin = normCabin(body.travelClass);

    // outbound
    const out = await fetchOneWaySmart({
      from, to, date: dep, adults, travelClass: cabin, currency: "INR"
    });
    meta.outStatus = out.status;
    meta.request.outTried = out.tried;
    const outboundFlights = out.data?.flights || [];

    // return (if round trip)
    let returnFlights = [];
    if (tripType === "round-trip" && ret) {
      const rt = await fetchOneWaySmart({
        from: to, to: from, date: ret, adults, travelClass: cabin, currency: "INR"
      });
      meta.retStatus = rt.status;
      meta.request.retTried = rt.tried;
      returnFlights = rt.data?.flights || [];
    }

    return res.json({ meta, outboundFlights, returnFlights });
  } catch (e) {
    meta.outStatus = e?.response?.status || 404;
    meta.error = e?.message || "Search failed";
    if (e?.tried) meta.request.tried = e.tried;
    return res.json({ meta, outboundFlights: [], returnFlights: [] });
  }
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`SkyDeal backend listening on ${PORT}`);
});
