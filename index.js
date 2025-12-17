// index.js (SkyDeal backend) — ESM
import express from "express";
import cors from "cors";
import axios from "axios";
import { MongoClient } from "mongodb";

// --------------------
// Setup
// --------------------
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// --------------------
// Config
// --------------------
const OTAS = ["Goibibo", "MakeMyTrip", "Yatra", "EaseMyTrip", "Cleartrip"];

// Your requirement: +₹250 markup across 5 OTAs
const OTA_MARKUP = Number(process.env.OTA_MARKUP || 250);

// Mongo envs
const MONGO_URI = process.env.MONGO_URI;
const MONGODB_DB = process.env.MONGODB_DB || "skydeal";
const MONGO_COL = process.env.MONGO_COL || "offers";

// FlightAPI env
const FLIGHTAPI_KEY = process.env.FLIGHTAPI_KEY;

// --------------------
// Helpers: Date + Cabin
// --------------------
function toISO(d) {
  if (!d) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d; // yyyy-mm-dd
  const m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/); // dd/mm/yyyy
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const t = new Date(d);
  if (!isNaN(t)) return t.toISOString().slice(0, 10);
  return "";
}

// FlightAPI expects: Economy | Premium_Economy | Business | First (based on your earlier notes + typical docs)
function normalizeCabin(travelClass) {
  const v = String(travelClass || "economy").toLowerCase().trim();
  if (v === "premium economy" || v === "premium_economy" || v === "premium-economy") return "Premium_Economy";
  if (v === "business") return "Business";
  if (v === "first") return "First";
  return "Economy";
}

// --------------------
// Mongo (single client)
// --------------------
let _mongoClient = null;

async function getOffersCollection() {
  if (!MONGO_URI) throw new Error("Missing MONGO_URI env var");
  if (!_mongoClient) {
    _mongoClient = new MongoClient(MONGO_URI, {
      // keep defaults; your connection already works for /payment-options
    });
    await _mongoClient.connect();
  }
  return _mongoClient.db(MONGODB_DB).collection(MONGO_COL);
}

// --------------------
// FlightAPI call (FIXED): onewaytrip
// --------------------
function buildOnewayTripUrl({ from, to, date, adults, children, infants, cabin, currency }) {
  if (!FLIGHTAPI_KEY) throw new Error("Missing FLIGHTAPI_KEY env var");

  // IMPORTANT: FlightAPI price search uses /onewaytrip/... not /oneway/...
  // format:
  // https://api.flightapi.io/onewaytrip/<api-key>/<from>/<to>/<date>/<adults>/<children>/<infants>/<cabin>/<currency>
  return `https://api.flightapi.io/onewaytrip/${encodeURIComponent(FLIGHTAPI_KEY)}/${from}/${to}/${date}/${adults}/${children}/${infants}/${cabin}/${currency}`;
}

async function fetchOneWayTrip({ from, to, date, adults = 1, cabin = "Economy", currency = "INR" }) {
  const url = buildOnewayTripUrl({
    from,
    to,
    date,
    adults,
    children: 0,
    infants: 0,
    cabin,
    currency,
  });

  const tried = [{ url }];

  try {
    const r = await axios.get(url, { timeout: 25000 });
    return { status: r.status, data: r.data, tried };
  } catch (e) {
    const st = e?.response?.status || 0;
    const body =
      typeof e?.response?.data === "string"
        ? e.response.data
        : e?.response?.data
          ? JSON.stringify(e.response.data)
          : "";
    tried[0].status = st;
    tried[0].body = body.slice(0, 800);

    const err = new Error(`FlightAPI request failed (${st || "no-status"})`);
    err.status = st || 500;
    err.tried = tried;
    throw err;
  }
}

