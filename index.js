// index.js — SkyDeal backend (FlightAPI version, airline-official price + ₹250 portal markup)
import express from "express";
import cors from "cors";
import { MongoClient, ServerApiVersion } from "mongodb";

// -------------------- CONFIG -----------------------
const app = express();
const PORT = process.env.PORT || 10000;

// Mongo
const MONGODB_URI = process.env.MONGODB_URI || "";
const MONGODB_DB  = process.env.MONGODB_DB  || "skydeal";

// FlightAPI
const FLIGHTAPI_KEY  = process.env.FLIGHTAPI_KEY; // required
const FLIGHTAPI_BASE = "https://api.flightapi.io";

// UI constants
const PORTALS = ["MakeMyTrip", "Goibibo", "EaseMyTrip", "Yatra", "Cleartrip"];
const INR_MARKUP_PER_PORTAL = 250;

// Payment types used for /payment-options formatting
const PAYMENT_TYPES = ["Credit Card", "Debit Card", "EMI", "NetBanking", "Wallet", "UPI"];

// -------------------- MIDDLEWARE (CORS always-on) -----------------------
app.use((req, res, next) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(cors({ origin: true, credentials: false }));
app.use(express.json());

// -------------------- HEALTH -----------------------
app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// -------------------- MONGO ------------------------
let db = null;
async function initMongo() {
  if (db || !MONGODB_URI) return db;
  const cli = new MongoClient(MONGODB_URI, { serverApi: ServerApiVersion.v1 });
  await cli.connect();
  db = cli.db(MONGODB_DB);
  console.log("✅ Mongo connected:", MONGODB_DB);
  return db;
}

// -------------------- SMALL UTILS ------------------
function toISO(d) {
  if (!d) return null;
  const s = String(d).trim();
  const m1 = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);      // dd/mm/yyyy
  if (m1) return `${m1[3]}-${m1[2]}-${m1[1]}`;
  const m2 = s.match(/^\d{4}-\d{2}-\d{2}$/);              // yyyy-mm-dd
  if (m2) return s;
  const dt = new Date(s);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
}

