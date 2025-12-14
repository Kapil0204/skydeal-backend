// index.js (SkyDeal backend) — ESM
import express from "express";
import cors from "cors";
import axios from "axios";
import { MongoClient } from "mongodb";

// ---------- setup ----------
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// ---------- helpers ----------
function toISO(d) {
  if (!d) return "";
  // already yyyy-mm-dd
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  // dd/mm/yyyy -> yyyy-mm-dd
  const m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  // fallback: Date()
  const t = new Date(d);
  if (!isNaN(t)) {
    const mm = String(t.getMonth() + 1).padStart(2, "0");
    const dd = String(t.getDate()).padStart(2, "0");
    return `${t.getFullYear()}-${mm}-${dd}`;
  }
  return "";
}

// build candidate FlightAPI URLs (we try a few formats)
function buildCandidates({ from, to, date, adults = 1, travelClass = "ECONOMY", currency = "INR" }) {
  const key = process.env.FLIGHTAPI_KEY;
  const base = "https://api.flightapi.io";
  const encKey = encodeURIComponent(key);
  const cls = travelClass.toUpperCase(); // ECONOMY | PREMIUM_ECONOMY | BUSINESS | FIRST

  const Q = new URLSearchParams({
    from, to, date, adults: String(adults), travelClass: cls, currency
  }).toString();

  return [
    // path style
    `${base}/oneway/${encKey}/${from}/${to}/${date}/${adults}/${cls}?currency=${currency}`,
    // query apikey
    `${base}/oneway?apikey=${encKey}&${Q}`,
    // query api_key
    `${base}/oneway?api_key=${encKey}&${Q}`,
  ];
}

// Try candidates in sequence; collect debug
async function fetchOneWaySmart(params) {
  const tried = [];
  for (const url of buildCandidates(params)) {
    try {
      const r = await axios.get(url, { timeout: 15000 });
      tried.push({ url, status: r.status });
      return { data: r.data, status: r.status, tried };
    } catch (e) {
      const st = e?.response?.status || 0;
      const body = typeof e?.response?.data === "string"
        ? e.response.data
        : (e?.response?.data ? JSON.stringify(e.response.data) : "");
      tried.push({ url, status: st, body: body?.slice(0, 400) });
    }
  }
  const err = new Error("All FlightAPI variants failed");
  err.tried = tried;
  throw err;
}

// Minimal mapper so frontend gets consistent shape
function mapFlights(raw) {
  // FlightAPI responses vary; keep it defensive
  const items = raw?.data?.flights || raw?.flights || raw?.data || [];
  return (Array.isArray(items) ? items : []).map((f) => ({
    airlineName: f.airlineName || f.airline || f.carrier || "-",
    flightNumber: f.flightNumber || f.number || f.code || "-",
    departureTime: f.departureTime || f.departure || f.dep_time || null,
    arrivalTime: f.arrivalTime || f.arrival || f.arr_time || null,
    stops: typeof f.stops === "number" ? f.stops : (Array.isArray(f.legs) ? Math.max(0, f.legs.length - 1) : 0),
    price: f.price || f.totalPrice || f.amount || 0,
    raw: f,
  }));
}

// ---------- payment options (unchanged) ----------
app.get("/payment-options", async (req, res) => {
  // Keep your existing logic. Here’s a safe static fallback to avoid breaking the modal.
  res.json({
    usedFallback: false,
    options: {
      "Credit Card": ["AU Small Bank","Axis Bank","BOBCARD LTD","HDFC Bank","HSBC","ICICI Bank","IDFC First Bank","Kotak Bank","RBL Bank"],
      "Debit Card": ["AU Small Bank","Central Bank of India","HDFC Bank"],
      "Net Banking": ["ICICI Bank"],
      "UPI": ["Mobikwik","CRED UPI"],
      "Wallet": []
    }
  });
});

// ---------- search ----------
app.post("/search", async (req, res) => {
  const body = req.body || {};
  const meta = { source: "flightapi", outStatus: 0, retStatus: 0, request: {} };

  try {
    let { from, to, departureDate, returnDate, tripType, passengers, travelClass } = body;

    const outDate = toISO(departureDate);
    const retDate = toISO(returnDate);

    const cls = (travelClass || "economy").toLowerCase() === "premium economy"
      ? "PREMIUM_ECONOMY"
      : (travelClass || "economy").toUpperCase();

    const adults = Number(passengers) || 1;
    const currency = "INR";

    // Outbound
    const outRes = await fetchOneWaySmart({ from, to, date: outDate, adults, travelClass: cls, currency });
    meta.outStatus = outRes.status;

    // Return (if round-trip)
    let retFlights = [];
    if (tripType === "round-trip" && retDate) {
      const retRes = await fetchOneWaySmart({ from: to, to: from, date: retDate, adults, travelClass: cls, currency });
      meta.retStatus = retRes.status;
      retFlights = mapFlights(retRes.data);
      meta.request.retTried = retRes.tried;
    }

    const outFlights = mapFlights(outRes.data);
    meta.request.outTried = outRes.tried;

    return res.json({ meta, outboundFlights: outFlights, returnFlights: retFlights });
  } catch (e) {
    // structured error
    const st = e?.response?.status || 500;
    const bodyStr = typeof e?.response?.data === "string"
      ? e.response.data
      : (e?.response?.data ? JSON.stringify(e.response.data) : "");
    meta.error = e.message || "Search failed";
    meta.outStatus ||= st;
    meta.request.errorBody = bodyStr?.slice(0, 600);
    return res.json({ meta, outboundFlights: [], returnFlights: [] });
  }
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`SkyDeal backend listening on ${PORT}`);
});