// --------------------
// Map FlightAPI response to consistent flights
// FlightAPI responses often look "Skyscanner-style" with itineraries/legs/segments/carriers.
// This mapper is defensive.
// --------------------
function mapFlightsFromFlightAPI(raw) {
  const itineraries = Array.isArray(raw?.itineraries) ? raw.itineraries : [];
  const legs = Array.isArray(raw?.legs) ? raw.legs : [];
  const carriers = Array.isArray(raw?.carriers) ? raw.carriers : [];
  const segments = Array.isArray(raw?.segments) ? raw.segments : [];

  const legById = Object.fromEntries(legs.map((l) => [l.id, l]));
  const carrierById = Object.fromEntries(carriers.map((c) => [String(c.id), c]));
  const segmentById = Object.fromEntries(segments.map((s) => [s.id, s]));

  const flights = [];

  for (const it of itineraries) {
    const legId = Array.isArray(it.leg_ids) ? it.leg_ids[0] : null;
    const leg = legId ? legById[legId] : null;

    // cheapest price
    let cheapestAmount = null;
    const pricingOptions = Array.isArray(it.pricing_options) ? it.pricing_options : [];
    for (const opt of pricingOptions) {
      const amount = opt?.price?.amount;
      if (typeof amount === "number") {
        if (cheapestAmount === null || amount < cheapestAmount) cheapestAmount = amount;
      }
    }

    // Carrier name
    const marketingCarrierId = Array.isArray(leg?.marketing_carrier_ids) ? leg.marketing_carrier_ids[0] : null;
    const carrier = marketingCarrierId != null ? carrierById[String(marketingCarrierId)] : null;

    const airlineName = carrier?.name || carrier?.display_name || carrier?.code || "-";

    // flight number guess from first segment
    let flightNumber = "-";
    if (Array.isArray(leg?.segment_ids) && leg.segment_ids.length > 0) {
      const seg = segmentById[leg.segment_ids[0]];
      const num = seg?.flight_number || seg?.marketing_flight_number;
      if (num) flightNumber = String(num);
    }

    const departureTime = leg?.departure || null;
    const arrivalTime = leg?.arrival || null;
    const stops = typeof leg?.stop_count === "number" ? leg.stop_count : 0;

    flights.push({
      airlineName,
      flightNumber,
      departureTime,
      arrivalTime,
      stops,
      price: typeof cheapestAmount === "number" ? cheapestAmount : 0,
      raw: { itinerary: it, leg },
    });
  }

  return flights;
}

// --------------------
// Offer matching + pricing
// --------------------
function normalizePaymentType(t) {
  const v = String(t || "").toLowerCase().trim();
  if (v.includes("credit")) return "Credit Card";
  if (v.includes("debit")) return "Debit Card";
  if (v.includes("net")) return "Net Banking";
  if (v.includes("upi")) return "UPI";
  if (v.includes("wallet")) return "Wallet";
  if (v.includes("emi")) return "EMI";
  return t || "Other";
}

// Extract (type,name) from offer documents with different shapes
function extractOfferPaymentMethods(offer) {
  const out = [];
  const pm = offer?.paymentMethods;

  // Shape A: [{type, bank/network/name, ...}]
  if (Array.isArray(pm)) {
    for (const x of pm) {
      if (typeof x === "string") {
        // string like "ICICI Bank" without type (not ideal)
        out.push({ type: "Other", name: x });
      } else if (x && typeof x === "object") {
        const type = normalizePaymentType(x.type || x.methodType || x.paymentType);
        const name =
          x.name ||
          x.bank ||
          x.bankName ||
          x.provider ||
          x.network ||
          x.cardNetwork ||
          x.issuer ||
          "";
        if (name) out.push({ type, name: String(name) });
      }
    }
  }

  // Shape B: rawFields.paymentMethods may exist
  const rawPM = offer?.rawFields?.paymentMethods;
  if (Array.isArray(rawPM)) {
    for (const x of rawPM) {
      if (x && typeof x === "object") {
        const type = normalizePaymentType(x.type);
        const name = x.name || x.bank || x.network || x.provider;
        if (name) out.push({ type, name: String(name) });
      }
    }
  }

  return out;
}

function offerAppliesToPortal(offer, portalName) {
  // If offer has explicit platform/portal targeting, respect it. Otherwise assume it can apply.
  const candidates = [
    offer?.sourcePortal,
    offer?.sourceMetadata?.sourcePortal,
  ].filter(Boolean);

  if (candidates.length > 0) {
    return candidates.some((p) => String(p).toLowerCase() === String(portalName).toLowerCase());
  }

  const platforms = offer?.parsedApplicablePlatforms || offer?.applicablePlatforms || offer?.platforms;
  if (Array.isArray(platforms) && platforms.length > 0) {
    return platforms.some((p) => String(p).toLowerCase().includes(String(portalName).toLowerCase()));
  }

  return true;
}

function isOfferExpired(offer) {
  if (typeof offer?.isExpired === "boolean") return offer.isExpired;

  // try parsed validityPeriod end
  const end = offer?.validityPeriod?.endDate || offer?.parsedFields?.validityPeriod?.endDate;
  if (end) {
    const t = new Date(end);
    if (!isNaN(t)) return t.getTime() < Date.now();
  }
  return false; // default: not expired if unknown
}