function titleCase(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function normTypeKey(t) {
  const x = String(t || "").toLowerCase();
  if (!x) return null;
  if (/\bemi\b/.test(x)) return "emi";
  if (/credit|cc/.test(x)) return "credit";
  if (/debit/.test(x)) return "debit";
  if (/net\s*bank|netbank/.test(x)) return "netbanking";
  if (/wallet/.test(x)) return "wallet";
  if (/\bupi\b/.test(x)) return "upi";
  return null;
}

function normalizeBankName(raw) {
  if (!raw) return "";
  let s = String(raw).trim().replace(/\s+/g, " ").toLowerCase();
  s = s.replace(/\bltd\.?\b/g, "").replace(/\blimited\b/g, "").replace(/\bplc\b/g, "").trim();
  const map = [
    [/amazon\s*pay\s*icici/i, "ICICI Bank"], [/^icici\b/i, "ICICI Bank"],
    [/flipkart\s*axis/i, "Axis Bank"],       [/^axis\b/i, "Axis Bank"],
    [/\bau\s*small\s*finance\b/i, "AU Small"],
    [/\bbobcard\b/i, "Bank of Baroda"], [/bank\s*of\s*baroda|^bob\b/i, "Bank of Baroda"],
    [/\bsbi\b|state\s*bank\s*of\s*india/i, "State Bank of India"],
    [/hdfc/i, "HDFC Bank"], [/kotak/i, "Kotak"], [/yes\s*bank/i, "YES Bank"],
    [/idfc/i, "IDFC First Bank"], [/indusind/i, "IndusInd Bank"], [/federal/i, "Federal Bank"],
    [/rbl/i, "RBL Bank"], [/standard\s*chartered/i, "Standard Chartered"],
    [/hsbc/i, "HSBC"], [/canara/i, "Canara Bank"],
  ];
  for (const [rx, canon] of map) if (rx.test(raw) || rx.test(s)) return canon;
  const cleaned = String(s).replace(/\b(bank|card|cards)\b/gi, "").trim();
  return cleaned ? cleaned.replace(/\b[a-z]/g, c => c.toUpperCase()) : String(raw).trim();
}

// -------------------- PAYMENT OPTIONS (from Mongo offers) ---------------
app.get("/payment-options", async (_req, res) => {
  try {
    const database = await initMongo();
    if (!database) return res.json({ options: {} });

    const col = database.collection("offers");
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

    const cursor = col.find(
      { isExpired: { $ne: true }, $or: activeValidityOr },
      { projection: { paymentMethods: 1 }, limit: 4000 }
    );

    const sets = Object.fromEntries(PAYMENT_TYPES.map(t => [t, new Set()]));
    for await (const doc of cursor) {
      const list = Array.isArray(doc.paymentMethods) ? doc.paymentMethods : [];
      for (const pm of list) {
        if (pm && typeof pm === "object") {
          const tkey = normTypeKey(pm.type || pm.method || pm.category || pm.mode);
          const bank = titleCase(normalizeBankName(pm.bank || pm.cardBank || pm.issuer || pm.cardIssuer || pm.provider || ""));
          if (!tkey || !bank) continue;
          if (tkey === "emi") { sets["EMI"].add(`${bank} (Credit Card EMI)`); sets["Credit Card"].add(bank); }
          else if (tkey === "credit") sets["Credit Card"].add(bank);
          else if (tkey === "debit")  sets["Debit Card"].add(bank);
          else if (tkey === "netbanking") sets["NetBanking"].add(bank);
          else if (tkey === "wallet") sets["Wallet"].add(bank);
          else if (tkey === "upi")    sets["UPI"].add(bank);
        } else if (typeof pm === "string") {
          const tkey = normTypeKey(pm);
          const bank = titleCase(normalizeBankName(pm.replace(/credit\s*card|debit\s*card|\bemi\b|net\s*bank(?:ing)?|upi|wallet/gi, "")));
          if (!bank) continue;
          if (tkey === "emi") { sets["EMI"].add(`${bank} (Credit Card EMI)`); sets["Credit Card"].add(bank); }
          else if (tkey === "credit") sets["Credit Card"].add(bank);
          else if (tkey === "debit")  sets["Debit Card"].add(bank);
          else if (tkey === "netbanking") sets["NetBanking"].add(bank);
          else if (tkey === "wallet") sets["Wallet"].add(bank);
          else if (tkey === "upi")    sets["UPI"].add(bank);
        }
      }
    }

    const out = {};
    PAYMENT_TYPES.forEach(t => out[t] = Array.from(sets[t]).sort((a,b)=>a.localeCompare(b)));
    res.json({ options: out });
  } catch (e) {
    console.error("X /payment-options error:", e);
    res.status(500).json({ options: {} });
  }
});

// -------------------- FLIGHTAPI FETCH & MAP -----------------------------

/**
 * Fetches FlightAPI roundtrip JSON (FlightAPI expects both dep/ret in the path).
 */
async function fetchFlightApiRoundTrip({ apiKey, from, to, depISO, retISO, adults = 1, travelClass = "economy", currency = "INR" }) {
  const url = `${FLIGHTAPI_BASE}/roundtrip/${apiKey}/${from}/${to}/${depISO}/${retISO}/${adults}/0/0/${travelClass.toLowerCase()}/${currency}?region=IN`;
  const r = await fetch(url);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`FlightAPI ${r.status}: ${t.slice(0,300)}`);
  }
  return r.json();
}

/**
 * Heuristic to find the airline's own agent price for an itinerary.
 * We compare the itinerary's first segment marketing carrier against agent names/ids.
 */
function pickOfficialPrice(itinerary, root, legsById, segmentsById, carriersById) {
  const leg = legsById[String(itinerary.leg_ids?.[0] || "")];
  if (!leg) return null;
  const seg0 = segmentsById[String(leg.segment_ids?.[0] || "")];
  if (!seg0) return null;

  const carrierId   = String(seg0.marketing_carrier_id || "");
  const carrierName = carriersById[carrierId]?.name?.toLowerCase() || "";
  const carrierTokens = [
    carrierName,
    carrierName.replace(/\s+/g, ""),
    carrierName.split(" ")[0] || ""
  ].filter(Boolean);

  // Known short names → official agent id keywords
  const carrierHints = {
    AI: ["airindia"], IX: ["airindiaexpress", "air india express", "aix", "ix"],
    I5: ["aix connect", "airasia india", "airasia"],  // legacy naming
    6E: ["indigo", "goindigo", "interglobe"],
    UK: ["vistara"],
    SG: ["spicejet"],
    QP: ["akasa", "akasaair", "akasa air"],
    G8: ["goair", "go first", "gofirst"],
  };
  const hints = carrierHints[seg0.marketing_carrier_id] || [];

  const agentsById = Object.fromEntries((root.agents || []).map(a => [String(a.id), a]));
  const options = Array.isArray(itinerary.pricing_options) ? itinerary.pricing_options : [];

  // Find pricing option where ANY agent matches carrier name or hint
  for (const po of options) {
    const ids = Array.isArray(po.agent_ids) ? po.agent_ids.map(String) : [];
    for (const aid of ids) {
      const agent = agentsById[aid];
      if (!agent) continue;
      const aname = String(agent?.name || "").toLowerCase();
      const akey  = String(agent?.id || "").toLowerCase();

      if (hints.some(h => aname.includes(h) || akey.includes(h))) {
        return po.price?.amount ?? null;
      }
      if (carrierTokens.some(tok => tok && (aname.includes(tok) || akey.includes(tok)))) {
        return po.price?.amount ?? null;
      }
    }
  }

  // Fallback to cheapest option if no official found
  const cheapest = options[0]?.price?.amount ?? null;
  return cheapest;
}

