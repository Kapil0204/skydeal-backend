// =======================
//  SKYDEAL BACKEND INDEX.JS (FINAL)
// =======================

import express from "express";
import cors from "cors";
import axios from "axios";
import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

// -----------------------
//  APP INIT
// -----------------------
const app = express();
app.use(express.json());
app.use(cors({
  origin: "*",
  methods: "GET,POST",
}));

const PORT = process.env.PORT || 10000;

// -----------------------
//  MONGO CONNECT
// -----------------------
if (!process.env.MONGODB_URI) {
  console.warn("⚠️  MONGODB_URI not set");
} else {
  mongoose.set("strictQuery", false);

  mongoose
    .connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 8000,
      socketTimeoutMS: 20000,
    })
    .then(() => console.log("MongoDB connected ✔️"))
    .catch((err) => console.error("MongoDB connection error ❌:", err.message));
}

// Minimal offer schema
const OfferSchema = new mongoose.Schema({}, { strict: false, collection: "offers" });
const Offer = mongoose.models.Offer || mongoose.model("Offer", OfferSchema);

// -----------------------
//  PAYMENT METHODS API
// -----------------------
app.get("/api/payment-methods", async (req, res) => {
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

    const pipeline = [
      { $unwind: "$paymentMethods" },
      {
        $project: {
          type: "$paymentMethods.type",
          name: "$paymentMethods.name",
        },
      },
      { $group: { _id: { type: "$type", name: "$name" } } },
    ];

    const rows = await Offer.aggregate(pipeline);

    const grouped = {
      creditCard: [],
      debitCard: [],
      wallet: [],
      upi: [],
      netBanking: [],
      emi: [],
    };

    rows.forEach((r) => {
      const type = r._id?.type?.trim() || "";
      const name = r._id?.name?.trim() || "";
      if (!type || !name) return;

      const key = type.replace(/\s+/g, "");
      if (grouped[key] && !grouped[key].includes(name)) {
        grouped[key].push(name);
      }
    });

    Object.keys(grouped).forEach((k) => grouped[k].sort());

    res.json(grouped);
  } catch (err) {
    console.error("payment-methods error:", err);
    res.json({
      creditCard: [],
      debitCard: [],
      wallet: [],
      upi: [],
      netBanking: [],
      emi: [],
    });
  }
});

// -----------------------
//  SIMULATED FLIGHTS (kept for testing)
// -----------------------
app.post("/simulated-flights", (req, res) => {
  const { paymentMethods } = req.body;

  const bestDeals = {
    "ICICI Bank Credit Card": { portal: "MakeMyTrip", offer: "10% off", code: "SKYICICI10", price: 4900 },
    "HDFC Bank Credit Card": { portal: "Goibibo", offer: "12% off", code: "SKYHDFC12", price: 4700 },
    "Axis Bank Credit Card": { portal: "EaseMyTrip", offer: "15% off", code: "SKYAXIS15", price: 4500 },
  };

  const outboundFlights = [
    {
      flightName: "IndiGo 6E123",
      departure: "08:00",
      arrival: "10:00",
      bestDeal: bestDeals[paymentMethods?.[0]] || null,
      price: 5200,
      stops: 0,
    },
    {
      flightName: "Air India AI456",
      departure: "12:30",
      arrival: "14:45",
      bestDeal: bestDeals[paymentMethods?.[0]] || null,
      price: 5600,
      stops: 1,
    },
  ];

  const returnFlights = [
    {
      flightName: "SpiceJet SG789",
      departure: "18:00",
      arrival: "20:00",
      bestDeal: bestDeals[paymentMethods?.[0]] || null,
      price: 5400,
      stops: 0,
    },
    {
      flightName: "Vistara UK321",
      departure: "21:30",
      arrival: "23:50",
      bestDeal: bestDeals[paymentMethods?.[0]] || null,
      price: 5900,
      stops: 1,
    },
  ];

  res.json({ outboundFlights, returnFlights });
});

// -----------------------
//  REAL FLIGHT SEARCH (Amadeus)
// -----------------------
app.post("/search", async (req, res) => {
  try {
    const { from, to, departureDate, returnDate, passengers, travelClass, tripType } = req.body;

    const tokenRes = await axios.post(
      "https://test.api.amadeus.com/v1/security/oauth2/token",
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: process.env.AMADEUS_API_KEY,
        client_secret: process.env.AMADEUS_API_SECRET,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const accessToken = tokenRes.data.access_token;

    const response = await axios.get(
      "https://test.api.amadeus.com/v2/shopping/flight-offers",
      {
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
      }
    );

    const data = response.data;

    const carriers = {};
    data.dictionaries?.carriers &&
      Object.keys(data.dictionaries.carriers).forEach((code) => {
        carriers[code] = data.dictionaries.carriers[code];
      });

    const outbound = [];
    const inbound = [];

    (data.data || []).forEach((offer) => {
      const firstItin = offer.itineraries[0];
      const secondItin = offer.itineraries[1];

      const processItinerary = (itin) => {
        const seg = itin.segments[0];
        const carrierName = carriers[seg.carrierCode] || seg.carrierCode;

        return {
          airline: carrierName,
          flightNumber: seg.carrierCode + " " + seg.number,
          departureTime: seg.departure.at.substring(11, 16),
          arrivalTime: seg.arrival.at.substring(11, 16),
          price: offer.price.total,
          stops: itin.segments.length - 1,
        };
      };

      outbound.push(processItinerary(firstItin));
      if (secondItin) inbound.push(processItinerary(secondItin));
    });

    res.json({ outbound, inbound });
  } catch (err) {
    console.error("Amadeus search error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch real flights" });
  }
});

// -----------------------
app.get("/", (req, res) => {
  res.send("SkyDeal backend running.");
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
