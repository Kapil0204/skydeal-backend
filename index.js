// index.js (ESM)
// Run on Render port 10000
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
  const db = mongoClient.db(dbName);
  offersCol = db.collection(colName);
}

// small helpers for display/normalization
const titleFix = (s) =>
  (s || "")
    .replace(/\s+/g, " ")
    .replace(/^\s+|\s+$/g, "");

const dedupeClean = (arr) => {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const v = titleFix(x);
    if (!v) continue;
    const k = v.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  return out;
};

// ---------- /payment-options ----------
app.get("/payment-options", async (req, res) => {
  try {
    await ensureMongo();

    // pull payment data from both paymentMethods and parsedFields.paymentMethods
    const cursor = offersCol.aggregate([
      {
        $match: {
          $or: [{ isExpired: { $exists: false } }, { isExpired: false }],
        },
      },
      {
        $project: {
          pm1: "$paymentMethods",
          pm2: "$parsedFields.paymentMethods",
        },
      },
      {
        $project: {
          merged: {
            $concatArrays: [
              { $ifNull: ["$pm1", []] },
              { $ifNull: ["$pm2", []] },
            ],
          },
        },
      },
    ]);

    const buckets = {
      "Credit Card": [],
      "Debit Card": [],
      "Net Banking": [],
      UPI: [],
      Wallet: [],
    };

    const isBanky = (s) =>
      /bank|card|visa|master|rupay|amex|axis|hdfc|icici|kotak|idfc|hsbc|rbl|bob|au/i.test(
        s || ""
      ) && !/payments?|\bwallet\b.+not applicable|3rd party|gift card/i.test(s);

    for await (const doc of cursor) {
      for (const pm of doc.merged || []) {
        const type = titleFix(pm?.type || "");
        const bank = titleFix(pm?.bank || pm?.raw || "");
        if (!type) continue;

        if (/credit/i.test(type)) {
          if (isBanky(bank)) buckets["Credit Card"].push(bank || "Credit Card");
        } else if (/debit/i.test(type)) {
          if (isBanky(bank)) buckets["Debit Card"].push(bank || "Debit Card");
        } else if (/net.*bank/i.test(type) || /internet.*bank/i.test(type)) {
          if (isBanky(bank)) buckets["Net Banking"].push(bank || "Net Banking");
        } else if (/upi/i.test(type)) {
          buckets["UPI"].push(bank || "UPI");
        } else if (/wallet/i.test(type)) {
          buckets["Wallet"].push(bank || "Wallet");
        }
      }
    }

    const options = Object.fromEntries(
      Object.entries(buckets).map(([k, v]) => [k, dedupeClean(v)])
    );

    res.json({ usedFallback: false, options });
  } catch (e) {
    // conservative fallback if Mongo is unavailable
    res.json({
      usedFallback: true,
      options: {
        "Credit Card": ["HDFC Bank", "ICICI Bank", "Axis Bank", "Kotak Bank"],
        "Debit Card": ["HDFC Bank"],
        "Net Banking": ["ICICI Bank"],
        UPI: ["CRED UPI", "Mobikwik"],
        Wallet: [],
      },
      error: e.message || String(e),
    });
  }
});

// ---------- /search ----------
/**
 * Calls FlightAPI twice (two one-way searches):
 *  1) out: from -> to on departureDate
 *  2) ret: to -> from on returnDate (only if round-trip)
 *
 * We only return raw lists here. Offer application can happen
 * in a separate step or on the frontend selection.
 */
app.post("/search", async (req, res) => {
  const body = req.body || {};
  const meta = { source: "flightapi", outStatus: 0, retStatus: 0, offerDebug: {} };

  try {
    const {
      from,
      to,
      departureDate,
      returnDate,
      tripType,
      passengers,
      travelClass,
    } = body;

    if (!process.env.FLIGHTAPI_KEY) {
      throw new Error("FLIGHTAPI_KEY missing");
    }

    const base = "https://api.flightapi.io/oneway";
    const headers = {
      "Content-Type": "application/json",
      apikey: process.env.FLIGHTAPI_KEY,
    };

    // OUTBOUND one-way
    const outUrl = `${base}?from=${encodeURIComponent(
      from
    )}&to=${encodeURIComponent(to)}&date=${encodeURIComponent(
      departureDate
    )}&adults=${encodeURIComponent(
      passengers ?? 1
    )}&travelClass=${encodeURIComponent(travelClass ?? "economy")}`;

    const outRes = await axios.get(outUrl, { headers });
    meta.outStatus = outRes.status;
    const outboundFlights = outRes.data?.flights || [];

    // RETURN one-way (if round-trip)
    let returnFlights = [];
    if (tripType === "round-trip" && returnDate) {
      const retUrl = `${base}?from=${encodeURIComponent(
        to
      )}&to=${encodeURIComponent(from)}&date=${encodeURIComponent(
        returnDate
      )}&adults=${encodeURIComponent(
        passengers ?? 1
      )}&travelClass=${encodeURIComponent(travelClass ?? "economy")}`;
      const retRes = await axios.get(retUrl, { headers });
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

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`SkyDeal backend listening on ${PORT}`);
});
