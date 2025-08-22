// index.js  — SkyDeal backend (ESM)
// --------------------------------------------------
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { MongoClient, ServerApiVersion } from "mongodb";

const app = express();

// ---------- CORS (explicit allowlist + preflight) ----------
const ALLOWED_ORIGINS = [
  "https://skydeal-frontend-git-main-kapils-projects-0b446913.vercel.app",
  "https://skydeal-frontend.vercel.app",
];
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
    maxAge: 86400,
  })
);
app.options("*", cors());

app.use(express.json());

// -------------------- CONFIG -----------------------
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB  = process.env.MONGODB_DB || "skydeal";

const PORTALS = ["MakeMyTrip", "Goibibo", "EaseMyTrip", "Yatra", "Cleartrip"];
const PAYMENT_TYPES = ["Credit Card", "Debit Card", "EMI", "NetBanking", "Wallet", "UPI"];

// -------------------- MONGO ------------------------
let mongoClient;
let db;
async function initMongo() {
  if (db) return db;
  mongoClient = new MongoClient(MONGODB_URI, { serverApi: ServerApiVersion.v1 });
  await mongoClient.connect();
  db = mongoClient.db(MONGODB_DB);
  console.log("✅ Mongo connected:", MONGODB_DB);
  return db;
}

// -------------------- HELPERS ----------------------
function asMoney(x) {
  if (x == null) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function toISODateStr(d) {
  try {
    if (!d) return null;
    const s = String(d).trim();
    const m1 = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m1) { const [, dd, mm, yyyy] = m1; return `${yyyy}-${mm}-${dd}`; }
    const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m2) return s;
    const dt = new Date(s);
    if (Number.isNaN(dt.getTime())) return null;
    return dt.toISOString().slice(0, 10);
  } catch { return null; }
}

function isOfferActiveForDate(offer, travelISO) {
  if (offer.isExpired === true) return false;
  const end =
    offer?.validityPeriod?.end ??
    offer?.validityPeriod?.to ??
    offer?.validityPeriod?.endDate ??
    offer?.validityPeriod?.till ??
    offer?.validityPeriod?.until ?? null;
  const endISO = toISODateStr(end);
  if (!endISO) return true;
  return travelISO <= endISO;
}

function normalizeUserPaymentChoices(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.map((s) => String(s || "").trim().toLowerCase()).filter(Boolean);
}