function minTxnOK(offer, amount) {
  const v =
    offer?.minTransactionValue ??
    offer?.parsedFields?.minTransactionValue ??
    offer?.parsedFields?.minTxnValue ??
    null;

  if (typeof v === "number") return amount >= v;

  // sometimes minTransactionValue is string like "4000"
  const n = Number(String(v || "").replace(/[^\d.]/g, ""));
  if (!isNaN(n) && n > 0) return amount >= n;

  return true; // if unknown, do not block
}

function computeDiscountedPrice(offer, baseAmount) {
  // Support percent discount AND flat discount (you explicitly need flat-amount support)
  const percent =
    offer?.discountPercent ??
    offer?.parsedFields?.discountPercent ??
    null;

  const flat =
    offer?.flatDiscountAmount ??
    offer?.parsedFields?.flatDiscountAmount ??
    offer?.discountAmount ??
    offer?.parsedFields?.discountAmount ??
    null;

  let final = baseAmount;

  if (typeof percent === "number" && percent > 0) {
    final = baseAmount * (1 - percent / 100);
  } else {
    const n = Number(String(flat || "").replace(/[^\d.]/g, ""));
    if (!isNaN(n) && n > 0) final = baseAmount - n;
  }

  // cap by maxDiscountAmount if present (if percent was used)
  const maxAmt =
    offer?.maxDiscountAmount ??
    offer?.parsedFields?.maxDiscountAmount ??
    null;

  if (typeof percent === "number" && percent > 0 && maxAmt != null) {
    const maxN = Number(String(maxAmt).replace(/[^\d.]/g, ""));
    if (!isNaN(maxN) && maxN > 0) {
      const discount = baseAmount - final;
      if (discount > maxN) final = baseAmount - maxN;
    }
  }

  // no negative
  if (final < 0) final = 0;
  return Math.round(final);
}

function offerMatchesSelectedPayment(offer, selectedPaymentMethods) {
  if (!Array.isArray(selectedPaymentMethods) || selectedPaymentMethods.length === 0) return true;

  const offerPMs = extractOfferPaymentMethods(offer);
  if (offerPMs.length === 0) return false;

  const sel = selectedPaymentMethods.map((x) => ({
    type: normalizePaymentType(x.type),
    name: String(x.name || "").toLowerCase().trim(),
  }));

  return offerPMs.some((pm) => {
    const t = normalizePaymentType(pm.type);
    const n = String(pm.name || "").toLowerCase().trim();
    return sel.some((s) => s.type === t && s.name === n);
  });
}

function pickBestOfferForPortal(offers, portal, baseAmount, selectedPaymentMethods) {
  let best = null;

  for (const offer of offers) {
    if (isOfferExpired(offer)) continue;
    if (!offerAppliesToPortal(offer, portal)) continue;
    if (!offerMatchesSelectedPayment(offer, selectedPaymentMethods)) continue;
    if (!minTxnOK(offer, baseAmount)) continue;

    const discounted = computeDiscountedPrice(offer, baseAmount);

    if (!best || discounted < best.finalPrice) {
      best = {
        finalPrice: discounted,
        offer,
      };
    }
  }

  return best;
}

async function applyOffersToFlight(flight, selectedPaymentMethods) {
  const col = await getOffersCollection();

  // Pull a reasonable set (you can tighten query later)
  const offers = await col
    .find({}, { projection: { _id: 0 } })
    .toArray();

  const base = typeof flight.price === "number" ? flight.price : 0;

  const portalPrices = OTAS.map((portal) => {
    const portalBase = Math.round(base + OTA_MARKUP);

    const best = pickBestOfferForPortal(offers, portal, portalBase, selectedPaymentMethods);

    const bestDeal = best
      ? {
          portal,
          finalPrice: best.finalPrice,
          code: best.offer?.code || best.offer?.couponCode || best.offer?.parsedFields?.code || null,
          title: best.offer?.title || null,
          rawDiscount: best.offer?.rawDiscount || best.offer?.parsedFields?.rawDiscount || null,
        }
      : null;

    return {
      portal,
      basePrice: portalBase,
      finalPrice: best ? best.finalPrice : portalBase,
      applied: !!best,
      code: bestDeal?.code || null,
      title: bestDeal?.title || null,
      rawDiscount: bestDeal?.rawDiscount || null,
    };
  });

  // best overall among portals
  const bestPortal = portalPrices.reduce((acc, p) => (acc == null || p.finalPrice < acc.finalPrice ? p : acc), null);

  return {
    ...flight,
    portalPrices,
    bestDeal: bestPortal
      ? {
          portal: bestPortal.portal,
          finalPrice: bestPortal.finalPrice,
          basePrice: bestPortal.basePrice,
          applied: bestPortal.applied,
          code: bestPortal.code,
          title: bestPortal.title,
          rawDiscount: bestPortal.rawDiscount,
        }
      : null,
  };
}

