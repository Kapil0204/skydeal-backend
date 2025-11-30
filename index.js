import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// ---------------- MONGO ----------------
const MONGO_URI = process.env.MONGODB_URI || "";
let mongoReady = false;

if (MONGO_URI) {
  mongoose.connect(MONGO_URI, { dbName: "skydeal" })
    .then(() => {
      mongoReady = true;
      console.log("MongoDB connected");
    })
    .catch((err) => console.error("MongoDB connect error:", err.message));
}

// Offers schema (we only care about paymentMethods)
const OfferSchema = new mongoose.Schema(
  {
    paymentMethods: [{ type: { type: String }, name: String }]
  },
  { strict: false, collection: "offers" }
);
const Offer = mongoose.models.Offer || mongoose.model("Offer", OfferSchema);

// ---------------- PAYMENT METHODS ----------------
app.get("/api/payment-methods", async (_req, res) => {
  // fallback so UI never empty
  const fallback = {
    creditCard: ["ICICI Bank Credit Card", "HDFC Bank Credit Card", "Axis Bank Credit Card", "SBI Credit Card"],
    debitCard:  ["ICICI Bank Debit Card",  "HDFC Bank Debit Card",  "Axis Bank Debit Card",  "SBI Debit Card"],
    wallet:     ["Amazon Pay", "Paytm", "PhonePe"],
    upi:        ["UPI"],
    netBanking: ["ICICI NetBanking", "HDFC NetBanking", "SBI NetBanking", "Axis NetBanking"],
    emi:        ["ICICI Credit Card EMI", "HDFC Credit Card EMI"]
  };

  try {
    if (!mongoReady) {
      console.log("payment-methods: mongo not ready -> fallback");
      return res.json(fallback);
    }

    const groups = { creditCard: [], debitCard: [], wallet: [], upi: [], netBanking: [], emi: [] };

    const docs = await Offer.aggregate([
      { $match: { paymentMethods: { $exists: true, $ne: [] } } },
      { $unwind: "$paymentMethods" },
      { $group: { _id: { type: "$paymentMethods.type", name: "$paymentMethods.name" } } }
    ]);

    for (const row of docs) {
      const t = row?._id?.type, n = row?._id?.name;
      if (!t || !n) continue;
      if (!groups[t]) groups[t] = [];
      if (!groups[t].includes(n)) groups[t].push(n);
    }

    const total = Object.values(groups).reduce((a, arr) => a + arr.length, 0);
    if (total === 0) {
      console.log("payment-methods: no data in Mongo -> fallback");
      return res.json(fallback);
    }

    console.log(`payment-methods: cc=${groups.creditCard.length}, dc=${groups.debitCard.length}, wallet=${groups.wallet.length}, upi=${groups.upi.length}, nb=${groups.netBanking.length}, emi=${groups.emi.length}`);
    return res.json(groups);
  } catch (e) {
    console.error("payment-methods error:", e.message);
    return res.json(fallback);
  }
});

// ---------------- FLIGHT SEARCH (FlightAPI.io) ----------------
const FLIGHTAPI_KEY = process.env.FLIGHTAPI_KEY || "";
const REGION = (process.env.FLIGHTAPI_REGION || "IN").toUpperCase();
const BASE = "https://api.flightapi.io";

function normalizeCabin(c) {
  if (!c) return "Economy";
  const x = String(c).toLowerCase();
  if (x.includes("premium")) return "Premium_Economy";
  if (x.startsWith("bus"))   return "Business";
  if (x.startsWith("fir"))   return "First";
  return "Economy";
}