// --------- Payment label helpers ----------
const DISPLAY = {
  "credit card": "Credit Card",
  "debit card": "Debit Card",
  "emi": "Credit Card EMI",
  "netbanking": "NetBanking",
  "wallet": "Wallet",
  "upi": "UPI",
};
function titleCase(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
function looksComplete(bank) {
  return /(card|emi|net ?bank|wallet|upi)/i.test(bank || "");
}
function makePaymentLabel(bank, type) {
  if (/^(all|any)$/i.test(bank)) return DISPLAY[type?.toLowerCase()] || type || "";
  if (looksComplete(bank)) return titleCase(bank);
  return `${titleCase(bank)} ${DISPLAY[type?.toLowerCase()] || type || ""}`.trim();
}

// --- Canonical bank normalization so options list stays clean ---
function normalizeBankName(raw) {
  if (!raw) return "";
  let s = String(raw).trim().replace(/\s+/g, " ").toLowerCase();

  // common noise
  s = s.replace(/\bltd\.?\b/g, "").replace(/\blimited\b/g, "").replace(/\bplc\b/g, "").trim();

  // co-brands & aliases → parent bank
  const map = [
    [/amazon\s*pay\s*icici/i, "ICICI Bank"],
    [/^icici\b/i, "ICICI Bank"],

    [/flipkart\s*axis/i, "Axis Bank"],
    [/^axis\b/i, "Axis Bank"],

    [/\bau\s*small\s*finance\b/i, "AU Small Finance Bank"],

    [/\bbobcard\b/i, "Bank of Baroda"],
    [/bank\s*of\s*baroda|^bob\b/i, "Bank of Baroda"],

    [/\bsbi\b|state\s*bank\s*of\s*india/i, "State Bank of India"],

    [/hdfc/i, "HDFC Bank"],
    [/kotak/i, "Kotak"],
    [/yes\s*bank/i, "YES Bank"],
    [/idfc/i, "IDFC First Bank"],
    [/indusind/i, "IndusInd Bank"],
    [/federal/i, "Federal Bank"],
    [/rbl/i, "RBL Bank"],
    [/standard\s*chartered/i, "Standard Chartered"],
    [/hsbc/i, "HSBC"],
    [/canara/i, "Canara Bank"],
    [/bob\s*card/i, "Bank of Baroda"],
  ];

  for (const [rx, canon] of map) {
    if (rx.test(raw)) return canon;
    if (rx.test(s)) return canon;
  }

  const cleaned = titleCase(s.replace(/\b(bank|card|cards)\b/gi, "").trim());
  return cleaned || titleCase(String(raw).trim());
}

function extractPaymentMethodLabel(offerDoc) {
  if (offerDoc.paymentMethodLabel) return offerDoc.paymentMethodLabel;
  if (Array.isArray(offerDoc.paymentMethods) && offerDoc.paymentMethods.length) {
    const first = offerDoc.paymentMethods[0];
    if (typeof first === "string") return first.trim();
    if (first && (first.bank || first.type || first.cardNetwork)) {
      const bank = normalizeBankName(first.bank || "");
      const type = first.type || "";
      return makePaymentLabel(bank, type);
    }
  }
  const text = `${offerDoc.title || ""} ${offerDoc.rawDiscount || ""}`;
  if (/wallet/i.test(text)) return "Wallet";
  if (/\bupi\b/i.test(text)) return "UPI";
  if (/net\s*bank|netbank/i.test(text)) return "NetBanking";
  if (/debit/i.test(text)) return "Debit Card";
  if (/credit|emi/i.test(text)) return "Credit Card";
  return "—";
}

// -------------------- AMADEUS ----------------------
let cachedToken = null;
let tokenExpiry = 0;

async function getAmadeusToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry - 30_000) return cachedToken;

  const res = await fetch("https://test.api.amadeus.com/v1/security/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.AMADEUS_API_KEY,
      client_secret: process.env.AMADEUS_API_SECRET,
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Amadeus token error: ${res.status} ${t}`);
  }
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in || 1800) * 1000;
  return cachedToken;
}

function mapAmadeusToUI(itin, dictionaries) {
  const seg = itin?.itineraries?.[0]?.segments?.[0];
  const carrierCode = seg?.carrierCode || itin?.validatingAirlineCodes?.[0] || "NA";
  const airlineName = dictionaries?.carriers?.[carrierCode] || carrierCode;
  const departure = seg?.departure?.at ? new Date(seg.departure.at).toTimeString().slice(0,5) : "--:--";
  const arrival   = seg?.arrival?.at   ? new Date(seg.arrival.at).toTimeString().slice(0,5)   : "--:--";
  const flightNum = `${carrierCode} ${seg?.number || ""}`.trim();
  const stops = (itin?.itineraries?.[0]?.segments?.length || 1) - 1;
  const price = Number(itin?.price?.grandTotal || itin?.price?.total || 0) || 0;
  return { flightNumber: flightNum, airlineName, departure, arrival, price: price.toFixed(2), stops };
}

async function fetchAmadeusOffers({ from, to, date, adults, travelClass }) {
  const token = await getAmadeusToken();
  const url = new URL("https://test.api.amadeus.com/v2/shopping/flight-offers");
  url.search = new URLSearchParams({
    originLocationCode: from,
    destinationLocationCode: to,
    departureDate: date,
    adults: String(adults || 1),
    travelClass: travelClass || "ECONOMY",
    currencyCode: "INR",
    max: "20",
  });
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Amadeus search error: ${res.status} ${t}`);
  }
  const json = await res.json();
  const dict = json?.dictionaries || {};
  return (json?.data || []).map((d) => mapAmadeusToUI(d, dict));
}

