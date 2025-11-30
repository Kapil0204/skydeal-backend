// index.js — SkyDeal backend (FlightAPI + Mongo + payment methods hard fallback)

import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import axios from "axios";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// ---------- Mongo Connect ----------
const MONGO_URI = process.env.MONGODB_URI || "";
if (!MONGO_URI) console.warn("MONGODB_URI not set – payment methods will rely on hard fallback.");

let mongoReady = false;
async function connectMongo() {
  if (!MONGO_URI) return;
  try {
    await mongoose.connect(MONGO_URI, { dbName: "skydeal" });
    mongoReady = true;
    console.log("MongoDB connected.");
  } catch (err) {
    console.error("Mongo connect error:", err.message);
  }
}
connectMongo();

// A very loose Offer schema (only fields we need for payment methods)
const OfferSchema = new mongoose.Schema(
  {
    paymentMethods: [
      {
        type: { type: String },   // creditCard | debitCard | wallet | upi | netBanking | emi
        bank: String,             // e.g., HDFC, ICICI
        network: String,          // e.g., Visa, RuPay (optional)
        label: String             // display label
      }
    ]
  },
  { strict: false, collection: "offers" }
);
const Offer = mongoose.models.Offer || mongoose.model("Offer", OfferSchema);

// ---------- Payment Methods ----------
const HARD_METHODS = {
  creditCard: [
    { key: "ICICI Bank Credit Card", label: "ICICI Bank Credit Card" },
    { key: "HDFC Bank Credit Card", label: "HDFC Bank Credit Card" },
    { key: "Axis Bank Credit Card", label: "Axis Bank Credit Card" },
    { key: "SBI Credit Card", label: "SBI Credit Card" }
  ],
  debitCard: [
    { key: "ICICI Bank Debit Card", label: "ICICI Bank Debit Card" },
    { key: "HDFC Bank Debit Card", label: "HDFC Bank Debit Card" },
    { key: "Axis Bank Debit Card", label: "Axis Bank Debit Card" }
  ],
  wallet: [
    { key: "Paytm Wallet", label: "Paytm Wallet" },
    { key: "PhonePe Wallet", label: "PhonePe Wallet" },
    { key: "Amazon Pay Wallet", label: "Amazon Pay Wallet" }
  ],
  upi: [{ key: "UPI", label: "UPI" }],
  netBanking: [
    { key: "ICICI NetBanking", label: "ICICI NetBanking" },
    { key: "HDFC NetBanking", label: "HDFC NetBanking" },
    { key: "Axis NetBanking", label: "Axis NetBanking" }
  ],
  emi: [
    { key: "HDFC EMI", label: "HDFC EMI" },
    { key: "ICICI EMI", label: "ICICI EMI" }
  ]
};

app.get("/api/payment-methods", async (_req, res) => {
  try {
    if (!mongoReady) {
      console.log("payment-methods: mongo not ready -> hard fallback");
      return res.json(HARD_METHODS);
    }

    // scan offers for structured payment methods
    const cursor = Offer.find({}, { paymentMethods: 1 }).cursor();
    const buckets = {
      creditCard: new Map(),
      debitCard: new Map(),
      wallet: new Map(),
      upi: new Map(),
      netBanking: new Map(),
      emi: new Map()
    };
    let scanned = 0;

    for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
      scanned++;
      const arr = doc.paymentMethods || [];
      for (const pm of arr) {
        const t = (pm.type || "").trim();
        if (!buckets[t]) continue;
        const label =
          pm.label ||
          [pm.bank, pm.network, t].filter(Boolean).join(" ");
        const key = label || `${t}:${pm.bank || ""}:${pm.network || ""}`;
        if (!buckets[t].has(key)) buckets[t].set(key, { key, label: label || key });
      }
    }

    const toArray = (m) => Array.from(m.values());
    const payload = {
      creditCard: toArray(buckets.creditCard),
      debitCard: toArray(buckets.debitCard),
      wallet: toArray(buckets.wallet),
      upi: toArray(buckets.upi),
      netBanking: toArray(buckets.netBanking),
      emi: toArray(buckets.emi)
    };

    const total =
      payload.creditCard.length +
      payload.debitCard.length +
      payload.wallet.length +
      payload.upi.length +
      payload.netBanking.length +
      payload.emi.length;

    if (total === 0) {
      console.log(`payment-methods: scanned=${scanned}, found=0 -> hard fallback`);
      return res.json(HARD_METHODS);
    }
    console.log(`payment-methods: scanned=${scanned}, found=${total}`);
    return res.json(payload);
  } catch (e) {
    console.error("payment-methods error:", e.message);
    return res.json(HARD_METHODS);
  }
});

