// index.js — SkyDeal backend (Express, ESM)
// RUN: node index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// ---- CORS (declare ONCE) ----
app.use(cors({
  origin: '*', // keep simple for now; Vercel + Render are fine
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));
app.use(express.json());

// ---- constants ----
const CURRENCY = "INR";
const REGION   = "IN"; // used by FlightAPI if enabled
const MARKUP   = 100;  // ₹ per-OTA markup

// ---- helpers ----
function money(n) { return Math.max(0, Math.round(Number(n || 0))); }
function todayISO() { return new Date().toISOString().slice(0, 10); }

// ---- Payment options (static, kept as-is) ----
const PAYMENT_DB = {
  "Credit Card": [
    "HDFC Bank", "ICICI Bank", "Axis Bank", "Kotak Bank",
    "Yes Bank", "RBL Bank", "Federal Bank", "HSBC Bank", "IDFC First Bank"
  ],
  "Debit Card":  ["HDFC Bank", "ICICI Bank", "Axis Bank", "Kotak Bank", "IDFC First Bank", "Federal Bank"],
  "Net Banking": ["HDFC Bank", "ICICI Bank", "Axis Bank", "SBI"],
  "UPI":         ["Any UPI"],
  "Wallet":      ["Paytm", "PhonePe", "Amazon Pay"],
  "EMI":         ["HDFC Bank", "Axis Bank", "RBL Bank", "Yes Bank", "Federal Bank"]
};

// simple normalized map for quick matching
const norm = s => String(s||"").toLowerCase().replace(/\s+/g,"").replace(/bank$/,"");
const PAYMENT_SET = Object.fromEntries(
  Object.entries(PAYMENT_DB).map(([k, arr]) => [k, new Set(arr.map(norm))])
);

// ---- Offers (example real logic retained) ----
// * flat or percent; min txn; by portal; by payment method
const OFFERS = [
  // percent discount examples
  { portal:"MakeMyTrip", label:"10% off on ICICI", type:"percent", value:10, min:3000, code:"SKYICICI10", applyTo:"Credit Card", banks:["ICICI Bank"] },
  { portal:"Goibibo",    label:"12% off on HDFC",  type:"percent", value:12, min:3000, code:"SKYHDFC12",  applyTo:"Credit Card", banks:["HDFC Bank"] },
  { portal:"EaseMyTrip", label:"15% off on Axis",  type:"percent", value:15, min:3000, code:"SKYAXIS15",  applyTo:"Credit Card", banks:["Axis Bank"] },
  // flat discount examples
  { portal:"Yatra",      label:"₹400 off via UPI", type:"flat",    value:400, min:2500, code:"SKYUPI400",  applyTo:"UPI",         banks:["Any UPI"] },
  { portal:"Cleartrip",  label:"₹600 HDFC EMI",    type:"flat",    value:600, min:4000, code:"SKYEMIHDFC", applyTo:"EMI",         banks:["HDFC Bank"] },
];

// OTA list
const OTAS = ["MakeMyTrip", "Goibibo", "EaseMyTrip", "Yatra", "Cleartrip"];

// build default portal prices (carrier base + markup)
function buildDefaultPortalPrices(base) {
  return OTAS.map(p => ({
    portal: p,
    basePrice: base,
    finalPrice: base + MARKUP,
    source: "carrier+markup"
  }));
}

function bestDealFrom(portals) {
  let best = portals[0];
  for (const p of portals) if (p.finalPrice < best.finalPrice) best = p;
  return {
    portal: best.portal,
    finalPrice: best.finalPrice,
    note: best._why || "Best price after applicable offers (if any)"
  };
}

function applyOffersToPortals(base, selectedPayments, debugBag) {
  const portals = buildDefaultPortalPrices(base);
  const sel = (Array.isArray(selectedPayments) ? selectedPayments : []).map(norm);
  const selSet = new Set(sel);

  const applied = [];

  for (const p of portals) {
    // find an offer matching: same portal + a selected payment method category + bank
    const candidate = OFFERS.find(ofr => {
      if (ofr.portal !== p.portal) return false;
      // category must be selected (e.g., "Credit Card", "UPI")
      const catNorm = norm(ofr.applyTo);
      if (!selSet.has(catNorm)) return false;

      // if user selected a bank (e.g., "HDFC Bank"), we treat presence of the bank in selected list as OK.
      // We allow "Any UPI" as wildcard for UPI.
      const banksNorm = (ofr.banks || []).map(norm);
      // if user passed *banks* (like "HDFC Bank") in the selection array, match those too
      // selection may include categories + bank names; we match if ANY bank in offer exists in selection
      const bankMatched = banksNorm.some(b => selSet.has(b)) || banksNorm.includes("anyupi");
      return bankMatched;
    });

    if (candidate) {
      let discount = 0;
      if (candidate.type === "percent") discount = Math.round((candidate.value/100) * base);
      else discount = candidate.value;

      if (base >= candidate.min) {
        const newPrice = Math.max(0, base + MARKUP - discount);
        p.finalPrice = newPrice;
        p.source = "carrier+offer+markup";
        p._why = `${candidate.label} (code ${candidate.code})`;

        applied.push({
          portal: p.portal,
          why: p._why,
          value: discount
        });
      }
    }
  }

  if (debugBag) debugBag.applied = applied;
  return { portalPrices: portals, bestDeal: bestDealFrom(portals) };
}

// ---- External flight search (optional; falls back if fails) ----
async function fetchFlightsReal({ from, to, departureDate, returnDate, adults = 1, cabin = "economy" }) {
  // Try FlightAPI first if key is present, otherwise skip to fallback
  const KEY = process.env.FLIGHTAPI_KEY;
  if (!KEY) throw new Error("FLIGHTAPI_KEY missing");

  const url = `https://api.flightapi.io/roundtrip/${KEY}/${from}/${to}/${departureDate}/${returnDate}/${adults}/0/0/${cabin}/${CURRENCY}?region=${REGION}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);

  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    const status = resp.status;
    let json = null;
    try { json = await resp.json(); } catch {}
    if (status !== 200 || !json) throw new Error(`flightapi non-200 (${status})`);
    // Map to simple list: take a handful of itineraries
    const items = (json.itineraries || []).slice(0, 6).map((it, i) => ({
      id: `F${i+1}`,
      airlineName: (json.carriers?.[0]?.name) || "Air India",
      flightNumber: it?.id || `AI${1000+i}`,
      departure: "22:45",
      arrival: "01:10",
      basePrice: money(it?.price || 5600),
      stops: 0
    }));
    return { items, meta: { outStatus: status, used: "flightapi" } };
  } finally {
    clearTimeout(t);
  }
}

// simple deterministic fallback so app always works
function fallbackFlights() {
  const base = [6225, 5650, 9800, 10419, 11627];
  const names = [
    { airlineName:"Air India",  flightNumber:"AI 1201" },
    { airlineName:"IndiGo",     flightNumber:"6E 5123" },
    { airlineName:"SpiceJet",   flightNumber:"SG 402"  },
    { airlineName:"Air India",  flightNumber:"AI 1405" },
    { airlineName:"BatikAir",   flightNumber:"ID 181"  }
  ];
  const mk = (i) => ({
    id: `S${i+1}`,
    ...names[i % names.length],
    departure: ["09:00","10:55","12:15","15:35","22:45"][i%5],
    arrival:   ["11:20","13:15","14:40","18:10","01:10"][i%5],
    basePrice: base[i % base.length],
    stops: (i % 3 === 0) ? 0 : 1
  });
  const items = Array.from({length:6}, (_,i)=>mk(i));
  return { items, meta:{ outStatus: 200, used: "fallback" } };
}

// ---- ROUTES ----

// Payment methods
app.get("/payment-options", (req, res) => {
  const options = {
    "Credit Card": PAYMENT_DB["Credit Card"],
    "Debit Card": PAYMENT_DB["Debit Card"],
    "Net Banking": PAYMENT_DB["Net Banking"],
    "UPI":         PAYMENT_DB["UPI"],
    "Wallet":      PAYMENT_DB["Wallet"],
    "EMI":         PAYMENT_DB["EMI"],
  };
  res.json({ usedFallback:false, options });
});

// Search
app.post("/search", async (req, res) => {
  const {
    from = "BOM",
    to   = "DEL",
    departureDate = todayISO(),
    returnDate    = "",
    tripType = "one-way",
    passengers = 1,
    travelClass = "economy",
    paymentMethods = []
  } = req.body || {};

  console.log("[SkyDeal] search request:", {
    from, to, departureDate, returnDate, passengers, travelClass, tripType, paymentMethods
  });

  // real -> fallback
  let real;
  try {
    real = await fetchFlightsReal({
      from, to, departureDate,
      returnDate: (tripType === "round-trip" ? (returnDate || departureDate) : departureDate),
      adults: passengers,
      cabin: travelClass
    });
  } catch (e) {
    console.warn("Real flight search failed -> using fallback:", e.message);
  }
  const data = real || fallbackFlights();

  const debug = { checked: 0, applied: [] };
  const decorate = (f) => {
    const base = money(f.basePrice);
    const { portalPrices, bestDeal } = applyOffersToPortals(base, paymentMethods, debug);
    return { ...f, portalPrices, bestDeal };
  };

  const outboundFlights = data.items.map(decorate);
  const returnFlights   = (tripType === "round-trip") ? data.items.map(decorate) : [];

  return res.json({
    meta: {
      source: data.meta.used,
      outStatus: data.meta.outStatus,
      outCount: outboundFlights.length,
      retCount: returnFlights.length,
      offerDebug: debug
    },
    outboundFlights,
    returnFlights
  });
});

app.get("/", (_req, res) => res.send("SkyDeal backend OK"));

app.listen(PORT, () => {
  console.log(`SkyDeal backend listening on ${PORT}`);
});
