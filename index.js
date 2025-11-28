// SkyDeal Backend — FlightAPI Only Version (Final Clean Build)

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { MongoClient, ServerApiVersion } from "mongodb";

dotenv.config();

// ----------------------
// CONFIG
// ----------------------
const PORT = process.env.PORT || 10000;
const FLIGHTAPI_KEY = process.env.FLIGHTAPI_KEY;
const MONGO_URI = process.env.MONGO_URI;

// MongoDB client
let mongoClient;
let offersCollection = null;

async function connectMongo() {
  try {
    mongoClient = new MongoClient(MONGO_URI, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: false,
        deprecationErrors: false,
      },
    });

    await mongoClient.connect();
    const db = mongoClient.db("skydeal");
    offersCollection = db.collection("offers");

    console.log("MongoDB connected");
  } catch (err) {
    console.error("Mongo connection error:", err?.message);
  }
}

// ----------------------
// EXPRESS APP
// ----------------------
const app = express();
app.use(cors());
app.use(express.json());

// ----------------------
// Helpers
// ----------------------

// Build FlightAPI one-way URL
function buildOneWayUrl(from, to, date, adults, cabin) {
  return `https://api.flightapi.io/onewaytrip/${FLIGHTAPI_KEY}/${from}/${to}/${date}/${adults}/0/0/${cabin}/INR`;
}

// Fetch one-way results from FlightAPI
async function fetchFlightapiOneway(from, to, date, adults, cabin) {
  const url = buildOneWayUrl(from, to, date, adults, cabin);

  try {
    const res = await fetch(url);
    const data = await res.json();
    return { url, data };
  } catch (err) {
    console.error("FlightAPI fetch error:", err?.message);
    return { url, data: null, error: err?.message };
  }
}

// Extract time safely
function safeTime(str) {
  if (!str) return "--:--";
  if (str.includes("T")) return str.split("T")[1].slice(0, 5);
  if (str.length >= 5) return str.slice(11, 16);
  return "--:--";
}

// Map FlightAPI itineraries -> SkyDeal format
function mapFlightapiItineraries(raw, { currency = "INR" } = {}) {
  if (!raw || !raw.data || !Array.isArray(raw.data.itineraries)) return [];

  const itins = raw.data.itineraries;
  const segmentsMap =
    Array.isArray(raw.data.segments) &&
    raw.data.segments.reduce((acc, seg) => {
      acc[seg.id] = seg;
      return acc;
    }, {});

  const carriersMap =
    Array.isArray(raw.data.carriers) &&
    raw.data.carriers.reduce((acc, c) => {
      acc[c.id] = c.name || "Airline";
      return acc;
    }, {});

  return itins.map((itin) => {
    const pricing = itin.pricing_options?.[0] || null;
    const price = pricing?.price?.amount || 0;

    const legId = itin.leg_ids?.[0];
    const leg = raw.data.legs?.find((l) => l.id === legId) || null;

    let seg0 = null;
    let seg1 = null;

    if (leg && Array.isArray(leg.segment_ids)) {
      seg0 = segmentsMap[leg.segment_ids[0]];
      if (leg.segment_ids.length > 1) {
        seg1 = segmentsMap[leg.segment_ids[1]];
      }
    }

    const dep = safeTime(seg0?.departure);
    const arr = safeTime(seg1?.arrival || seg0?.arrival);

    const marketingCarrier =
      seg0?.marketing_carrier_id || seg1?.marketing_carrier_id || null;

    const airlineName =
      carriersMap?.[marketingCarrier] ||
      carriersMap?.[String(marketingCarrier)] ||
      "Airline";

    const flightNumber = String(seg0?.flight_number || "");

    return {
      airlineName,
      flightNumber,
      departure: dep,
      arrival: arr,
      price: price.toFixed(2),
      stops: leg?.segment_ids?.length ? leg.segment_ids.length - 1 : 0,
      carrierCode: marketingCarrier ? String(marketingCarrier) : "",
      stopCodes:
        leg?.segment_ids
          ?.map((sid) => {
            const s = segmentsMap?.[sid];
            return s ? String(s.origin) : null;
          })
          .filter(Boolean) || [],
      portalPrices: [
        "MakeMyTrip",
        "Goibibo",
        "EaseMyTrip",
        "Yatra",
        "Cleartrip",
      ].map((portal) => ({
        portal,
        basePrice: price,
        markedUpPrice: price + 250,
        finalPrice: price + 250,
        appliedOffer: null,
      })),
    };
  });
}

// ----------------------
// ROUTES
// ----------------------

// ---- Debug route: See URL + sample mapped flight
app.post("/flightapi/probe", async (req, res) => {
  const { from, to, date, adults = 1, cabin = "economy" } = req.body || {};
  const r = await fetchFlightapiOneway(from, to, date, adults, cabin);

  const mapped =
    mapFlightapiItineraries(r.data, { currency: "INR" })?.[0] || null;

  res.json({
    url: r.url,
    status: r.data ? 200 : 500,
    sample: mapped,
  });
});

// ---- Raw fetch (for debugging)
app.post("/flightapi/raw", async (req, res) => {
  const { from, to, date, adults = 1, cabin = "economy" } = req.body;
  const r = await fetchFlightapiOneway(from, to, date, adults, cabin);
  res.json(r.data || {});
});

// ---- MAIN SEARCH (supports round-trip)
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
    } = req.body || {};

    if (!from || !to || !departureDate) {
      return res.status(400).json({
        error: "bad_request",
        message: "from, to, departureDate required",
      });
    }

    const adults = Math.max(1, Number(passengers) || 1);
    const cabin = String(travelClass || "ECONOMY").toLowerCase();

    const fetchOutbound = fetchFlightapiOneway(
      from,
      to,
      departureDate,
      adults,
      cabin
    );

    const wantReturn =
      tripType === "round-trip" && typeof returnDate === "string";

    const fetchReturn = wantReturn
      ? fetchFlightapiOneway(to, from, returnDate, adults, cabin)
      : Promise.resolve(null);

    const [outRaw, retRaw] = await Promise.all([fetchOutbound, fetchReturn]);

    const outboundFlights = mapFlightapiItineraries(outRaw.data, {
      currency: "INR",
    });

    const returnFlights = wantReturn
      ? mapFlightapiItineraries(retRaw?.data, { currency: "INR" })
      : [];

    return res.json({
      outboundFlights,
      returnFlights,
      meta: {
        from,
        to,
        departureDate,
        returnDate: wantReturn ? returnDate : null,
        tripType,
        source: "flightapi",
      },
    });
  } catch (err) {
    console.error("SEARCH_ERROR:", err?.message);
    res.status(500).json({ error: "search_failed", message: err?.message });
  }
});

// ----------------------
// START SERVER
// ----------------------
app.listen(PORT, async () => {
  console.log(`SkyDeal backend running on port ${PORT}`);
  await connectMongo();
});