/** Attempt roundtrip, if 400 then attempt oneway automatically. */
async function fetchFlights({from, to, dep, ret, adults, children, infants, cabin, currency}) {
  const pathRound = `${BASE}/roundtrip/${encodeURIComponent(FLIGHTAPI_KEY)}/${from}/${to}/${dep}/${ret}/${adults}/${children}/${infants}/${cabin}/${currency}?region=${REGION}`;
  console.log("FlightAPI GET:", pathRound.replace(FLIGHTAPI_KEY, "****KEY****"));

  try {
    const r = await axios.get(pathRound, { timeout: 30000, headers: { Accept: "application/json" } });
    return { kind: "roundtrip", data: r.data };
  } catch (err) {
    const status = err?.response?.status;
    const data   = err?.response?.data;
    console.error("FlightAPI roundtrip error:", status, typeof data === "string" ? data.slice(0, 400) : JSON.stringify(data || {}, null, 2).slice(0, 400));

    // Retry with oneway if roundtrip fails (common with some accounts/regions)
    const pathOne = `${BASE}/onewaytrip/${encodeURIComponent(FLIGHTAPI_KEY)}/${from}/${to}/${dep}/${adults}/${children}/${infants}/${cabin}/${currency}?region=${REGION}`;
    console.log("FlightAPI RETRY (oneway):", pathOne.replace(FLIGHTAPI_KEY, "****KEY****"));
    const r2 = await axios.get(pathOne, { timeout: 30000, headers: { Accept: "application/json" } });
    return { kind: "oneway", data: r2.data };
  }
}

function mapFlightApi(json) {
  const arr =
    json?.data ||
    json?.results ||
    json?.itineraries ||
    json?.outboundFlights ||
    [];

  const toCard = (r) => ({
    airline: r.airlineName || r.airline || r.carrier || "Flight",
    flightNumber: r.flightNumber || r.number || "",
    departureTime: r.departureTime || r.departure || r.departure_time || "",
    arrivalTime: r.arrivalTime || r.arrival || r.arrival_time || "",
    price: Number(r.price || r.total || r.amount || r.minPrice || 0),
    stops: Number(r.stops ?? 0)
  });

  const cards = Array.isArray(arr) ? arr.map(toCard) : [];
  return { outbound: cards, inbound: cards };
}

app.post("/search", async (req, res) => {
  try {
    if (!FLIGHTAPI_KEY) return res.status(500).json({ error: "Missing FLIGHTAPI_KEY" });

    const {
      from, to,
      departureDate,
      returnDate,
      passengers = 1,
      travelClass = "Economy",
      tripType = "round-trip"
    } = req.body || {};

    if (!from || !to || !departureDate) {
      return res.status(400).json({ error: "Missing from/to/departureDate" });
    }

    const dep = departureDate;
    const ret = tripType === "one-way" ? departureDate : (returnDate || departureDate);
    const payload = {
      from: encodeURIComponent(from),
      to: encodeURIComponent(to),
      dep: encodeURIComponent(dep),
      ret: encodeURIComponent(ret),
      adults: encodeURIComponent(String(passengers)),
      children: "0",
      infants: "0",
      cabin: encodeURIComponent(normalizeCabin(travelClass)),
      currency: "INR"
    };

    const { data } = await fetchFlights(payload);
    const mapped = mapFlightApi(data);
    return res.json(mapped);
  } catch (err) {
    // log full detail so we see what FlightAPI actually returned
    const status = err?.response?.status;
    const data   = err?.response?.data;
    console.error("FlightAPI search error:", status, typeof data === "string" ? data.slice(0, 800) : JSON.stringify(data || {}, null, 2).slice(0, 800));

    // last-resort mock so UI keeps working
    const mock = {
      outbound: [
        { airline: "IndiGo", flightNumber: "6E123", departureTime: "08:00", arrivalTime: "10:00", price: 4999, stops: 0 },
        { airline: "Air India", flightNumber: "AI456", departureTime: "12:30", arrivalTime: "14:45", price: 5499, stops: 0 }
      ],
      inbound: [
        { airline: "Vistara", flightNumber: "UK321", departureTime: "18:30", arrivalTime: "20:45", price: 5799, stops: 0 }
      ]
    };
    return res.json(mock);
  }
});

// ---------------- HEALTH ----------------
app.get("/", (_req, res) => res.send("SkyDeal backend up"));

// ---------------- START ----------------
app.listen(PORT, () => console.log(`Server ON ${PORT}`));
