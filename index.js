// SKYDEAL BACKEND — FINAL CONSOLIDATED
// Matches “Fix Mongo Connectivity” rules: FlightAPI first, Mongo read-only for payment methods,
// no ScraperAPI, single Mongo connect, stable env names, resilient fallbacks.

import express from "express";
import cors from "cors";
import axios from "axios";
import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: "*", // if you want to lock later, add your Vercel domain here
    methods: ["GET", "POST"],
  })
);

// ---------- ENV (single source of truth) ----------
const PORT = process.env.PORT || 10000;

// Provider toggle: "flightapi" (default) or "amadeus"
const PROVIDER = (process.env.FLIGHT_PROVIDER || "flightapi").toLowerCase();

// Mongo URI — accept either MONGODB_URI or MONGO_URI (back-compat), prefer MONGODB_URI
const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || "";

// ---------- Mongo (read-only for payment methods) ----------
let Offer;
if (MONGO_URI) {
  mongoose.set("strictQuery", false);
  mongoose
    .connect(MONGO_URI, {
      serverSelectionTimeoutMS: 8000,
      socketTimeoutMS: 20000,
    })
    .then(() => console.log("MongoDB connected"))
    .catch((err) => console.error("MongoDB connection error:", err.message));

  const OfferSchema = new mongoose.Schema({}, { strict: false, collection: "offers" });
  Offer = mongoose.models.Offer || mongoose.model("Offer", OfferSchema);
} else {
  console.warn("MONGO URI not set (MONGODB_URI or MONGO_URI). Payment methods will be empty.");
}

// Payment methods grouped from Mongo
app.get("/api/payment-methods", async (_req, res) => {
  try {
    if (!Offer || mongoose.connection.readyState !== 1) {
      return res.json({
        creditCard: [],
        debitCard: [],
        wallet: [],
        upi: [],
        netBanking: [],
        emi: [],
      });
    }

    const pipe = [
      { $unwind: "$paymentMethods" },
      { $project: { type: "$paymentMethods.type", name: "$paymentMethods.name" } },
      { $group: { _id: { type: "$type", name: "$name" } } },
    ];
    const rows = await Offer.aggregate(pipe);

    const out = { creditCard: [], debitCard: [], wallet: [], upi: [], netBanking: [], emi: [] };
    for (const r of rows) {
      const t = (r._id?.type || "").trim();
      const n = (r._id?.name || "").trim();
      if (!t || !n) continue;
      const key = t.replace(/\s+/g, "");
      if (out[key] && !out[key].includes(n)) out[key].push(n);
    }
    Object.keys(out).forEach((k) => out[k].sort((a, b) => a.localeCompare(b)));
    res.json(out);
  } catch (e) {
    console.error("payment-methods error:", e.message || e);
    res.json({ creditCard: [], debitCard: [], wallet: [], upi: [], netBanking: [], emi: [] });
  }
});

// ---------- Flight search (provider-normalized) ----------
app.post("/search", async (req, res) => {
  try {
    const { from, to, departureDate, returnDate, passengers, travelClass, tripType } = req.body;

    if (PROVIDER === "flightapi") {
      // FlightAPI.io proxy — we forward and normalize.
      // Because FlightAPI endpoints vary by plan, we use a generic proxy URL & headers from env.
      // REQUIRED ENVS:
      //   FLIGHTAPI_URL   -> full base URL for search on your plan (e.g., https://api.flightapi.io/search)
      //   FLIGHTAPI_KEY   -> your API key or token (sent as header X-API-Key by default)
      const baseUrl = process.env.FLIGHTAPI_URL;
      const key = process.env.FLIGHTAPI_KEY;

      if (!baseUrl || !key) throw new Error("FlightAPI envs missing (FLIGHTAPI_URL / FLIGHTAPI_KEY)");

      // We forward a standard payload so your backend remains consistent.
      const params = {
        from,
        to,
        departureDate,
        returnDate: tripType === "round-trip" ? returnDate : "",
        passengers,
        travelClass,
        tripType,
        currency: "INR",
      };

      const faRes = await axios.post(baseUrl, params, {
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": key, // adjust to your provider’s header if different
        },
        timeout: 20000,
      });

      // Expect any shape; normalize to { outbound[], inbound[] }
      const normalized = normalizeFlightAPI(faRes.data);
      return res.json(normalized);
    }

    // Fallback: Amadeus (only if explicitly selected)
    if (PROVIDER === "amadeus") {
      const tokenRes = await axios.post(
        "https://test.api.amadeus.com/v1/security/oauth2/token",
        new URLSearchParams({
          grant_type: "client_credentials",
          client_id: process.env.AMADEUS_API_KEY,
          client_secret: process.env.AMADEUS_API_SECRET,
        }),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 20000 }
      );

      const accessToken = tokenRes.data.access_token;

      const response = await axios.get("https://test.api.amadeus.com/v2/shopping/flight-offers", {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          originLocationCode: from,
          destinationLocationCode: to,
          departureDate,
          returnDate: tripType === "round-trip" ? returnDate : undefined,
          adults: passengers,
          travelClass,
          currencyCode: "INR",
          max: 40,
        },
        timeout: 20000,
      });

      const out = normalizeAmadeus(response.data);
      return res.json(out);
    }

    throw new Error(`Unknown FLIGHT_PROVIDER: ${PROVIDER}`);
  } catch (err) {
    console.error("search error:", err.response?.data || err.message || err);
    res.status(500).json({ error: "Failed to fetch flights" });
  }
});

