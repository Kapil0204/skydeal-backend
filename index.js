import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { MongoClient } from "mongodb";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// -----------------------------
// 1. ENV VARS
// -----------------------------
const MONGO_URI = process.env.MONGO_URI;
const FLIGHTAPI_KEY = process.env.FLIGHTAPI_KEY;

if (!MONGO_URI) console.error("❌ Missing MONGO_URI");
if (!FLIGHTAPI_KEY) console.error("❌ Missing FLIGHTAPI_KEY");

// -----------------------------
// 2. DB CONNECTION
// -----------------------------
let db;
async function connectDB() {
  try {
    const client = new MongoClient(MONGO_URI, {
      useUnifiedTopology: true,
    });
    await client.connect();
    db = client.db("skydeal");
    console.log("✅ Connected to MongoDB (EC2)");
  } catch (err) {
    console.error("❌ MongoDB Connection Error:", err);
  }
}
connectDB();

// -----------------------------
// 3. PAYMENT OPTIONS ENDPOINT
// -----------------------------
app.get("/payment-options", async (req, res) => {
  try {
    const offers = await db.collection("offers").find().toArray();

    const map = {
      CreditCard: new Set(),
      DebitCard: new Set(),
      NetBanking: new Set(),
      Wallet: new Set(),
      EMI: new Set(),
      UPI: new Set(),
    };

    offers.forEach((offer) => {
      (offer.paymentMethods || []).forEach((pm) => {
        const type = pm.type?.trim() || "";
        const bank = pm.bank?.trim() || "";
        if (!type || !bank) return;

        if (type.toLowerCase() === "credit") map.CreditCard.add(bank);
        else if (type.toLowerCase() === "debit") map.DebitCard.add(bank);
        else if (type.toLowerCase() === "netbanking") map.NetBanking.add(bank);
        else if (type.toLowerCase() === "wallet") map.Wallet.add(bank);
        else if (type.toLowerCase() === "upi") map.UPI.add(bank);
        else if (type.toLowerCase() === "emi") map.EMI.add(bank);
      });
    });

    res.json({
      options: {
        CreditCard: [...map.CreditCard],
        DebitCard: [...map.DebitCard],
        EMI: [...map.EMI],
        NetBanking: [...map.NetBanking],
        Wallet: [...map.Wallet],
        UPI: [...map.UPI],
      },
    });
  } catch (err) {
    console.error("❌ payment-options error", err);
    res.status(500).json({ error: "Failed loading payment options" });
  }
});

// -----------------------------
// 4. FLIGHTAPI → Only carrier price
// -----------------------------
const CARRIER_HINTS = {
  "AI": ["airindia"],
  "IX": ["airindiaexpress", "air india express", "aix"],
  "I5": ["aix connect", "airasia india", "airasia"],
  "6E": ["indigo", "goindigo", "interglobe"],
  "UK": ["vistara"],
  "SG": ["spicejet"],
  "QP": ["akasa", "akasaair", "akasa air"],
  "G8": ["goair", "go first", "gofirst"]
};

// best match helper
function normalizeCarrierName(s) {
  if (!s) return "";
  return s.toLowerCase().replace(/[^a-z]/g, "");
}

// -----------------------------
// 5. SEARCH ENDPOINT
// -----------------------------
app.post("/search", async (req, res) => {
  try {
    const {
      from,
      to,
      departureDate,
      returnDate,
      passengers,
      travelClass,
      tripType
    } = req.body;

    if (!from || !to || !departureDate) {
      return res.json({ outboundFlights: [], returnFlights: [] });
    }

    const url =
      `https://api.flightapi.io/roundtrip/${FLIGHTAPI_KEY}/` +
      `${from}/${to}/${departureDate}/${returnDate}/${passengers}/0/0/` +
      `${travelClass.toLowerCase()}/INR`;

    const apiRes = await fetch(url);
    const data = await apiRes.json();

    if (!data.itineraries || data.itineraries.length === 0) {
      return res.json({
        outboundFlights: [],
        returnFlights: [],
        meta: { source: "flightapi", reason: "no-itineraries" }
      });
    }

    const legsMap = {};
    (data.legs || []).forEach((l) => (legsMap[l.id] = l));

    const segmentsMap = {};
    (data.segments || []).forEach((s) => (segmentsMap[s.id] = s));

    const carrierMap = {};
    (data.carriers || []).forEach((c) => (carrierMap[c.id] = c));

    function extractFlights(isReturn = false) {
      const list = [];

      data.itineraries.forEach((it) => {
        const legId = isReturn ? it.legIds[1] : it.legIds[0];
        const leg = legsMap[legId];
        if (!leg) return;

        const seg = segmentsMap[leg.segmentIds[0]];
        if (!seg) return;

        const carrierId = seg.marketingCarrierId;
        const carrierNameRaw = carrierMap[carrierId]?.name || "";
        const carrierCode = carrierMap[carrierId]?.code || "";

        const norm = normalizeCarrierName(carrierNameRaw);

        let match = null;
        if (CARRIER_HINTS[carrierCode]) {
          CARRIER_HINTS[carrierCode].forEach((hint) => {
            if (norm.includes(hint)) match = carrierCode;
          });
        }

        if (!match) match = carrierCode;

        const offersForThisFlight = it.pricingOptions || [];
        let carrierPrice = null;

        offersForThisFlight.forEach((opt) => {
          if (!opt?.agent) return;
          const agentName = opt.agent?.toLowerCase() || "";
          if (
            CARRIER_HINTS[match]?.some((hint) => agentName.includes(hint))
          ) {
            carrierPrice = opt.price?.amount || null;
          }
        });

        if (!carrierPrice) return;

        const portals = [
          { name: "MakeMyTrip", price: carrierPrice + 250 },
          { name: "Goibibo", price: carrierPrice + 250 },
          { name: "EaseMyTrip", price: carrierPrice + 250 },
          { name: "Cleartrip", price: carrierPrice + 250 },
          { name: "Yatra", price: carrierPrice + 250 }
        ];

        list.push({
          flightName: `${carrierCode} ${seg.flightNumber}`,
          carrierCode,
          departure: leg.departure,
          arrival: leg.arrival,
          duration: leg.duration,
          stops: leg.stopCount,
          basePrice: carrierPrice,
          portals
        });
      });

      return list;
    }

    const outboundFlights = extractFlights(false);
    const returnFlights =
      tripType === "round-trip" ? extractFlights(true) : [];

    res.json({
      outboundFlights,
      returnFlights,
      meta: { source: "flightapi", total: outboundFlights.length }
    });
  } catch (err) {
    console.error("❌ Search error:", err);
    res.json({ outboundFlights: [], returnFlights: [], error: "search-failed" });
  }
});

// -----------------------------
// 6. HEALTH CHECK
// -----------------------------
app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// -----------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 SkyDeal backend running on ${PORT}`));
