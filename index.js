// ====================== IMPORTS ============================
import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

// ====================== APP INIT ===========================
const app = express();
app.use(express.json());

// ---------- CORS (clean + safe) ----------
const ALLOW = [
  /\.vercel\.app$/,              // Any Vercel frontend URL
  /^http:\/\/localhost(:\d+)?$/, // Local dev
];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const ok = ALLOW.some(rule =>
        rule instanceof RegExp ? rule.test(origin) : rule === origin
      );
      cb(ok ? null : new Error("CORS blocked"), ok);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

app.options("*", cors());

// ====================== HEALTH CHECK ===========================
app.get("/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});


// ================================================================
// =============== 1. SIMULATED FLIGHTS ROUTE ======================
// ================================================================
app.post("/simulated-flights", (req, res) => {
  const {
    from,
    to,
    departureDate,
    returnDate,
    passengers,
    travelClass,
    paymentMethods,
    tripType,
  } = req.body;

  const bestDeals = {
    "ICICI Bank": {
      portal: "MakeMyTrip",
      offer: "10% off",
      code: "SKYICICI10",
      price: 4900,
    },
    "HDFC Bank": {
      portal: "Goibibo",
      offer: "12% off",
      code: "SKYHDFC12",
      price: 4700,
    },
    "Axis Bank": {
      portal: "EaseMyTrip",
      offer: "15% off",
      code: "SKYAXIS15",
      price: 4500,
    },
  };

  const outboundFlights = [
    {
      flightName: "IndiGo 6E123",
      departure: "08:00",
      arrival: "10:00",
      bestDeal: bestDeals[paymentMethods?.[0]] || null,
    },
    {
      flightName: "Air India AI456",
      departure: "12:30",
      arrival: "14:45",
      bestDeal: bestDeals[paymentMethods?.[0]] || null,
    },
  ];

  const returnFlights =
    tripType === "round-trip"
      ? [
          {
            flightName: "SpiceJet SG789",
            departure: "18:00",
            arrival: "20:00",
            bestDeal: bestDeals[paymentMethods?.[0]] || null,
          },
          {
            flightName: "Vistara UK321",
            departure: "21:30",
            arrival: "23:50",
            bestDeal: bestDeals[paymentMethods?.[0]] || null,
          },
        ]
      : [];

  res.json({ outboundFlights, returnFlights });
});


// ================================================================
// =============== 2. REAL FLIGHT SEARCH (Amadeus) ================
// ================================================================
app.post("/search", async (req, res) => {
  try {
    const {
      from,
      to,
      departureDate,
      returnDate,
      passengers,
      travelClass,
      tripType,
    } = req.body;

    console.log("[SkyDeal] Search request:", req.body);

    const responses = [];
    const amadeusURL = "https://test.api.amadeus.com/v2/shopping/flight-offers";

    // Get Amadeus Bearer Token
    const tokenResp = await axios.post(
      "https://test.api.amadeus.com/v1/security/oauth2/token",
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: process.env.AMADEUS_CLIENT_ID,
        client_secret: process.env.AMADEUS_CLIENT_SECRET,
      })
    );

    const accessToken = tokenResp.data.access_token;

    const searchParams = {
      originLocationCode: from,
      destinationLocationCode: to,
      departureDate,
      adults: passengers,
      travelClass,
      currencyCode: "INR",
      max: 20,
    };

    if (tripType === "round-trip") {
      searchParams.returnDate = returnDate;
    }

    const flightResp = await axios.get(amadeusURL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: searchParams,
    });

    console.log("[SkyDeal] Amadeus count:", flightResp.data.data?.length || 0);

    res.json({
      meta: {
        source: "amadeus",
        outStatus: 200,
        retStatus: 200,
      },
      outboundFlights: flightResp.data.data || [],
      returnFlights: [],
    });
  } catch (err) {
    console.error("Search failed:", err?.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch flights" });
  }
});


// ================================================================
// =============== 3. PAYMENT OPTIONS (MongoDB) ====================
// ================================================================
app.get("/payment-options", async (req, res) => {
  try {
    const mongo = new MongoClient(process.env.MONGO_URI);
    await mongo.connect();

    const db = mongo.db("skydeal");
    const options = await db.collection("paymentOptions").find({}).toArray();

    mongo.close();

    res.json({
      usedFallback: false,
      options: options?.[0] || {},
    });
  } catch (err) {
    console.error("Payment options failed:", err.message);
    res.json({
      usedFallback: true,
      options: {
        CreditCard: ["ICICI Bank", "HDFC Bank"],
        DebitCard: ["ICICI Debit", "HDFC Debit"],
        Wallet: ["Paytm", "PhonePe"],
        EMI: ["HDFC", "Axis"],
      },
    });
  }
});


// ================================================================
// =============== 4. START SERVER ================================
// ================================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`SkyDeal backend running on port ${PORT}`);
});
