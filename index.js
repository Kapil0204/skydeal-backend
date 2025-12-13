// index.js (SkyDeal backend) — FULL FILE
import express from "express";
import cors from "cors";
import axios from "axios";
import { MongoClient } from "mongodb";

const app = express();
app.use(cors({ origin: "*"}));
app.use(express.json());

/* ====== ENV ====== */
const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI; // support either key
const MONGODB_DB = process.env.MONGODB_DB || "skydeal";
const MONGO_COL  = process.env.MONGO_COL  || "offers";

/* ====== MONGO ====== */
let _mongo = { client: null, col: null };

async function ensureMongo() {
  if (_mongo.col) return _mongo;
  if (!MONGO_URI) throw new Error("MONGO_URI missing");
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db  = client.db(MONGODB_DB);
  const col = db.collection(MONGO_COL);
  _mongo = { client, col };
  return _mongo;
}

/* ====== NORMALIZERS ====== */
function cleanBankName(name = "") {
  let s = String(name || "").trim();
  if (!s) return "";
  s = s.replace(/\b(bank|ltd|limited)\b\.?/gi, "").trim();
  s = s.replace(/\s+/g, " ");
  return s
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

const PORTAL_SYNONYMS = [
  { match: /make\s*my\s*trip|mmt/i, canonical: "MakeMyTrip" },
  { match: /go\s*ibibo|goibibo/i, canonical: "Goibibo" },
  { match: /ease\s*my\s*trip/i, canonical: "EaseMyTrip" },
  { match: /yatra/i, canonical: "Yatra" },
  { match: /clear\s*trip/i, canonical: "Cleartrip" },
];

function mapPortalName(s = "") {
  for (const p of PORTAL_SYNONYMS) if (p.match.test(s || "")) return p.canonical;
  return "";
}

/* ====== LOAD PAYMENT CATALOG (5 categories, dedup) ====== */
let _catalogCache = null;
async function loadPaymentCatalog() {
  if (_catalogCache) return _catalogCache;

  const { col } = await ensureMongo();
  // only non-expired (or missing flag)
  const cur = col.find({
    $or: [{ isExpired: { $exists: false } }, { isExpired: false }],
  });

  const cat = {
    "Credit Card": new Set(),
    "Debit Card": new Set(),
    "Net Banking": new Set(),
    "UPI": new Set(),
    "Wallet": new Set(),
  };

  const pushBank = (type, bank) => {
    const b = cleanBankName(bank);
    if (!b) return;
    switch (String(type || "").toLowerCase()) {
      case "credit card":
      case "credit_card":
      case "credit":
        cat["Credit Card"].add(b);
        break;
      case "debit card":
      case "debit_card":
      case "debit":
        cat["Debit Card"].add(b);
        break;
      case "internet banking":
      case "net_banking":
      case "net banking":
      case "netbanking":
      case "internet":
        cat["Net Banking"].add(b);
        break;
      case "upi":
        cat["UPI"].add(b || "Any");
        break;
      case "wallet":
        cat["Wallet"].add(b || "Any");
        break;
      default:
        // try to guess from raw text
        if (/credit/i.test(type)) cat["Credit Card"].add(b);
        else if (/debit/i.test(type)) cat["Debit Card"].add(b);
        else if (/net|internet/i.test(type)) cat["Net Banking"].add(b);
        else if (/upi/i.test(type)) cat["UPI"].add(b || "Any");
        else if (/wallet/i.test(type)) cat["Wallet"].add(b || "Any");
        break;
    }
  };

  // scan both parsedFields.paymentMethods and paymentMethods
  for await (const doc of cur) {
    const a = doc?.parsedFields?.paymentMethods || [];
    for (const pm of a) pushBank(pm.type, pm.bank);

    const b = doc?.paymentMethods || [];
    for (const pm of b) pushBank(pm.type, pm.bank);
  }

  _catalogCache = {
    usedFallback: false,
    options: Object.fromEntries(
      Object.entries(cat).map(([k, set]) => [k, Array.from(set).sort()])
    ),
  };
  return _catalogCache;
}

/* ====== OFFER APPLICATION ====== */
const OTAS = ["MakeMyTrip", "Goibibo", "EaseMyTrip", "Yatra", "Cleartrip"];

function computeDiscount(price, off) {
  const pct = Number(off.discountPercent || 0) || 0;
  const cap = Number(off.maxDiscountAmount || 0) || 0;
  const flat = Number(off.flatAmount || 0) || 0;

  let d = 0;
  if (pct > 0) d = (price * pct) / 100;
  if (flat > 0) d = d + flat; // if both exist, allow both; adjust if needed

  if (cap > 0 && d > cap) d = cap;
  d = Math.max(0, Math.floor(d));

  return d;
}

function normalizeOffer(doc) {
  const o = {
    portal: mapPortalName(doc.portal || ""),
    discountPercent: doc.discountPercent ?? doc.parsedFields?.discountPercent ?? null,
    maxDiscountAmount: doc.maxDiscountAmount ?? doc.parsedFields?.maxDiscountAmount ?? null,
    flatAmount: doc.flatAmount ?? doc.parsedFields?.flatAmount ?? null,
    minTransactionValue: doc.minTransactionValue ?? doc.parsedFields?.minTransactionValue ?? null,
    banks: [],
    title: doc.title || "",
    raw: doc,
  };

  const pm = [
    ...(doc.paymentMethods || []),
    ...(doc.parsedFields?.paymentMethods || []),
  ];
  for (const p of pm) {
    const bank = cleanBankName(p.bank || "");
    if (bank) o.banks.push(bank);
    else if (/any|all/i.test(p.bank || p.raw || "")) o.banks.push("Any");
  }

  // If portal missing in DB, treat as "ANY portal" for now
  if (!o.portal) o.portal = "ANY";

  return o;
}

async function applyMongoOffers(basePrice, selectedBanks, forPortal /* canonical or one of OTAS */) {
  const { col } = await ensureMongo();

  const wanted = new Set((selectedBanks || []).map(cleanBankName));

  const docs = await col
    .find({ $or: [{ isExpired: { $exists: false } }, { isExpired: false }] })
    .limit(2000)
    .toArray();

  let best = null;

  for (const doc of docs) {
    const off = normalizeOffer(doc);

    // PORTAL FILTER:
    // - If offer portal is canonical OTA, require match.
    // - If offer portal is "ANY", allow it for all OTAs.
    if (off.portal !== "ANY" && forPortal && off.portal !== forPortal) continue;

    // BANK FILTER (if user selected any)
    if (wanted.size) {
      const banksClean = (off.banks || []).map(cleanBankName);
      const ok =
        banksClean.some((b) => wanted.has(b)) ||
        banksClean.map((x) => x.toLowerCase()).includes("any");
      if (!ok) continue;
    }

    // MIN TXN FILTER
    const min = Number(off.minTransactionValue || 0) || 0;
    if (min > 0 && basePrice < min) continue;

    const discount = computeDiscount(basePrice, off);
    if (discount <= 0) continue;

    const finalPrice = Math.max(0, basePrice - discount);
    if (!best || finalPrice < best.finalPrice) {
      best = {
        portal: forPortal || "Unknown",
        sourceOfferTitle: off.title || "Offer",
        discount,
        finalPrice,
      };
    }
  }

  if (!best) return { portal: forPortal || "Unknown", finalPrice: basePrice, note: "No eligible offer" };
  return best;
}

/* ====== PAYMENT OPTIONS ENDPOINT ====== */
app.get("/payment-options", async (req, res) => {
  try {
    const out = await loadPaymentCatalog();
    res.json(out);
  } catch (e) {
    console.error("[/payment-options] error:", e.message);
    res.status(500).json({ usedFallback: true, options: {
      "Credit Card": [],
      "Debit Card": [],
      "Net Banking": [],
      "UPI": [],
      "Wallet": [],
    }});
  }
});

/* ====== FLIGHT SEARCH BLOCK ======
   IMPORTANT: Keep your working FlightAPI.io code here. 
   Return { outbound: [...], returns: [...] } with each item at least:
   {
     id, airlineName, depTime, arrTime, price, stops, portalBasePrices?: {
       MakeMyTrip, Goibibo, EaseMyTrip, Yatra, Cleartrip
     }
   }

   If you already have a working function, paste it here and call it from /search.
*/
async function searchFlightsFlightAPI(payload) {
  // 🔴 REPLACE THIS WITH YOUR CURRENT WORKING FLIGHTAPI.IO CALL
  // For continuity, we’ll return an empty list if not replaced.
  return { outbound: [], returns: [] };
}

/* ====== /search ====== */
app.post("/search", async (req, res) => {
  const t0 = Date.now();
  try {
    const {
      from, to, departureDate, returnDate,
      tripType, passengers, travelClass,
      paymentMethods = []
    } = req.body || {};

    // 1) Get real flights from your existing FlightAPI code
    const { outbound, returns } = await searchFlightsFlightAPI({
      from, to, departureDate, returnDate, tripType, passengers, travelClass
    });

    // 2) Apply offers per OTA on each flight (if you have base prices per portal)
    const otas = OTAS;
    const decorate = async (list) => {
      const out = [];
      for (const f of list) {
        const basePrice = Number(f.price || 0) || 0;

        // if you already compute per-portal base prices, use them; else one base for all
        const perPortalBase = f.portalBasePrices || Object.fromEntries(otas.map(p => [p, basePrice]));
        const portalPrices = {};
        let best = { portal: otas[0], finalPrice: basePrice, note: "No eligible offer" };

        for (const p of otas) {
          const base = Number(perPortalBase[p] || basePrice) || basePrice;
          const deal = await applyMongoOffers(base, paymentMethods, p);
          portalPrices[p] = { base, final: deal.finalPrice, note: deal.note };
          if (deal.finalPrice < best.finalPrice) best = { ...deal, portal: p };
        }

        out.push({ ...f, bestDeal: best, portalPrices });
      }
      return out;
    };

    const outboundFlights = await decorate(outbound);
    const returnFlights  = await decorate(returns);

    res.json({
      meta: {
        source: "flightapi",
        outStatus: 200,
        outCount: outboundFlights.length,
        retCount: returnFlights.length,
        offerDebug: {}
      },
      outboundFlights,
      returnFlights
    });
  } catch (e) {
    console.error("[/search] error:", e);
    res.status(502).json({
      meta: { source: "flightapi", outStatus: 502, outCount: 0, retCount: 0, offerDebug: { err: e.message } },
      outboundFlights: [],
      returnFlights: []
    });
  } finally {
    if (Date.now() - t0 > 12000) console.warn("[/search] slow", Date.now() - t0, "ms");
  }
});

/* ====== START ====== */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`SkyDeal backend listening on ${PORT}`);
});