// ---------- Flight Search (FlightAPI with graceful fallback) ----------
const FLIGHTAPI_KEY = process.env.FLIGHTAPI_KEY || "";
function buildRoundtripURL({ from, to, departureDate, returnDate, adults, children, infants, cabin, currency, region }) {
  // Spec per docs: /roundtrip/<key>/<from>/<to>/<dep>/<ret>/<adults>/<children>/<infants>/<cabin>/<currency>?region=IN
  const parts = [
    "https://api.flightapi.io/roundtrip",
    encodeURIComponent(FLIGHTAPI_KEY),
    encodeURIComponent(from),
    encodeURIComponent(to),
    encodeURIComponent(departureDate),
    encodeURIComponent(returnDate),
    String(adults ?? 1),
    String(children ?? 0),
    String(infants ?? 0),
    encodeURIComponent(cabin || "Economy"),
    encodeURIComponent(currency || "INR")
  ];
  const base = parts.join("/");
  const r = region ? `?region=${encodeURIComponent(region)}` : "";
  return `${base}${r}`;
}

function mockFlights(from, to) {
  return {
    outbound: [
      {
        id: "MOCK-OUT-1",
        airline: "IndiGo",
        flightNumber: "6E 201",
        departure: `${from} 08:30`,
        arrival: `${to} 10:35`,
        price: 5299,
        stops: 0
      },
      {
        id: "MOCK-OUT-2",
        airline: "Air India",
        flightNumber: "AI 657",
        departure: `${from} 12:15`,
        arrival: `${to} 14:30`,
        price: 5699,
        stops: 0
      }
    ],
    return: [
      {
        id: "MOCK-RET-1",
        airline: "Vistara",
        flightNumber: "UK 944",
        departure: `${to} 18:20`,
        arrival: `${from} 20:35`,
        price: 5899,
        stops: 0
      },
      {
        id: "MOCK-RET-2",
        airline: "SpiceJet",
        flightNumber: "SG 015",
        departure: `${to} 21:05`,
        arrival: `${from} 23:10`,
        price: 5499,
        stops: 0
      }
    ]
  };
}

app.post("/api/search", async (req, res) => {
  try {
    const {
      from, to,
      departureDate, returnDate,
      passengers = 1,
      travelClass = "Economy",
      tripType = "round-trip"
    } = req.body || {};

    if (!FLIGHTAPI_KEY) {
      console.warn("FLIGHTAPI_KEY missing -> sending mock flights");
      return res.json(mockFlights(from, to));
    }

    const adults = passengers || 1;
    const children = 0;
    const infants = 0;
    const currency = "INR";
    const region = "IN";

    if (tripType === "one-way") {
      // FlightAPI recommends /onewaytrip when needed (fallback if roundtrip fails).
      const onewayURL = `https://api.flightapi.io/onewaytrip/${encodeURIComponent(FLIGHTAPI_KEY)}/${encodeURIComponent(from)}/${encodeURIComponent(to)}/${encodeURIComponent(departureDate)}/${adults}/${children}/${infants}/${encodeURIComponent(travelClass)}/${currency}?region=${region}`;
      console.log("FlightAPI GET (oneway):", onewayURL);
      const r = await axios.get(onewayURL);
      return res.json({ outbound: r.data?.data || [], return: [] });
    }

    const url = buildRoundtripURL({
      from,
      to,
      departureDate,
      returnDate,
      adults,
      children,
      infants,
      cabin: travelClass,
      currency,
      region
    });

    console.log("FlightAPI GET:", url);
    const resp = await axios.get(url);
    // Normalise quickly for frontend (use provider’s structure if you prefer)
    const data = resp.data?.data || resp.data || {};
    if (!data || (Array.isArray(data) && data.length === 0)) {
      console.warn("FlightAPI empty -> mock");
      return res.json(mockFlights(from, to));
    }
    return res.json(data);
  } catch (err) {
    const status = err?.response?.status;
    const body = err?.response?.data;
    console.error("FlightAPI roundtrip error:", status, body || err.message);
    // On any error -> graceful mock so UI still flows
    return res.json(mockFlights(req.body?.from, req.body?.to));
  }
});

// ---------- Root ----------
app.get("/", (_req, res) => {
  res.send("SkyDeal backend running.");
});

app.listen(PORT, () => {
  console.log(`Server on ${PORT}`);
});
