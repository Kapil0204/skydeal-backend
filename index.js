// SKYDEAL BACKEND — FINAL, NO AMADEUS, ONLY FLIGHTAPI
// Clean, stable, EC2 Mongo, payment methods, and FlightAPI search

import express from "express";
import cors from "cors";
import axios from "axios";
import mongoose from "mongoose";
import dotenv from "dotenv";
import { URL } from "url";
dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({ origin: "*", methods: ["GET", "POST"] }));

const PORT = process.env.PORT || 10000;

// =======================
//  MONGO (EC2) with smart fallback
// =======================
let Offer;

async function tryConnect(uri, label) {
  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 8000,
      socketTimeoutMS: 20000,
    });
    console.log(`MongoDB connected via ${label}`);
    return true;
  } catch (e) {
    console.error(`Mongo connect failed via ${label}:`, e.message);
    try { await mongoose.disconnect(); } catch {}
    return false;
  }
}

async function connectMongo() {
  const raw = process.env.MONGODB_URI || process.env.MONGO_URI || "";
  if (!raw) {
    console.warn("Mongo URI not set");
    return;
  }

  // 1) try as-is
  if (await tryConnect(raw, "env-uri")) return;

  // 2) try authSource=admin
  let u = new URL(raw.replace(/^mongodb:\/\//, "http://"));
  const rebuild = (authSource) => {
    const auth = u.username
      ? `${u.username}${u.password ? ":" + u.password : ""}@`
      : "";
    const qs = new URLSearchParams(u.searchParams);
    qs.set("authSource", authSource);
    return `mongodb://${auth}${u.host}${u.pathname}?${qs.toString()}`;
  };

  if (await tryConnect(rebuild("admin"), "authSource=admin")) return;
  if (await tryConnect(rebuild("skydeal"), "authSource=skydeal")) return;

  console.error("❌ Mongo still failing after all fallbacks");
}

await connectMongo();

const OfferSchema = new mongoose.Schema({}, { strict: false, collection: "offers" });
Offer = mongoose.models.Offer || mongoose.model("Offer", OfferSchema);

// =======================
//  PAYMENT METHODS (Mongo)
// =======================
app.get("/api/payment-methods", async (_req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.json({
        creditCard: [],
        debitCard: [],
        wallet: [],
        upi: [],
        netBanking: [],
        emi: [],
      });
    }

    const rows = await Offer.aggregate([
      { $unwind: "$paymentMethods" },
      { $project: { type: "$paymentMethods.type", name: "$paymentMethods.name" } },
      { $group: { _id: { type: "$type", name: "$name" } } },
    ]);

    const out = { creditCard: [], debitCard: [], wallet: [], upi: [], netBanking: [], emi: [] };
    for (const r of rows) {
      const t = r._id?.type || "";
      const n = r._id?.name || "";
      const key = t.replace(/\s+/g, "");
      if (out[key] && !out[key].includes(n)) out[key].push(n);
    }
    Object.keys(out).forEach((k) => out[k].sort());
    res.json(out);
  } catch (e) {
    console.error("payment-methods error:", e.message);
    res.json({ creditCard: [], debitCard: [], wallet: [], upi: [], netBanking: [], emi: [] });
  }
});

// =======================
//  FLIGHT SEARCH — ONLY FlightAPI
// =======================
app.post("/search", async (req, res) => {
  try {
    const { from, to, departureDate, returnDate, passengers, travelClass, tripType } = req.body;

    const url = process.env.FLIGHTAPI_URL;
    const key = process.env.FLIGHTAPI_KEY;

    if (!url || !key) throw new Error("Missing FLIGHTAPI_URL or FLIGHTAPI_KEY");

    const payload = {
      from,
      to,
      departureDate,
      returnDate: tripType === "round-trip" ? returnDate : "",
      passengers,
      travelClass,
      tripType,
      currency: "INR",
    };

    const faRes = await axios.post(url, payload, {
      headers: { "Content-Type": "application/json", "X-API-Key": key },
      timeout: 20000,
    });

    res.json(normalizeFlightAPI(faRes.data));
  } catch (e) {
    console.error("FlightAPI search error:", e.response?.data || e.message);
    res.status(500).json({ error: "FlightAPI request failed" });
  }
});

// =======================
// NORMALIZER (FlightAPI only)
// =======================
function normalizeFlightAPI(raw) {
  const out = { outbound: [], inbound: [] };
  const items = raw?.results || raw?.data || [];

  for (const r of items) {
    const mk = (itin) => {
      if (!itin) return null;
      const seg = Array.isArray(itin.segments) ? itin.segments[0] : itin;
      const airline = seg?.airlineName || seg?.airline || "Flight";
      const flightNo = seg?.flightNumber || seg?.number || "";
      const dep = (seg?.departureTime || seg?.departure_at || "").slice(11, 16) || seg?.departureTime;
      const arr = (seg?.arrivalTime || seg?.arrival_at || "").slice(11, 16) || seg?.arrivalTime;
      const price = Number(r?.price?.total ?? r?.price ?? r?.total ?? 0);
      const stops = Math.max(0, (itin?.segments?.length ?? 1) - 1);
      return { airline, flightNumber: `${flightNo}`.trim(), departureTime: dep || "", arrivalTime: arr || "", price, stops };
    };

    const o = mk(r.outbound || r.itineraries?.[0]);
    if (o) out.outbound.push(o);

    const i = mk(r.inbound || r.itineraries?.[1]);
    if (i) out.inbound.push(i);
  }

  return out;
}

// =======================
app.get("/", (_req, res) => res.send("SkyDeal backend running (FlightAPI only, EC2 Mongo)."));

app.listen(PORT, () => console.log(`Server ON ${PORT} — FlightAPI only`));

