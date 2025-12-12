// index.js — SkyDeal backend (Express + Mongo) — REAL offers + FlightAPI
// Node 18+ (global fetch). RUN: node index.js

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// ---- CORS ----
app.use(cors({ origin: '*', methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type"] }));
app.use(express.json());

// ---- ENV ----
const FLIGHTAPI_KEY = process.env.FLIGHTAPI_KEY;
const MONGO_URI     = process.env.MONGO_URI || process.env.MONGODB_URI;   // support both
const MONGO_DB      = process.env.MONGODB_DB || process.env.MONGO_DB || "skydeal";
const MONGO_COL     = process.env.MONGO_COL || process.env.MONGODB_COL || "offers";

// ---- CONST ----
const CURRENCY = "INR";
const REGION   = "IN";
const MARKUP   = 100; // +₹100 per OTA as per milestone

const OTAS = ["MakeMyTrip","Goibibo","EaseMyTrip","Yatra","Cleartrip"];

// ---- MONGO ----
let client, col;
async function ensureMongo() {
  if (!MONGO_URI) throw new Error("MONGO_URI missing");
  if (col) return col;
  client = new MongoClient(MONGO_URI, { maxPoolSize: 5 });
  await client.connect();
  col = client.db(MONGO_DB).collection(MONGO_COL);
  return col;
}

// ---- Utils ----
const money = n => Math.max(0, Math.round(Number(n||0)));
const norm  = s => String(s||"").trim().toLowerCase();

// normalize payment method objects found in documents to {type, bank}
function extractPaymentsFromDoc(doc) {
  // supports:
  // - doc.paymentMethods[] -> { type, bank, ... }
  // - doc.parsedFields.paymentMethods[] -> { type, bank, ... }
  // - also tolerate fields like { category/type: "Credit Card", bankName/bank: "HDFC Bank" }
  const buckets = [];
  const paths = [
    doc?.paymentMethods,
    doc?.parsedFields?.paymentMethods,
    doc?.rawFields?.paymentMethods
  ].filter(Boolean);

  for (const arr of paths) {
    if (!Array.isArray(arr)) continue;
    for (const pm of arr) {
      const type = pm?.type || pm?.category || pm?.method || "";
      const bank = pm?.bank || pm?.bankName || pm?.issuer || "";
      if (!type || !bank) continue;
      buckets.push({ type, bank });
    }
  }

  // Also tolerate simple hints:
  // doc.paymentType / doc.bank
  if (doc?.paymentType && doc?.bank) {
    buckets.push({ type: doc.paymentType, bank: doc.bank });
  }
  return buckets;
}

// Map any variant to our 5 top-level categories
function mapTypeToCategory(t) {
  const s = norm(t);
  if (s.includes("credit")) return "Credit Card";
  if (s.includes("debit"))  return "Debit Card";
  if (s.includes("net") || s.includes("internet")) return "Net Banking";
  if (s.includes("upi"))    return "UPI";
  if (s.includes("wallet")) return "Wallet";
  // put unknowns into sensible buckets
  if (s.includes("emi")) return "Credit Card";
  return null;
}

// Offer normalization: return a uniform {portal, type, value, kind, min, label, code, banks[], topCategory}
function normalizeOffer(doc) {
  // portal
  const portal =
    doc?.portal ||
    doc?.sourcePortal ||
    doc?.parsedFields?.portal ||
    "";

  // discount
  let kind = null;      // 'percent' | 'flat'
  let value = 0;
  let label = "";
  let code = "";
  let min = 0;

  // raw/parsed fields we’ve used before
  const pf = doc?.parsedFields || {};
  const rf = doc?.rawFields || {};

  // percent
  const pct =
    pf.discountPercent ??
    doc?.discountPercent ??
    rf.discountPercent;
  if (typeof pct === "number" && pct > 0) {
    kind = "percent";
    value = pct;
  }

  // flat
  const flat =
    pf.maxDiscountAmount ??
    doc?.maxDiscountAmount ??
    pf.flatAmount ??
    doc?.flatAmount ??
    rf.maxDiscountAmount;
  if (!kind && typeof flat === "number" && flat > 0) {
    kind = "flat";
    value = flat;
  }

  // fallback: sometimes only rawDiscount like "10% off" or "₹600 off"
  const rawDiscount = pf.rawDiscount || doc?.rawDiscount || rf?.rawDiscount || "";
  if (!kind && typeof rawDiscount === "string") {
    const mPct = rawDiscount.match(/(\d+)\s*%/);
    const mFlat = rawDiscount.match(/₹\s*([\d,]+)/);
    if (mPct) { kind = "percent"; value = Number(mPct[1]); }
    else if (mFlat) { kind = "flat"; value = Number(mFlat[1].replace(/,/g,"")); }
  }

  // min transaction
  min =
    pf.minTransactionValue ??
    doc?.minTransactionValue ??
    pf.minAmount ??
    doc?.minAmount ??
    0;

  // code
  code = pf.couponCode || doc?.couponCode || rf?.couponCode || "";

  // label
  label = pf.title || doc?.title || rf?.title || "";
  if (!label) {
    label = (kind === "percent")
      ? `${value}% off`
      : (kind === "flat" && value) ? `₹${value} off` : "Offer";
  }

  // payment methods
  const payments = extractPaymentsFromDoc(doc);
  const banks = payments.map(p => p.bank).filter(Boolean);
  // pick a top-level category if available
  const topCategory = mapTypeToCategory(payments[0]?.type || "");

  return { portal, kind, value, min: Number(min||0), label, code, banks, topCategory };
}

// Build 5-category -> banks[] map from Mongo documents
async function loadPaymentCatalog() {
  const c = await ensureMongo();

  // only “active” offers (if the flag exists); otherwise take all
  const query = { };
  // tolerate common flags
  query.$and = [
    { $or: [
      { isExpired: { $exists: false } },
      { isExpired: false }
    ] }
  ];

  const cursor = c.find(query, { projection: { paymentMethods: 1, parsedFields: 1, rawFields: 1 } });
  const cat = {
    "Credit Card": new Set(),
    "Debit Card":  new Set(),
    "Net Banking": new Set(),
    "UPI":         new Set(),
    "Wallet":      new Set()
  };

  for await (const doc of cursor) {
    const pms = extractPaymentsFromDoc(doc);
    for (const pm of pms) {
      const catName = mapTypeToCategory(pm.type);
      if (!catName || !pm.bank) continue;
      cat[catName].add(pm.bank.trim());
    }
  }

  // Convert sets → sorted arrays
  const out = {};
  for (const [k, v] of Object.entries(cat)) {
    const arr = Array.from(v);
    arr.sort((a,b)=>a.localeCompare(b));
    out[k] = arr;
  }
  return out;
}

// Apply offers from Mongo to a base fare for each OTA
async function applyMongoOffers(baseAmount, selectedBanks = []) {
  const c = await ensureMongo();

  // Normalize user selection
  const wantedBanks = new Set((selectedBanks || []).map(b => norm(b)));

  // Load candidate offers (we could filter more, but keep it simple + robust)
  const cursor = c.find(
    { $or: [{ isExpired: { $exists: false } }, { isExpired: false }] },
    { projection: { portal:1, parsedFields:1, rawFields:1, paymentMethods:1, title:1, minAmount:1, minTransactionValue:1, discountPercent:1, flatAmount:1, maxDiscountAmount:1, couponCode:1 } }
  );

  // Organize by portal
  const portalRows = OTAS.map(p => ({
    portal: p,
    basePrice: baseAmount,
    finalPrice: baseAmount + MARKUP,
    source: "carrier+markup",
    _why: "No eligible offer"
  }));

  for await (const doc of cursor) {
    const off = normalizeOffer(doc);
    if (!off.portal || !OTAS.includes(off.portal)) continue;
    if (!off.kind || !off.value) continue;

    // If user picked specific banks, require a bank overlap; if none picked, allow all
    if (wantedBanks.size) {
      const banksNorm = (off.banks || []).map(b => norm(b));
      const overlaps = banksNorm.some(b => wantedBanks.has(b)) || banksNorm.includes("any") || banksNorm.includes("anyupi");
      if (!overlaps) continue;
    }

    // compute discount
    const discount = (off.kind === "percent")
      ? Math.round((off.value/100) * baseAmount)
      : Math.round(off.value);

    // enforce minimum amount if present
    if (off.min && baseAmount < off.min) continue;

    // apply if better than current for that portal
    const row = portalRows.find(r => r.portal === off.portal);
    if (!row) continue;
    const candidatePrice = Math.max(0, baseAmount + MARKUP - discount);
    if (candidatePrice < row.finalPrice) {
      row.finalPrice = candidatePrice;
      row.source = "carrier+offer+markup";
      row._why = `${off.label}${off.code ? ` (code ${off.code})` : ""}`;
    }
  }

  // choose best
  let best = portalRows[0];
  for (const r of portalRows) if (r.finalPrice < best.finalPrice) best = r;

  return {
    portalPrices: portalRows,
    bestDeal: {
      portal: best.portal,
      finalPrice: best.finalPrice,
      note: best._why || "Best price after applicable offers"
    }
  };
}

// ---- FlightAPI (roundtrip endpoint used for both) ----
async function fetchFlightsReal({ from, to, departureDate, returnDate, adults=1, cabin="economy" }) {
  if (!FLIGHTAPI_KEY) throw new Error("FLIGHTAPI_KEY missing");
  const url = `https://api.flightapi.io/roundtrip/${FLIGHTAPI_KEY}/${from}/${to}/${departureDate}/${returnDate || departureDate}/${adults}/0/0/${cabin}/${CURRENCY}?region=${REGION}`;
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), 25000);

  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    const status = resp.status;
    const json = await resp.json();
    if (status !== 200 || !json?.itineraries?.length) {
      throw new Error(`flightapi ${status}`);
    }

    // maps: carriers, segments, legs may vary; do safe mapping
    const items = [];
    const itins = json.itineraries.slice(0, 50); // take more, we’ll slice per-direction to 25
    for (let i=0;i<itins.length;i++) {
      const it = itins[i];
      const price = it?.price ?? it?.pricing_options?.[0]?.price?.amount ?? 0;
      const flightNo = it?.id || it?.code || `F${i+1}`;
      const airlineName = json?.carriers?.[0]?.name || "Airline";
      const departure = "00:00"; // if you have segment times in your plan, map them here
      const arrival   = "00:00";
      items.push({
        id: String(flightNo),
        airlineName,
        flightNumber: String(flightNo),
        departure,
        arrival,
        basePrice: money(price),
        stops: 0
      });
    }
    return { items, meta: { outStatus: status, used: "flightapi" } };
  } finally {
    clearTimeout(t);
  }
}

