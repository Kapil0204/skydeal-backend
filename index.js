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

// ---------------- Mongo helpers ----------------
let mongoClient;
let offersCol;

async function ensureMongo() {
  const uri = process.env.MONGO_URI;
  const dbName = process.env.MONGODB_DB || "skydeal";
  const colName = process.env.MONGO_COL || "offers";
  if (!uri) throw new Error("MONGO_URI missing");
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

// ---------------- /payment-options ----------------
app.get("/payment-options", async (_req, res) => {
  try {
    await ensureMongo();

    const cursor = offersCol.aggregate([
      { $match: { $or: [ {isExpired: {$exists:false}}, {isExpired:false} ] } },
      { $project: { pm1:"$paymentMethods", pm2:"$parsedFields.paymentMethods" } },
      { $project: { merged: { $concatArrays: [ {$ifNull:["$pm1",[]]}, {$ifNull:["$pm2",[]]} ] } } }
    ]);

    const buckets = {
      "Credit Card": [], "Debit Card": [], "Net Banking": [], "UPI": [], "Wallet": []
    };

    const isBanky = (s) =>
      /bank|card|visa|master|rupay|amex|axis|hdfc|icici|kotak|idfc|hsbc|rbl|bob|au/i.test(s||"") &&
      !/not applicable|3rd party|gift card/i.test(s||"");

    for await (const doc of cursor) {
      for (const pm of doc.merged || []) {
        const type = titleFix(pm?.type || "");
        const bank = titleFix(pm?.bank || pm?.raw || "");
        if (!type) continue;

        if (/credit/i.test(type))       { if (isBanky(bank)) buckets["Credit Card"].push(bank || "Credit Card"); }
        else if (/debit/i.test(type))   { if (isBanky(bank)) buckets["Debit Card"].push(bank || "Debit Card"); }
        else if (/net.*bank|internet.*bank/i.test(type)) {
          if (isBanky(bank)) buckets["Net Banking"].push(bank || "Net Banking");
        }
        else if (/upi/i.test(type))     { buckets["UPI"].push(bank || "UPI"); }
        else if (/wallet/i.test(type))  { buckets["Wallet"].push(bank || "Wallet"); }
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

// ---------------- FlightAPI helpers ----------------
function toYYYYMMDD(s) {
  if (!s) return s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;           // already normalized
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);       // DD/MM/YYYY
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return s; // as-is
}

// Two supported styles:
// 1) query:  https://api.flightapi.io/oneway?apikey=KEY&from=BOM&to=DEL&date=YYYY-MM-DD&adults=1&travelClass=economy
// 2) path:   https://api.flightapi.io/oneway/KEY/BOM/DEL/YYYY-MM-DD/1/economy
function buildOneWayUrl({ from, to, date, adults=1, travelClass="economy" }) {
  const key = process.env.FLIGHTAPI_KEY;
  if (!key) throw new Error("FLIGHTAPI_KEY missing");
  const style = (process.env.FLIGHTAPI_STYLE || "query").toLowerCase();

  if (style === "path") {
    // common public docs format
    return `https://api.flightapi.io/oneway/${encodeURIComponent(key)}/${encodeURIComponent(from)}/${encodeURIComponent(to)}/${encodeURIComponent(date)}/${encodeURIComponent(adults)}/${encodeURIComponent(travelClass)}`;
  }

  // default to query style
  const base = "https://api.flightapi.io/oneway";
  return `${base}?apikey=${encodeURIComponent(key)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&date=${encodeURIComponent(date)}&adults=${encodeURIComponent(adults)}&travelClass=${encodeURIComponent(travelClass)}`;
}

// ---------------- /search (two one-way calls) ----------------
app.post("/search", async (req, res) => {
  const body = req.body || {};
  const meta = { source: "flightapi", outStatus: 0, retStatus: 0, offerDebug: {}, request:{} };

  try {
    const { from, to, departureDate, returnDate, tripType, passengers, travelClass } = body;

    const dep = toYYYYMMDD(departureDate);
    const ret = toYYYYMMDD(returnDate);

    const outUrl = buildOneWayUrl({
      from, to, date: dep, adults: passengers ?? 1, travelClass: travelClass ?? "economy"
    });
    meta.request.outUrl = outUrl;

    const outRes = await axios.get(outUrl);
    meta.outStatus = outRes.status;
    const outboundFlights = outRes.data?.flights || [];

    let returnFlights = [];
    if (tripType === "round-trip" && ret) {
      const retUrl = buildOneWayUrl({
        from: to, to: from, date: ret, adults: passengers ?? 1, travelClass: travelClass ?? "economy"
      });
      meta.request.retUrl = retUrl;

      const retRes = await axios.get(retUrl);
      meta.retStatus = retRes.status;
      returnFlights = retRes.data?.flights || [];
    }

    return res.json({ meta, outboundFlights, returnFlights });
  } catch (e) {
    meta.outStatus = e?.response?.status || 500;
    meta.error = e?.message || "Search failed";
    return res.json({ meta, outboundFlights: [], returnFlights: [] });
  }
});

// ---------------- start ----------------
app.listen(PORT, () => {
  console.log(`SkyDeal backend listening on ${PORT}`);
});