// -------------------- OFFERS LOOKUP ----------------
async function loadActiveCouponOffersByPortal({ travelISO }) {
  const collection = (await initMongo()).collection("offers");

  const today = travelISO;
  const orValidity = [
    { validityPeriod: { $exists: false } },
    {
      $and: [
        { "validityPeriod.end": { $exists: false } },
        { "validityPeriod.to": { $exists: false } },
        { "validityPeriod.endDate": { $exists: false } },
        { "validityPeriod.till": { $exists: false } },
        { "validityPeriod.until": { $exists: false } },
      ],
    },
    { "validityPeriod.end": { $gte: today } },
    { "validityPeriod.to": { $gte: today } },
    { "validityPeriod.endDate": { $gte: today } },
    { "validityPeriod.till": { $gte: today } },
    { "validityPeriod.until": { $gte: today } },
  ];

  const cursor = collection.find({
    couponCode: { $exists: true, $ne: "" },
    isExpired: { $ne: true },
    "sourceMetadata.sourcePortal": { $in: PORTALS },
    $or: orValidity,
  });

  const byPortal = new Map(PORTALS.map((p) => [p, []]));
  for await (const doc of cursor) {
    const portal = doc?.sourceMetadata?.sourcePortal;
    if (byPortal.has(portal)) byPortal.get(portal).push(doc);
  }
  return byPortal;
}

// -------------------- ROUTES -----------------------
app.get("/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), now: new Date().toISOString() });
});

// 🔍 Debug helpers (optional)
app.get("/debug-emi", async (_req, res) => {
  const collection = (await initMongo()).collection("offers");
  const docs = await collection.find(
    { "paymentMethods.type": /emi/i },
    { projection: { paymentMethods: 1, title: 1 } }
  ).limit(40).toArray();
  res.json(docs);
});

app.get("/debug-types", async (_req, res) => {
  const c = (await initMongo()).collection("offers");
  const cur = c.find({}, { projection: { paymentMethods: 1 }, limit: 2000 });
  const counts = {};
  const norm = (s) => (typeof s === "string" ? s.trim() : "");
  const normType = (t) => {
    const x = norm(t).toLowerCase();
    if (!x) return "(empty)";
    if (/\bemi\b/.test(x)) return "EMI";
    if (/credit|cc/.test(x)) return "Credit Card";
    if (/debit/.test(x)) return "Debit Card";
    if (/net\s*bank|netbank/.test(x)) return "NetBanking";
    if (/wallet/.test(x)) return "Wallet";
    if (/\bupi\b/.test(x)) return "UPI";
    return `other:${x}`;
  };
  for await (const d of cur) {
    const a = Array.isArray(d.paymentMethods) ? d.paymentMethods : [];
    for (const pm of a) {
      if (typeof pm === "string") {
        const s = pm.toLowerCase();
        const type =
          /\bemi\b/.test(s) ? "EMI" :
          /credit|cc/.test(s) ? "Credit Card" :
          /debit/.test(s) ? "Debit Card" :
          /net\s*bank|netbank/.test(s) ? "NetBanking" :
          /wallet/.test(s) ? "Wallet" :
          /\bupi\b/.test(s) ? "UPI" : "other";
        counts[type] = (counts[type] || 0) + 1;
      } else if (pm && typeof pm === "object") {
        const k = normType(pm.type ?? pm.method ?? pm.category ?? pm.mode);
        counts[k] = (counts[k] || 0) + 1;
      }
    }
  }
  res.json(counts);
});

