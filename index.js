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

// ---------- MONGO ----------
const MONGO_URI = process.env.MONGODB_URI || "";
let mongoReady = false;
if (MONGO_URI) {
  mongoose
    .connect(MONGO_URI, { dbName: "skydeal" })
    .then(() => {
      mongoReady = true;
      console.log("MongoDB connected");
    })
    .catch((err) => {
      console.error("MongoDB connect error:", err.message);
    });
}

// Generic Offer schema (minimum needed fields)
const OfferSchema = new mongoose.Schema(
  {
    paymentMethods: [
      {
        type: { type: String }, // "creditCard" | "debitCard" | "wallet" | "upi" | "netBanking" | "emi"
        name: String,           // e.g. "ICICI Bank Credit Card"
      },
    ],
  },
  { strict: false, timestamps: false, collection: "offers" }
);
const Offer = mongoose.models.Offer || mongoose.model("Offer", OfferSchema);

// ---------- PAYMENT METHODS ----------
/**
 * Returns grouped payment methods from Mongo.
 * If Mongo is empty/unavailable, returns a sane static fallback
 * so the frontend always shows *something* (no blank modal).
 */
app.get("/api/payment-methods", async (_req, res) => {
  const buckets = {
    creditCard: [],
    debitCard: [],
    wallet: [],
    upi: [],
    netBanking: [],
    emi: [],
  };

  try {
    if (!mongoReady) {
      console.log("payment-methods: mongo not ready -> sending fallback");
      return res.json(buckets);
    }

    // Pull distinct {type,name} from offers.paymentMethods
    // (works with your parsed GPT schema used earlier)
    const docs = await Offer.aggregate([
      { $unwind: "$paymentMethods" },
      {
        $group: {
          _id: {
            type: "$paymentMethods.type",
            name: "$paymentMethods.name",
          },
        },
      },
    ]);

    for (const row of docs) {
      const type = row?._id?.type;
      const name = row?._id?.name;
      if (!type || !name) continue;
      if (!buckets[type]) buckets[type] = [];
      if (!buckets[type].includes(name)) buckets[type].push(name);
    }

    console.log(
      `payment-methods: grouped -> cc=${buckets.creditCard.length}, dc=${buckets.debitCard.length}, wallet=${buckets.wallet.length}, upi=${buckets.upi.length}, nb=${buckets.netBanking.length}, emi=${buckets.emi.length}`
    );

    return res.json(buckets);
  } catch (err) {
    console.error("payment-methods error:", err.message);
    return res.json(buckets); // empty groups on error (never 500)
  }
});

// ---------- SEARCH (FlightAPI.io) ----------
/**
 * Expects body:
 * { from, to, departureDate, returnDate, passengers, travelClass, tripType }
 * Calls FlightAPI.io roundtrip endpoint.
 */
app.post("/search", async (req, res) => {
  try {
    const {
      from,
      to,
      departureDate,
      returnDate,
      passengers = 1,
      travelClass = "Economy",
      tripType = "round-trip",
    } = req.body || {};

    // Validate required params so we never hit 404 HTML from FlightAPI
    if (!from || !to || !departureDate) {
      return res.status(400).json({ error: "Missing from/to/departureDate" });
    }

    const infants = 0;
    const children = 0;
    const currency = "INR";

    // For one-way, set returnDate equal to departureDate (FlightAPI path requires it)
    const ret = tripType === "one-way" ? departureDate : (returnDate || departureDate);

    const apiKey = process.env.FLIGHTAPI_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing FLIGHTAPI_KEY" });

    // FlightAPI path schema:
    // https://api.flightapi.io/roundtrip/<api-key>/<from>/<to>/<dep>/<ret>/<adults>/<children>/<infants>/<cabin>/<currency>
    const url = `https://api.flightapi.io/roundtrip/${encodeURIComponent(apiKey)}/${encodeURIComponent(from)}/${encodeURIComponent(to)}/${encodeURIComponent(departureDate)}/${encodeURIComponent(ret)}/${encodeURIComponent(String(passengers))}/${encodeURIComponent(String(children))}/${encodeURIComponent(String(infants))}/${encodeURIComponent(travelClass)}/${encodeURIComponent(currency)}`;

    // Helpful log without leaking the key:
    console.log("FlightAPI GET:", url.replace(apiKey, "****KEY****"));

    const resp = await axios.get(url, { timeout: 30000 });

    // Map to simple structure your frontend expects
    const mapped = mapFlightApi(resp.data);
    return res.json(mapped);
  } catch (err) {
    // If FlightAPI returns HTML (404 page), surface a clean error
    const msg = (err.response && typeof err.response.data === "string")
      ? err.response.data.slice(0, 120)
      : err.message;
    console.error("FlightAPI search error:", msg);
    return res.status(500).json({ error: "FlightAPI search failed" });
  }
});

function mapFlightApi(apiJson) {
  // Very defensive; adjust mapping to your exact API response
  const results = apiJson?.data || apiJson?.results || apiJson?.itineraries || [];
  const toCard = (r) => ({
    airline: r.airlineName || r.airline || r.carrier || "Flight",
    flightNumber: r.flightNumber || r.number || "",
    departureTime: r.departureTime || r.departure || "",
    arrivalTime: r.arrivalTime || r.arrival || "",
    price: Number(r.price || r.total || r.amount || 0),
    stops: Number(r.stops ?? 0),
  });

  // If API doesn’t split by direction, just duplicate into outbound & inbound
  const cards = Array.isArray(results) ? results.map(toCard) : [];
  return { outbound: cards, inbound: cards };
}

// ---------- HEALTH ----------
app.get("/", (_req, res) => res.send("SkyDeal backend up"));

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`Server ON ${PORT}`);
});