// --------------------
// Routes
// --------------------

// Payment options must come from Mongo (no static fallback list)
app.get("/payment-options", async (req, res) => {
  const meta = { usedFallback: false };

  try {
    const col = await getOffersCollection();

    const offers = await col.find({}, { projection: { _id: 0, paymentMethods: 1, rawFields: 1 } }).toArray();

    const groups = {
      "Credit Card": new Set(),
      "Debit Card": new Set(),
      "Net Banking": new Set(),
      "UPI": new Set(),
      "Wallet": new Set(),
      "EMI": new Set(),
    };

    for (const offer of offers) {
      const pms = extractOfferPaymentMethods(offer);
      for (const pm of pms) {
        const type = normalizePaymentType(pm.type);
        const name = String(pm.name || "").trim();
        if (!name) continue;
        if (!groups[type]) groups[type] = new Set();
        groups[type].add(name);
      }
    }

    // convert to arrays (sorted)
    const options = {};
    for (const [k, set] of Object.entries(groups)) {
      options[k] = Array.from(set).sort((a, b) => a.localeCompare(b));
    }

    res.json({ ...meta, options });
  } catch (e) {
    res.status(500).json({
      usedFallback: false,
      options: {
        "Credit Card": [],
        "Debit Card": [],
        "Net Banking": [],
        "UPI": [],
        "Wallet": [],
        "EMI": [],
      },
      error: e?.message || "Failed to load payment options",
    });
  }
});

// Search flights + apply offers
app.post("/search", async (req, res) => {
  const body = req.body || {};
  const meta = { source: "flightapi", outStatus: 0, retStatus: 0, request: {} };

  try {
    const from = String(body.from || "").trim().toUpperCase();
    const to = String(body.to || "").trim().toUpperCase();
    const outDate = toISO(body.departureDate);
    const retDate = toISO(body.returnDate);

    const tripType = body.tripType === "round-trip" ? "round-trip" : "one-way";
    const adults = Number(body.passengers || 1) || 1;
    const cabin = normalizeCabin(body.travelClass);
    const currency = "INR";

    const selectedPaymentMethods = Array.isArray(body.paymentMethods) ? body.paymentMethods : [];

    if (!from || !to || !outDate) {
      return res.status(400).json({
        meta: { ...meta, error: "Missing from/to/departureDate" },
        outboundFlights: [],
        returnFlights: [],
      });
    }

    // Outbound
    const outRes = await fetchOneWayTrip({ from, to, date: outDate, adults, cabin, currency });
    meta.outStatus = outRes.status;
    meta.request.outTried = outRes.tried;

    const outFlightsRaw = mapFlightsFromFlightAPI(outRes.data);

    // Apply offers per flight
    const outboundFlights = [];
    for (const f of outFlightsRaw) {
      outboundFlights.push(await applyOffersToFlight(f, selectedPaymentMethods));
    }

    // Return (if round-trip)
    let returnFlights = [];
    if (tripType === "round-trip" && retDate) {
      const retRes = await fetchOneWayTrip({ from: to, to: from, date: retDate, adults, cabin, currency });
      meta.retStatus = retRes.status;
      meta.request.retTried = retRes.tried;

      const retFlightsRaw = mapFlightsFromFlightAPI(retRes.data);

      const enriched = [];
      for (const f of retFlightsRaw) {
        enriched.push(await applyOffersToFlight(f, selectedPaymentMethods));
      }
      returnFlights = enriched;
    }

    res.json({ meta, outboundFlights, returnFlights });
  } catch (e) {
    const status = e?.status || e?.response?.status || 500;
    meta.outStatus = meta.outStatus || status;
    meta.error = e?.message || "Search failed";
    meta.request.tried = e?.tried || [];

    res.status(500).json({ meta, outboundFlights: [], returnFlights: [] });
  }
});

app.listen(PORT, () => {
  console.log(`SkyDeal backend listening on ${PORT}`);
});
