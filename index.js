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

// Minimal offer schema (works with your GPT-parsed docs)
const OfferSchema = new mongoose.Schema(
  {
    paymentMethods: [
      {
        type: { type: String }, // "creditCard" | "debitCard" | "wallet" | "upi" | "netBanking" | "emi"
        name: String
      }
    ]
  },
  { strict: false, timestamps: false, collection: "offers" }
);
const Offer = mongoose.models.Offer || mongoose.model("Offer", OfferSchema);

// ---------- PAYMENT METHODS ----------
app.get("/api/payment-methods", async (_req, res) => {
  const buckets = {
    creditCard: [],
    debitCard: [],
    wallet: [],
    upi: [],
    netBanking: [],
    emi: []
  };

  try {
    if (!mongoReady) {
      console.log("payment-methods: mongo not ready -> sending empty buckets");
      return res.json(buckets);
    }

    // Group distinct paymentMethods by {type, name}
    const docs = await Offer.aggregate([
      { $unwind: "$paymentMethods" },
      {
        $group: {
          _id: {
            type: "$paymentMethods.type",
            name: "$paymentMethods.name"
          }
        }
      }
    ]);

    for (const row of docs) {
      const type = row?._id?.type;
      const name = row?._id?.name;
      if (!type || !name) continue;
      if (!buckets[type]) buckets[type] = [];
      if (!buckets[type].includes(name)) buckets[type].push(name);
    }

    console.log(
      `payment-methods: cc=${buckets.creditCard.length}, dc=${buckets.debitCard.length}, wallet=${buckets.wallet.length}, upi=${buckets.upi.length}, nb=${buckets.netBanking.length}, emi=${buckets.emi.length}`
    );

    return res.json(buckets);
  } catch (err) {
    console.error("payment-methods error:", err.message);
    return res.json(buckets); // never 500 for this; return empty groups
  }
});

// ---------- SEARCH (FlightAPI.io) ----------
app.post("/search", async (req, res) => {
  try {
    const {
      from,
      to,
      departureDate,
      returnDate,
      passengers = 1,
      travelClass = "Economy",
      tripType = "round-trip"
    } = req.body || {};

    if (!from || !to || !departureDate) {
      return res.status(400).json({ error: "Missing from/to/departureDate" });
    }

    const infants = 0;
    const children = 0;
    const currency = "INR";

    // FlightAPI path requires a return date even for one-way. Reuse dep date.
    const ret = tripType === "one-way" ? departureDate : (returnDate || departureDate);

    const apiKey = process.env.FLIGHTAPI_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing FLIGHTAPI_KEY" });

    // https://api.flightapi.io/roundtrip/<key>/<from>/<to>/<dep>/<ret>/<adults>/<children>/<infants>/<cabin>/<currency>
    const url = `https://api.flightapi.io/roundtrip/${encodeURIComponent(apiKey)}/${encodeURIComponent(from)}/${encodeURIComponent(to)}/${encodeURIComponent(departureDate)}/${encodeURIComponent(ret)}/${encodeURIComponent(String(passengers))}/${encodeURIComponent(String(children))}/${encodeURIComponent(String(infants))}/${encodeURIComponent(travelClass)}/${encodeURIComponent(currency)}`;

    console.log("FlightAPI GET:", url.replace(apiKey, "****KEY****"));

    const resp = await axios.get(url, { timeout: 30000 });

    const mapped = mapFlightApi(resp.data);
    return res.json(mapped);
  } catch (err) {
    const msg =
      err.response && typeof err.response.data === "string"
        ? err.response.data.slice(0, 150)
        : err.message;
    console.error("FlightAPI search error:", msg);
    return res.status(500).json({ error: "FlightAPI search failed" });
  }
});

function mapFlightApi(apiJson) {
  // Defensive mapping – adjust when you lock the schema
  const results = apiJson?.data || apiJson?.results || apiJson?.itineraries || [];
  const toCard = (r) => ({
    airline: r.airlineName || r.airline || r.carrier || "Flight",
    flightNumber: r.flightNumber || r.number || "",
    departureTime: r.departureTime || r.departure || "",
    arrivalTime: r.arrivalTime || r.arrival || "",
    price: Number(r.price || r.total || r.amount || 0),
    stops: Number(r.stops ?? 0)
  });
  const cards = Array.isArray(results) ? results.map(toCard) : [];
  return { outbound: cards, inbound: cards };
}

// ---------- HEALTH ----------
app.get("/", (_req, res) => res.send("SkyDeal backend up"));

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`Server ON ${PORT}`);
});
