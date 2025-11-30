// index.js — SkyDeal backend (Render)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import { MongoClient } from "mongodb";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

let db = null;
let offersColl = null;

// ---------- Mongo connect ----------
async function connectMongo() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.log("Mongo: no MONGO_URI set — payment methods will use fallback.");
    return;
  }
  if (db) return; // already connected
  const client = new MongoClient(uri, { maxPoolSize: 5 });
  await client.connect();
  db = client.db(); // database inferred from URI
  offersColl = db.collection("offers"); // <-- collection name
  console.log("Mongo connected.");
}
connectMongo().catch(e => {
  console.error("Mongo connect error:", e.message);
});

// ---------- Helpers ----------
const TYPE_KEYS = {
  "credit card": "creditCard",
  "creditcard": "creditCard",
  "credit": "creditCard",
  "debit card": "debitCard",
  "debitcard": "debitCard",
  "debit": "debitCard",
  "wallet": "wallet",
  "upi": "upi",
  "netbanking": "netBanking",
  "net banking": "netBanking",
  "emi": "emi",
};

function normalizeType(t) {
  if (!t) return null;
  const key = String(t).trim().toLowerCase();
  return TYPE_KEYS[key] || null;
}

function buildLabel(pm) {
  // Try common fields in your schema variants
  const bank = pm.bank || pm.issuer || pm.provider || pm.gateway || "";
  const network = pm.cardNetwork || pm.network || "";
  const methodName = pm.method || pm.methodName || "";

  // Prefer bank + network (e.g., "ICICI Credit (Visa)")
  const parts = [bank, network].filter(Boolean);
  if (parts.length) return parts.join(" ").trim();

  // else show methodName (e.g., "Paytm Wallet")
  if (methodName) return methodName.trim();

  // else show whatever identifier exists
  return (pm.name || pm.label || "").trim();
}

// ---------- API: payment methods ----------
app.get("/api/payment-methods", async (_req, res) => {
  try {
    await connectMongo();

    // If no Mongo, or not connected, return empty groups (frontend still works)
    if (!offersColl) {
      console.log("payment-methods: no Mongo -> fallback (empty)");
      return res.json({
        creditCard: [],
        debitCard: [],
        wallet: [],
        upi: [],
        netBanking: [],
        emi: [],
      });
    }

    // Pull only non-expired offers. Your schema stores both raw + parsed; we only need parsedFields/paymentMethods[]
    // If your schema uses a different flag field for expiry, add it here.
    const pipeline = [
      { $match: { $or: [{ isExpired: { $exists: false } }, { isExpired: { $ne: true } }] } },
      { $match: { paymentMethods: { $exists: true, $ne: [] } } },
      { $unwind: "$paymentMethods" },
      {
        $project: {
          pm: "$paymentMethods",
        },
      },
    ];

    const cursor = offersColl.aggregate(pipeline, { allowDiskUse: true });
    const buckets = {
      creditCard: new Set(),
      debitCard: new Set(),
      wallet: new Set(),
      upi: new Set(),
      netBanking: new Set(),
      emi: new Set(),
    };

    for await (const doc of cursor) {
      const pm = doc.pm || {};
      // Normalize type
      const type =
        normalizeType(pm.type) ||
        normalizeType(pm.category) ||
        normalizeType(pm.channel) ||
        normalizeType(pm.paymentType);

      const mapped = type || null;
      if (!mapped || !buckets[mapped]) continue;

      const label = buildLabel(pm);
      if (!label) continue;

      buckets[mapped].add(label);
    }

    const out = {
      creditCard: Array.from(buckets.creditCard).sort(),
      debitCard: Array.from(buckets.debitCard).sort(),
      wallet: Array.from(buckets.wallet).sort(),
      upi: Array.from(buckets.upi).sort(),
      netBanking: Array.from(buckets.netBanking).sort(),
      emi: Array.from(buckets.emi).sort(),
    };

    console.log(
      `payment-methods: scanned -> credit=${out.creditCard.length}, debit=${out.debitCard.length}, wallet=${out.wallet.length}, upi=${out.upi.length}, net=${out.netBanking.length}, emi=${out.emi.length}`
    );

    return res.json(out);
  } catch (err) {
    console.error("payment-methods error:", err);
    return res.json({
      creditCard: [],
      debitCard: [],
      wallet: [],
      upi: [],
      netBanking: [],
      emi: [],
    });
  }
});

// ---------- FlightAPI (unchanged, minimal demo) ----------
const FLIGHTAPI_BASE = "https://api.flightapi.io";

app.post("/api/search", async (req, res) => {
  const {
    from,
    to,
    departureDate,
    returnDate,
    passengers = 1,
    travelClass = "Economy",
    currency = "INR",
    region = "IN",
  } = req.body || {};

  const apiKey = process.env.FLIGHTAPI_KEY;
  if (!apiKey) return res.status(500).json({ error: "Missing FLIGHTAPI_KEY" });

  // Build roundtrip URL (FlightAPI expects path params)
  const roundUrl = `${FLIGHTAPI_BASE}/roundtrip/${apiKey}/${from}/${to}/${departureDate}/${returnDate || departureDate}/${passengers}/0/0/${encodeURIComponent(
    travelClass
  )}/${currency}?region=${encodeURIComponent(region)}`;

  try {
    const r = await axios.get(roundUrl, { timeout: 20000 });
    return res.json(r.data);
  } catch (e) {
    console.error("FlightAPI roundtrip error:", e.response?.status, e.response?.data || e.message);
    // Try oneway fallback so the UI shows *something*
    const oneUrl = `${FLIGHTAPI_BASE}/onewaytrip/${apiKey}/${from}/${to}/${departureDate}/${passengers}/0/0/${encodeURIComponent(
      travelClass
    )}/${currency}?region=${encodeURIComponent(region)}`;
    try {
      const r2 = await axios.get(oneUrl, { timeout: 20000 });
      return res.json(r2.data);
    } catch (e2) {
      console.error("FlightAPI oneway error:", e2.response?.status, e2.response?.data || e2.message);
      return res.status(502).json({ error: "Failed to fetch flights" });
    }
  }
});

app.get("/", (_req, res) => res.send("SkyDeal backend OK"));

app.listen(PORT, () => {
  console.log(`Server ON ${PORT}`);
});
