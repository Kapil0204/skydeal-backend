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

// ---------- config ----------
const MONGO_URI = process.env.MONGO_URI;
const MONGODB_DB = process.env.MONGODB_DB || "skydeal";
const MONGO_COL = process.env.MONGO_COL || "offers";

// Your 5 OTAs (names used in UI)
const OTAS = ["MakeMyTrip", "Goibibo", "Cleartrip", "Yatra", "EaseMyTrip"];
const OTA_MARKUP = 250; // ₹250 markup per OTA (your requirement)

// ---------- mongo (single cached client) ----------
let _client;
async function getOffersCol() {
  if (!_client) {
    if (!MONGO_URI) throw new Error("MONGO_URI missing");
    _client = new MongoClient(MONGO_URI, { maxPoolSize: 5 });
    await _client.connect();
  }
  return _client.db(MONGODB_DB).collection(MONGO_COL);
}

// ---------- helpers ----------
function toISO(d) {
  if (!d) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const t = new Date(d);
  if (!isNaN(t)) return t.toISOString().slice(0, 10);
  return "";
}

function safeNum(x, def = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : def;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// --------------------
// FlightAPI fetching
// --------------------
function buildCandidates({ from, to, date, adults = 1, travelClass = "ECONOMY", currency = "INR" }) {
  const key = process.env.FLIGHTAPI_KEY;
  if (!key) throw new Error("FLIGHTAPI_KEY missing");

  const base = "https://api.flightapi.io";
  const encKey = encodeURIComponent(key);
  const cls = travelClass.toUpperCase(); // ECONOMY | PREMIUM_ECONOMY | BUSINESS | FIRST

  const Q = new URLSearchParams({
    from,
    to,
    date,
    adults: String(adults),
    travelClass: cls,
    currency,
  }).toString();

  return [
    `${base}/oneway/${encKey}/${from}/${to}/${date}/${adults}/${cls}?currency=${currency}`,
    `${base}/oneway?apikey=${encKey}&${Q}`,
    `${base}/oneway?api_key=${encKey}&${Q}`,
  ];
}

async function fetchOneWaySmart(params) {
  const tried = [];
  for (const url of buildCandidates(params)) {
    try {
      const r = await axios.get(url, { timeout: 20000 });
      tried.push({ url, status: r.status });
      return { data: r.data, status: r.status, tried };
    } catch (e) {
      const st = e?.response?.status || 0;
      const body =
        typeof e?.response?.data === "string"
          ? e.response.data
          : e?.response?.data
          ? JSON.stringify(e.response.data)
          : "";
      tried.push({ url, status: st, body: body?.slice(0, 400) });
    }
  }
  const err = new Error("All FlightAPI variants failed");
  err.tried = tried;
  throw err;
}

// Minimal mapper so frontend gets consistent shape
function mapFlights(raw) {
  const items = raw?.data?.flights || raw?.flights || raw?.data || [];
  const arr = Array.isArray(items) ? items : [];
  return arr.map((f) => ({
    airlineName: f.airlineName || f.airline || f.carrier || "-",
    flightNumber: f.flightNumber || f.number || f.code || "-",
    departureTime: f.departureTime || f.departure || f.dep_time || null,
    arrivalTime: f.arrivalTime || f.arrival || f.arr_time || null,
    stops:
      typeof f.stops === "number"
        ? f.stops
        : Array.isArray(f.legs)
        ? Math.max(0, f.legs.length - 1)
        : 0,
    price: safeNum(f.price || f.totalPrice || f.amount, 0),
    raw: f,
  }));
}

// --------------------
// Offer logic
// --------------------
function normalizeType(t) {
  const s = String(t || "").toLowerCase();
  if (s.includes("credit")) return "Credit Card";
  if (s.includes("debit")) return "Debit Card";
  if (s.includes("net")) return "Net Banking";
  if (s.includes("upi")) return "UPI";
  if (s.includes("emi")) return "EMI";
  if (s.includes("wallet")) return "Wallet";
  return null;
}

function parseAmountToNumber(x) {
  // supports "₹4,000", "4000", "Rs. 4,000"
  const s = String(x || "").replace(/,/g, "").replace(/[^\d.]/g, "").trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function isOfferExpired(offer) {
  // We only use validityPeriod for expiry (your rule).
  // If schema has parsedFields.validityPeriodEnd or validityPeriod.endDate, handle both.
  const end =
    offer?.parsedFields?.validityPeriodEnd ||
    offer?.parsedFields?.validityPeriod?.endDate ||
    offer?.validityPeriodEnd ||
    offer?.validityPeriod?.endDate ||
    "";
  const endISO = end ? toISO(end) : "";
  if (!endISO) return false; // unknown => treat as not expired (conservative)
  return endISO < todayISO();
}

function offerMinAmount(offer) {
  return (
    offer?.parsedFields?.minTransactionValue ??
    offer?.minTransactionValue ??
    parseAmountToNumber(offer?.parsedFields?.rawMinTransactionAmount) ??
    parseAmountToNumber(offer?.rawMinTransactionAmount) ??
    0
  );
}

function offerDiscount(offer, basePrice) {
  // supports percent + max cap AND flat amount
  const pct =
    safeNum(offer?.parsedFields?.discountPercent ?? offer?.discountPercent, 0) || 0;

  const maxCap =
    offer?.parsedFields?.maxDiscountAmount != null
      ? safeNum(offer.parsedFields.maxDiscountAmount, 0)
      : offer?.maxDiscountAmount != null
      ? safeNum(offer.maxDiscountAmount, 0)
      : null;

  const flat =
    offer?.parsedFields?.flatDiscountAmount != null
      ? safeNum(offer.parsedFields.flatDiscountAmount, 0)
      : offer?.flatDiscountAmount != null
      ? safeNum(offer.flatDiscountAmount, 0)
      : 0;

  let pctDiscount = 0;
  if (pct > 0) {
    pctDiscount = (basePrice * pct) / 100;
    if (maxCap != null && maxCap > 0) pctDiscount = Math.min(pctDiscount, maxCap);
  }

  const flatDiscount = flat > 0 ? flat : 0;

  // take the better of percent-based vs flat (simple rule)
  return Math.max(pctDiscount, flatDiscount, 0);
}

function offerCouponCode(offer) {
  return (
    offer?.parsedFields?.couponCode ||
    offer?.couponCode ||
    offer?.parsedFields?.code ||
    offer?.code ||
    ""
  );
}

function offerTitle(offer) {
  return offer?.title || offer?.parsedFields?.title || "";
}

function offerPlatforms(offer) {
  // expected array like ["MakeMyTrip"] etc
  const p =
    offer?.parsedFields?.parsedApplicablePlatforms ||
    offer?.parsedApplicablePlatforms ||
    offer?.applicablePlatforms ||
    [];
  return Array.isArray(p) ? p : [];
}

function offerPaymentMethods(offer) {
  // expected array of objects like { type, bank, network, conditions }
  const pm = offer?.parsedFields?.paymentMethods || offer?.paymentMethods || [];
  return Array.isArray(pm) ? pm : [];
}

function matchesSelection(offer, selected) {
  // selected = [{type:"Credit Card", bank:"ICICI Bank"}, ...]
  const offerPMs = offerPaymentMethods(offer).map((x) => ({
    type: normalizeType(x.type) || x.type || "",
    bank: x.bank || x.issuer || "",
  }));

  for (const s of selected) {
    const st = normalizeType(s.type) || s.type;
    const sb = String(s.bank || "").trim();
    const hit = offerPMs.some(
      (op) =>
        String(op.type || "").trim() === String(st || "").trim() &&
        String(op.bank || "").trim().toLowerCase() === sb.toLowerCase()
    );
    if (hit) return true;
  }
  return false;
}

async function findBestDealsForFlight({ basePrice, selectedPaymentMethods }) {
  const col = await getOffersCol();

  // If user didn’t select anything, we return plain portal pricing (no discounts)
  const selected = Array.isArray(selectedPaymentMethods) ? selectedPaymentMethods : [];

  let offers = [];
  if (selected.length > 0) {
    // We pull a reasonable number and filter in Node (schema variations across portals).
    // NOTE: If you later standardize fields further, we can push more of this into Mongo queries.
    offers = await col
      .find({}, { projection: { parsedFields: 1, title: 1, sourceMetadata: 1, offerCategories: 1 } })
      .limit(2000)
      .toArray();
  }

  const portalPrices = [];
  let bestDeal = null;

  for (const portal of OTAS) {
    const withMarkup = basePrice + OTA_MARKUP;

    let bestForPortal = {
      portal,
      basePrice: withMarkup,
      discount: 0,
      finalPrice: withMarkup,
      couponCode: "",
      offerTitle: "",
      reason: "No eligible offer",
    };

    if (selected.length > 0 && offers.length > 0) {
      for (const offer of offers) {
        // expired?
        if (isOfferExpired(offer)) continue;

        // platform match (if platforms present)
        const platforms = offerPlatforms(offer);
        if (platforms.length > 0 && !platforms.includes(portal)) continue;

        // payment match
        if (!matchesSelection(offer, selected)) continue;

        // min amount check
        const minAmt = offerMinAmount(offer);
        if (minAmt && withMarkup < minAmt) continue;

        // discount compute
        const disc = offerDiscount(offer, withMarkup);
        if (disc <= 0) continue;

        const finalPrice = Math.max(0, Math.round(withMarkup - disc));

        if (finalPrice < bestForPortal.finalPrice) {
          bestForPortal = {
            portal,
            basePrice: withMarkup,
            discount: Math.round(disc),
            finalPrice,
            couponCode: offerCouponCode(offer),
            offerTitle: offerTitle(offer),
            reason: "Eligible offer found",
          };
        }
      }
    }

    portalPrices.push(bestForPortal);

    if (!bestDeal || bestForPortal.finalPrice < bestDeal.finalPrice) {
      bestDeal = bestForPortal;
    }
  }

  return { bestDeal, portalPrices };
}

// --------------------
// routes
// --------------------
app.get("/health", (req, res) => res.json({ ok: true }));

// Payment options: built from MongoDB offers
app.get("/payment-options", async (req, res) => {
  try {
    const col = await getOffersCol();

    // Pull only paymentMethods from offers (schema tolerant)
    const docs = await col
      .find(
        {},
        {
          projection: {
            paymentMethods: 1,
            parsedFields: 1,
          },
        }
      )
      .limit(5000)
      .toArray();

    const groups = new Map(); // type -> Set(banks)

    for (const d of docs) {
      const pm =
        (Array.isArray(d?.parsedFields?.paymentMethods) && d.parsedFields.paymentMethods) ||
        (Array.isArray(d?.paymentMethods) && d.paymentMethods) ||
        [];

      for (const p of pm) {
        const type = normalizeType(p?.type);
        const bank = String(p?.bank || p?.issuer || "").trim();
        if (!type || !bank) continue;

        if (!groups.has(type)) groups.set(type, new Set());
        groups.get(type).add(bank);
      }
    }

    // Build final output with stable ordering
    const orderedTypes = ["Credit Card", "Debit Card", "EMI", "Net Banking", "Wallet", "UPI"];
    const options = {};
    for (const t of orderedTypes) {
      const set = groups.get(t) || new Set();
      options[t] = Array.from(set).sort((a, b) => a.localeCompare(b));
    }

    res.json({ usedFallback: false, options });
  } catch (e) {
    res.status(500).json({
      usedFallback: false,
      error: "Failed to load payment options from MongoDB",
      details: e.message,
    });
  }
});

// Search: FlightAPI real flights + offers applied
app.post("/search", async (req, res) => {
  const body = req.body || {};
  const meta = { source: "flightapi", outStatus: 0, retStatus: 0, request: {} };

  try {
    let {
      from,
      to,
      departureDate,
      returnDate,
      tripType,
      passengers,
      travelClass,
      selectedPaymentMethods,
    } = body;

    const outDate = toISO(departureDate);
    const retDate = toISO(returnDate);

    const clsRaw = String(travelClass || "economy").toLowerCase();
    const cls =
      clsRaw === "premium economy" || clsRaw === "premium_economy"
        ? "PREMIUM_ECONOMY"
        : clsRaw === "business"
        ? "BUSINESS"
        : clsRaw === "first"
        ? "FIRST"
        : "ECONOMY";

    const adults = Number(passengers) || 1;
    const currency = "INR";

    // Outbound
    const outRes = await fetchOneWaySmart({
      from,
      to,
      date: outDate,
      adults,
      travelClass: cls,
      currency,
    });
    meta.outStatus = outRes.status;
    meta.request.outTried = outRes.tried;

    // Return (if round-trip)
    let retFlights = [];
    if (tripType === "round-trip" && retDate) {
      const retRes = await fetchOneWaySmart({
        from: to,
        to: from,
        date: retDate,
        adults,
        travelClass: cls,
        currency,
      });
      meta.retStatus = retRes.status;
      meta.request.retTried = retRes.tried;
      retFlights = mapFlights(retRes.data);
    }

    const outFlights = mapFlights(outRes.data);

    // Apply offer engine to each flight (keep it light: first 30 each side)
    const applyToList = async (flights) => {
      const limited = flights.slice(0, 30);
      const out = [];
      for (const f of limited) {
        const basePrice = safeNum(f.price, 0);
        const deals = await findBestDealsForFlight({
          basePrice,
          selectedPaymentMethods,
        });

        out.push({
          ...f,
          bestDeal: deals.bestDeal,
          portalPrices: deals.portalPrices,
        });
      }
      return out;
    };

    const outWithDeals = await applyToList(outFlights);
    const retWithDeals = await applyToList(retFlights);

    return res.json({
      meta,
      outboundFlights: outWithDeals,
      returnFlights: retWithDeals,
    });
  } catch (e) {
    const st = e?.response?.status || 500;
    const bodyStr =
      typeof e?.response?.data === "string"
        ? e.response.data
        : e?.response?.data
        ? JSON.stringify(e.response.data)
        : "";

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
