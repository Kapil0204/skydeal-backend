// index.js (SkyDeal backend) — ESM
import express from "express";
import cors from "cors";
import axios from "axios";
import { MongoClient } from "mongodb";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// --------------------
// Config
// --------------------
const PORTALS = ["Goibibo", "MakeMyTrip", "Yatra", "EaseMyTrip", "Cleartrip"];
const OTA_MARKUP = Number(process.env.OTA_MARKUP || 250); // your current requirement: +₹250

// --------------------
// Date helpers
// --------------------
function toISO(d) {
  if (!d) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const t = new Date(d);
  if (!isNaN(t)) {
    const mm = String(t.getMonth() + 1).padStart(2, "0");
    const dd = String(t.getDate()).padStart(2, "0");
    return `${t.getFullYear()}-${mm}-${dd}`;
  }
  return "";
}

function safeNum(x, def = 0) {
  const n = typeof x === "number" ? x : Number(String(x || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : def;
}

// --------------------
// FlightAPI helpers
// --------------------
function buildCandidates({ from, to, date, adults = 1, travelClass = "ECONOMY", currency = "INR" }) {
  const key = process.env.FLIGHTAPI_KEY;
  if (!key) throw new Error("Missing FLIGHTAPI_KEY env var");

  const base = "https://api.flightapi.io";
  const encKey = encodeURIComponent(key);
  const cls = String(travelClass || "ECONOMY").toUpperCase();
  const style = String(process.env.FLIGHTAPI_STYLE || "path").toLowerCase(); // "path" or "query"

  const Q = new URLSearchParams({
    from,
    to,
    date,
    adults: String(adults),
    travelClass: cls,
    currency,
  }).toString();

  const pathUrls = [
    `${base}/oneway/${encKey}/${from}/${to}/${date}/${adults}/${cls}?currency=${currency}`,
  ];

  const queryUrls = [
    `${base}/oneway?apikey=${encKey}&${Q}`,
    `${base}/oneway?api_key=${encKey}&${Q}`,
  ];

  // prefer order by style
  return style === "query" ? [...queryUrls, ...pathUrls] : [...pathUrls, ...queryUrls];
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

function mapFlights(raw) {
  const items =
    raw?.data?.flights ||
    raw?.flights ||
    raw?.data ||
    raw?.results ||
    [];

  return (Array.isArray(items) ? items : []).map((f) => {
    const price = safeNum(f.price ?? f.totalPrice ?? f.amount ?? f.fare ?? 0, 0);

    return {
      airlineName: f.airlineName || f.airline || f.carrier || f.marketingCarrier || "-",
      flightNumber: f.flightNumber || f.number || f.code || f.flight_code || "-",
      departureTime: f.departureTime || f.departure || f.dep_time || f.departure_time || null,
      arrivalTime: f.arrivalTime || f.arrival || f.arr_time || f.arrival_time || null,
      stops:
        typeof f.stops === "number"
          ? f.stops
          : (Array.isArray(f.legs) ? Math.max(0, f.legs.length - 1) : 0),
      price,
      raw: f,
    };
  });
}

// --------------------
// Mongo (cached client)
// --------------------
let _mongoClient = null;
let _mongoClientPromise = null;

async function getOffersCollection() {
  const uri = process.env.MONGO_URI;
  const dbName = process.env.MONGODB_DB || "skydeal";
  const colName = process.env.MONGO_COL || "offers";

  if (!uri) throw new Error("Missing MONGO_URI env var");

  if (_mongoClient) {
    return _mongoClient.db(dbName).collection(colName);
  }

  if (!_mongoClientPromise) {
    _mongoClientPromise = MongoClient.connect(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 15000,
    });
  }

  _mongoClient = await _mongoClientPromise;
  return _mongoClient.db(dbName).collection(colName);
}

// --------------------
// Offer extraction (robust to schema differences)
// --------------------
function normStr(s) {
  return String(s || "").trim();
}

function normalizePortal(p) {
  const x = normStr(p).toLowerCase();
  if (!x) return "";
  if (x.includes("make") && x.includes("trip")) return "MakeMyTrip";
  if (x.includes("goibibo") || x === "go ibibo" || x === "go-ibibo") return "Goibibo";
  if (x.includes("cleartrip") || x.includes("clear trip")) return "Cleartrip";
  if (x.includes("yatra")) return "Yatra";
  if (x.includes("ease") && x.includes("trip")) return "EaseMyTrip";
  // fallback: TitleCase-ish
  return x.replace(/\b\w/g, (m) => m.toUpperCase());
}

function normalizePayType(t) {
  const x = normStr(t).toLowerCase();
  if (!x) return "";
  if (x.includes("credit")) return "Credit Card";
  if (x.includes("debit")) return "Debit Card";
  if (x.includes("net") || x.includes("banking")) return "Net Banking";
  if (x === "upi" || x.includes("upi")) return "UPI";
  if (x.includes("emi")) return "EMI";
  if (x.includes("wallet")) return "Wallet";
  return x.replace(/\b\w/g, (m) => m.toUpperCase());
}

function extractPaymentMethodsFromDoc(doc) {
  // possible locations
  const pm =
    doc?.paymentMethods ||
    doc?.parsedFields?.paymentMethods ||
    doc?.rawFields?.paymentMethods ||
    doc?.parsed?.paymentMethods ||
    [];

  const arr = Array.isArray(pm) ? pm : [];

  const out = [];
  for (const item of arr) {
    if (!item) continue;

    if (typeof item === "string") {
      // e.g. "ICICI Bank credit card"
      out.push({ type: "", name: normStr(item) });
      continue;
    }

    const type = normalizePayType(item.type || item.methodType || item.paymentType || "");
    const bank = normStr(item.bank || item.name || item.provider || item.brand || "");
    const network = normStr(item.network || item.cardNetwork || "");
    const name = bank || network || normStr(item.label || "");
    if (name) out.push({ type, name });
  }

  return out;
}

function getOfferIsExpired(doc) {
  // prefer explicit field if present
  const direct = doc?.isExpired;
  const parsed = doc?.parsedFields?.isExpired;
  if (typeof direct === "boolean") return direct;
  if (typeof parsed === "boolean") return parsed;

  // try validityPeriod end date if present
  const end =
    doc?.validityPeriod?.endDate ||
    doc?.parsedFields?.validityPeriod?.endDate ||
    doc?.parsedFields?.validityPeriod?.end ||
    "";

  if (end) {
    const dt = new Date(end);
    if (!isNaN(dt)) return dt.getTime() < Date.now();
  }

  return false; // default: treat as active (we’ll still validate min txn etc.)
}

function extractOfferCore(doc) {
  const title = normStr(doc?.title || doc?.parsedFields?.title || doc?.rawFields?.title || "");
  const code = normStr(
    doc?.couponCode ||
    doc?.code ||
    doc?.parsedFields?.couponCode ||
    doc?.parsedFields?.code ||
    doc?.rawFields?.couponCode ||
    ""
  );

  const discountPercent = safeNum(
    doc?.discountPercent ??
    doc?.parsedFields?.discountPercent ??
    doc?.parsedFields?.percentOff ??
    0,
    0
  );

  // Flat discount could be stored in different places/labels
  const flatDiscountAmount = safeNum(
    doc?.flatDiscountAmount ??
    doc?.discountAmount ??
    doc?.parsedFields?.flatDiscountAmount ??
    doc?.parsedFields?.discountAmount ??
    0,
    0
  );

  const maxDiscountAmount = safeNum(
    doc?.maxDiscountAmount ??
    doc?.parsedFields?.maxDiscountAmount ??
    doc?.parsedFields?.maxDiscount ??
    0,
    0
  );

  const minTransactionValue = safeNum(
    doc?.minTransactionValue ??
    doc?.minAmount ??
    doc?.parsedFields?.minTransactionValue ??
    doc?.parsedFields?.minAmount ??
    0,
    0
  );

  const sourcePortal = normalizePortal(
    doc?.sourcePortal ||
    doc?.sourceMetadata?.sourcePortal ||
    doc?.parsedFields?.sourcePortal ||
    doc?.portal ||
    ""
  );

  const offerText =
    normStr(doc?.rawDiscount || doc?.parsedFields?.rawDiscount || doc?.discount || "") ||
    (discountPercent ? `${discountPercent}% off` : (flatDiscountAmount ? `₹${flatDiscountAmount} off` : ""));

  return {
    title,
    code,
    discountPercent,
    flatDiscountAmount,
    maxDiscountAmount,
    minTransactionValue,
    sourcePortal,
    offerText,
    isExpired: getOfferIsExpired(doc),
    paymentMethods: extractPaymentMethodsFromDoc(doc),
    raw: doc,
  };
}

function matchOfferToSelectedPayments(offer, selected) {
  // selected: [{type, name}] from frontend
  if (!Array.isArray(selected) || selected.length === 0) return false;

  const offerPM = Array.isArray(offer.paymentMethods) ? offer.paymentMethods : [];
  if (offerPM.length === 0) {
    // Some offers may not have structured PM list; treat as non-match
    return false;
  }

  const sel = selected.map((s) => ({
    type: normalizePayType(s.type || ""),
    name: normStr(s.name || s.bank || s.label || "").toLowerCase(),
  }));

  for (const opm of offerPM) {
    const ot = normalizePayType(opm.type || "");
    const on = normStr(opm.name || opm.bank || "").toLowerCase();
    if (!on) continue;

    for (const s of sel) {
      const typeOk = !ot || !s.type || ot === s.type;
      const nameOk = on === s.name || on.includes(s.name) || s.name.includes(on);
      if (typeOk && nameOk) return true;
    }
  }

  return false;
}

function computeSavings(price, offer) {
  if (price <= 0) return 0;

  // % based
  let percentSaving = 0;
  if (offer.discountPercent > 0) {
    percentSaving = (price * offer.discountPercent) / 100;
    if (offer.maxDiscountAmount > 0) {
      percentSaving = Math.min(percentSaving, offer.maxDiscountAmount);
    }
  }

  // flat amount
  let flatSaving = 0;
  if (offer.flatDiscountAmount > 0) {
    flatSaving = offer.flatDiscountAmount;
  }

  return Math.max(percentSaving, flatSaving, 0);
}

// --------------------
// Caches
// --------------------
let paymentOptionsCache = { at: 0, data: null };
let offersCache = { at: 0, data: null };
const CACHE_MS = 10 * 60 * 1000;

async function getAllOffersCached() {
  const now = Date.now();
  if (offersCache.data && now - offersCache.at < CACHE_MS) return offersCache.data;

  const col = await getOffersCollection();

  // Keep projection small-ish; schema can be large
  const docs = await col
    .find({}, {
      projection: {
        title: 1,
        couponCode: 1,
        code: 1,
        discountPercent: 1,
        discountAmount: 1,
        flatDiscountAmount: 1,
        maxDiscountAmount: 1,
        minTransactionValue: 1,
        minAmount: 1,
        isExpired: 1,
        validityPeriod: 1,
        sourcePortal: 1,
        sourceMetadata: 1,
        rawDiscount: 1,
        paymentMethods: 1,
        parsedFields: 1,
        rawFields: 1,
      }
    })
    .limit(50000)
    .toArray();

  const offers = docs.map(extractOfferCore).filter((o) => o.sourcePortal);
  offersCache = { at: now, data: offers };
  return offers;
}

// --------------------
// Routes
// --------------------

// REAL payment options from Mongo (NO static fallback)
app.get("/payment-options", async (req, res) => {
  try {
    const now = Date.now();
    if (paymentOptionsCache.data && now - paymentOptionsCache.at < CACHE_MS) {
      return res.json({ usedFallback: false, options: paymentOptionsCache.data });
    }

    const offers = await getAllOffersCached();

    const grouped = {
      "Credit Card": new Set(),
      "Debit Card": new Set(),
      "EMI": new Set(),
      "Net Banking": new Set(),
      "UPI": new Set(),
      "Wallet": new Set(),
    };

    for (const o of offers) {
      if (o.isExpired) continue;

      for (const pm of o.paymentMethods || []) {
        const type = normalizePayType(pm.type || "");
        const name = normStr(pm.name || "");
        if (!name) continue;

        if (grouped[type]) grouped[type].add(name);
      }
    }

    // convert sets -> sorted arrays
    const options = {};
    for (const [k, v] of Object.entries(grouped)) {
      options[k] = Array.from(v).sort((a, b) => a.localeCompare(b));
    }

    paymentOptionsCache = { at: now, data: options };
    return res.json({ usedFallback: false, options });
  } catch (e) {
    return res.status(500).json({
      usedFallback: false,
      options: { "Credit Card": [], "Debit Card": [], "EMI": [], "Net Banking": [], "UPI": [], "Wallet": [] },
      error: e?.message || "Failed to load payment options",
    });
  }
});

// Search flights + apply best offers
app.post("/search", async (req, res) => {
  const body = req.body || {};
  const meta = {
    source: "flightapi",
    outStatus: 0,
    retStatus: 0,
    request: {},
    offerEngine: { markup: OTA_MARKUP, portals: PORTALS },
  };

  try {
    let { from, to, departureDate, returnDate, tripType, passengers, travelClass, paymentMethods } = body;

    const outDate = toISO(departureDate);
    const retDate = toISO(returnDate);

    // normalize class for FlightAPI
    const clsRaw = normStr(travelClass || "economy").toLowerCase();
    const cls =
      clsRaw.includes("premium") ? "PREMIUM_ECONOMY"
      : clsRaw.includes("business") ? "BUSINESS"
      : clsRaw.includes("first") ? "FIRST"
      : "ECONOMY";

    const adults = Number(passengers) || 1;
    const currency = "INR";

    if (!from || !to || !outDate) {
      return res.status(400).json({ meta: { ...meta, error: "Missing from/to/departureDate" }, outboundFlights: [], returnFlights: [] });
    }

    // fetch outbound
    const outRes = await fetchOneWaySmart({ from, to, date: outDate, adults, travelClass: cls, currency });
    meta.outStatus = outRes.status;
    meta.request.outTried = outRes.tried;

    // fetch return if needed
    let retFlights = [];
    if (tripType === "round-trip" && retDate) {
      const retRes = await fetchOneWaySmart({ from: to, to: from, date: retDate, adults, travelClass: cls, currency });
      meta.retStatus = retRes.status;
      meta.request.retTried = retRes.tried;
      retFlights = mapFlights(retRes.data);
    }

    const outFlights = mapFlights(outRes.data);

    // Apply offers
    const offers = await getAllOffersCached();
    const selected = Array.isArray(paymentMethods) ? paymentMethods : [];

    function applyOffersToFlight(f) {
      const base = safeNum(f.price, 0);
      const portalPrices = [];

      for (const portal of PORTALS) {
        const portalBase = base + OTA_MARKUP;

        // offers only for this portal + active + matches selected payments
        const candidates = offers.filter((o) =>
          o.sourcePortal === portal &&
          !o.isExpired &&
          matchOfferToSelectedPayments(o, selected) &&
          (o.minTransactionValue <= 0 || portalBase >= o.minTransactionValue)
        );

        let bestOffer = null;
        let bestFinal = portalBase;

        for (const o of candidates) {
          const saving = computeSavings(portalBase, o);
          const final = Math.max(0, portalBase - saving);
          if (final < bestFinal) {
            bestFinal = final;
            bestOffer = o;
          }
        }

        portalPrices.push({
          portal,
          basePrice: portalBase,
          finalPrice: bestFinal,
          savings: Math.max(0, portalBase - bestFinal),
          offer: bestOffer
            ? {
                title: bestOffer.title,
                offerText: bestOffer.offerText,
                code: bestOffer.code,
                minTransactionValue: bestOffer.minTransactionValue,
              }
            : null,
        });
      }

      // best deal across portals
      const sorted = portalPrices.slice().sort((a, b) => a.finalPrice - b.finalPrice);
      const best = sorted[0] || null;

      return {
        ...f,
        price: base,
        bestDeal: best
          ? {
              portal: best.portal,
              finalPrice: best.finalPrice,
              savings: best.savings,
              offerText: best.offer?.offerText || "",
              code: best.offer?.code || "",
            }
          : null,
        portalPrices,
      };
    }

    const outFinal = outFlights.map(applyOffersToFlight);
    const retFinal = retFlights.map(applyOffersToFlight);

    return res.json({ meta, outboundFlights: outFinal, returnFlights: retFinal });
  } catch (e) {
    const st = e?.response?.status || 500;
    const bodyStr = typeof e?.response?.data === "string"
      ? e.response.data
      : (e?.response?.data ? JSON.stringify(e.response.data) : "");
    meta.error = e?.message || "Search failed";
    meta.outStatus ||= st;
    meta.request.errorBody = bodyStr?.slice(0, 600);
    return res.status(500).json({ meta, outboundFlights: [], returnFlights: [] });
  }
});

app.listen(PORT, () => {
  console.log(`SkyDeal backend listening on ${PORT}`);
});