// tiny flight fallback so UX doesn’t blank out if FlightAPI hiccups
function fallbackFlights() {
  const base = [13046, 13143, 13280, 13420, 13510, 13990, 14110, 14240, 14480, 14560];
  const names = ["Air India", "IndiGo", "Vistara", "SpiceJet", "Akasa Air"];
  const out = Array.from({length:25}, (_,i)=>({
    id:`S${i+1}`,
    airlineName: names[i % names.length],
    flightNumber: `F${1000+i}`,
    departure: "00:00",
    arrival: "00:00",
    basePrice: base[i % base.length],
    stops: 0
  }));
  return { items: out, meta:{ outStatus: 200, used: "fallback" } };
}

// ---- ROUTES ----

// payment methods: 5 categories -> banks[] (deduped)
app.get("/payment-options", async (_req, res) => {
  try {
    const cat = await loadPaymentCatalog();
    res.json({ usedFallback: false, options: cat });
  } catch (e) {
    console.error("[/payment-options] error:", e.message);
    // fail softly with empty lists so UI stays stable
    res.status(200).json({
      usedFallback: true,
      options: {
        "Credit Card": [],
        "Debit Card": [],
        "Net Banking": [],
        "UPI": [],
        "Wallet": []
      }
    });
  }
});

app.post("/search", async (req, res) => {
  const {
    from="BOM", to="DEL",
    departureDate, returnDate,
    tripType="one-way",
    passengers=1,
    travelClass="economy",
    paymentMethods=[]
  } = req.body || {};

  console.log("[SkyDeal] search", { from, to, departureDate, returnDate, passengers, travelClass, tripType,
    paymentTypesCount: paymentMethods.length });

  let data;
  try {
    data = await fetchFlightsReal({
      from, to,
      departureDate,
      returnDate: tripType === "round-trip" ? (returnDate || departureDate) : departureDate,
      adults: passengers,
      cabin: travelClass
    });
  } catch {
    data = fallbackFlights();
  }

  // Sort by ascending base price then slice to 25 for each list
  const sorted = [...data.items].sort((a,b)=>a.basePrice-b.basePrice);
  const out25  = sorted.slice(0,25);
  const ret25  = (tripType === "round-trip") ? sorted.slice(0,25) : [];

  // apply offers per flight
  const decorate = async (f) => {
    const { portalPrices, bestDeal } = await applyMongoOffers(money(f.basePrice), paymentMethods);
    return { ...f, portalPrices, bestDeal };
  };

  const outboundFlights = await Promise.all(out25.map(decorate));
  const returnFlights   = await Promise.all(ret25.map(decorate));

  res.json({
    meta: {
      source: data.meta.used,
      outStatus: data.meta.outStatus,
      outCount: outboundFlights.length,
      retCount: returnFlights.length,
      offerDebug: {} // can populate if needed
    },
    outboundFlights,
    returnFlights
  });
});

app.get("/", (_req,res)=>res.send("SkyDeal backend OK"));
app.listen(PORT, ()=>console.log(`SkyDeal backend listening on ${PORT}`));
