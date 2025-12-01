// index.js — SkyDeal backend (FlightAPI + Mongo offers application)
// Node ESM

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// -----------------------------
// Env, DB, constants
// -----------------------------
const MONGO_URI = process.env.MONGO_URI || "";
const FLIGHTAPI_KEY = process.env.FLIGHTAPI_KEY || process.env.FLIGHT_API_KEY || process.env.FLIGHTAPI || "";
const BASE_REGION = "IN"; // keep stable

const PORTALS = ["MakeMyTrip", "Goibibo", "EaseMyTrip", "Yatra", "Cleartrip"];
const MARKUP_RS = 250; // fixed markup per portal

let db = null;
let mongoClient = null;

async function connectDB() {
  if (!MONGO_URI || !/^mongodb(\+srv)?:\/\//i.test(MONGO_URI)) {
    console.warn("❌ Missing or invalid MONGO_URI");
    return;
  }
  mongoClient = new MongoClient(MONGO_URI, { ignoreUndefined: true });
  await mongoClient.connect();
  db = mongoClient.db(); // db name is part of URI
  console.log("✅ Connected to MongoDB");
}
await connectDB().catch((e) => console.error("❌ MongoDB Connection Error:", e));

// -----------------------------
// Helpers: text normalization
// -----------------------------
const BANK_CANON = {
  "hdfc": "HDFC Bank",
  "hdfc bank": "HDFC Bank",
  "icici": "ICICI Bank",
  "icici bank": "ICICI Bank",
  "axis": "Axis Bank",
  "axis bank": "Axis Bank",
  "au small": "AU Small Bank",
  "au small bank": "AU Small Bank",
  "idfc": "IDFC First Bank",
  "idfc first": "IDFC First Bank",
  "idfc first bank": "IDFC First Bank",
  "yes bank": "Yes Bank",
  "kotak": "Kotak Bank",
  "kotak bank": "Kotak Bank",
  "rbl": "Rbl Bank",
  "rbl bank": "Rbl Bank",
  "federal": "Federal Bank",
  "federal bank": "Federal Bank",
  "central bank of india": "Central Bank Of India",
  "sbi bank": "SBI Bank",
  "hsbc": "Hsbc",
  "hsbc bank": "Hsbc Bank",
  "bobcard ltd": "Bobcard Ltd",
  "canara bank": "Canara Bank",
  "flipkart axis": "Flipkart Axis",
  "flipkart axis credit card": "Flipkart Axis Credit Card",
  "mobikwik": "Mobikwik"
};
function canonicalBankOrLabel(s) {
  if (!s) return "";
  const k = String(s).trim().toLowerCase();
  return BANK_CANON[k] || titleCase(s);
}
function titleCase(s) {
  return String(s)
    .toLowerCase()
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .replace(/\bOf\b/g, "of")
    .replace(/\bAnd\b/g, "and");
}
function normalizeType(rawType) {
  if (!rawType) return "";
  const t = String(rawType).trim().toLowerCase();
  if (t.includes("credit")) return "CreditCard";
  if (t.includes("debit")) return "DebitCard";
  if (t.includes("wallet")) return "Wallet";
  if (t.includes("upi")) return "UPI";
  if (t.includes("net")) return "NetBanking";
  if (t.includes("emi")) return "EMI";
  if (t === "bank offer" || t === "bank") return "CreditCard"; // generic bank offers → usually cards
  if (["online", "other", "any"].includes(t)) return "CreditCard";
  return "CreditCard";
}
function looksEMI(pm) {
  const blob = [
    pm?.type, pm?.category, pm?.mode, pm?.method
  ].filter(Boolean).join(" ").toLowerCase();
  return /(^|\W)emi(\W|$)/.test(blob);
}
function withinDateRange(nowISO, range) {
  // range may be object {start:'YYYY-MM-DD', end:'YYYY-MM-DD'} or strings
  if (!range) return true;
  const now = new Date(nowISO);
  let start = null, end = null;
  if (typeof range === "string") {
    // attempt parse "YYYY-MM-DD to YYYY-MM-DD"
    const m = range.match(/(\d{4}-\d{2}-\d{2}).*(\d{4}-\d{2}-\d{2})/);
    if (m) { start = new Date(m[1]); end = new Date(m[2]); }
  } else {
    if (range.start) start = new Date(range.start);
    if (range.end) end = new Date(range.end);
  }
  if (start && now < start) return false;
  if (end && now > end) return false;
  return true;
}
function numberish(x) {
  if (x == null) return null;
  const n = typeof x === "number" ? x : Number(String(x).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// -----------------------------
// Offer selection & application
// -----------------------------
/**
 * Extract a discount amount for a given offer and base price.
 * Supports:
 *  - percentage via `discountPercent`
 *  - flat via `maxDiscountAmount` (if no percent)
 *  - guard with `minTransactionValue`
 *  - cap via `maxDiscountAmount` (when percent)
 */
function computeDiscountForPrice(offer, baseAmount) {
  const amount = numberish(baseAmount) || 0;
  const minTxn = numberish(offer?.minTransactionValue);
  if (minTxn != null && amount < minTxn) return 0;

  const pct = numberish(offer?.discountPercent);
  const maxCap = numberish(offer?.maxDiscountAmount);
  let discount = 0;

  if (pct != null && pct > 0) {
    discount = (amount * pct) / 100.0;
    if (maxCap != null && maxCap > 0) discount = Math.min(discount, maxCap);
  } else {
    // Flat amount if provided
    if (maxCap != null && maxCap > 0) discount = maxCap;
  }

  // Don't allow negative final price
  discount = Math.max(0, Math.min(discount, amount));
  return Math.floor(discount); // integer rupees
}

/**
 * Check if an offer applies to:
 *  - the selected payment labels (banks/methods) from the UI
 *  - current booking date (validityPeriod)
 *  - not expired
 *  - portal (if filtering by portal)
 */
function offerMatches(offer, selectedLabels, portalName) {
  if (offer?.isExpired === true) return false;

  // booking validity
  const nowISO = new Date().toISOString().slice(0, 10);
  if (offer?.validityPeriod && !withinDateRange(nowISO, offer.validityPeriod)) return false;

  // portal filter if requested
  if (portalName) {
    // We stored portal under sourcePortal (per memory)
    const p = (offer.sourcePortal || offer.portal || "").toString().trim().toLowerCase();
    if (p && p !== portalName.toLowerCase()) return false;
  }

  if (!selectedLabels || selectedLabels.length === 0) {
    // If user selected nothing, do not auto-apply generic offers
    return false;
  }

  // any intersection between user's selected labels and offer's paymentMethods banks/methods
  const fromOffer = (offer.paymentMethods || []).flatMap(pm => {
    const parts = [];
    if (pm.bank) parts.push(canonicalBankOrLabel(pm.bank));
    if (pm.method) parts.push(canonicalBankOrLabel(pm.method));
    if (pm.wallet) parts.push(canonicalBankOrLabel(pm.wallet));
    return parts;
  }).map(s => s.toLowerCase());

  const selected = selectedLabels.map(s => canonicalBankOrLabel(s).toLowerCase());

  return selected.some(lbl => fromOffer.includes(lbl));
}

/**
 * For a base price and selected payment labels, compute best price per portal + overall best.
 * Returns:
 * {
 *   breakdown: [{ portal, basePrice, offerApplied, discount, finalPrice, offerInfo }],
 *   best: { portal, finalPrice, label, offerInfo }
 * }
 */
async function applyOffersToPrice(basePrice, selectedLabels) {
  const amount = numberish(basePrice) || 0;

  // fetch active offers once
  const offers = db
    ? await db.collection("offers")
        .find({ isExpired: { $ne: true } }, { projection: {
          title: 1, terms: 1, rawText: 1, couponRequired: 1,
          discountPercent: 1, maxDiscountAmount: 1, minTransactionValue: 1,
          validityPeriod: 1, paymentMethods: 1, sourcePortal: 1, sourceUrl: 1
        }})
        .toArray()
    : [];

  const breakdown = [];
  for (const portal of PORTALS) {
    let bestForPortal = { portal, basePrice: amount, discount: 0, finalPrice: amount, offerApplied: false, offerInfo: null };

    // Filter offers for this portal and user’s payment labels
    const candidates = offers.filter(o => offerMatches(o, selectedLabels, portal));
    if (candidates.length) {
      // choose the offer that gives the max discount on this amount
      let best = bestForPortal;
      for (const o of candidates) {
        const d = computeDiscountForPrice(o, amount);
        const finalP = amount - d;
        if (finalP < best.finalPrice) {
          best = {
            portal,
            basePrice: amount,
            discount: d,
            finalPrice: finalP,
            offerApplied: d > 0,
            offerInfo: {
              title: o.title || "",
              couponRequired: !!o.couponRequired,
              discountPercent: numberish(o.discountPercent),
              maxDiscountAmount: numberish(o.maxDiscountAmount),
              minTransactionValue: numberish(o.minTransactionValue),
              sourceUrl: o.sourceUrl || "",
              sourcePortal: o.sourcePortal || portal
            }
          };
        }
      }
      bestForPortal = best;
    }

    // Always apply fixed portal markup
    bestForPortal.finalPrice = bestForPortal.finalPrice + MARKUP_RS;

    breakdown.push(bestForPortal);
  }

  // choose overall best
  let best = breakdown[0];
  for (const b of breakdown) {
    if (b.finalPrice < best.finalPrice) best = b;
  }

  // Make a short label like “Best on MakeMyTrip ₹12,345 with HDFC Bank”
  let label = `Best on ${best.portal} ₹${best.finalPrice}`;
  if (selectedLabels && selectedLabels.length) {
    label += ` with ${canonicalBankOrLabel(selectedLabels[0])}`;
  }

  return { breakdown, best: { ...best, label } };
}

// -----------------------------
// FlightAPI helpers
// -----------------------------
function buildFlightUrl(params, mode) {
  const { from, to, departureDate, returnDate, passengers, travelClass, tripType } = params;
  const cabin = String(travelClass || "economy").toLowerCase();
  const pax = Number(passengers || 1);

  if (!FLIGHTAPI_KEY) return null;

  if (tripType === "one-way") {
    return `https://api.flightapi.io/onewaytrip/${FLIGHTAPI_KEY}/${from}/${to}/${departureDate}/${pax}/0/0/${cabin}/INR?region=${BASE_REGION}`;
  }
  // round-trip
  return `https://api.flightapi.io/roundtrip/${FLIGHTAPI_KEY}/${from}/${to}/${departureDate}/${returnDate}/${pax}/0/0/${cabin}/INR?region=${BASE_REGION}`;
}

async function callFlightApi(url) {
  const resp = await fetch(url, { timeout: 25000 });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    return { ok: false, status: resp.status, error: txt };
  }
  const json = await resp.json();
  return { ok: true, status: 200, data: json };
}

// Map carrier id→name
function buildCarrierMap(carriers) {
  const m = new Map();
  for (const c of carriers || []) {
    m.set(String(c.id), c.name || "");
  }
  return m;
}

// Extract outbound legs from one FlightAPI response (supports onewaytrip or roundtrip first leg)
function extractOutbound(data) {
  const out = [];
  const legById = new Map();
  (data.legs || []).forEach(l => legById.set(l.id, l));
  const segById = new Map();
  (data.segments || []).forEach(s => segById.set(s.id, s));
  const carr = buildCarrierMap(data.carriers || []);

  for (const it of data.itineraries || []) {
    if (!Array.isArray(it.leg_ids) || it.leg_ids.length === 0) continue;
    const outId = it.leg_ids[0];
    const leg = legById.get(outId);
    if (!leg) continue;

    const firstSeg = segById.get(leg.segment_ids?.[0]);
    const carrierName = firstSeg ? carr.get(String(firstSeg.marketing_carrier_id)) || "" : "";

    // price from pricing_options[0]
    const price = it?.pricing_options?.[0]?.price?.amount;
    if (!price) continue;

    out.push({
      flightNumber: carrierName || "Flight",
      airlineName: carrierName || "Flight",
      departure: (leg.departure || "").slice(11,16),
      arrival: (leg.arrival || "").slice(11,16),
      price: String(Math.round(price)), // integer
      stops: Math.max(0, (leg.segment_ids?.length || 1) - 1),
      carrierCode: String(firstSeg?.marketing_carrier_id ?? "")
    });
  }
  return out;
}

// Extract return legs from a roundtrip response (leg_ids[1])
function extractReturn(data) {
  const ret = [];
  const legById = new Map();
  (data.legs || []).forEach(l => legById.set(l.id, l));
  const segById = new Map();
  (data.segments || []).forEach(s => segById.set(s.id, s));
  const carr = buildCarrierMap(data.carriers || []);

  for (const it of data.itineraries || []) {
    if (!Array.isArray(it.leg_ids) || it.leg_ids.length < 2) continue;
    const retId = it.leg_ids[1];
    const leg = legById.get(retId);
    if (!leg) continue;

    const firstSeg = segById.get(leg.segment_ids?.[0]);
    const carrierName = firstSeg ? carr.get(String(firstSeg.marketing_carrier_id)) || "" : "";

    // Use the same combined price (roundtrip) just to build “shape” here — we’ll prefer onewaytrips path.
    const price = it?.pricing_options?.[0]?.price?.amount;
    if (!price) continue;

    ret.push({
      flightNumber: carrierName || "Flight",
      airlineName: carrierName || "Flight",
      departure: (leg.departure || "").slice(11,16),
      arrival: (leg.arrival || "").slice(11,16),
      price: String(Math.round(price)),
      stops: Math.max(0, (leg.segment_ids?.length || 1) - 1),
      carrierCode: String(firstSeg?.marketing_carrier_id ?? "")
    });
  }
  return ret;
}

// -----------------------------
// Routes
// -----------------------------
app.get("/health", async (req, res) => {
  return res.json({ ok: true, time: new Date().toISOString(), dbConnected: !!db });
});

// Payment options (already working for you with EMI scan). Keeping your improved logic:
app.get("/payment-options", async (req, res) => {
  try {
    let options = {
      CreditCard: [],
      DebitCard: [],
      Wallet: [],
      UPI: [],
      NetBanking: [],
      EMI: [],
    };
    if (!db) return res.json({ usedFallback: true, options });

    // Pass 1: structured
    const rows = await db.collection("offers").aggregate([
      { $match: { isExpired: { $ne: true } } },
      { $unwind: "$paymentMethods" },
      {
        $project: {
          pm: {
            type: { $ifNull: ["$paymentMethods.type", ""] },
            bank: { $ifNull: ["$paymentMethods.bank", ""] },
            method: { $ifNull: ["$paymentMethods.method", ""] },
            wallet: { $ifNull: ["$paymentMethods.wallet", ""] },
            category: { $ifNull: ["$paymentMethods.category", ""] },
            mode: { $ifNull: ["$paymentMethods.mode", ""] },
          },
        },
      },
    ]).toArray();

    const sets = {
      CreditCard: new Set(),
      DebitCard: new Set(),
      Wallet: new Set(),
      UPI: new Set(),
      NetBanking: new Set(),
      EMI: new Set(),
    };

    for (const r of rows) {
      const pm = r.pm || {};
      const bucket = normalizeType(pm.type) || "";
      const subRaw = pm.bank || pm.method || pm.wallet || "";
      if (!subRaw) continue;
      const label = canonicalBankOrLabel(subRaw);
      const isEMI = looksEMI(pm);
      if (isEMI) sets.EMI.add(label);
      if (bucket) sets[bucket].add(label);
    }

    // Pass 2: text/category EMI hints
    const emiHintDocs = await db.collection("offers").aggregate([
      { $match: { isExpired: { $ne: true } } },
      {
        $project: {
          title: { $ifNull: ["$title", ""] },
          terms: { $ifNull: ["$terms", ""] },
          rawText: { $ifNull: ["$rawText", ""] },
          offerCategories: { $ifNull: ["$offerCategories", []] },
          paymentMethods: { $ifNull: ["$paymentMethods", []] },
        },
      },
      {
        $addFields: {
          emiByText: {
            $or: [
              { $regexMatch: { input: "$title", regex: /emi/i } },
              { $regexMatch: { input: "$terms", regex: /emi/i } },
              { $regexMatch: { input: "$rawText", regex: /emi/i } },
              {
                $gt: [
                  {
                    $size: {
                      $filter: {
                        input: "$offerCategories",
                        as: "c",
                        cond: { $regexMatch: { input: "$$c", regex: /emi/i } },
                      },
                    },
                  },
                  0,
                ],
              },
            ],
          },
        },
      },
      { $match: { emiByText: true } },
      { $unwind: "$paymentMethods" },
      {
        $project: {
          pm: {
            type: { $ifNull: ["$paymentMethods.type", ""] },
            bank: { $ifNull: ["$paymentMethods.bank", ""] },
            method: { $ifNull: ["$paymentMethods.method", ""] },
            category: { $ifNull: ["$paymentMethods.category", ""] },
            mode: { $ifNull: ["$paymentMethods.mode", ""] },
          },
        },
      },
    ]).toArray();

    for (const r of emiHintDocs) {
      const pm = r.pm || {};
      const subRaw = pm.bank || pm.method || "";
      if (!subRaw) continue;
      sets.EMI.add(canonicalBankOrLabel(subRaw));
      const bucket = normalizeType(pm.type);
      if (bucket) sets[bucket].add(canonicalBankOrLabel(subRaw));
    }

    for (const k of Object.keys(sets)) {
      options[k] = Array.from(sets[k]).sort((a, b) => a.localeCompare(b));
    }
    return res.json({ usedFallback: false, options });
  } catch (e) {
    console.error("payment-options error:", e);
    return res.status(500).json({ error: e.message });
  }
});

// Debug (dry / live) flightapi
app.post("/debug-flightapi", async (req, res) => {
  try {
    const dry = String(req.query.dry || "") === "1";
    const url = buildFlightUrl(req.body || {}, dry ? "dry" : "live");
    if (!url) return res.json({ ok: false, error: "no-api-key", status: null, keys: null, hasItin: null });

    if (dry) return res.json({ ok: true, url, mode: "dry" });

    const r = await callFlightApi(url);
    if (!r.ok) return res.json({ ok: false, status: r.status, keys: [], hasItin: false, error: r.error || "error" });
    const keys = Object.keys(r.data || {});
    const hasItin = Array.isArray(r.data?.itineraries) ? r.data.itineraries.length : 0;
    return res.json({ ok: true, status: 200, keys, hasItin, error: null });
  } catch (e) {
    return res.json({ ok: false, status: 0, keys: [], hasItin: false, error: "timeout" });
  }
});

// Main search
app.post("/search", async (req, res) => {
  try {
    const {
      from, to, departureDate, returnDate,
      passengers = 1, travelClass = "economy",
      tripType = "round-trip",
      paymentMethods = []
    } = req.body || {};

    if (!FLIGHTAPI_KEY) {
      return res.json({ outboundFlights: [], returnFlights: [], meta: { source: "flightapi", reason: "no-key" } });
    }

    // Always use one-way for better comparability
    const urlOut = buildFlightUrl({ from, to, departureDate, passengers, travelClass, tripType: "one-way" });
    const outResp = await callFlightApi(urlOut);
    if (!outResp.ok) {
      return res.json({ outboundFlights: [], returnFlights: [], meta: { source: "flightapi", reason: "outbound-failed" } });
    }
    const outbound = extractOutbound(outResp.data);

    let returns = [];
    if (tripType === "round-trip" && returnDate) {
      const urlRet = buildFlightUrl({ from: to, to: from, departureDate: returnDate, passengers, travelClass, tripType: "one-way" });
      const retResp = await callFlightApi(urlRet);
      if (retResp.ok) {
        returns = extractOutbound(retResp.data);
      }
    }

    // Apply offers (selected payment labels) to each flight’s price
    const selectedLabels = Array.isArray(paymentMethods) ? paymentMethods : [];

    async function decorateWithOffers(f) {
      const base = numberish(f.price) || 0;
      const { breakdown, best } = db ? await applyOffersToPrice(base, selectedLabels) : {
        breakdown: PORTALS.map(p => ({
          portal: p, basePrice: base, discount: 0, finalPrice: base + MARKUP_RS, offerApplied: false, offerInfo: null
        })),
        best: { portal: "MakeMyTrip", finalPrice: base + MARKUP_RS, label: `Best on MakeMyTrip ₹${base + MARKUP_RS}` }
      };
      return {
        ...f,
        portalPrices: breakdown.map(b => ({
          portal: b.portal,
          basePrice: b.basePrice,
          finalPrice: b.finalPrice,
          source: b.offerApplied ? "carrier+offer+markup" : "carrier+markup",
          offerInfo: b.offerInfo
        })),
        bestDeal: best // { portal, finalPrice, label, offerInfo }
      };
    }

    const outboundDecorated = await Promise.all(outbound.map(decorateWithOffers));
    const returnDecorated = await Promise.all(returns.map(decorateWithOffers));

    return res.json({
      outboundFlights: outboundDecorated,
      returnFlights: returnDecorated,
      meta: { source: "flightapi" }
    });
  } catch (e) {
    console.error("❌ Search error:", e);
    return res.json({ outboundFlights: [], returnFlights: [], error: "search-failed" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 SkyDeal backend running on ${PORT}`);
});