/**
 * Map FlightAPI JSON to our UI flights, and split outbound/return by origin.
 */
function mapFlightApiToUI(root, ORG, DST) {
  const carriersById = Object.fromEntries((root.carriers || []).map(c => [String(c.id), c]));
  const segmentsById = Object.fromEntries((root.segments || []).map(s => [String(s.id), s]));
  const legsById     = Object.fromEntries((root.legs || []).map(l => [String(l.id), l]));

  const uiOutbound = [];
  const uiReturn   = [];

  for (const it of (root.itineraries || [])) {
    const leg = legsById[String(it.leg_ids?.[0] || "")];
    if (!leg) continue;
    const seg0 = segmentsById[String(leg.segment_ids?.[0] || "")];
    if (!seg0) continue;

    const carrier = carriersById[String(seg0.marketing_carrier_id)];
    const airlineName = carrier?.name || String(seg0.marketing_carrier_id || "NA");
    const flightNum   = `${seg0.marketing_carrier_id || ""} ${seg0.number || ""}`.trim();
    const depTime     = (leg.departure_time_utc || leg.departure || "").slice(11,16) || "--:--";
    const arrTime     = (leg.arrival_time_utc   || leg.arrival   || "").slice(11,16) || "--:--";
    const stops       = Math.max(0, (leg.segment_ids?.length || 1) - 1);

    const official = pickOfficialPrice(it, root, legsById, segmentsById, carriersById);
    const basePrice = Number(official || 0);

    const flightUI = {
      flightNumber: flightNum,
      airlineName,
      departure: depTime,
      arrival: arrTime,
      price: basePrice.toFixed(2),
      stops,
      carrierCode: String(seg0.marketing_carrier_id || "")
    };

    // crude but effective split by first leg origin
    const originIata = (leg.origin?.iata || leg.origin?.iata_code || leg.origin?.display_code || "").toUpperCase();
    if (originIata === ORG) uiOutbound.push(flightUI);
    else if (originIata === DST) uiReturn.push(flightUI);
    else uiOutbound.push(flightUI); // default bucket if unknown
  }

  return { uiOutbound, uiReturn };
}

// -------------------- SEARCH (FlightAPI + ₹250 portal markup) ----------
app.post("/search", async (req, res) => {
  try {
    if (!FLIGHTAPI_KEY) throw new Error("FLIGHTAPI_KEY missing");

    const {
      from, to,
      departureDate, returnDate,
      passengers = 1,
      travelClass = "Economy",
      tripType = "round-trip",
      // paymentMethods = []   // kept for future offer logic; currently unused
    } = req.body || {};

    const depISO = toISO(departureDate);
    const retISO = toISO(returnDate);
    if (!from || !to || !depISO) {
      return res.status(400).json({ error: "Missing required fields (from, to, departureDate)" });
    }

    const ORG = String(from).trim().toUpperCase();
    const DST = String(to).trim().toUpperCase();
    const useRet = (tripType === "round-trip" && retISO) ? retISO : depISO;

    // Fetch once (FlightAPI returns the pool for both legs)
    const fa = await fetchFlightApiRoundTrip({
      apiKey: FLIGHTAPI_KEY,
      from: ORG, to: DST,
      depISO,
      retISO: useRet,
      adults: passengers,
      travelClass,
      currency: "INR"
    });

    const { uiOutbound, uiReturn } = mapFlightApiToUI(fa, ORG, DST);

    // Decorate with portal prices (airline base + 250)
    function decorate(list) {
      return list.map(f => {
        const base = Number(f.price || 0);
        const portalPrices = PORTALS.map(p => ({
          portal: p,
          basePrice: base,
          finalPrice: base + INR_MARKUP_PER_PORTAL
        }));
        return { ...f, portalPrices };
      });
    }

    const outboundDecorated = decorate(uiOutbound);
    const returnDecorated   = decorate(uiReturn);

    res.json({
      outboundFlights: outboundDecorated,
      returnFlights: returnDecorated,
      meta: { source: "flightapi", pricing: "airline_base_plus_250" }
    });
  } catch (err) {
    console.error("X /search error:", err.message);
    res.status(502).json({ error: "search_failed", message: err.message });
  }
});

// -------------------- START ------------------------
app.listen(PORT, async () => {
  try { await initMongo(); } catch (e) { console.error("Mongo init failed:", e.message); }
  console.log(`🚀 SkyDeal backend (FlightAPI) on :${PORT}`);
});