// ---------- Normalizers ----------
function normalizeFlightAPI(raw) {
  // We accept various shapes, but return:
  // { outbound: [{airline, flightNumber, departureTime, arrivalTime, price, stops}], inbound: [...] }
  const out = { outbound: [], inbound: [] };

  // Example tolerant parsing (adjust if your FlightAPI shape differs)
  const results = raw?.results || raw?.data || [];
  for (const r of results) {
    const conv = (segBlock) => {
      if (!segBlock) return null;
      const seg = Array.isArray(segBlock.segments) ? segBlock.segments[0] : segBlock;
      const airline = seg?.airlineName || seg?.airline || r?.airline || "Flight";
      const flightNo = seg?.flightNumber || seg?.number || "";
      const dep = (seg?.departureTime || seg?.departure || seg?.departure_at || "").slice(11, 16) || seg?.departureTime;
      const arr = (seg?.arrivalTime || seg?.arrival || seg?.arrival_at || "").slice(11, 16) || seg?.arrivalTime;
      const price = Number(r?.price?.total ?? r?.price ?? r?.total ?? 0);
      const stops = (segBlock?.segments?.length ?? r?.stops ?? 1) - 1;
      return {
        airline,
        flightNumber: flightNo ? `${flightNo}` : "",
        departureTime: dep || "",
        arrivalTime: arr || "",
        price,
        stops: Math.max(0, stops || 0),
      };
    };

    const o = conv(r.outbound || r.out || r.itineraries?.[0]);
    if (o) out.outbound.push(o);
    const i = conv(r.inbound || r.in || r.itineraries?.[1]);
    if (i) out.inbound.push(i);
  }

  return out;
}

function normalizeAmadeus(data) {
  const carriers = data?.dictionaries?.carriers || {};
  const outbound = [];
  const inbound = [];

  (data?.data || []).forEach((offer) => {
    const it0 = offer.itineraries?.[0];
    const it1 = offer.itineraries?.[1];

    const toCard = (itin) => {
      if (!itin) return null;
      const seg = itin.segments?.[0];
      const airline = carriers[seg?.carrierCode] || seg?.carrierCode || "Flight";
      const dep = seg?.departure?.at?.substring(11, 16) || "";
      const arr = seg?.arrival?.at?.substring(11, 16) || "";
      return {
        airline,
        flightNumber: `${seg?.carrierCode || ""} ${seg?.number || ""}`.trim(),
        departureTime: dep,
        arrivalTime: arr,
        price: Number(offer?.price?.total || 0),
        stops: Math.max(0, (itin?.segments?.length || 1) - 1),
      };
    };

    const o = toCard(it0);
    if (o) outbound.push(o);
    const i = toCard(it1);
    if (i) inbound.push(i);
  });

  return { outbound, inbound };
}

// ---------- Health ----------
app.get("/", (_req, res) => res.send("SkyDeal backend running (FlightAPI-first)."));

app.listen(PORT, () => console.log(`Server on ${PORT} | Provider=${PROVIDER}`));