// -------------------- PAYMENT OPTIONS -----------------------
// Returns { options: { "EMI": ["HSBC (Credit Card EMI)", "Federal Bank (Debit Card EMI)", ...], ... } }
app.get("/payment-options", async (_req, res) => {
  try {
    const collection = (await initMongo()).collection("offers");

    const today = new Date().toISOString().slice(0, 10);
    const activeValidityOr = [
      { validityPeriod: { $exists: false } },
      {
        $and: [
          { "validityPeriod.end": { $exists: false } },
          { "validityPeriod.to": { $exists: false } },
          { "validityPeriod.endDate": { $exists: false } },
          { "validityPeriod.till": { $exists: false } },
          { "validityPeriod.until": { $exists: false } },
        ],
      },
      { "validityPeriod.end": { $gte: today } },
      { "validityPeriod.to": { $gte: today } },
      { "validityPeriod.endDate": { $gte: today } },
      { "validityPeriod.till": { $gte: today } },
      { "validityPeriod.until": { $gte: today } },
    ];

    const cursor = collection.find(
      { isExpired: { $ne: true }, $or: activeValidityOr },
      { projection: { paymentMethods: 1, title: 1, rawDiscount: 1 }, limit: 4000 }
    );

    const TYPES = PAYMENT_TYPES;
    const optionsSets = Object.fromEntries(TYPES.map((t) => [t, new Set()]));

    const KNOWN_BANKS = [
      "ICICI Bank","HDFC Bank","Axis Bank","State Bank of India","SBI","Kotak",
      "YES Bank","IDFC First Bank","IndusInd Bank","Bank of Baroda","RBL Bank",
      "HSBC","Standard Chartered","AU Small Finance Bank","Federal Bank","IDBI Bank",
      "Bajaj Finserv","Canara Bank","Flipkart Axis"
    ];
    const banksFromText = (text) => {
      const res = new Set();
      const t = String(text || "");
      if (!t) return res;
      KNOWN_BANKS.forEach((b) => {
        const rx = new RegExp(`\\b${b.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "i");
        if (rx.test(t)) res.add(normalizeBankName(b));
      });
      if (res.has("SBI") && !res.has("State Bank of India")) {
        res.delete("SBI");
        res.add("State Bank of India");
      }
      return res;
    };

    const normType = (t) => {
      const x = String(t || "").toLowerCase();
      if (!x) return null;
      if (/\bemi\b/.test(x)) return "EMI";
      if (/credit|cc/.test(x)) return "Credit Card";
      if (/debit/.test(x)) return "Debit Card";
      if (/net\s*bank|netbank/.test(x)) return "NetBanking";
      if (/wallet/.test(x)) return "Wallet";
      if (/\bupi\b/.test(x)) return "UPI";
      return null;
    };

    const emiLabel = (bank, via) => {
      const v = (String(via||"").toLowerCase().includes("debit")) ? "Debit Card EMI" : "Credit Card EMI";
      return `${bank} (${v})`;
    };

    for await (const doc of cursor) {
      const pm = Array.isArray(doc.paymentMethods) ? doc.paymentMethods : [];

      // 1) Structured entries (objects)
      for (const entry of pm) {
        if (entry && typeof entry === "object") {
          const type =
            normType(entry.type) ||
            normType(entry.method) ||
            normType(entry.category) ||
            normType(entry.mode);
          const rawBank =
            String(entry.bank || entry.cardBank || entry.issuer || entry.cardIssuer || entry.provider || "").trim();

          if (type && rawBank) {
            const bank = normalizeBankName(rawBank);
            if (bank) {
              if (type === "EMI") {
                const via = (entry.type || entry.mode || entry.category || "").toLowerCase();
                optionsSets["EMI"].add(emiLabel(bank, via));
                optionsSets["Credit Card"].add(bank); // discovery
              } else {
                optionsSets[type].add(bank);
              }
            }
          }
        }
        // 2) String-only entries ("HSBC Credit Card EMI")
        else if (typeof entry === "string") {
          const s = entry;
          const type =
            /\bemi\b/i.test(s) ? "EMI" :
            /credit|cc/i.test(s) ? "Credit Card" :
            /debit/i.test(s) ? "Debit Card" :
            /net\s*bank|netbank/i.test(s) ? "NetBanking" :
            /wallet/i.test(s) ? "Wallet" :
            /\bupi\b/i.test(s) ? "UPI" : null;

          if (type) {
            const rawBank = s.replace(/credit\s*card|debit\s*card|\bemi\b|net\s*bank(?:ing)?|upi|wallet/gi, "").trim();
            const bank = normalizeBankName(rawBank);
            if (bank) {
              if (type === "EMI") {
                const via = /\bdebit\b/i.test(s) ? "debit" : "credit";
                optionsSets["EMI"].add(emiLabel(bank, via));
                optionsSets["Credit Card"].add(bank);
              } else {
                optionsSets[type].add(bank);
              }
            }
          }
        }
      }

      // 3) Titles / rawDiscount fallbacks
      if (!pm.length) {
        const text = `${doc.title || ""} ${doc.rawDiscount || ""}`;
        const hits = new Set();
        if (/\bemi\b/i.test(text)) hits.add("EMI");
        if (/credit|cc/i.test(text)) hits.add("Credit Card");
        if (/debit/i.test(text)) hits.add("Debit Card");
        if (/net\s*bank|netbank/i.test(text)) hits.add("NetBanking");
        if (/wallet/i.test(text)) hits.add("Wallet");
        if (/\bupi\b/i.test(text)) hits.add("UPI");

        const banks = banksFromText(text);
        if (banks.size && hits.size) {
          for (const t of hits) {
            if (t === "EMI") {
              const via = /\bdebit\b/i.test(text) ? "debit" : "credit";
              banks.forEach((b) => optionsSets["EMI"].add(emiLabel(b, via)));
              banks.forEach((b) => optionsSets["Credit Card"].add(b));
            } else {
              banks.forEach((b) => optionsSets[t].add(b));
            }
          }
        }
      }
    }

    // Final shape: arrays sorted
    const out = {};
    PAYMENT_TYPES.forEach((t) => {
      out[t] = Array.from(optionsSets[t]).sort((a, b) => a.localeCompare(b));
    });

    res.json({ options: out });
  } catch (e) {
    console.error("X /payment-options error:", e);
    res.status(500).json({ options: {} });
  }
});

app.get("/payment-methods", async (_req, res) => {
  try {
    const collection = (await initMongo()).collection("offers");

    const cursor = collection.find(
      {},
      { projection: { paymentMethods: 1, title: 1, rawDiscount: 1 }, limit: 4000 }
    );

    const set = new Map();
    for await (const doc of cursor) {
      const label = extractPaymentMethodLabel(doc);
      const canon = label.toLowerCase().replace(/\s+/g, " ").trim();
      if (canon && !set.has(canon)) set.set(canon, label);
    }
    const methods = Array.from(set.values()).sort((a, b) => a.localeCompare(b));
    methods.push("Other");
    res.json({ methods });
  } catch (e) {
    console.error("X /payment-methods error:", e.message);
    res.status(500).json({ methods: [] });
  }
});

// -------------------- STRICT PAYMENT MATCHING -----------------------
function offerMatchesPayment(offer, selected) {
  // if nothing selected, allow all (frontend fix should prevent this)
  if (!selected || selected.length === 0) return true;

  // normalize selected into lower-case labels
  const sel = selected.map(s => String(s||'').toLowerCase().trim()).filter(Boolean);
  if (sel.length === 0) return true;

  // build canonical labels for the offer's payment methods
  const list = Array.isArray(offer.paymentMethods) ? offer.paymentMethods : [];
  const labels = [];

  for (const pm of list) {
    if (typeof pm === "string") {
      const s = pm.toLowerCase().trim();
      labels.push(s);

      const bankOnly = s.replace(/credit\s*card|debit\s*card|\bemi\b|net\s*bank(?:ing)?|upi|wallet/gi, "").trim();
      if (bankOnly) {
        const b = normalizeBankName(bankOnly).toLowerCase();
        labels.push(b);
        if (/\bemi\b/i.test(s)) {
          const via = /\bdebit\b/i.test(s) ? "debit card emi" : "credit card emi";
          labels.push(`${b} ${via}`);
        } else if (/credit|cc/i.test(s)) {
          labels.push(`${b} credit card`);
        } else if (/debit/i.test(s)) {
          labels.push(`${b} debit card`);
        }
      }
    } else if (pm && typeof pm === "object") {
      const bank = normalizeBankName(pm.bank || pm.cardBank || pm.issuer || pm.cardIssuer || pm.provider || "");
      const typeStr = String(pm.type || pm.method || pm.category || pm.mode || "").toLowerCase();
      const b = bank.toLowerCase().trim();
      if (b) {
        labels.push(b);
        if (/\bemi\b/.test(typeStr)) {
          const via = /debit/.test(typeStr) ? "debit card emi" : "credit card emi";
          labels.push(`${b} ${via}`);
        } else if (/credit|cc/.test(typeStr)) {
          labels.push(`${b} credit card`);
        } else if (/debit/.test(typeStr)) {
          labels.push(`${b} debit card`);
        }
      }
    }
  }

  // match if any selected token overlaps our canonicalized label set
  return sel.some(s => {
    const simplified = s.replace(/[()]/g, "").replace(/\s+/g, " ").trim();
    return labels.some(l => l.includes(s) || s.includes(l) || l.includes(simplified));
  });
}

// -------------------- SEARCH -----------------------
function applyBestOfferForPortal({ basePrice, portal, offers, travelISO, selectedPayments }) {
  let best = { finalPrice: basePrice, discountApplied: 0, appliedOffer: null };
  for (const offer of offers) {
    if (!offer.couponCode) continue;
    if (!isOfferActiveForDate(offer, travelISO)) continue;
    if (!offerMatchesPayment(offer, selectedPayments)) continue;

    const minTxn = asMoney(offer.minTransactionValue) ?? 0;
    if (basePrice < minTxn) continue;

    const pct = offer.discountPercent != null ? Number(offer.discountPercent) : null;
    const cap = asMoney(offer.maxDiscountAmount);
    if (pct == null || !Number.isFinite(pct) || pct <= 0) continue;

    let discount = Math.floor((basePrice * pct) / 100);
    if (cap != null && cap > 0) discount = Math.min(discount, cap);
    if (discount <= 0) continue;

    const finalPrice = basePrice - discount;
    if (finalPrice < best.finalPrice) {
      best = {
        finalPrice,
        discountApplied: discount,
        appliedOffer: {
          portal: offer?.sourceMetadata?.sourcePortal || portal,
          couponCode: offer.couponCode,
          discountPercent: Number.isFinite(pct) ? pct : null,
          maxDiscountAmount: cap ?? null,
          minTransactionValue: minTxn || null,
          validityPeriod: offer.validityPeriod || null,
          rawDiscount: offer.rawDiscount || null,
          title: offer.title || null,
          offerId: String(offer._id),
          paymentMethodLabel: extractPaymentMethodLabel(offer),
        },
      };
    }
  }
  if (best.appliedOffer) {
    console.log(`✅ Offer: portal=${portal} base=${basePrice} final=${best.finalPrice} code=${best.appliedOffer.couponCode} pm=${best.appliedOffer.paymentMethodLabel}`);
  } else {
    console.log(`— No offer: portal=${portal} base=${basePrice}`);
  }
  return best;
}

function makeMockFlights({ from, to, date, count = 6 }) {
  const carriers = [
    { code: "AI", name: "Air India" },
    { code: "UK", name: "Vistara" },
    { code: "6E", name: "IndiGo" },
    { code: "SG", name: "SpiceJet" },
    { code: "G8", name: "Go First" },
  ];
  const base = 4500;
  const out = [];
  for (let i = 0; i < count; i++) {
    const c = carriers[i % carriers.length];
    const dep = new Date(`${date}T0${(8 + i) % 10}:00:00Z`);
    const arr = new Date(dep.getTime() + (90 + i * 10) * 60000);
    const price = base + i * 350 + Math.round(Math.random() * 400);
    out.push({
      flightNumber: `${c.code} ${100 + i}`,
      airlineName: c.name,
      departure: dep.toISOString().slice(11, 16),
      arrival: arr.toISOString().slice(11, 16),
      price: price.toFixed(2),
      stops: i % 3 === 0 ? 1 : 0,
    });
  }
  return out;
}

app.post("/search", async (req, res) => {
  try {
    const {
      from, to,
      departureDate, returnDate,
      passengers = 1,
      travelClass = "ECONOMY",
      tripType = "round-trip",
      paymentMethods = [],
    } = req.body || {};

    const depISO = toISODateStr(departureDate);
    const retISO = toISODateStr(returnDate);
    if (!from || !to || !depISO) return res.status(400).json({ error: "Missing required fields" });

    const selectedPayments = normalizeUserPaymentChoices(paymentMethods);
    const offersByPortal = await loadActiveCouponOffersByPortal({ travelISO: depISO });

    // Outbound
    let outbound = [];
    try {
      outbound = await fetchAmadeusOffers({ from, to, date: depISO, adults: passengers, travelClass });
    } catch (e) {
      console.error("Amadeus outbound failed:", e.message);
      outbound = makeMockFlights({ from, to, date: depISO });
    }

    // Return
    let retFlights = [];
    if (tripType === "round-trip" && retISO) {
      try {
        retFlights = await fetchAmadeusOffers({ from: to, to: from, date: retISO, adults: passengers, travelClass });
      } catch (e) {
        console.error("Amadeus return failed:", e.message);
        retFlights = makeMockFlights({ from: to, to: from, date: retISO });
      }
    }

    // Decorate with portal prices/offers
    function decorateWithPortalPrices(flight, travelISO) {
      const base = asMoney(flight.price) || 0;
      const prices = PORTALS.map((portal) => {
        const portalOffers = offersByPortal.get(portal) || [];
        const best = applyBestOfferForPortal({ basePrice: base, portal, offers: portalOffers, travelISO, selectedPayments });
        return {
          portal,
          basePrice: base,
          finalPrice: best.finalPrice,
          ...(best.discountApplied > 0 ? { discountApplied: best.discountApplied } : {}),
          appliedOffer: best.appliedOffer,
        };
      });
      return { ...flight, portalPrices: prices };
    }

    const outboundDecorated = outbound.map((f) => decorateWithPortalPrices(f, depISO));
    const returnDecorated = retFlights.map((f) => decorateWithPortalPrices(f, retISO || depISO));

    const usedFallback =
      outbound.some(f => !/^[A-Z0-9]+ \d+$/.test(f.flightNumber || "")) ||
      (tripType === "round-trip" && retFlights.length > 0 &&
       retFlights.some(f => !/^[A-Z0-9]+ \d+$/.test(f.flightNumber || "")));

    res.json({
      outboundFlights: outboundDecorated,
      returnFlights: returnDecorated,
      meta: { fallback: usedFallback ? "mock" : "live" }
    });
  } catch (err) {
    console.error("X /search error:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// -------------------- START ------------------------
app.listen(PORT, async () => {
  try { await initMongo(); } catch (e) { console.error("Mongo init failed:", e.message); }
  console.log(`🚀 SkyDeal backend listening on :${PORT}`);
});
