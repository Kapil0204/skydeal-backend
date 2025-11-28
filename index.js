// =============================
// SkyDeal Backend (FINAL STABLE)
// FlightAPI + MongoDB EC2 offers
// =============================

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { MongoClient, ServerApiVersion } from "mongodb";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// --------- FLIGHTAPI KEY ----------
const FLIGHTAPI_KEY = process.env.FLIGHTAPI_KEY;
if (!FLIGHTAPI_KEY) {
  console.error("❌ Missing FLIGHTAPI_KEY in .env");
  process.exit(1);
}

// --------- MONGO CONNECTION ----------
const MONGO_URI = "mongodb://13.233.155.88:27017/skydeal"; // FIXED EC2 URI

let offersCache = []; // Loaded once at start

async function connectMongo() {
  try {
    const client = new MongoClient(MONGO_URI, {
      serverApi: ServerApiVersion.v1,
    });
    await client.connect();
    console.log("✅ Mongo connected (EC2)");

    const db = client.db("skydeal");
    const offers = await db.collection("offers").find({}).toArray();
    offersCache = offers || [];

    console.log(`📦 Loaded ${offersCache.length} offers`);
  } catch (err) {
    console.error("❌ Mongo connection failed:", err.message);
  }
}
connectMongo();

// =============================
// FLIGHTAPI: Fetch one-way route
// =============================
async function fetchFlightapiOneway(from, to, date, adults, cabin) {
  const url = `https://api.flightapi.io/onewaytrip/${FLIGHTAPI_KEY}/${from}/${to}/${date}/${adults}/0/0/${cabin}/INR`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`FlightAPI error ${res.status}`);

  return res.json();
}

// =============================
// MAP FLIGHTAPI ITINERARY
// =============================
function mapFlight(itin) {
  const legs = itin.legs || [];
  if (legs.length === 0) return null;

  const firstLeg = legs[0];
  const lastLeg = legs[legs.length - 1];

  return {
    airlineName: firstLeg.marketingCarrierName || "Airline",
    flightNumber: firstLeg.marketingFlightNumber || "",
    departure: firstLeg.departure?.slice(11, 16) || "--:--",
    arrival: lastLeg.arrival?.slice(11, 16) || "--:--",
    price: itin.cheapestPrice?.amount?.toFixed(2) || "0.00",
    stops: legs.length - 1,
    carrierCode: firstLeg.marketingCarrierId || "",
    stopCodes: legs.map((l) => l.origin || ""),
  };
}

// =============================
// OFFER ENGINE
// =============================
function applyOffers(basePrice) {
  const portals = ["MakeMyTrip", "Goibibo", "EaseMyTrip", "Yatra", "Cleartrip"];
  const markup = 250;

  const portalPrices = portals.map((portal) => {
    let best = null;

    for (const offer of offersCache) {
      if (offer.parsed?.applicablePlatforms?.includes(portal)) {
        const discountPercent = offer.parsed?.discountPercent || 0;
        const maxCap = offer.parsed?.maxDiscountAmount || null;

        let discountAmount = (basePrice * discountPercent) / 100;
        if (maxCap && discountAmount > maxCap) discountAmount = maxCap;

        if (discountAmount > 0) {
          if (!best || discountAmount > best.discountApplied) {
            best = {
              portal,
              couponCode: offer.parsed?.couponCode || "",
              discountPercent,
              maxDiscountAmount: maxCap,
              discountApplied: discountAmount,
              offerId: offer._id,
              title: offer.parsed?.title || "",
            };
          }
        }
      }
    }

    const marked = basePrice + markup;
    const final = best ? marked - best.discountApplied : marked;

    return {
      portal,
      basePrice,
      markedUpPrice: marked,
      finalPrice: final,
      discountApplied: best?.discountApplied || 0,
      appliedOffer: best || null,
    };
  });

  return portalPrices;
}

// =============================
// /search — One-way + Round-trip
// =============================
app.post("/search", async (req, res) => {
  try {
    const {
      from,
      to,
      departureDate,
      returnDate,
      tripType = "one-way",
      passengers = 1,
      travelClass = "ECONOMY",
    } = req.body;

    if (!from || !to || !departureDate) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const adults = Number(passengers) || 1;
    const cabin = travelClass.toLowerCase();

    // Fetch outbound
    const outData = await fetchFlightapiOneway(from, to, departureDate, adults, cabin);
    const outboundItins = outData.itineraries || [];

    const outboundFlights = outboundItins
      .map(mapFlight)
      .filter(Boolean)
      .map((f) => ({
        ...f,
        portalPrices: applyOffers(Number(f.price)),
      }));

    // Fetch return only if RT
    let returnFlights = [];
    if (tripType === "round-trip" && returnDate) {
      const retData = await fetchFlightapiOneway(to, from, returnDate, adults, cabin);
      const retItins = retData.itineraries || [];

      returnFlights = retItins
        .map(mapFlight)
        .filter(Boolean)
        .map((f) => ({
          ...f,
          portalPrices: applyOffers(Number(f.price)),
        }));
    }

    return res.json({
      outboundFlights,
      returnFlights,
    });
  } catch (err) {
    console.error("SEARCH ERROR:", err);
    return res.status(500).json({ error: "search_failed", message: err.message });
  }
});

// =============================
app.listen(PORT, () => {
  console.log(`🚀 SkyDeal backend running on port ${PORT}`);
});
