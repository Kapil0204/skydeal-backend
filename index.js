// index.js (SkyDeal backend) — ESM
import express from "express";
import cors from "cors";
import { MongoClient } from "mongodb";

function requireDebugEnabled(req, res) {
  if (process.env.ENABLE_DEBUG_ENDPOINTS === "true") return true;

  res.status(404).json({
    error: "Not found"
  });

  return false;
}

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

// Mongo envs
const MONGO_URI = process.env.MONGO_URI;
const MONGODB_DB = process.env.MONGODB_DB || "skydeal";
const MONGO_COL = process.env.MONGO_COL || "offers";

// FlightAPI env
const FLIGHTAPI_KEY = process.env.FLIGHTAPI_KEY;

function maskFlightApiKeyInUrl(url) {
  const key = process.env.FLIGHTAPI_KEY || "";
  if (!url || !key) return url;
  return String(url).replace(encodeURIComponent(key), "***MASKED_FLIGHTAPI_KEY***").replace(key, "***MASKED_FLIGHTAPI_KEY***");
}

// Feature flags
const ENABLE_ESTIMATED_DISCOUNTS =
  String(process.env.ENABLE_ESTIMATED_DISCOUNTS || "false").toLowerCase() === "true";

const OFFERS_CACHE_TTL_MS = Number(process.env.OFFERS_CACHE_TTL_MS || 60000);
let offersCacheData = null;
let offersCacheLoadedAt = 0;

const FLIGHTAPI_CACHE_TTL_MS = Number(process.env.FLIGHTAPI_CACHE_TTL_MS || 600000);
const flightApiSuccessCache = new Map();
// --------------------
// Route geography helpers
// --------------------
const INDIAN_IATA_AIRPORTS = new Set([
  "AMD","ATQ","BBI","BDQ","BHO","BHU","BLR","BOM","CCJ","CCU","CJB","COK","DED","DEL","DMU",
  "GAU","GOI","GOP","GWL","HBX","HYD","IDR","IXA","IXB","IXC","IXD","IXE","IXG","IXJ","IXL",
  "IXM","IXR","IXS","IXU","JAI","JDH","JGA","JLR","JRG","JSA","IXY","JGB","KNU","LKO","MAA",
  "MYQ","NAG","PAT","PNQ","RJA","RPR","SAG","SLV","SXR","STV","SXV","TRV","TRZ","UDR","VGA",
  "VNS","VTZ","PNY","AGX","DIB","IMF","SHL","AIP","NDC","TIR","RDP","JRH","TEZ","TCR","TCR",
  "COH","DHM","KUU","LEH","SBI","TCR","UDR","BEP","HJR","JLG","AJL","IXK","ISK","JAI","NMI"
]);

function isIndianAirportIata(iata) {
  return INDIAN_IATA_AIRPORTS.has(String(iata || "").trim().toUpperCase());
}

function isDomesticRoute(from, to) {
  const a = String(from || "").trim().toUpperCase();
  const b = String(to || "").trim().toUpperCase();
  if (!a || !b) return true; // safe default
  return isIndianAirportIata(a) && isIndianAirportIata(b);
}

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

function isSuspiciousGenericOffer(offer, allOffersForPortal = []) {
  const hasPayment =
    (offer?.eligiblePaymentMethods && offer.eligiblePaymentMethods.length > 0) ||
    (offer?.paymentMethods && offer.paymentMethods.length > 0);

  if (hasPayment) return false;

  const coupon = offer?.couponCode;
  if (!coupon) return false;

  // check if same coupon exists with payment-specific version
  const hasPaymentVariant = allOffersForPortal.some(o =>
    o?.couponCode === coupon &&
    (
      (o?.eligiblePaymentMethods && o.eligiblePaymentMethods.length > 0) ||
      (o?.paymentMethods && o.paymentMethods.length > 0)
    )
  );

  return hasPaymentVariant;
}

function paymentLabelFromSelection(selectedPaymentMethods) {
  const sel = Array.isArray(selectedPaymentMethods) ? selectedPaymentMethods : [];
  if (!sel.length) return null;

  const first = sel[0] || {};
  const bank = String(first.name || first.bank || "").trim();
  const type = String(first.type || "").trim().toLowerCase().replace(/\s+/g, "");

  if (!bank && !type) return null;
  return [bank || null, type || null].filter(Boolean).join(" • ");
}

// FlightAPI expects: Economy | Premium_Economy | Business | First
function normalizeCabin(travelClass) {
  const v = String(travelClass || "economy").toLowerCase().trim();
  if (v === "premium economy" || v === "premium_economy" || v === "premium-economy") return "Premium_Economy";
  if (v === "business") return "Business";
  if (v === "first") return "First";
  return "Economy";
}

function normalizeCabinShort(cabin) {
  const c = String(cabin || "Economy")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (c === "premium_economy" || c === "premium") return "premium";
  if (c === "business") return "business";
  if (c === "first" || c === "first_class") return "first";
  return "economy";
}

// --------------------
// Mongo (single client)
// --------------------
let _mongoClient = null;

async function getOffersCollection() {
  if (!MONGO_URI) throw new Error("Missing MONGO_URI env var");
  if (!_mongoClient) {
    _mongoClient = new MongoClient(MONGO_URI, {});
    await _mongoClient.connect();
  }
  return _mongoClient.db(MONGODB_DB).collection(MONGO_COL);
}

// --------------------
// FlightAPI call: onewaytrip
// --------------------
function encodeFlightApiPathPart(value) {
  return encodeURIComponent(String(value ?? "").trim());
}

function buildOnewayTripUrl({ from, to, date, adults, children, infants, cabin, currency }) {
  if (!FLIGHTAPI_KEY) throw new Error("Missing FLIGHTAPI_KEY env var");

  const parts = [
    "https://api.flightapi.io/onewaytrip",
    FLIGHTAPI_KEY,
    from,
    to,
    date,
    adults,
    children,
    infants,
    cabin,
    currency
  ];

  const [base, ...pathParts] = parts;
  return `${base}/${pathParts.map(encodeFlightApiPathPart).join("/")}`;
}

function shouldRetryFlightApiFailure(status, bodyText = "") {
  const statusNum = Number(status);
  const body = String(bodyText || "").toLowerCase();

  if (statusNum === 408 || statusNum === 409 || statusNum === 425 || statusNum === 429) {
    return true;
  }

  if (statusNum >= 500) {
    return true;
  }

  // FlightAPI often returns 400 for temporary provider-side failure:
  // {"message":"something went wrong, please try again"}
  if (
    statusNum === 400 &&
    (
      body.includes("something went wrong") ||
      body.includes("please try again") ||
      body.includes("try again") ||
      body.includes("temporarily")
    )
  ) {
    return true;
  }

  return false;
}

function flightApiRetryDelayMs(attempt) {
  const baseDelayMs = Number(process.env.FLIGHTAPI_RETRY_BASE_DELAY_MS || 800);
  const delay = baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(delay, 4000);
}

function buildFlightApiCacheKey({ from, to, date, adults, children, infants, cabin, currency }) {
  return [
    String(from || "").trim().toUpperCase(),
    String(to || "").trim().toUpperCase(),
    String(date || "").trim(),
    Number(adults || 1),
    Number(children || 0),
    Number(infants || 0),
    String(cabin || "Economy").trim(),
    String(currency || "INR").trim().toUpperCase()
  ].join("|");
}

async function fetchOneWayTrip({
  from,
  to,
  date,
  adults = 1,
  children = 0,
  infants = 0,
  cabin = "Economy",
  currency = "INR",
  direction = "oneway"
}) {
  const url = buildOnewayTripUrl({
    from,
    to,
    date,
    adults,
    children,
    infants,
    cabin,
    currency,
  });

  const fallbackCabin = String(cabin || "").trim() === "Economy" ? "economy" : null;
  const fallbackUrl = fallbackCabin
    ? buildOnewayTripUrl({
        from,
        to,
        date,
        adults,
        children,
        infants,
        cabin: fallbackCabin,
        currency,
      })
    : null;

  const cacheKey = buildFlightApiCacheKey({
    from,
    to,
    date,
    adults,
    children,
    infants,
    cabin,
    currency
  });

  const cached = flightApiSuccessCache.get(cacheKey);
  if (cached && Date.now() - cached.loadedAt < FLIGHTAPI_CACHE_TTL_MS) {
    return {
      status: 200,
      data: cached.data,
      tried: [{
        url: maskFlightApiKeyInUrl(url),
        status: "CACHE_HIT",
        attempt: 0,
        direction,
        cacheAgeMs: Date.now() - cached.loadedAt,
        cacheTtlMs: FLIGHTAPI_CACHE_TTL_MS
      }]
    };
  }

  const tried = [];
  let lastError = null;

  const timeoutMs = Number(process.env.FLIGHTAPI_TIMEOUT_MS || 12000);
  const maxAttempts = Number(process.env.FLIGHTAPI_MAX_ATTEMPTS || 3);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const activeUrl = fallbackUrl && attempt > 1 ? fallbackUrl : url;
      const res = await fetch(activeUrl, { signal: controller.signal });
      clearTimeout(timeout);

      const text = await res.text();

      const triedRow = {
        url: maskFlightApiKeyInUrl(activeUrl),
        status: res.status,
        attempt,
        direction,
        timeoutMs,
        ...(attempt > 1 ? { retry: true } : {}),
      };

      if (!res.ok) {
        triedRow.body = text.slice(0, 800);
      }

      tried.push(triedRow);

      if (res.ok) {
        try {
          const parsedData = JSON.parse(text);
          flightApiSuccessCache.set(cacheKey, {
            loadedAt: Date.now(),
            data: parsedData
          });

          return {
            status: res.status,
            data: parsedData,
            tried,
          };
        } catch (jsonErr) {
          lastError = {
            status: "INVALID_JSON",
            body: text.slice(0, 800),
            error: jsonErr?.message || String(jsonErr)
          };
        }
      } else {
        lastError = {
          status: res.status,
          body: text,
        };

        if (!shouldRetryFlightApiFailure(res.status, text)) {
          break;
        }
      }
    } catch (err) {
      clearTimeout(timeout);

      const isAbort = err?.name === "AbortError";
      lastError = {
        error: isAbort ? `FlightAPI request timed out after ${timeoutMs}ms` : (err?.message || String(err)),
      };

      tried.push({
        url: maskFlightApiKeyInUrl(fallbackUrl && attempt > 1 ? fallbackUrl : url),
        attempt,
        direction,
        ...(attempt > 1 ? { retry: true } : {}),
        status: isAbort ? "TIMEOUT" : "ERROR",
        timeoutMs,
        error: lastError.error,
      });
    }

    if (attempt < maxAttempts) {
      const waitMs = flightApiRetryDelayMs(attempt);
      const lastTried = tried[tried.length - 1];
      if (lastTried) lastTried.waitBeforeNextAttemptMs = waitMs;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  const err = new Error(
    `FlightAPI request failed (${lastError?.status || lastError?.error || "no-status"})`
  );
  err.status = lastError?.status || 500;
  err.tried = tried;
  err.flightApiLastError = lastError;
  throw err;
}


// --------------------
// Map FlightAPI response to consistent flights
// --------------------
function normalizeForMatch(v) {
  return String(v || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getCarrierAliases(airlineName, carrier = {}) {
  const name = normalizeForMatch(airlineName);
  const code = normalizeForMatch(carrier?.code || carrier?.iata || carrier?.display_code || "");

  const aliases = new Set([name, code].filter(Boolean));

  if (name.includes("indigo")) {
    aliases.add("indigo");
    aliases.add("6e");
  }

  if (name.includes("air india express")) {
    aliases.add("air india express");
    aliases.add("air india");
    aliases.add("aix");
    aliases.add("ix");
    aliases.add("aind");
  } else if (name.includes("air india")) {
    aliases.add("air india");
    aliases.add("ai");
    aliases.add("aind");
  }

  if (name.includes("akasa")) {
    aliases.add("akasa");
    aliases.add("akasa air");
    aliases.add("qp");
  }

  if (name.includes("spicejet")) {
    aliases.add("spicejet");
    aliases.add("sg");
  }

  if (name.includes("vistara")) {
    aliases.add("vistara");
    aliases.add("uk");
  }

  if (name.includes("alliance air")) {
    aliases.add("alliance air");
    aliases.add("9i");
  }

  if (name.includes("star air")) {
    aliases.add("star air");
    aliases.add("s5");
  }

  return Array.from(aliases).filter(Boolean);
}

function getAgentText(agentId, agentById) {
  const agent = agentById[String(agentId)] || {};
  return normalizeForMatch([
    agentId,
    agent?.name,
    agent?.display_name,
    agent?.type,
    agent?.category,
    agent?.booking_provider_type
  ].filter(Boolean).join(" "));
}

function pricingOptionLooksLikeCarrierSource(opt, airlineName, carrier, agentById) {
  const agentIds = new Set();

  if (Array.isArray(opt?.agent_ids)) {
    opt.agent_ids.forEach((id) => agentIds.add(String(id)));
  }

  if (Array.isArray(opt?.items)) {
    opt.items.forEach((item) => {
      if (item?.agent_id) agentIds.add(String(item.agent_id));
    });
  }

  if (agentIds.size === 0) return false;

  const aliases = getCarrierAliases(airlineName, carrier);
  const allAgentText = Array.from(agentIds)
    .map((id) => getAgentText(id, agentById))
    .join(" ");

  return aliases.some((alias) => {
    if (!alias) return false;
    return allAgentText.includes(alias);
  });
}

function getPricingOptionAmount(opt) {
  const direct = opt?.price?.amount;
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;

  const itemAmounts = Array.isArray(opt?.items)
    ? opt.items
        .map((item) => item?.price?.amount)
        .filter((n) => typeof n === "number" && Number.isFinite(n))
    : [];

  if (itemAmounts.length > 0) return Math.min(...itemAmounts);

  return null;
}

function getFlightApiCarrierDebug(raw) {
  const itineraries = Array.isArray(raw?.itineraries) ? raw.itineraries : [];
  const legs = Array.isArray(raw?.legs) ? raw.legs : [];
  const carriers = Array.isArray(raw?.carriers) ? raw.carriers : [];
  const segments = Array.isArray(raw?.segments) ? raw.segments : [];
  const agents = Array.isArray(raw?.agents) ? raw.agents : [];

  const legById = Object.fromEntries(legs.map((l) => [l.id, l]));
  const carrierById = Object.fromEntries(carriers.map((c) => [String(c.id), c]));
  const segmentById = Object.fromEntries(segments.map((s) => [s.id, s]));
  const agentById = Object.fromEntries(agents.map((a) => [String(a.id), a]));

  return itineraries.map((it) => {
    const legId = Array.isArray(it.leg_ids) ? it.leg_ids[0] : null;
    const leg = legId ? legById[legId] : null;

    const marketingCarrierId = Array.isArray(leg?.marketing_carrier_ids)
      ? leg.marketing_carrier_ids[0]
      : null;

    const carrier = marketingCarrierId != null
      ? carrierById[String(marketingCarrierId)]
      : null;

    let flightNumber = "-";
    if (Array.isArray(leg?.segment_ids) && leg.segment_ids.length > 0) {
      const seg = segmentById[leg.segment_ids[0]];
      flightNumber = String(seg?.flight_number || seg?.marketing_flight_number || "-");
    }

    const pricingOptions = Array.isArray(it.pricing_options) ? it.pricing_options : [];

    return {
      airlineName: carrier?.name || carrier?.display_name || carrier?.code || "-",
      carrierId: marketingCarrierId,
      carrierCode: carrier?.code || carrier?.display_code || carrier?.iata || null,
      flightNumber,
      departure: leg?.departure || null,
      arrival: leg?.arrival || null,
      pricingOptions: pricingOptions.map((opt) => {
        const agentIds = [
          ...(Array.isArray(opt?.agent_ids) ? opt.agent_ids : []),
          ...(Array.isArray(opt?.items) ? opt.items.map((item) => item?.agent_id).filter(Boolean) : [])
        ].map(String);

        return {
          amount: getPricingOptionAmount(opt),
          agentIds: [...new Set(agentIds)],
          agents: [...new Set(agentIds)].map((id) => ({
            id,
            name: agentById[id]?.name || agentById[id]?.display_name || null,
            type: agentById[id]?.type || agentById[id]?.category || null
          }))
        };
      })
    };
  });
}

// --------------------
// Map FlightAPI response to consistent flights
// IMPORTANT:
// SkyDeal base fare must come from the flight carrier/airline source only.
// We do NOT use OTA/cheapest marketplace pricing as base fare.
// --------------------
function mapFlightsFromFlightAPI(raw) {
  const itineraries = Array.isArray(raw?.itineraries) ? raw.itineraries : [];
  const legs = Array.isArray(raw?.legs) ? raw.legs : [];
  const carriers = Array.isArray(raw?.carriers) ? raw.carriers : [];
  const segments = Array.isArray(raw?.segments) ? raw.segments : [];
  const agents = Array.isArray(raw?.agents) ? raw.agents : [];

  const legById = Object.fromEntries(legs.map((l) => [l.id, l]));
  const carrierById = Object.fromEntries(carriers.map((c) => [String(c.id), c]));
  const segmentById = Object.fromEntries(segments.map((s) => [s.id, s]));
  const agentById = Object.fromEntries(agents.map((a) => [String(a.id), a]));

  const flights = [];

  for (const it of itineraries) {
    const legId = Array.isArray(it.leg_ids) ? it.leg_ids[0] : null;
    const leg = legId ? legById[legId] : null;

    const marketingCarrierId = Array.isArray(leg?.marketing_carrier_ids)
      ? leg.marketing_carrier_ids[0]
      : null;

    const carrier = marketingCarrierId != null
      ? carrierById[String(marketingCarrierId)]
      : null;

    const airlineName = carrier?.name || carrier?.display_name || carrier?.code || "-";

    const pricingOptions = Array.isArray(it.pricing_options) ? it.pricing_options : [];

    const carrierPricingOptions = pricingOptions.filter((opt) =>
      pricingOptionLooksLikeCarrierSource(opt, airlineName, carrier, agentById)
    );

    const carrierAmounts = carrierPricingOptions
      .map(getPricingOptionAmount)
      .filter((n) => typeof n === "number" && Number.isFinite(n) && n > 0);

    // Strict SkyDeal rule:
    // If FlightAPI does not expose the carrier-airline price, do not use OTA/cheapest price.
    if (carrierAmounts.length === 0) {
      continue;
    }

    const carrierAmount = Math.min(...carrierAmounts);

    let flightNumber = "-";
    if (Array.isArray(leg?.segment_ids) && leg.segment_ids.length > 0) {
      const seg = segmentById[leg.segment_ids[0]];
      const num = seg?.flight_number || seg?.marketing_flight_number;
      if (num) flightNumber = String(num);
    }

    const departureTime = leg?.departure || null;
    const arrivalTime = leg?.arrival || null;
    const stops = typeof leg?.stop_count === "number" ? leg.stop_count : 0;

    const carrierAgentIds = Array.from(new Set(
      carrierPricingOptions.flatMap((opt) => [
        ...(Array.isArray(opt?.agent_ids) ? opt.agent_ids : []),
        ...(Array.isArray(opt?.items) ? opt.items.map((item) => item?.agent_id).filter(Boolean) : [])
      ]).map(String)
    ));

    const flight = {
      airlineName,
      flightNumber,
      departureTime,
      arrivalTime,
      stops,
      price: carrierAmount,
      priceSource: "carrier_airline",
      carrierAgentIds,
      pricingOptionCount: pricingOptions.length,
      carrierPricingOptionCount: carrierPricingOptions.length,
    };

    if (String(process.env.INCLUDE_FLIGHTAPI_RAW_IN_RESULTS || "false").toLowerCase() === "true") {
      flight.raw = { itinerary: it, leg };
    }

    flights.push(flight);
  }

  return flights;
}

// --------------------
// --------------------
// Limit results
// --------------------
const MAX_RESULTS_PER_DIRECTION = 100;

const INDIAN_CARRIERS = [
  "air india express",
  "air india",
  "indigo",
  "akasa",
  "spicejet",
  "fly91",
  "star air",
  "alliance air",
  "trujet",
  "vistara",
  "go first",
];

function isIndianCarrier(airlineName) {
  const n = String(airlineName || "").toLowerCase();
  return INDIAN_CARRIERS.some((c) => n.includes(c));
}

function limitAndSortFlights(flights) {
  const pool = Array.isArray(flights) ? [...flights] : [];

  return pool.sort((a, b) => {
    const aStops = Number(a.stops || 0);
    const bStops = Number(b.stops || 0);

    // Default SkyDeal ordering: non-stop flights first.
    if (aStops !== bStops) return aStops - bStops;

    const aPrice = Number(a.price || 0);
    const bPrice = Number(b.price || 0);

    if (aPrice !== bPrice) return aPrice - bPrice;

    return String(a.departureTime || "").localeCompare(String(b.departureTime || ""));
  });
}


// --------------------
// Offer matching + pricing
// --------------------
function isTrustedPricingRule(offer) {
  if (!offer || typeof offer !== "object") return false;

  // If we are using the new clean DB structure, only trusted rules should price.
  const hasCleanDbFields =
    "pricingEligible" in offer ||
    "displayOnly" in offer ||
    "reviewStatus" in offer ||
    "hasDeterministicDiscount" in offer ||
    "offerKind" in offer;

  if (!hasCleanDbFields) {
    return true; // backward compatible if old offers collection is used
  }

  if (offer.pricingEligible !== true) return false;
  if (offer.displayOnly === true) return false;
  if (offer.reviewStatus && offer.reviewStatus !== "APPROVED") return false;
  if (offer.hasDeterministicDiscount === false) return false;

 if (!offer.sourceMetadata?.sourcePortal && !offer.sourcePortal) return false;

// Clean DB note:
// offer_rules may include always-on bank/payment offers with no expiry date.
// We already filtered risky missing-validity rows during promotion.
// So do NOT reject missing validity here.
return true;
}

function isValidBestOffer(offer) {
  if (!offer || typeof offer !== "object") return false;

  if (isOfferExpired(offer)) return false;

  const rawDiscount = String(
    offer?.rawDiscount ||
    offer?.parsedFields?.rawDiscount ||
    ""
  ).trim();

  const title = String(offer?.title || "").trim();
  const blob = `${title} ${rawDiscount}`.toLowerCase();

  const percent = Number(
    offer?.discountPercent ??
    offer?.parsedFields?.discountPercent ??
    0
  );

  const flat = Number(
    offer?.flatDiscountAmount ??
    offer?.parsedFields?.flatDiscountAmount ??
    0
  );

  const maxCap = Number(
    offer?.maxDiscountAmount ??
    offer?.parsedFields?.maxDiscountAmount ??
    0
  );

  const minTxn = Number(
    offer?.minTransactionValue ??
    offer?.parsedFields?.minTransactionValue ??
    0
  );

  const tiers =
    offer?.discountTiers ||
    offer?.parsedFields?.discountTiers ||
    [];

  const hasTierDiscount =
    Array.isArray(tiers) &&
    tiers.some((t) => {
      const tierFlat = Number(t?.flatDiscountAmount || t?.discountAmount || 0);
      const tierPct = Number(t?.discountPercent || 0);
      return tierFlat > 0 || tierPct > 0;
    });

  const hasPercent = Number.isFinite(percent) && percent > 0;
  const hasFlat = Number.isFinite(flat) && flat > 0;
  const hasCap = Number.isFinite(maxCap) && maxCap > 0;
  const hasMinTxn = Number.isFinite(minTxn) && minTxn > 0;

  const mentionsUpTo = /\bup\s*to\b|\bupto\b/.test(blob);
  const mentionsCashback = /\bcashback\b/.test(blob);
  const mentionsInstantDiscount =
    /\binstant discount\b/.test(blob) ||
    /\binstant off\b/.test(blob) ||
    /\bflat\b/.test(blob) ||
    /\boff\b/.test(blob) ||
    /\bdiscount\b/.test(blob);

  const code =
    offer?.couponCode ||
    offer?.code ||
    offer?.parsedFields?.couponCode ||
    offer?.parsedFields?.code ||
    null;

  if (offer?.couponRequired && !code) return false;

  if (!hasPercent && !hasFlat && !hasTierDiscount) return false;

  if (mentionsCashback && !mentionsInstantDiscount) return false;

  // Approved clean portal/airline/payment rules with a computable percent + cap are valid,
  // even when text says "up to". Example: Cleartrip CTDOM = 25% capped at ₹1500.
  if (
    offer?.pricingEligible === true &&
    offer?.hasDeterministicDiscount === true &&
    hasPercent &&
    hasCap
  ) {
    return true;
  }

  if (mentionsUpTo && !hasFlat && !hasCap && !hasMinTxn && !hasTierDiscount) return false;

  if (hasPercent && !hasFlat && !hasCap && mentionsUpTo) return false;

  return true;
}

function normalizeText(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "");
}

function normalizeBankName(raw) {
  const s0 = String(raw || "").trim();
  const s = normalizeText(s0.replace(/_/g, " "));

  if (s.includes("flipkart") && s.includes("axis")) return "axis bank";
  if (s === "au bank" || s.includes("au bank")) return "au small finance bank";

  const cleaned = s
    .replace(/\bbank\b/g, "bank")
    .replace(/\bltd\b/g, "ltd")
    .replace(/\blimited\b/g, "ltd")
    .trim();

  const map = new Map([
    ["hdfc", "hdfc bank"],
    ["hdfc bank", "hdfc bank"],
    ["au", "au small finance bank"],
    ["axis", "axis bank"],
    ["axis bank", "axis bank"],
    ["federal", "federal bank"],
    ["federal bank", "federal bank"],
    ["icici", "icici bank"],
    ["icici bank", "icici bank"],
    ["sbi", "state bank of india"],
    ["state bank of india", "state bank of india"],
    ["sbi bank", "state bank of india"],
    ["dbs", "dbs bank"],
    ["dbs bank", "dbs bank"],
    ["hsbc", "hsbc bank"],
    ["hsbc bank", "hsbc bank"],
    ["pnb", "punjab national bank"],
    ["punjab national", "punjab national bank"],
    ["punjab national bank", "punjab national bank"],
    ["au small bank", "au small finance bank"],
    ["au small finance bank", "au small finance bank"],
  ]);

  return map.get(cleaned) || cleaned;
}

function normalizePaymentType(rawType, rawText = "") {
  const t = normalizeText(rawType);
  const r = normalizeText(rawText);

  if (t.includes("emi") || r.includes("emi") || r.includes("no cost emi") || r.includes("no-cost emi")) return "emi";
  if (t.includes("net") && t.includes("bank")) return "netbanking";
  if (r.includes("net banking") || r.includes("netbanking")) return "netbanking";
  if (t.includes("credit")) return "creditcard";
  if (t.includes("debit")) return "debitcard";
  if (t.includes("upi") || r.includes("upi")) return "upi";
  if (t.includes("wallet") || r.includes("wallet")) return "wallet";

  return t || "other";
}

function extractOfferConstraints(offer) {
  const text = String(offer?.terms || "").toLowerCase();
  return {
    requiresEligibleBIN: text.includes("bin"),
    appOnly: text.includes("mobile app"),
    websiteOnly: text.includes("website bookings"),
    onePerUser: text.includes("once per"),
  };
}

/**
 * ===========================
 * Inference fallback (kept)
 * ===========================
 */
function inferPaymentMethodsFromText(offer) {
    // IMPORTANT: inference must be CORE-only.
  // rawText/terms often contain template noise (nav/footer) and causes false bank matches.
  const offerSummary =
    typeof offer?.offerSummary === "string"
      ? offer.offerSummary
      : offer?.offerSummary
        ? JSON.stringify(offer.offerSummary)
        : (offer?.parsedFields?.offerSummary ? JSON.stringify(offer.parsedFields.offerSummary) : "");

  const blob = String(`${offer?.title || ""} ${offer?.rawDiscount || ""} ${offerSummary}`)
    .toLowerCase()
    .slice(0, 8000);

  const inferredTypes = new Set();
  if (/\bno[\s-]?cost\s*emi\b|\bemi\b/.test(blob)) inferredTypes.add("EMI");
  if (/\bcredit\s*card\b|\bcc\b/.test(blob)) inferredTypes.add("CREDIT_CARD");
  if (/\bdebit\s*card\b/.test(blob)) inferredTypes.add("DEBIT_CARD");
  if (/\bnet\s*banking\b|\bnetbanking\b|\binternet\s*banking\b/.test(blob)) inferredTypes.add("NET_BANKING");
  if (/\bupi\b/.test(blob)) inferredTypes.add("UPI");
  if (/\bwallet\b/.test(blob)) inferredTypes.add("WALLET");

  const bankRules = [
    { re: /\baxis\b/, bank: "Axis Bank", canon: "AXIS_BANK" },
    { re: /\bhdfc\b/, bank: "HDFC Bank", canon: "HDFC_BANK" },
    { re: /\bicici\b/, bank: "ICICI Bank", canon: "ICICI_BANK" },
    { re: /\bhsbc\b/, bank: "HSBC", canon: "HSBC" },
    { re: /\bsbi\b|\bstate bank\b/, bank: "State Bank of India", canon: "STATE_BANK_OF_INDIA" },
    { re: /\bkotak\b/, bank: "Kotak Bank", canon: "KOTAK_BANK" },
    { re: /\byes bank\b|\byes\b/, bank: "Yes Bank", canon: "YES_BANK" },
    { re: /\brbl\b/, bank: "RBL Bank", canon: "RBL_BANK" },
    { re: /\bau bank\b|\bau small\b|\bau small finance\b/, bank: "AU Bank", canon: "AU_BANK" },
    { re: /\bfederal\b/, bank: "Federal Bank", canon: "FEDERAL_BANK" },
    { re: /\bidfc\b/, bank: "IDFC First Bank", canon: "IDFC_FIRST_BANK" },
    { re: /\bindusind\b/, bank: "IndusInd Bank", canon: "INDUSIND_BANK" },
  ];

  const banks = bankRules.filter((r) => r.re.test(blob));
  if (inferredTypes.size === 0 || banks.length === 0) return [];

  const out = [];
  for (const b of banks) {
    for (const t of inferredTypes) {
      out.push({
        type:
          t === "EMI" ? "emi" :
          t === "CREDIT_CARD" ? "credit_card" :
          t === "DEBIT_CARD" ? "debit_card" :
          t === "NET_BANKING" ? "net_banking" :
          t === "UPI" ? "upi" : "wallet",
        bank: b.bank,
        network: null,
        methodCanonical: t,
        bankCanonical: b.canon,
        networkCanonical: null,
        emiOnly: t === "EMI" || /\bemi\b/.test(blob),
        tenureMonths: null,
        conditions: /\bno[\s-]?cost\s*emi\b/.test(blob) ? "No-Cost EMI" : null,
        raw: `${b.bank} (inferred)`,
        inferred: true,
      });
    }
  }
  return out;
}
function extractOfferPaymentMethodsNoInference(offer) {
  if (!offer || typeof offer !== "object") return [];

  let out = [];

  if (Array.isArray(offer.eligiblePaymentMethods) && offer.eligiblePaymentMethods.length > 0) {
    out = offer.eligiblePaymentMethods
      .filter((pm) => pm && typeof pm === "object")
      .map((pm) => ({
        type: pm.type || null,
        bank: pm.bank || null,
        network: pm.network || null,
        methodCanonical: pm.methodCanonical || null,
        bankCanonical: pm.bankCanonical || null,
        networkCanonical: pm.networkCanonical || null,
        cardVariant: pm.cardVariant || null,
        emiOnly: pm.emiOnly === true,
        tenureMonths: pm.tenureMonths ?? null,
        conditions: pm.conditions || null,
        raw: pm.raw || null,
        inferred: pm.inferred === true, // if DB ever has it
      }))
      // ✅ HARD FILTER: remove null-only PM rows like your Malaysia example
      .filter((pm) => {
        const hasAny =
          (pm.type && String(pm.type).trim() !== "") ||
          (pm.methodCanonical && String(pm.methodCanonical).trim() !== "") ||
          (pm.bank && String(pm.bank).trim() !== "") ||
          (pm.bankCanonical && String(pm.bankCanonical).trim() !== "");
        return hasAny;
      });
  } else if (Array.isArray(offer.paymentMethods) && offer.paymentMethods.length > 0) {
    out = offer.paymentMethods
      .filter((pm) => pm && typeof pm === "object")
      .map((pm) => ({
        type: pm.type || null,
        bank: pm.bank || pm.name || null,
        network: pm.network || null,
        methodCanonical: pm.methodCanonical || null,
        bankCanonical: pm.bankCanonical || null,
        networkCanonical: pm.networkCanonical || null,
        cardVariant: pm.cardVariant || null,
        emiOnly: pm.emiOnly === true,
        tenureMonths: pm.tenureMonths ?? null,
        conditions: pm.conditions || null,
        raw: pm.raw || null,
        inferred: pm.inferred === true,
      }))
      .filter((pm) => {
        const hasAny =
          (pm.type && String(pm.type).trim() !== "") ||
          (pm.methodCanonical && String(pm.methodCanonical).trim() !== "") ||
          (pm.bank && String(pm.bank).trim() !== "") ||
          (pm.bankCanonical && String(pm.bankCanonical).trim() !== "");
        return hasAny;
      });
  }

  // ❌ IMPORTANT: no inferPaymentMethodsFromText() here
  return out || [];
}

function extractOfferPaymentMethods(offer) {
  if (!offer || typeof offer !== "object") return [];

  let out = [];

  if (Array.isArray(offer.eligiblePaymentMethods) && offer.eligiblePaymentMethods.length > 0) {
    out = offer.eligiblePaymentMethods
      .filter((pm) => pm && typeof pm === "object")
      .map((pm) => ({
        type: pm.type || null,
        bank: pm.bank || null,
        network: pm.network || null,
        methodCanonical: pm.methodCanonical || null,
        bankCanonical: pm.bankCanonical || null,
        networkCanonical: pm.networkCanonical || null,
        cardVariant: pm.cardVariant || null,
        emiOnly: pm.emiOnly === true,
        tenureMonths: pm.tenureMonths ?? null,
        conditions: pm.conditions || null,
        raw: pm.raw || null,
        inferred: false, // ✅ explicit, not inferred
      }))
      .filter((pm) => pm.type || pm.methodCanonical || pm.bank || pm.bankCanonical);
  } else if (Array.isArray(offer.paymentMethods) && offer.paymentMethods.length > 0) {
    out = offer.paymentMethods
      .filter((pm) => pm && typeof pm === "object")
      .map((pm) => ({
        type: pm.type || null,
        bank: pm.bank || pm.name || null,
        network: pm.network || null,
        methodCanonical: pm.methodCanonical || null,
        bankCanonical: pm.bankCanonical || null,
        networkCanonical: pm.networkCanonical || null,
        cardVariant: pm.cardVariant || null,
        emiOnly: pm.emiOnly === true,
        tenureMonths: pm.tenureMonths ?? null,
        conditions: pm.conditions || null,
        raw: pm.raw || null,
        inferred: false, // ✅ explicit, not inferred
      }))
      .filter((pm) => pm.type || pm.methodCanonical || pm.bank || pm.bankCanonical);
  }

  if (!out || out.length === 0) {
    const inferred = inferPaymentMethodsFromText(offer);
    if (Array.isArray(inferred) && inferred.length > 0) return inferred;
  }

  return out || [];
}

function offerAppliesToPortal(offer, portalName) {
  const portal = String(portalName || "").toLowerCase().trim();

  const src =
    offer?.sourceMetadata?.sourcePortal ??
    offer?.sourcePortal ??
    offer?.parsedFields?.sourceMetadata?.sourcePortal ??
    null;

  if (src) {
    return String(src).toLowerCase().trim() === portal;
  }

  const platforms =
    offer?.parsedApplicablePlatforms ||
    offer?.applicablePlatforms ||
    offer?.platforms ||
    offer?.parsedFields?.parsedApplicablePlatforms ||
    null;

  if (Array.isArray(platforms) && platforms.length > 0) {
    return platforms.some((p) => String(p || "").toLowerCase().includes(portal));
  }

  return false;
}

function isFlightOffer(offer) {
  // IMPORTANT: Only trust "core" fields for classification.
  // rawText/terms often contain site template noise (e.g., nav/footer with “Flights”).
  const title = String(offer?.title || "");
  const rawDiscount = String(offer?.rawDiscount || offer?.parsedFields?.rawDiscount || "");
  const offerSummary =
    typeof offer?.offerSummary === "string"
      ? offer.offerSummary
      : offer?.offerSummary
        ? JSON.stringify(offer.offerSummary)
        : (offer?.parsedFields?.offerSummary ? JSON.stringify(offer.parsedFields.offerSummary) : "");

  const core = `${title} ${rawDiscount} ${offerSummary}`.toLowerCase();

  const cats = offer?.offerCategories || offer?.parsedFields?.offerCategories;
  const catBlob = Array.isArray(cats)
    ? cats.map((c) => String(c || "").toLowerCase()).join(" | ")
    : "";

  // Strong non-flight verticals (if core says these and does NOT say flights, it’s NOT a flight offer)
  const NON_FLIGHT_RE =
    /\bhotel(s)?\b|\bbus(es)?\b|\bcab(s)?\b|\btrain(s)?\b|\btourism\b|\battraction(s)?\b|\bholiday(s)?\b|\bactivities?\b|\bvisa\b|\bforex\b/;

  // Strong flight signals (must appear in CORE text)
    // Strong flight signals (must appear in CORE text)
  // ✅ Added airline+fare combo to catch titles like "Malaysia Airlines Exclusive Fares"
  const FLIGHT_CORE_RE =
    /\bflight(s)?\b|\bair\s*ticket(s)?\b|\bairfare\b|\bdomestic\s+flight(s)?\b|\binternational\s+flight(s)?\b|\bairlines?\b.*\bfare(s)?\b|\bfare(s)?\b.*\bairlines?\b/;

  const coreHasFlight = FLIGHT_CORE_RE.test(core);
  const coreHasNonFlight = NON_FLIGHT_RE.test(core);

  // If core clearly indicates a non-flight vertical AND does not clearly indicate flights => reject
  if (coreHasNonFlight && !coreHasFlight) return false;

  // If core clearly indicates flights => accept
  if (coreHasFlight) return true;

  // Weak fallback: if categories say flight AND core doesn't indicate non-flight verticals
// (prevents template noise from rawText causing false positives)
const catsSayFlight = /\bflight(s)?\b/.test(catBlob);
if (catsSayFlight && !coreHasNonFlight) return true;

// Clean DB fallback:
// In offer_rules, some Goibibo bank-flight rows are parsed as categories:
// ["domestic"] or ["international"] without the word "flight" in title/rawDiscount.
// Since offer_rules is already curated, allow these as flight offers.
const catsSayDomesticOrInternational =
  /\bdomestic\b/.test(catBlob) || /\binternational\b/.test(catBlob);

if (isTrustedPricingRule(offer) && catsSayDomesticOrInternational && !coreHasNonFlight) {
  return true;
}

return false;
}

function isHotelOnlyOffer(offer) {
  const text = `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.terms || ""}`.toLowerCase();

  const mentionsHotel = /\bhotel(s)?\b/.test(text);
  const mentionsFlight = /\bflight(s)?\b|\bair\s*ticket(s)?\b|\bairfare\b/.test(text);

  // ❌ Explicit hotel-only offer
  return mentionsHotel && !mentionsFlight;
}

function isFirstTimeOrNewUserOffer(offer) {
  const blob = normalizeText(
    `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""} ${offer?.terms?.raw || offer?.terms || ""}`
  );

  return (
    /\bnew\s*user(s)?\b/.test(blob) ||
    /\bnew\s*customer(s)?\b/.test(blob) ||
    /\bfirst\s*(booking|transaction|order|purchase|trip|flight)\b/.test(blob) ||
    /\bfirst[-\s]*time\b/.test(blob) ||
    /\bfirst\s*app\s*booking\b/.test(blob) ||
    /\bfirst\s*ever\b/.test(blob)
  );
}

function hasExplicitOfferPaymentMethods(offer) {
  // First trust structured payment methods only.
  const structured = extractOfferPaymentMethodsNoInference(offer);
  if (Array.isArray(structured) && structured.length > 0) return true;

  // Fallback should be CORE-only.
  // Do not scan rawText/terms because portal pages contain template/payment noise.
  const offerSummary =
    typeof offer?.offerSummary === "string"
      ? offer.offerSummary
      : offer?.offerSummary
        ? JSON.stringify(offer.offerSummary)
        : offer?.parsedFields?.offerSummary
          ? JSON.stringify(offer.parsedFields.offerSummary)
          : "";

  const coreBlob = `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offerSummary}`.toLowerCase();

  const bankKeywords = [
    "axis", "hdfc", "icici", "sbi", "kotak", "amex", "american express",
    "indusind", "hsbc", "idfc", "yes bank", "rbl", "au bank", "federal",
    "canara", "bank of baroda", "bobcard", "central bank", "onecard", "cred"
  ];

  const paymentKeywords = [
    "credit card", "debit card", "emi", "upi", "wallet", "net banking", "netbanking"
  ];

  const mentionsBank = bankKeywords.some((b) => coreBlob.includes(b));
  const mentionsPayment = paymentKeywords.some((p) => coreBlob.includes(p));

  return mentionsBank || mentionsPayment;
}
function isNoPaymentOffer(offer) {
  return !hasExplicitOfferPaymentMethods(offer);
}

function offerTargetsThisAirline(offer, airlineName) {
  const airline = normalizeText(airlineName || "");
  if (!airline) return false;

  const routeRestrictions = Array.isArray(offer?.terms?.routeOrAirlineRestrictions)
    ? offer.terms.routeOrAirlineRestrictions.join(" ")
    : "";

  const parsedRouteRestrictions = Array.isArray(offer?.parsedFields?.terms?.routeOrAirlineRestrictions)
    ? offer.parsedFields.terms.routeOrAirlineRestrictions.join(" ")
    : "";

  const blob = normalizeText(
    `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""} ${offer?.terms?.raw || offer?.terms || ""} ${routeRestrictions} ${parsedRouteRestrictions}`
  );

  if (blob.includes(airline)) return true;

  // Airline aliases / codes
  if (airline.includes("air india express") && (/\bair india express\b/.test(blob) || /\baix\b/.test(blob))) return true;
  if (airline.includes("air india") && /\bair india\b/.test(blob)) return true;
  if (airline.includes("indigo") && (/\bindigo\b/.test(blob) || /\b6e\b/.test(blob))) return true;
  if (airline.includes("spicejet") && (/\bspicejet\b/.test(blob) || /\bsg\b/.test(blob))) return true;
  if (airline.includes("akasa") && (/\bakasa\b/.test(blob) || /\bqp\b/.test(blob))) return true;
  if (airline.includes("alliance air") && /\balliance air\b/.test(blob)) return true;
  if (airline.includes("star air") && /\bstar air\b/.test(blob)) return true;
  if (airline.includes("fly91") && /\bfly91\b/.test(blob)) return true;

  return false;
}

function getOfferKindForFlight(offer, selectedPaymentMethods, flightAirlineName) {
  const hasExplicitPM = hasExplicitOfferPaymentMethods(offer);
  const hasSelectedPM = Array.isArray(selectedPaymentMethods) && selectedPaymentMethods.length > 0;
    if (offer?.offerKind === "portal") {
    return { kind: "portal" };
  }

  if (offer?.offerKind === "airline") {
    return { kind: "airline" };
  }

  // 1) Payment-required offers must not apply when user selected nothing
     if (hasExplicitPM) {
    if (!hasSelectedPM) {
      return { kind: null, reason: "PAYMENT_REQUIRED_NOT_SELECTED" };
    }

    const matches = offerMatchesSelectedPayment(offer, selectedPaymentMethods);
    if (matches) {
      return { kind: "payment" };
    }

    return { kind: null, reason: "PAYMENT_MISMATCH" };
  }

  // 2) No explicit payment requirement → airline or portal
  if (offerTargetsThisAirline(offer, flightAirlineName)) {
    return { kind: "airline" };
  }

  return { kind: "portal" };
}

function getOfferTypeLabel(kind, offer = null) {
  const suffix = offer && isCashbackStyleOffer(offer) ? " (cashback)" : "";

  if (kind === "payment") return `Payment offer${suffix}`;
  if (kind === "airline") return `Airline offer${suffix}`;
  if (kind === "portal") return `Portal offer (no payment required)${suffix}`;
  return null;
}

function getOfferChannelLabel(offer) {
  const c = extractOfferConstraints(offer);
  if (c.appOnly) return "Book on app";
  if (c.websiteOnly) return "Book on website";
  return null;
}
function offerCannotBeClubbed(offer) {
  const blob = normalizeText(
    `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""} ${offer?.terms?.raw || offer?.terms || ""}`
  );

  return (
    /\bcannot be clubbed\b/.test(blob) ||
    /\bcan not be clubbed\b/.test(blob) ||
    /\bnot be clubbed\b/.test(blob) ||
    /\bnot valid with any other offer\b/.test(blob) ||
    /\bcannot be combined\b/.test(blob) ||
    /\bnot combinable\b/.test(blob) ||
    /\bnot applicable with any other offer\b/.test(blob)
  );
}
function offerRequiresRoundTrip(offer) {
  const blob = normalizeText(
    `${offer?.title || ""} ${offer?.rawDiscount || ""}`
  );

  return (
    /\bround trip only\b/.test(blob) ||
    /\broundtrip only\b/.test(blob) ||
    /\bround-trip only\b/.test(blob) ||
    /\breturn trip only\b/.test(blob) ||
    /\breturn booking only\b/.test(blob) ||
    /\breturn flight only\b/.test(blob)
  );
}

function offerRequiresOneWayOnly(offer) {
  const blob = normalizeText(
    `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""} ${offer?.terms?.raw || offer?.terms || ""}`
  );

  const hasOneWay =
    /\bone way\b|\bone-way\b|\boneway\b/.test(blob);

  const hasRoundTrip =
    /\bround trip\b|\bround-trip\b|\broundtrip\b|\breturn booking(s)?\b|\breturn flight(s)?\b/.test(blob);

  return hasOneWay && !hasRoundTrip;
}
function getPassengerRestrictionResult(offer, passengers = 1) {
  const pax = Math.max(1, Number(passengers) || 1);

  const blob = normalizeText(
    `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""} ${offer?.terms?.raw || offer?.terms || ""}`
  );

  // Solo / single passenger only
  if (
    /\bsolo traveler only\b/.test(blob) ||
    /\bsolo traveller only\b/.test(blob) ||
    /\bsingle passenger only\b/.test(blob) ||
    /\bone passenger only\b/.test(blob) ||
    /\bonly for 1 passenger\b/.test(blob)
  ) {
    if (pax !== 1) {
      return { ok: false, reason: "PASSENGER_COUNT_RESTRICTED_SOLO_ONLY" };
    }
  }

  // Minimum passenger count
  const minMatch =
    blob.match(/\bminimum\s+(\d+)\s+passenger(s)?\b/) ||
    blob.match(/\bmin(?:imum)?\s+(\d+)\s+passenger(s)?\b/) ||
    blob.match(/\bvalid only for (\d+)\+\s*passenger(s)?\b/) ||
    blob.match(/\bfor (\d+)\+\s*passenger(s)?\b/);

  if (minMatch && minMatch[1]) {
    const minPax = Number(minMatch[1]);
    if (Number.isFinite(minPax) && pax < minPax) {
      return { ok: false, reason: "PASSENGER_COUNT_BELOW_MINIMUM", minPassengers: minPax };
    }
  }

  // Maximum passenger count
  const maxMatch =
    blob.match(/\bmaximum\s+(\d+)\s+passenger(s)?\b/) ||
    blob.match(/\bmax(?:imum)?\s+(\d+)\s+passenger(s)?\b/) ||
    blob.match(/\bup to (\d+)\s+passenger(s)? only\b/);

  if (maxMatch && maxMatch[1]) {
    const maxPax = Number(maxMatch[1]);
    if (Number.isFinite(maxPax) && pax > maxPax) {
      return { ok: false, reason: "PASSENGER_COUNT_ABOVE_MAXIMUM", maxPassengers: maxPax };
    }
  }

  // Infant restrictions
  if (
    /\binfant not allowed\b/.test(blob) ||
    /\bnot valid with infant\b/.test(blob) ||
    /\bexcluding infant\b/.test(blob)
  ) {
    // current request model does not separately carry infants
    // keep this as informational only for now
    return { ok: true, warning: "INFANT_RESTRICTION_PRESENT_BUT_NOT_ENFORCED" };
  }

  return { ok: true };
}

function isOfferExpired(offer) {
  const toDate =
    offer?.validityPeriod?.to ||
    offer?.parsedFields?.validityPeriod?.to ||
    offer?.validityPeriod?.endDate ||
    offer?.parsedFields?.validityPeriod?.endDate ||
    null;

  function parseDateLoose(x) {
    const s = String(x || "").trim();
    if (!s) return null;

    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
      const d = new Date(s);
      return isNaN(d) ? null : d;
    }

    const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (m) {
      const dd = Number(m[1]), mm = Number(m[2]), yy = Number(m[3]);
      const d = new Date(Date.UTC(yy, mm - 1, dd));
      return isNaN(d) ? null : d;
    }

    const d2 = new Date(s.replace(/(\d+)(st|nd|rd|th)/gi, "$1"));
    return isNaN(d2) ? null : d2;
  }

  // 1) Strong structured validity first
  if (toDate) {
    const t = parseDateLoose(toDate);
    if (t) {
      const end = new Date(t);
      end.setHours(23, 59, 59, 999);

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      return end.getTime() < today.getTime();
    }
  }

  // If structured validity exists but cannot be parsed, do not allow stale isExpired:false to override it.
  // Otherwise, after structured validity check, fall back to explicit boolean only when no structured end date exists.
  if (typeof offer?.isExpired === "boolean") return offer.isExpired;

  // 2) If no structured validity exists, only trust text fallback
  const blobs = [];
  if (offer?.validityPeriod?.raw) blobs.push(String(offer.validityPeriod.raw));
  if (offer?.parsedFields?.validityPeriod?.raw) blobs.push(String(offer.parsedFields.validityPeriod.raw));
  if (offer?.terms?.raw) blobs.push(String(offer.terms.raw));
  if (offer?.parsedFields?.terms?.raw) blobs.push(String(offer.parsedFields.terms.raw));
  blobs.push(String(offer?.title || ""));
  blobs.push(String(offer?.rawDiscount || ""));
  blobs.push(String(offer?.rawText || ""));

  const text = blobs.filter(Boolean).join(" \n ");
  const lower = text.toLowerCase();

  const monthNames =
    "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  const re1 = new RegExp(`\\b${monthNames}\\s+\\d{1,2}(?:st|nd|rd|th)?[,]?\\s+\\d{4}\\b`, "ig");
  const re2 = new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${monthNames}\\s+\\d{4}\\b`, "ig");
  const re3 = /\b\d{4}-\d{2}-\d{2}\b/g;

  const candidates = [
    ...(text.match(re1) || []),
    ...(text.match(re2) || []),
    ...(text.match(re3) || []),
  ];

  if (candidates.length === 0) return false;

  const bookingValidityHints = [
    "valid till",
    "valid until",
    "validity",
    "booking period",
    "book by",
    "offer valid till",
    "offer valid until",
    "campaign period",
    "booking till",
    "expires on",
    "expiring on",
    "offer ends",
  ];

  let latest = null;

  for (const s of candidates) {
    const idx = lower.indexOf(String(s).toLowerCase());
    const winStart = Math.max(0, idx - 80);
    const winEnd = Math.min(lower.length, idx + 120);
    const windowTxt = lower.slice(winStart, winEnd);

    const looksLikeBookingValidity = bookingValidityHints.some((hint) => windowTxt.includes(hint));
    if (!looksLikeBookingValidity) continue;

    const d = new Date(String(s).replace(/(\d+)(st|nd|rd|th)/gi, "$1"));
    if (!isNaN(d)) {
      if (!latest || d.getTime() > latest.getTime()) latest = d;
    }
  }

  if (!latest) return false;

  const end = new Date(latest);
  end.setHours(23, 59, 59, 999);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return end.getTime() < today.getTime();
}
function inferMinTxnFromText(offer) {
  const blob = String(
    `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""} ${offer?.terms || ""}`
  );

  // Only trust amounts when they appear near min txn language
  const patterns = [
    /min(?:imum)?\s*(?:txn|transaction|booking|purchase)\s*(?:amount|value)?[^₹\d]{0,30}(?:₹|rs\.?|inr)?\s*([\d,]{3,})/i,
    /valid\s*on\s*(?:minimum)?\s*(?:transaction|booking)\s*(?:amount|value)?[^₹\d]{0,30}(?:₹|rs\.?|inr)?\s*([\d,]{3,})/i,
    /(?:minimum|min\.)\s*(?:amount|value)\s*[:\-]?\s*(?:₹|rs\.?|inr)?\s*([\d,]{3,})/i,
  ];

  // ✅ FIX #2: Flight-safe inference:
  // If coupon appears across verticals (Flights + Hotels), don't accidentally pick hotel min amount.
  // We only accept a match if a nearby window mentions "flight(s)" and does NOT mention "hotel(s)".
  const lower = blob.toLowerCase();
  for (const re of patterns) {
    const m = re.exec(blob);
    if (m && m[1]) {
      const idx = m.index != null ? m.index : -1;
      const winStart = Math.max(0, idx - 120);
      const winEnd = Math.min(lower.length, idx + 200);
      const windowTxt = lower.slice(winStart, winEnd);

      const hasFlightNearby = /\bflight(s)?\b|\bair\s*ticket(s)?\b|\bairfare\b/.test(windowTxt);
      const hasHotelNearby = /\bhotel(s)?\b/.test(windowTxt);

      if (!hasFlightNearby || hasHotelNearby) continue;

      const n = Number(String(m[1]).replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0) return n;
    }
  }

  return 0;
}

function getMinTxnValue(offer) {
  // For tiered offers, do NOT use bestTierForDisplay first.
  // bestTierForDisplay is for display only and may point to a higher slab,
  // e.g. HDFC 15000+ tier, which wrongly blocks 7500+ bookings.
  const tiers =
    offer?.discountTiers ??
    offer?.parsedFields?.discountTiers ??
    null;

  if (Array.isArray(tiers) && tiers.length > 0) {
    const mins = tiers
      .map((t) => Number(t?.minTransactionValue))
      .filter((n) => Number.isFinite(n) && n > 0);

    if (mins.length > 0) return Math.min(...mins);
  }

  const v = offer?.minTransactionValue ?? offer?.parsedFields?.minTransactionValue ?? null;
  const n = Number(v);

  if (Number.isFinite(n) && n > 0) return n;

  const inferred = inferMinTxnFromText(offer);
  return Number.isFinite(inferred) ? inferred : 0;
}

// --------------------
// Discount compute
// --------------------

function parsePercentFromRawDiscount(offer, isDomestic) {
  const txt = String(
    offer?.rawDiscount ||
    offer?.parsedFields?.rawDiscount ||
    offer?.offerSummary ||
    offer?.rawText ||
    ""
  );

  if (!txt) return null;

  const lower = txt.toLowerCase();

  // 1) Prefer explicit instant/upfront discount percentage when present
  const instantPct =
    lower.match(/(\d{1,2})\s*%\s*instant\s*discount/i) ||
    lower.match(/instant\s*discount[^%]{0,40}(\d{1,2})\s*%/i) ||
    lower.match(/(\d{1,2})\s*%\s*instant\s*off/i) ||
    lower.match(/instant\s*off[^%]{0,40}(\d{1,2})\s*%/i) ||
    lower.match(/\bflat\s*(\d{1,2})\s*%\s*off\b/i) ||
    lower.match(/\b(\d{1,2})\s*%\s*off\b/i);

  if (instantPct) {
    return Number(instantPct[1]);
  }

  // 2) Mixed offers: choose the first non-cashback percentage chunk
  const percentMatches = [...lower.matchAll(/(\d{1,2})\s*%/g)].map((m) => ({
    pct: Number(m[1]),
    idx: m.index ?? 0,
  }));

  if (percentMatches.length > 0) {
    for (const m of percentMatches) {
      const windowTxt = lower.slice(Math.max(0, m.idx - 35), Math.min(lower.length, m.idx + 55));

      // skip cashback/reward/coins/wallet/statement-credit percentages
      if (
        /cashback/.test(windowTxt) ||
        /reward/.test(windowTxt) ||
        /supercoin/.test(windowTxt) ||
        /coin/.test(windowTxt) ||
        /wallet/.test(windowTxt) ||
        /statement/.test(windowTxt)
      ) {
        continue;
      }

      // Prefer explicit discount/off context
      if (
        /instant/.test(windowTxt) ||
        /discount/.test(windowTxt) ||
        /\boff\b/.test(windowTxt)
      ) {
        return m.pct;
      }
    }
  }

  return null;
}

function offerIsPerPassenger(offer) {
  const blob = normalizeText(
    `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""} ${offer?.terms?.raw || offer?.terms || ""}`
  );

  return (
    /\bper passenger\b/.test(blob) ||
    /\bper pax\b/.test(blob) ||
    /\bfor each passenger\b/.test(blob) ||
    /\bfor every passenger\b/.test(blob) ||
    /\bper person\b/.test(blob)
  );
}

function isCashbackStyleOffer(offer) {
  const blob = normalizeText(
    `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""} ${offer?.terms?.raw || offer?.terms || ""}`
  );

  const hasCashbackSignal =
    /\bcashback\b/.test(blob) ||
    /\bback as cashback\b/.test(blob) ||
    /\bget .* cashback\b/.test(blob) ||
    /\badditional cashback\b/.test(blob) ||
    /\bbonus\b/.test(blob) ||
    /\breward point(s)?\b/.test(blob) ||
    /\bsupercoin(s)?\b/.test(blob) ||
    /\bcoin(s)?\b/.test(blob) ||
    /\bwallet credit\b/.test(blob) ||
    /\bcredited later\b/.test(blob) ||
    /\bcredited within\b/.test(blob) ||
    /\bstatement credit\b/.test(blob) ||
    /\bcredit shell\b/.test(blob);

  const hasUpfrontDiscountSignal =
    /\binstant discount\b/.test(blob) ||
    /\binstant off\b/.test(blob) ||
    /\bflat .* off\b/.test(blob) ||
    /\bdiscount\b/.test(blob) ||
    /\boff\b/.test(blob);

  // Cashback-style means cashback/reward exists.
  // Mixed offers may still also have upfront discount, but cashback part should not count in price.
  return hasCashbackSignal && !hasUpfrontDiscountSignal;
}

function getOfferMaxDiscountAmount(offer, passengers = 1) {
  const pax = Math.max(1, Number(passengers) || 1);

  const direct =
    offer?.maxDiscountAmount ??
    offer?.parsedFields?.maxDiscountAmount ??
    offer?.bestTierForDisplay?.maxDiscountAmount ??
    offer?.parsedFields?.bestTierForDisplay?.maxDiscountAmount ??
    null;

  const directNum = Number(direct);

  if (Number.isFinite(directNum) && directNum > 0) {
    return offerIsPerPassenger(offer) ? directNum * pax : directNum;
  }

  const tiers =
    offer?.discountTiers ??
    offer?.parsedFields?.discountTiers ??
    null;

  if (Array.isArray(tiers) && tiers.length > 0) {
    const caps = tiers
      .map((t) => Number(t?.maxDiscountAmount))
      .filter((n) => Number.isFinite(n) && n > 0);

    if (caps.length > 0) {
      const bestCap = Math.max(...caps);
      return offerIsPerPassenger(offer) ? bestCap * pax : bestCap;
    }
  }

  const blob = String(
    `${offer?.rawDiscount || ""} ${offer?.title || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""}`
  );

  const m =
    blob.match(/\bup to\s*(?:rs\.?|inr|₹)\s*([\d,]{3,})/i) ||
    blob.match(/\bcapped at\s*(?:rs\.?|inr|₹)\s*([\d,]{3,})/i) ||
    blob.match(/\bmax(?:imum)?\s*(?:discount)?\s*(?:of)?\s*(?:rs\.?|inr|₹)\s*([\d,]{3,})/i);

  if (m && m[1]) {
    const n = Number(String(m[1]).replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) {
      return offerIsPerPassenger(offer) ? n * pax : n;
    }
  }

  return null;
}
function getSelectedEmiTenure(selectedPaymentMethods = []) {
  if (!Array.isArray(selectedPaymentMethods)) return null;

  for (const pm of selectedPaymentMethods) {
    const type = String(pm?.type || "").toLowerCase();
    const tenure = Number(pm?.tenureMonths || pm?.emiTenureMonths || 0);

    if (type.includes("emi") && Number.isFinite(tenure) && tenure > 0) {
      return tenure;
    }
  }

  return null;
}

function tierScopeMatchesTrip(tier, isDomestic) {
  const rawScope = String(
    tier?.flightScope ||
    tier?.scope ||
    tier?.routeScope ||
    tier?.applicableRouteType ||
    tier?.routeType ||
    ""
  ).toUpperCase();

  const notes = String(tier?.notes || "").toUpperCase();

  const scopeBlob = `${rawScope} ${notes}`;

  const tierSaysDomestic =
    /\bDOMESTIC\b/.test(scopeBlob) ||
    /\bDOMESTIC\s+FLIGHT/.test(scopeBlob);

  const tierSaysInternational =
    /\bINTERNATIONAL\b/.test(scopeBlob) ||
    /\bINTERNATIONAL\s+FLIGHT/.test(scopeBlob);

  // Generic tier with no route scope applies to both.
  if (!tierSaysDomestic && !tierSaysInternational) return true;

  if (isDomestic) {
    return tierSaysDomestic && !tierSaysInternational;
  }

  return tierSaysInternational && !tierSaysDomestic;
}


function normalizeTierTripTypeValue(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tierTripTypeMatchesRequest(tier, tripType = "one-way") {
  const requested = normalizeTierTripTypeValue(tripType);
  const requestedRoundTrip = /round\s*trip|return\s*trip/.test(requested);
  const requestedOneWay = /one\s*way|1\s*way/.test(requested) || !requestedRoundTrip;

  const blob = normalizeTierTripTypeValue([
    tier?.tripType,
    tier?.journeyType,
    tier?.bookingType,
    tier?.routeTripType,
    tier?.notes,
    tier?.description,
    tier?.raw
  ].filter(Boolean).join(" "));

  const saysOneWay = /\bone\s*way\b|\b1\s*way\b/.test(blob);
  const saysRoundTrip = /\bround\s*trip\b|\breturn\s*trip\b/.test(blob);

  // Generic tier with no trip-type language applies to both.
  if (!saysOneWay && !saysRoundTrip) return true;

  // If a tier explicitly says both, let both through.
  if (saysOneWay && saysRoundTrip) return true;

  if (requestedRoundTrip) return saysRoundTrip;
  if (requestedOneWay) return saysOneWay;

  return true;
}

function wordsToPassengerNumber(raw = "") {
  const s = String(raw || "").toLowerCase();
  if (/\bone\b/.test(s)) return 1;
  if (/\btwo\b/.test(s)) return 2;
  if (/\bthree\b/.test(s)) return 3;
  if (/\bfour\b/.test(s)) return 4;
  if (/\bfive\b/.test(s)) return 5;

  const n = Number(s.match(/\d+/)?.[0] || 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function tierPassengerCountMatchesRequest(tier, passengers = 1) {
  const pax = Math.max(1, Number(passengers) || 1);

  const directPassengerCount = Number(
    tier?.passengerCount ??
    tier?.passengers ??
    tier?.pax ??
    0
  );

  if (Number.isFinite(directPassengerCount) && directPassengerCount > 0) {
    return pax === directPassengerCount;
  }

  const directMinPassengers = Number(
    tier?.minPassengers ??
    tier?.minPassengerCount ??
    tier?.minPax ??
    0
  );

  const directMaxPassengers = Number(
    tier?.maxPassengers ??
    tier?.maxPassengerCount ??
    tier?.maxPax ??
    0
  );

  if (Number.isFinite(directMinPassengers) && directMinPassengers > 0 && pax < directMinPassengers) {
    return false;
  }

  if (Number.isFinite(directMaxPassengers) && directMaxPassengers > 0 && pax > directMaxPassengers) {
    return false;
  }

  if (
    Number.isFinite(directMinPassengers) && directMinPassengers > 0 ||
    Number.isFinite(directMaxPassengers) && directMaxPassengers > 0
  ) {
    return true;
  }

  const blob = String([
    tier?.notes,
    tier?.description,
    tier?.raw,
    tier?.label
  ].filter(Boolean).join(" ")).toLowerCase();

  // Generic tier with no passenger language applies to all passenger counts.
  if (!/\bpassenger(s)?\b|\bpax\b/.test(blob)) return true;

  // "three and more passengers", "3+ passengers", "3 or more pax"
  const plusMatch =
    blob.match(/\b(\d+|one|two|three|four|five)\s*(?:\+|and\s+more|or\s+more)\s*(?:passenger(s)?|pax)\b/i) ||
    blob.match(/\b(?:for\s+)?(\d+|one|two|three|four|five)\s*(?:and\s+more|or\s+more)\b/i);

  if (plusMatch) {
    const min = wordsToPassengerNumber(plusMatch[1]);
    return min ? pax >= min : true;
  }

  // "for one passenger", "for two passengers"
  const exactMatch =
    blob.match(/\b(?:for\s+)?(\d+|one|two|three|four|five)\s*(?:passenger(s)?|pax)\b/i);

  if (exactMatch) {
    const exact = wordsToPassengerNumber(exactMatch[1]);
    return exact ? pax === exact : true;
  }

  return true;
}


function pickApplicableDiscountTier(
  offer,
  eligibilityAmount,
  selectedPaymentMethods = [],
  isDomestic = true,
  tripType = "one-way",
  passengers = 1
) {
  const tiers = offer?.discountTiers || offer?.parsedFields?.discountTiers || [];
  if (!Array.isArray(tiers) || tiers.length === 0) return null;

  const amount = Number(eligibilityAmount || 0);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const selectedTenure = getSelectedEmiTenure(selectedPaymentMethods);

  const eligible = tiers
    .filter((t) => {
      if (!tierScopeMatchesTrip(t, isDomestic)) return false;
      if (!tierTripTypeMatchesRequest(t, tripType)) return false;
      if (!tierPassengerCountMatchesRequest(t, passengers)) return false;

      const min = Number(t?.minTransactionValue || 0);
      if (min > 0 && amount < min) return false;

      const max = Number(t?.maxTransactionValue || 0);
      if (max > 0 && amount > max) return false;

      const tierTenure = Number(t?.tenureMonths || 0);

      // If user selected EMI tenure, allow exact tenure or generic all-tenure tier.
      // If user did NOT select tenure, do NOT apply tenure-specific slabs like 6/9 months.
      if (selectedTenure) {
        if (tierTenure > 0 && tierTenure !== selectedTenure) return false;
      } else {
        if (tierTenure > 0) return false;
      }

      const flat = Number(t?.flatDiscountAmount || t?.discountAmount || 0);
      const pct = Number(t?.discountPercent || 0);

      return flat > 0 || pct > 0;
    })
    .sort((a, b) => {
      const aMin = Number(a?.minTransactionValue || 0);
      const bMin = Number(b?.minTransactionValue || 0);

      // Higher applicable slab should win first.
      if (aMin !== bMin) return bMin - aMin;

      const aTenure = Number(a?.tenureMonths || 0);
      const bTenure = Number(b?.tenureMonths || 0);

      // Exact EMI tenure wins over generic tier.
      if (selectedTenure) {
        const aExact = aTenure === selectedTenure ? 1 : 0;
        const bExact = bTenure === selectedTenure ? 1 : 0;
        if (aExact !== bExact) return bExact - aExact;
      }

      // If no tenure selected, generic all-tenure tier should win.
      if (!selectedTenure) {
        const aGeneric = aTenure === 0 ? 1 : 0;
        const bGeneric = bTenure === 0 ? 1 : 0;
        if (aGeneric !== bGeneric) return bGeneric - aGeneric;
      }

      const aVal = Number(a?.flatDiscountAmount || a?.discountAmount || a?.maxDiscountAmount || 0);
      const bVal = Number(b?.flatDiscountAmount || b?.discountAmount || b?.maxDiscountAmount || 0);
      return bVal - aVal;
    });

  return eligible[0] || null;
}

function computeDiscountedPrice(offer, baseAmount, isDomestic, passengers = 1, selectedPaymentMethods = [], eligibilityAmount = baseAmount, tripType = "one-way") {
  const base = Number(baseAmount);
  const pax = Math.max(1, Number(passengers) || 1);

  if (!Number.isFinite(base) || base <= 0) return baseAmount;

  const perPassenger = offerIsPerPassenger(offer);
  const maxCap = getOfferMaxDiscountAmount(offer, passengers);

  // Hard safety guard:
  // maxDiscountAmount is only a cap, not the discount itself.
  // If there is no tier, no flat amount, and no percentage, do not reduce price.
  const calcTiers = offer?.discountTiers || offer?.parsedFields?.discountTiers || [];
  const calcHasTiers = Array.isArray(calcTiers) && calcTiers.length > 0;
  const calcFlat = Number(offer?.flatDiscountAmount ?? offer?.parsedFields?.flatDiscountAmount ?? 0);
  const calcPct = Number(offer?.discountPercent ?? offer?.parsedFields?.discountPercent ?? 0);
  const calcRawDiscount = String(
    `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.parsedFields?.rawDiscount || ""}`
  ).toLowerCase();

  const calcVisiblePctMatch =
    calcRawDiscount.match(/(?:flat\s*)?(\d{1,2})\s*%\s*(?:instant\s*)?(?:discount|off)/i) ||
    calcRawDiscount.match(/(?:instant\s*)?(?:discount|off)[^%]{0,40}(\d{1,2})\s*%/i) ||
    calcRawDiscount.match(/\b(\d{1,2})\s*%\s*off\b/i);

  const calcVisiblePct = calcVisiblePctMatch ? Number(calcVisiblePctMatch[1]) : 0;

  const calcHasComputableDiscount =
    calcHasTiers ||
    (Number.isFinite(calcFlat) && calcFlat > 0) ||
    (Number.isFinite(calcPct) && calcPct > 0) ||
    (Number.isFinite(calcVisiblePct) && calcVisiblePct > 0);

  if (Number.isFinite(maxCap) && maxCap > 0 && !calcHasComputableDiscount) {
    return base;
  }

  const applicableTier = pickApplicableDiscountTier(
  offer,
  eligibilityAmount,
  selectedPaymentMethods,
  isDomestic,
  tripType,
  passengers
);

if (applicableTier) {
  const tierFlat = Number(applicableTier.flatDiscountAmount || applicableTier.discountAmount || 0);
  const tierPct = Number(applicableTier.discountPercent || 0);
  const tierCap = Number(applicableTier.maxDiscountAmount || 0);

  if (tierFlat > 0) {
    const discountAmount = perPassenger ? Math.round(tierFlat * pax) : Math.round(tierFlat);
    const discounted = Math.round(base - discountAmount);
    return discounted < base ? discounted : base;
  }

  if (tierPct > 0) {
    let discountAmount = Math.round(base * (tierPct / 100));
    if (tierCap > 0) discountAmount = Math.min(discountAmount, tierCap);

    const discounted = Math.round(base - discountAmount);
    return discounted < base ? discounted : base;
  }
}

  // Pure cashback / rewards / coins must not reduce upfront payable price
  if (isCashbackStyleOffer(offer)) {
    return base;
  }

  let pct = null;

  // Trust structured percent only if the raw text does not look cashback-only
  if (offer?.discountPercent != null) {
    const n = Number(offer.discountPercent);
    if (Number.isFinite(n) && n > 0) {
      pct = parsePercentFromRawDiscount(offer, isDomestic) ?? n;
    }
  }

  if (pct == null && ENABLE_ESTIMATED_DISCOUNTS) {
    pct = parsePercentFromRawDiscount(offer, isDomestic);
  }

  if (pct != null && Number.isFinite(pct) && pct > 0) {
    let discountAmount = 0;

    if (perPassenger) {
      const perPaxBase = base / pax;
      let perPaxDiscount = Math.round(perPaxBase * (pct / 100));

      if (Number.isFinite(maxCap) && maxCap > 0) {
        perPaxDiscount = Math.min(perPaxDiscount, maxCap);
      }

      discountAmount = perPaxDiscount * pax;
    } else {
      discountAmount = Math.round(base * (pct / 100));

      if (Number.isFinite(maxCap) && maxCap > 0) {
  discountAmount = Math.min(discountAmount, maxCap);
} else if (/\bup\s*to\b|\bupto\b/.test(String(offer?.rawDiscount || "").toLowerCase())) {
  return base;
}
    }

    const discounted = Math.round(base - discountAmount);
    return discounted < base ? discounted : base;
  }

  const flat = Number(
    offer?.flatDiscountAmount ??
    offer?.parsedFields?.flatDiscountAmount
  );

  if (Number.isFinite(flat) && flat > 0) {
    let discountAmount = perPassenger ? Math.round(flat * pax) : Math.round(flat);

    if (!perPassenger && Number.isFinite(maxCap) && maxCap > 0) {
      discountAmount = Math.min(discountAmount, maxCap);
    }

    const discounted = Math.round(base - discountAmount);
    return discounted < base ? discounted : base;
  }

  return base;
}

// --------------------
// Payment matching (robust)
// --------------------
function bankCanonicalFromAny(raw) {
  const directBankAliasInput = String(raw || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (directBankAliasInput === "DBS" || directBankAliasInput === "DBS_BANK") {
    return "DBS_BANK";
  }

  if (directBankAliasInput === "HSBC" || directBankAliasInput === "HSBC_BANK") {
    return "HSBC_BANK";
  }

  if (
    directBankAliasInput === "SBI" ||
    directBankAliasInput === "SBI_BANK" ||
    directBankAliasInput === "STATE_BANK" ||
    directBankAliasInput === "STATE_BANK_OF_INDIA"
  ) {
    return "STATE_BANK_OF_INDIA";
  }

  const s = String(raw || "").toUpperCase().replace(/\s+/g, " ").trim();

  if (!s) return null;

  if (/\bFLIPKART\b.*\bAXIS\b|\bAXIS\b.*\bFLIPKART\b/.test(s)) return "AXIS_BANK";
  if (/\bAXIS\b/.test(s)) return "AXIS_BANK";

  if (/\bHDFC\b/.test(s)) return "HDFC_BANK";
  if (/\bICICI\b/.test(s)) return "ICICI_BANK";
    if (/\bHSBC\b/.test(s)) return "HSBC";
  if (/\bSTANDARD CHARTERED\b|\bSTANDARD_CHARTERED\b|\bSTANCHART\b|\bSCB\b/.test(s)) return "STANDARD_CHARTERED_BANK";
  if (/\bSBI\b|\bSTATE BANK\b|\bSTATE_BANK\b/.test(s)) return "STATE_BANK_OF_INDIA";
  if (/\bKOTAK\b/.test(s)) return "KOTAK_BANK";
  if (/\bYES\b/.test(s)) return "YES_BANK";
  if (/\bRBL\b/.test(s)) return "RBL_BANK";
 if (/\bAU\b|\bAU SMALL\b/.test(s)) return "AU_SMALL_FINANCE_BANK";
  if (/\bFEDERAL\b/.test(s)) return "FEDERAL_BANK";
  if (/\bIDFC\b/.test(s)) return "IDFC_FIRST_BANK";
  if (/\bINDUSIND\b/.test(s)) return "INDUSIND_BANK";
  if (/\bAMEX\b|\bAMERICAN EXPRESS\b/.test(s)) return "AMERICAN_EXPRESS";
  if (/\bONECARD\b|\bONE CARD\b/.test(s)) return "ONECARD";
 if (/\bBOB\b|\bBOBCARD\b|\bBANK OF BARODA\b/.test(s)) return "BANK_OF_BARODA";
if (/\bCANARA\b/.test(s)) return "CANARA_BANK";
if (/\bDBS\b/.test(s)) return "DBS";
if (/\bCENTRAL BANK\b|\bCENTRAL BANK OF INDIA\b/.test(s)) return "CENTRAL_BANK_OF_INDIA";

  const cleaned = s.replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalizeBankCanonicalAlias(cleaned) || cleaned || null;
}

function normalizeSelectedPM(pm) {
  const typeRaw = String(pm?.type || "").trim();
  const nameRaw = String(pm?.name || pm?.bank || "").trim();
  const t = typeRaw.toLowerCase().replace(/\s+/g, "");

  const typeNorm =
    /emi/.test(t) ? "EMI" :
    /credit/.test(t) ? "CREDIT_CARD" :
    /debit/.test(t) ? "DEBIT_CARD" :
    /netbank/.test(t) || /netbanking/.test(t) ? "NET_BANKING" :
    /upi/.test(t) ? "UPI" :
    /wallet/.test(t) ? "WALLET" :
    null;

  const bankCanonical = bankCanonicalFromAny(nameRaw);

  const tenureMonths =
    Number(pm?.tenureMonths) ||
    Number(pm?.emiTenureMonths) ||
    null;

  const networkRaw = String(pm?.network || "").trim();
  const networkCanonical =
    /visa/i.test(networkRaw) ? "VISA" :
    /master/i.test(networkRaw) ? "MASTERCARD" :
    /rupay/i.test(networkRaw) ? "RUPAY" :
    /american express|amex/i.test(networkRaw) ? "AMERICAN_EXPRESS" :
    null;

  const providerRaw = String(pm?.provider || "").trim();
  const providerCanonical =
    /cred/i.test(providerRaw) ? "CRED" :
    /google\s*pay|gpay/i.test(providerRaw) ? "GOOGLE_PAY" :
    /phonepe/i.test(providerRaw) ? "PHONEPE" :
    /paytm/i.test(providerRaw) ? "PAYTM" :
    /bhim/i.test(providerRaw) ? "BHIM" :
    /amazon\s*pay/i.test(providerRaw) ? "AMAZON_PAY" :
    /mobikwik/i.test(providerRaw) ? "MOBIKWIK" :
    /freecharge/i.test(providerRaw) ? "FREECHARGE" :
    null;

    const cardFamilyRaw = String(pm?.cardFamily || pm?.cardVariant || "").trim();
  const cardFamilyCanonical =
    /flipkart\s*axis/i.test(cardFamilyRaw) ? "FLIPKART_AXIS" :
    /axis\s*atlas/i.test(cardFamilyRaw) ? "AXIS_ATLAS" :
    /axis\s*ace/i.test(cardFamilyRaw) ? "AXIS_ACE" :
    /axis\s*neo/i.test(cardFamilyRaw) ? "AXIS_NEO" :
    /axis\s*rewards/i.test(cardFamilyRaw) ? "AXIS_REWARDS" :
    /axis\s*vistara/i.test(cardFamilyRaw) ? "AXIS_VISTARA" :
    /amazon\s*pay\s*icici/i.test(cardFamilyRaw) ? "AMAZON_PAY_ICICI" :
    /tata\s*neu/i.test(cardFamilyRaw) ? "TATA_NEU" :
    /swiggy\s*hdfc/i.test(cardFamilyRaw) ? "SWIGGY_HDFC" :
    /diners/i.test(cardFamilyRaw) ? "DINERS" :
    /infinia/i.test(cardFamilyRaw) ? "INFINIA" :
    /regalia/i.test(cardFamilyRaw) ? "REGALIA" :
    /millennia/i.test(cardFamilyRaw) ? "MILLENNIA" :
    /sbi\s*cashback/i.test(cardFamilyRaw) ? "SBI_CASHBACK" :
    /business\s*platinum/i.test(cardFamilyRaw) ? "BUSINESS_PLATINUM" :
    /platinum/i.test(cardFamilyRaw) ? "PLATINUM" :
    /select/i.test(cardFamilyRaw) ? "SELECT" :
    /signature/i.test(cardFamilyRaw) ? "SIGNATURE" :
    /gold/i.test(cardFamilyRaw) ? "GOLD" :
    /simplyclick/i.test(cardFamilyRaw) ? "SIMPLYCLICK" :
    /simplysave/i.test(cardFamilyRaw) ? "SIMPLYSAVE" :
    /coral/i.test(cardFamilyRaw) ? "CORAL" :
    /rubyx/i.test(cardFamilyRaw) ? "RUBYX" :
    /sapphiro/i.test(cardFamilyRaw) ? "SAPPHIRO" :
    /emeralde/i.test(cardFamilyRaw) ? "EMERALDE" :
    null;
  const isCorporate =
    pm?.isCorporate === true ? true :
    pm?.isCorporate === false ? false :
    null;

  return {
    typeNorm,
    bankCanonical,
    nameRaw,
    tenureMonths,
    networkCanonical,
    providerCanonical,
    cardFamilyCanonical,
    isCorporate
  };
}
function extractAllowedEmiTenuresFromOffer(offer, pm = null) {
  const rawSources = [
    pm?.conditions || "",
    pm?.raw || "",
    offer?.title || "",
    offer?.rawDiscount || "",
    offer?.offerSummary || "",
    offer?.rawText || "",
    offer?.terms?.raw || offer?.terms || "",
  ]
    .map((x) => String(x || ""))
    .join(" ");

  const lowerRaw = rawSources.toLowerCase();
  const blob = normalizeText(rawSources);

  if (!/\bemi\b/.test(blob)) return [];

  const found = new Set();

  let m;

  // Raw text patterns: "3 & 6 Months", "3 and 6 month", "3/6 months"
  const rawPairRegex = /(\d{1,2})\s*(?:&|and|\/|\+|,)\s*(\d{1,2})\s*month(s)?/gi;
  while ((m = rawPairRegex.exec(lowerRaw)) !== null) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (Number.isFinite(a)) found.add(a);
    if (Number.isFinite(b)) found.add(b);
  }

  // Normalized fallback after symbols were stripped: "3 6 month"
  const normalizedPairRegex = /(\d{1,2})\s+(\d{1,2})\s+month(s)?/gi;
  while ((m = normalizedPairRegex.exec(blob)) !== null) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (Number.isFinite(a)) found.add(a);
    if (Number.isFinite(b)) found.add(b);
  }

  // Range patterns: "3 to 6 months"
  const rangeRegex = /(\d{1,2})\s*(?:to|-)\s*(\d{1,2})\s*month(s)?/gi;
  while ((m = rangeRegex.exec(lowerRaw)) !== null) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      found.add(a);
      found.add(b);
    }
  }

  // Single patterns: "6 month EMI"
  const singleRegex = /(\d{1,2})\s*month(s)?/gi;
  while ((m = singleRegex.exec(lowerRaw)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) found.add(n);
  }

  return Array.from(found)
    .filter((n) => n >= 2 && n <= 60)
    .sort((a, b) => a - b);
}

function extractOfferNetworkRestrictions(offer, pm = null) {
  const blob = normalizeText(
    `${pm?.raw || ""} ${pm?.conditions || ""} ${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""} ${offer?.terms?.raw || offer?.terms || ""}`
  );

  const allowed = new Set();
  const excluded = new Set();

  if (/\bvisa\b/.test(blob)) allowed.add("VISA");
  if (/\bmastercard\b|\bmaster card\b/.test(blob)) allowed.add("MASTERCARD");
  if (/\brupay\b/.test(blob)) allowed.add("RUPAY");
  if (/\bamerican express\b|\bamex\b/.test(blob)) allowed.add("AMERICAN_EXPRESS");

  if (/\bnot valid on visa\b|\bexcluding visa\b/.test(blob)) excluded.add("VISA");
  if (/\bnot valid on mastercard\b|\bexcluding mastercard\b|\bexcluding master card\b/.test(blob)) excluded.add("MASTERCARD");
  if (/\bnot valid on rupay\b|\bexcluding rupay\b/.test(blob)) excluded.add("RUPAY");
  if (/\bnot valid on american express\b|\bnot valid on amex\b|\bexcluding amex\b/.test(blob)) excluded.add("AMERICAN_EXPRESS");

  return {
    allowed: Array.from(allowed),
    excluded: Array.from(excluded)
  };
}

function extractOfferProviderRestrictions(offer, pm = null) {
  const blob = normalizeText(
    `${pm?.raw || ""} ${pm?.conditions || ""} ${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""} ${offer?.terms?.raw || offer?.terms || ""}`
  );

  const allowed = new Set();

  if (/\bcred\b/.test(blob)) allowed.add("CRED");
  if (/\bgoogle pay\b|\bgpay\b/.test(blob)) allowed.add("GOOGLE_PAY");
  if (/\bphonepe\b/.test(blob)) allowed.add("PHONEPE");
  if (/\bpaytm\b/.test(blob)) allowed.add("PAYTM");
  if (/\bbhim\b/.test(blob)) allowed.add("BHIM");
  if (/\bamazon pay\b/.test(blob)) allowed.add("AMAZON_PAY");
  if (/\bmobikwik\b/.test(blob)) allowed.add("MOBIKWIK");
  if (/\bfreecharge\b/.test(blob)) allowed.add("FREECHARGE");

  return Array.from(allowed);
}

function extractOfferCardFamilyRestrictions(offer, pm = null) {
  const blob = normalizeText(
    `${pm?.raw || ""} ${pm?.conditions || ""} ${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""} ${offer?.terms?.raw || offer?.terms || ""}`
  );

  const allowed = new Set();

  if (/\bflipkart\s*axis\b/.test(blob)) allowed.add("FLIPKART_AXIS");
  if (/\baxis\s*atlas\b/.test(blob)) allowed.add("AXIS_ATLAS");
  if (/\baxis\s*ace\b/.test(blob)) allowed.add("AXIS_ACE");
  if (/\baxis\s*neo\b/.test(blob)) allowed.add("AXIS_NEO");
  if (/\baxis\s*rewards\b/.test(blob)) allowed.add("AXIS_REWARDS");
  if (/\baxis\s*vistara\b/.test(blob)) allowed.add("AXIS_VISTARA");

  if (/\bamazon\s*pay\s*icici\b/.test(blob)) allowed.add("AMAZON_PAY_ICICI");
  if (/\btata\s*neu\b/.test(blob)) allowed.add("TATA_NEU");
  if (/\bswiggy\s*hdfc\b/.test(blob)) allowed.add("SWIGGY_HDFC");

  if (/\bdiners\b/.test(blob)) allowed.add("DINERS");
  if (/\binfinia\b/.test(blob)) allowed.add("INFINIA");
  if (/\bregalia\b/.test(blob)) allowed.add("REGALIA");
  if (/\bmillennia\b/.test(blob)) allowed.add("MILLENNIA");

  if (/\bsbi\s*cashback\b/.test(blob)) allowed.add("SBI_CASHBACK");

  if (/\bbusiness\s*platinum\b/.test(blob)) allowed.add("BUSINESS_PLATINUM");
  if (/\bplatinum\b/.test(blob)) allowed.add("PLATINUM");
  // Do not treat generic "select cards" wording as a hard card-family restriction.
  // Example: "Applicable to select AU Small Finance Bank credit cards" means eligible cards,
  // not a product family named SELECT.
  if (/\bsignature\b/.test(blob)) allowed.add("SIGNATURE");
  if (/\bgold\b/.test(blob)) allowed.add("GOLD");

  if (/\bsimplyclick\b/.test(blob)) allowed.add("SIMPLYCLICK");
  if (/\bsimplysave\b/.test(blob)) allowed.add("SIMPLYSAVE");

  if (/\bcoral\b/.test(blob)) allowed.add("CORAL");
  if (/\brubyx\b/.test(blob)) allowed.add("RUBYX");
  if (/\bsapphiro\b/.test(blob)) allowed.add("SAPPHIRO");
  if (/\bemeralde\b/.test(blob)) allowed.add("EMERALDE");

  return Array.from(allowed);
}

function extractOfferCorporateRestriction(offer, pm = null) {
  const blob = normalizeText(
    `${pm?.raw || ""} ${pm?.conditions || ""} ${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""} ${offer?.terms?.raw || offer?.terms || ""}`
  );

  const excludesCorporate =
    /\bnot valid on corporate\b/.test(blob) ||
    /\bnot applicable on corporate\b/.test(blob) ||
    /\bexcluding corporate\b/.test(blob) ||
    /\bnot valid on commercial\b/.test(blob) ||
    /\bnot applicable on commercial\b/.test(blob) ||
    /\bexcluding commercial\b/.test(blob) ||
    /\bnot valid on business\b[^.]{0,120}\bcard(s)?\b/.test(blob) ||
    /\bnot applicable on business\b[^.]{0,120}\bcard(s)?\b/.test(blob) ||
    /\bexcluding business\b[^.]{0,120}\bcard(s)?\b/.test(blob) ||
    /\bnot valid on\b[^.]{0,120}\b(business|commercial|corporate)\b[^.]{0,120}\bcard(s)?\b/.test(blob) ||
    /\bnot applicable on\b[^.]{0,120}\b(business|commercial|corporate)\b[^.]{0,120}\bcard(s)?\b/.test(blob);

  const corporateOnly =
    /\bcorporate cards only\b/.test(blob) ||
    /\bcommercial cards only\b/.test(blob);

  return { excludesCorporate, corporateOnly };
}

function normalizeBankCanonicalAlias(value) {
  const s = String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!s) return null;

  if (
    s === "AU" ||
    s === "AU_BANK" ||
    s === "AU_SMALL_BANK" ||
    s === "AU_SMALL_FINANCE" ||
    s === "AU_SMALL_FINANCE_BANK"
  ) {
    return "AU_SMALL_FINANCE_BANK";
  }

  if (
    s === "BOB" ||
    s === "BOBCARD" ||
    s === "BOBCARD_LTD" ||
    s === "BANK_OF_BARODA" ||
    s === "BANK_OF_BARODA_CARD"
  ) {
    return "BANK_OF_BARODA";
  }

  if (s === "AMEX") return "AMERICAN_EXPRESS";
  if (s === "SBI" || s === "SBI_BANK" || s === "STATE_BANK") return "STATE_BANK_OF_INDIA";
  if (s === "DBS" || s === "DBS_BANK") return "DBS_BANK";
  if (s === "HSBC" || s === "HSBC_BANK") return "HSBC_BANK";
  if (s === "IDFC" || s === "IDFC_BANK") return "IDFC_FIRST_BANK";
  if (
    s === "PNB" ||
    s === "PNB_BANK" ||
    s === "PUNJAB_NATIONAL" ||
    s === "PUNJAB_NATIONAL_BANK"
  ) {
    return "PUNJAB_NATIONAL_BANK";
  }

  return s;
}
function normalizeMethodCanonicalAlias(value) {
  const s = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!s) return null;

  if (
    s === "NETBANKING" ||
    s === "NET_BANKING" ||
    s === "NET_BANK" ||
    s === "NETBANK" ||
    s === "INTERNET_BANKING" ||
    s === "ONLINE_BANKING"
  ) {
    return "NET_BANKING";
  }

  if (
    s === "CREDITCARD" ||
    s === "CREDIT_CARD" ||
    s === "CC"
  ) {
    return "CREDIT_CARD";
  }

  if (
    s === "DEBITCARD" ||
    s === "DEBIT_CARD" ||
    s === "DC"
  ) {
    return "DEBIT_CARD";
  }

  if (s === "EMI" || s.includes("NO_COST_EMI") || s.includes("NOCOST_EMI")) {
    return "EMI";
  }

  if (s === "UPI") return "UPI";
  if (s === "WALLET") return "WALLET";

  return s;
}

function normalizeOfferPM(pm, offer = null) {
  const methodCanonical = normalizeMethodCanonicalAlias(pm?.methodCanonical);
  const typeRaw = String(pm?.type || "").toLowerCase();

  const typeNorm =
    methodCanonical ||
    (/emi/.test(typeRaw) ? "EMI" :
     /credit/.test(typeRaw) ? "CREDIT_CARD" :
     /debit/.test(typeRaw) ? "DEBIT_CARD" :
     /net\s*bank/.test(typeRaw) || /netbank/.test(typeRaw) || /internet\s*bank/.test(typeRaw) ? "NET_BANKING" :
     /upi/.test(typeRaw) ? "UPI" :
     /wallet/.test(typeRaw) ? "WALLET" :
     null);

const explicitBankCanonical = pm?.bankCanonical ? normalizeBankCanonicalAlias(pm.bankCanonical) : null;

// Important:
// Do not use pm.raw as a bank source for structured payment matching.
// Example: UPIPAY has raw = "UPI payment method". If we pass that to
// bankCanonicalFromAny(), it becomes UPI_PAYMENT_METHOD and blocks generic UPI matching.
const bankFromFields = pm?.bank || pm?.name || "";
// Prefer the name-derived canonical so the OFFER side canonicalizes identically
// to the SELECTION side (normalizeSelectedPM), which always uses bankCanonicalFromAny.
// Fall back to the scraper-provided canonical only when there's no usable bank name
// (e.g. generic UPI like UPIPAY, whose pm.bank is empty). Fixes cases like GOINDUSEMI:
// stored "INDUSIND" never matched selection-side "INDUSIND_BANK".
const nameDerived = bankFromFields ? bankCanonicalFromAny(bankFromFields) : null;
const bankCanonical = nameDerived || explicitBankCanonical;

  const explicitTenure =
    Number(pm?.tenureMonths) ||
    null;

  const inferredTenures = extractAllowedEmiTenuresFromOffer(offer, pm);
  const networkRestrictions = extractOfferNetworkRestrictions(offer, pm);
  const providerRestrictions = extractOfferProviderRestrictions(offer, pm);
  const cardFamilyRestrictions = extractOfferCardFamilyRestrictions(offer, pm);
  const corporateRestriction = extractOfferCorporateRestriction(offer, pm);

  
  return {
    typeNorm,
    bankCanonical,
    emiOnly: pm?.emiOnly === true,
    raw: String(pm?.raw || "").toLowerCase(),
    tenureMonths: explicitTenure,
    allowedTenures: inferredTenures,
    allowedNetworks: networkRestrictions.allowed,
    excludedNetworks: networkRestrictions.excluded,
    allowedProviders: providerRestrictions,
    allowedCardFamilies: cardFamilyRestrictions,
    excludesCorporate: corporateRestriction.excludesCorporate,
    corporateOnly: corporateRestriction.corporateOnly
  };
}

function offerMatchesSelectedPayment(offer, selectedPaymentMethods = []) {
  if (!Array.isArray(selectedPaymentMethods) || selectedPaymentMethods.length === 0) {
    return false;
  }

  const selNorm = selectedPaymentMethods
    .map(normalizeSelectedPM)
    .filter((x) => x.typeNorm);

  if (selNorm.length === 0) return false;

  // -----------------------------
  // 1) Hard bank guard from code/title/raw text
  // -----------------------------
 // Do NOT infer bank from coupon code here.
// Coupons like GOYES can look bank-related but are not reliable enough for hard rejection.
// Structured eligiblePaymentMethods should be the source of truth.
// Hard bank guard disabled.
// Structured eligiblePaymentMethods is the source of truth.
// This prevents valid offers like GOYES from being rejected before structured matching.
  // -----------------------------
  // 2) Structured PM match only
  // -----------------------------
  const offerPMs = extractOfferPaymentMethodsNoInference(offer);

  if (!Array.isArray(offerPMs) || offerPMs.length === 0) {
    return false;
  }

  const offerNorm = offerPMs
    .map((pm) => normalizeOfferPM(pm, offer))
    .filter((x) => x.typeNorm);

  if (offerNorm.length === 0) return false;

   for (const s of selNorm) {
    for (const o of offerNorm) {
      // UPI
      if (s.typeNorm === "UPI") {
        if (o.typeNorm !== "UPI") continue;

        if (
          Array.isArray(o.allowedProviders) &&
          o.allowedProviders.length > 0 &&
          s.providerCanonical &&
          !o.allowedProviders.includes(s.providerCanonical)
        ) {
          continue;
        }

        if (o.bankCanonical) {
          if (s.bankCanonical && s.bankCanonical === o.bankCanonical) return true;
          continue;
        }

        // Generic UPI offer with no bank restriction
        if (!o.bankCanonical) return true;
        continue;
      }

      // EMI
      if (s.typeNorm === "EMI") {
        if (o.typeNorm !== "EMI" && !(o.typeNorm === "CREDIT_CARD" && o.emiOnly === true)) {
          continue;
        }

        if (
          Number.isFinite(s.tenureMonths) &&
          Array.isArray(o.allowedTenures) &&
          o.allowedTenures.length > 0 &&
          !o.allowedTenures.includes(Number(s.tenureMonths))
        ) {
          continue;
        }

        if (
          Number.isFinite(s.tenureMonths) &&
          Number.isFinite(o.tenureMonths) &&
          Number(s.tenureMonths) !== Number(o.tenureMonths)
        ) {
          continue;
        }

        if (
          Array.isArray(o.allowedNetworks) &&
          o.allowedNetworks.length > 0
        ) {
          const amexBankSatisfiesAmexNetwork =
            s.bankCanonical === "AMERICAN_EXPRESS" &&
            o.allowedNetworks.includes("AMERICAN_EXPRESS");

          if (!s.networkCanonical && !amexBankSatisfiesAmexNetwork) {
            continue;
          }

          if (
            s.networkCanonical &&
            !o.allowedNetworks.includes(s.networkCanonical) &&
            !amexBankSatisfiesAmexNetwork
          ) {
            continue;
          }
        }

        if (
          Array.isArray(o.excludedNetworks) &&
          o.excludedNetworks.length > 0 &&
          s.networkCanonical &&
          o.excludedNetworks.includes(s.networkCanonical)
        ) {
          continue;
        }

        if (Array.isArray(o.allowedCardFamilies) && o.allowedCardFamilies.length > 0) {
          if (!s.cardFamilyCanonical) {
            continue;
          }
          if (!o.allowedCardFamilies.includes(s.cardFamilyCanonical)) {
            continue;
          }
        }

        if (
          o.excludesCorporate === true &&
          s.isCorporate === true
        ) {
          continue;
        }

        if (
          o.corporateOnly === true &&
          s.isCorporate === false
        ) {
          continue;
        }

        if (o.bankCanonical) {
          if (s.bankCanonical && s.bankCanonical === o.bankCanonical) return true;
          continue;
        }

        continue;
      }

           // Credit / Debit / NetBanking / Wallet
      if (s.typeNorm === o.typeNorm) {
        // EMI-only credit card offers must not apply to normal credit-card selections.
        // Example: MMTAUEMI should apply only when user selects EMI, not Credit Card.
        if (o.emiOnly === true) {
          continue;
        }

        if (
          Array.isArray(o.allowedNetworks) &&
          o.allowedNetworks.length > 0
        ) {
          if (!s.networkCanonical) {
            continue;
          }
          if (!o.allowedNetworks.includes(s.networkCanonical)) {
            continue;
          }
        }

        if (
          Array.isArray(o.excludedNetworks) &&
          o.excludedNetworks.length > 0 &&
          s.networkCanonical &&
          o.excludedNetworks.includes(s.networkCanonical)
        ) {
          continue;
        }

        // Card-family logic:
        // 1) If offer is family-specific and user explicitly selected a conflicting family => reject
        // 2) If offer is family-specific and user selected only the generic bank card (no family) => do NOT apply
        if (Array.isArray(o.allowedCardFamilies) && o.allowedCardFamilies.length > 0) {
          if (!s.cardFamilyCanonical) {
            continue;
          }
          if (!o.allowedCardFamilies.includes(s.cardFamilyCanonical)) {
            continue;
          }
        }

        if (
          o.excludesCorporate === true &&
          s.isCorporate === true
        ) {
          continue;
        }

        if (
          o.corporateOnly === true &&
          s.isCorporate === false
        ) {
          continue;
        }

        if (o.bankCanonical) {
          if (s.bankCanonical && s.bankCanonical === o.bankCanonical) return true;
          continue;
        }

        continue;
      }
    }
  }

  return false;
}

function getMatchedSelectedPaymentLabel(offer, selectedPaymentMethods) {
  if (!Array.isArray(selectedPaymentMethods) || selectedPaymentMethods.length === 0) return null;

  const offerPMs = extractOfferPaymentMethodsNoInference(offer);
  if (offerPMs.length === 0) return null;

  const sel = selectedPaymentMethods.map((x) => {
    const t = normalizePaymentType(x?.type || x?.name || "", x?.raw || "");
    const nm = normalizeBankName(x?.name || x?.bank || x?.raw || "");
    return { type: t, name: nm, rawName: x?.name || x?.bank || x?.raw || "" };
  });

  for (const pm of offerPMs) {
    const t = normalizePaymentType(pm.type, pm.raw || "");
    const name = normalizeBankName(pm.bank || pm.name || "");

    const match = sel.find((s) => s.type === t && (!s.name || s.name === name));
    if (match) {
      const namePart = match.rawName ? match.rawName : "";
      const typePart = match.type ? match.type : "";
      if (namePart && typePart) return `${namePart} • ${typePart}`;
      if (namePart) return namePart;
      if (typePart) return typePart;
      return null;
    }
  }

  return null;
}
function getInfoOfferDisplayLabel(offer, selectedPaymentMethods = []) {
  const exact = getMatchedSelectedPaymentLabel(offer, selectedPaymentMethods);
  if (exact) return "Exact match";

  const offerPMs =
    offer?.paymentMethods ||
    offer?.parsedFields?.paymentMethods ||
    offer?.eligiblePaymentMethods ||
    offer?.parsedFields?.eligiblePaymentMethods ||
    [];

  const selected = Array.isArray(selectedPaymentMethods) ? selectedPaymentMethods : [];

  const sameBank = Array.isArray(offerPMs) && offerPMs.some((pm) =>
    selected.some((sel) => {
      const offerBank = normalizeBankName(pm?.bank || pm?.name || pm?.raw || "");
      const selectedBank = normalizeBankName(sel?.name || sel?.bank || "");
      return offerBank && selectedBank && offerBank === selectedBank;
    })
  );

  if (sameBank) return "Same bank alternative";

  return "Related offer";
}
function getInfoOfferReasonLabel(offer, selectedPaymentMethods = []) {
  const validForBest = isValidBestOffer(offer);
  if (!validForBest) return "Shown for reference only";

  const offerPMs = extractOfferPaymentMethodsNoInference(offer);
  const selNorm = Array.isArray(selectedPaymentMethods)
    ? selectedPaymentMethods.map(normalizeSelectedPM).filter((x) => x.typeNorm)
    : [];

  if (!selNorm.length) return null;
  if (!offerPMs.length) return null;

  const offerNorm = offerPMs
    .map((pm) => normalizeOfferPM(pm, offer))
    .filter((x) => x.typeNorm);

  if (!offerNorm.length) return null;

  for (const s of selNorm) {
    for (const o of offerNorm) {
      const sameBank = !o.bankCanonical || (s.bankCanonical && s.bankCanonical === o.bankCanonical);

      if (!sameBank) continue;

      if (o.typeNorm === "EMI" && s.typeNorm !== "EMI") {
        return "Requires EMI";
      }

      if (
        Array.isArray(o.allowedCardFamilies) &&
        o.allowedCardFamilies.length > 0 &&
        !s.cardFamilyCanonical
      ) {
        return "Specific card required";
      }

      if (
        Array.isArray(o.allowedCardFamilies) &&
        o.allowedCardFamilies.length > 0 &&
        s.cardFamilyCanonical &&
        !o.allowedCardFamilies.includes(s.cardFamilyCanonical)
      ) {
        return "Different card variant required";
      }

      if (
        Array.isArray(o.allowedNetworks) &&
        o.allowedNetworks.length > 0 &&
        s.networkCanonical &&
        !o.allowedNetworks.includes(s.networkCanonical)
      ) {
        return "Different card network required";
      }

      if (o.corporateOnly === true && s.isCorporate === false) {
        return "Corporate card required";
      }

      if (o.excludesCorporate === true && s.isCorporate === true) {
        return "Not valid on corporate cards";
      }
    }
  }

  return null;
}

function extractBestNumericDiscountValue(offer) {
  const pct = Number(offer?.discountPercent ?? offer?.parsedFields?.discountPercent);
  const flat = Number(offer?.flatDiscountAmount ?? offer?.parsedFields?.flatDiscountAmount);

  if (Number.isFinite(flat) && flat > 0) return flat;
  if (Number.isFinite(pct) && pct > 0) return pct;

  const raw = String(
    offer?.rawDiscount ||
    offer?.parsedFields?.rawDiscount ||
    offer?.offerSummary?.headline ||
    ""
  );

  const pctMatch = raw.match(/(\d{1,2})\s*%/);
  if (pctMatch) return Number(pctMatch[1]);

  const amtMatch = raw.match(/(?:₹|rs\.?|inr)\s*([\d,]+)/i);
  if (amtMatch) return Number(String(amtMatch[1]).replace(/,/g, ""));

  return 0;
}

function scoreInfoOfferForDisplay({
  offer,
  selectedPaymentMethods,
  isSpecificFamilyInfoOnly,
}) {
  let score = 0;

  if (offerMatchesSelectedPayment(offer, selectedPaymentMethods)) score += 100;
  if (isSpecificFamilyInfoOnly) score += 20;

  const kind = getOfferKindForFlight(offer, selectedPaymentMethods, "")?.kind;
  if (kind === "payment") score += 40;
  if (kind === "airline") score += 15;
  if (kind === "portal") score += 10;

  const blob = normalizeText(
    `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary?.headline || ""}`
  );

  if (/\bemi\b/.test(blob)) score += 12;
  if (/\binstant discount\b|\boff\b|\bdiscount\b/.test(blob)) score += 10;
  if (isCashbackStyleOffer(offer)) score -= 8;

  score += Math.min(25, extractBestNumericDiscountValue(offer));

  return score;
}

function isSpecificFamilyOfferForGenericSelectedBank(offer, selectedPaymentMethods = []) {
  if (!Array.isArray(selectedPaymentMethods) || selectedPaymentMethods.length === 0) return false;

  const selNorm = selectedPaymentMethods
    .map(normalizeSelectedPM)
    .filter((x) => x.typeNorm);

  if (selNorm.length === 0) return false;

  const offerPMs = extractOfferPaymentMethodsNoInference(offer);
  if (!Array.isArray(offerPMs) || offerPMs.length === 0) return false;

  const offerNorm = offerPMs
    .map((pm) => normalizeOfferPM(pm, offer))
    .filter((x) => x.typeNorm);

  if (offerNorm.length === 0) return false;

  for (const s of selNorm) {
    for (const o of offerNorm) {
      if (s.typeNorm !== o.typeNorm) continue;
      if (o.bankCanonical && s.bankCanonical && o.bankCanonical !== s.bankCanonical) continue;

      if (
        Array.isArray(o.allowedCardFamilies) &&
        o.allowedCardFamilies.length > 0 &&
        !s.cardFamilyCanonical
      ) {
        return true;
      }
    }
  }

  return false;
}

// scope/cabin sanity
function offerScopeMatchesTrip(offer, isDomestic, cabin) {
  // IMPORTANT:
  // Only trust CORE fields for domestic/international scope.
  // rawText/terms often contain mixed portal/template noise and can mention both domestic + international.
  const title = String(offer?.title || "");
  const rawDiscount = String(offer?.rawDiscount || offer?.parsedFields?.rawDiscount || "");
  const offerSummary =
    typeof offer?.offerSummary === "string"
      ? offer.offerSummary
      : offer?.offerSummary
        ? JSON.stringify(offer.offerSummary)
        : (offer?.parsedFields?.offerSummary ? JSON.stringify(offer.parsedFields.offerSummary) : "");

  const core = normalizeText(`${title} ${rawDiscount} ${offerSummary}`);

  const cats = offer?.offerCategories || offer?.parsedFields?.offerCategories;
  const catBlob = Array.isArray(cats)
    ? normalizeText(cats.map((c) => String(c || "")).join(" "))
    : "";

  const combined = `${core} ${catBlob}`.trim();

  // Prefer row-level rawDiscount route scope before generic title text.
  // Some pages have generic titles like "domestic & international flights",
  // while each row/slab has the actual scope in rawDiscount.
  // Example: OneCard has the same title for domestic + international rows,
  // but rawDiscount says "on Domestic Flights" or "on International Flights".
  const rawDiscountCore = normalizeText(rawDiscount);

  const rawDiscountMentionsDomesticFlights =
    /\bdomestic\s+flight(s)?\b/.test(rawDiscountCore) ||
    (/\bdomestic\b/.test(rawDiscountCore) && /\bflight(s)?\b/.test(rawDiscountCore));

  const rawDiscountMentionsInternationalFlights =
    /\binternational\s+flight(s)?\b/.test(rawDiscountCore) ||
    (/\binternational\b/.test(rawDiscountCore) && /\bflight(s)?\b/.test(rawDiscountCore));

  if (isDomestic) {
    if (rawDiscountMentionsInternationalFlights && !rawDiscountMentionsDomesticFlights) {
      return false;
    }
  } else {
    if (rawDiscountMentionsDomesticFlights && !rawDiscountMentionsInternationalFlights) {
      return false;
    }
  }

  // Fall back to title + rawDiscount only when rawDiscount itself did not give a clear one-way route scope.
  const titleDiscountCore = normalizeText(`${title} ${rawDiscount}`);
  const strictMentionsDomesticFlights =
    /\bdomestic\s+flight(s)?\b/.test(titleDiscountCore) ||
    (/\bdomestic\b/.test(titleDiscountCore) && /\bflight(s)?\b/.test(titleDiscountCore));

  const strictMentionsInternationalFlights =
    /\binternational\s+flight(s)?\b/.test(titleDiscountCore) ||
    (/\binternational\b/.test(titleDiscountCore) && /\bflight(s)?\b/.test(titleDiscountCore));

  if (!rawDiscountMentionsDomesticFlights && !rawDiscountMentionsInternationalFlights) {
    if (isDomestic) {
      if (strictMentionsInternationalFlights && !strictMentionsDomesticFlights) {
        return false;
      }
    } else {
      if (strictMentionsDomesticFlights && !strictMentionsInternationalFlights) {
        return false;
      }
    }
  }

  // Reject clear non-flight verticals unless flights are explicitly mentioned in core/categories
  const hasFlight = /\bflight(s)?\b|\bair\s*ticket(s)?\b|\bairfare\b/.test(combined);
  const hasNonFlightVertical =
    /\btourism\b|\battraction(s)?\b|\bholiday(s)?\b|\bbus(es)?\b|\bcab(s)?\b|\btrain(s)?\b|\bhotel(s)?\b/.test(combined);

  if (hasNonFlightVertical && !hasFlight) return false;

  const cabinShort = normalizeCabinShort(cabin);

  if (
    (cabinShort === "economy" || cabinShort === "premium") &&
    /\bbusiness\s+class\b|\bfirst\s+class\b/.test(combined)
  ) {
    return false;
  }

  const mentionsDomesticFlights =
    /\bdomestic\s+flight(s)?\b/.test(combined) ||
    (/\bdomestic\b/.test(combined) && /\bflight(s)?\b/.test(combined));

  const mentionsInternationalFlights =
    /\binternational\s+flight(s)?\b/.test(combined) ||
    (/\binternational\b/.test(combined) && /\bflight(s)?\b/.test(combined));

  if (isDomestic) {
    // Domestic search must reject international-only flight offers
    if (mentionsInternationalFlights && !mentionsDomesticFlights) {
      return false;
    }
  } else {
    // International search must reject domestic-only flight offers
    if (mentionsDomesticFlights && !mentionsInternationalFlights) {
      return false;
    }
  }

  return true;
}

const MANUAL_MMT_CABIN_SCOPE_OVERRIDES = {
  // Manually verified on MakeMyTrip checkout, May 2026.
  // Important: MMT sometimes restricts flight coupons to Economy even when source offer text does not mention cabin/class.
  MMTBOI: {
    default: ["economy"],
  },
  MMTBOIINT: {
    default: ["economy"],
  },
  MMTDBSINTEMI: {
    default: ["economy"],
  },
  MMTONECARDIFEMI: {
    default: ["economy"],
  },
  MMTONECARDINTEMI: {
    default: ["economy"],
  },

  // Verified:
  // - Domestic OneCard EMI worked for economy and business.
  // - International OneCard business did not work in manual MMT checkout testing.
  // Therefore this coupon is route-aware, not globally business-eligible.
  MMTONECARDEMI: {
    domestic: ["economy", "business"],
    international: ["economy"],
  },
};

function getOfferCodeForCabinScope(offer = {}) {
  return String(
    offer?.couponCode ||
    offer?.code ||
    offer?.rawFields?.couponCode ||
    offer?.parsedFields?.couponCode ||
    ""
  ).trim().toUpperCase();
}

function offerMatchesManualCabinScope(offer, cabin, isDomestic = true) {
  const code = getOfferCodeForCabinScope(offer);
  const override = MANUAL_MMT_CABIN_SCOPE_OVERRIDES[code];

  if (!override) {
    return { ok: true };
  }

  const selectedCabin = normalizeCabinShort(cabin || "Economy");
  const routeKey = isDomestic ? "domestic" : "international";

  const allowedCabins =
    override[routeKey] ||
    override.default ||
    null;

  if (!Array.isArray(allowedCabins) || allowedCabins.length === 0) {
    return { ok: true };
  }

  if (allowedCabins.includes(selectedCabin)) {
    return {
      ok: true,
      code,
      selectedCabin,
      allowedCabins,
      routeKey,
    };
  }

  return {
    ok: false,
    reason: "CABIN_CLASS_MISMATCH",
    code,
    selectedCabin,
    allowedCabins,
    routeKey,
  };
}


// --------------------
// Booking day / weekday restrictions
// --------------------
const WEEKDAY_ALIASES = {
  monday: "Monday", mon: "Monday",
  tuesday: "Tuesday", tue: "Tuesday", tues: "Tuesday",
  wednesday: "Wednesday", wed: "Wednesday",
  thursday: "Thursday", thu: "Thursday", thur: "Thursday", thurs: "Thursday",
  friday: "Friday", fri: "Friday",
  saturday: "Saturday", sat: "Saturday",
  sunday: "Sunday", sun: "Sunday"
};

function getBookingDayName(date = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: "Asia/Kolkata"
  }).format(date);
}

function normalizeWeekdayToken(token) {
  const key = String(token || "").trim().toLowerCase().replace(/[^a-z]/g, "");
  return WEEKDAY_ALIASES[key] || null;
}

function extractWeekdaysFromText(text) {
  const out = new Set();
  const re = /\b(monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun)\b/gi;

  let m;
  while ((m = re.exec(String(text || ""))) !== null) {
    const day = normalizeWeekdayToken(m[1]);
    if (day) out.add(day);
  }

  return Array.from(out);
}

function offerWeekdayBlob(offer) {
  const terms =
    typeof offer?.terms === "string"
      ? offer.terms
      : offer?.terms?.raw
        ? String(offer.terms.raw)
        : "";

  return [
    offer?.bookingDays,
    offer?.applicableDays,
    offer?.bookingDayRestriction,
    offer?.validityPeriod?.raw,
    offer?.parsedFields?.validityPeriod?.raw,
    terms,
    offer?.rawText,
    offer?.title,
    offer?.rawDiscount
  ]
    .flat()
    .filter(Boolean)
    .join(" ");
}

const BOOKING_DAY_RULE_CACHE = new WeakMap();

function rememberBookingDayRule(offer, rule) {
  if (offer && typeof offer === "object") {
    BOOKING_DAY_RULE_CACHE.set(offer, rule);
  }
  return rule;
}

function extractBookingDayRule(offer) {
  if (offer && typeof offer === "object" && BOOKING_DAY_RULE_CACHE.has(offer)) {
    return BOOKING_DAY_RULE_CACHE.get(offer);
  }

  const blobRaw = offerWeekdayBlob(offer);
  const blob = String(blobRaw || "").toLowerCase().replace(/\s+/g, " ").trim();

  if (!blob) return rememberBookingDayRule(offer, null);

  // Explicit everyday/all-days wording means no weekday restriction.
  // But if it also says "except Tuesday", the exception must still be enforced.
  const hasAllDaysSignal =
    /\bevery\s*day\b|\beveryday\b|\ball\s+days\b|\bmonday\s*(?:to|-|–|—)\s*sunday\b|\bmon\s*(?:to|-|–|—)\s*sun\b/.test(blob);

  const exceptMatch = blob.match(/\bexcept\s+((?:monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun)(?:\s*(?:,|&|and|\/)\s*(?:monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun))*)/i);

  if (exceptMatch) {
    const days = extractWeekdaysFromText(exceptMatch[1]);

    if (days.length > 0) {
      return rememberBookingDayRule(offer, {
        mode: "exclude",
        days,
        source: exceptMatch[0]
      });
    }
  }

  if (hasAllDaysSignal) return rememberBookingDayRule(offer, null);

  // Only treat weekday mentions as restrictions when there is a strong validity/booking-day signal nearby.
  const restrictionSignals = [
    /\bvalid\s+(?:only\s+)?(?:on\s+)?(?:all\s+)?(?:every\s+)?(?:monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun)/i,
    /\bvalid\s+for\s+(?:transactions|bookings)\s+made\s+(?:on\s+)?(?:all\s+)?(?:every\s+)?(?:monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun)/i,
    /\btransactions\s+made\s+(?:every\s+|on\s+)?(?:monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun)/i,
    /\bbookings\s+made\s+(?:every\s+|on\s+)?(?:monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun)/i,
    /\boffer\s+(?:can\s+be\s+availed|is\s+valid)\s+(?:every\s+|on\s+)?(?:monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun)/i,
    /\bevery\s+(?:monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun)/i,
    /\b(?:sat|saturday)\s*(?:&|and|\/)\s*(?:sun|sunday)\s+only\b/i
  ];

  const matchedSignal = restrictionSignals.find((re) => re.test(blob));

  if (!matchedSignal) return rememberBookingDayRule(offer, null);

  const days = extractWeekdaysFromText(blob);

  if (days.length === 0) return rememberBookingDayRule(offer, null);

  return rememberBookingDayRule(offer, {
    mode: "include",
    days,
    source: matchedSignal.toString()
  });
}

function offerMatchesBookingDay(offer, bookingDate = new Date()) {
  const rule = extractBookingDayRule(offer);
  const bookingDay = getBookingDayName(bookingDate);

  if (!rule || !Array.isArray(rule.days) || rule.days.length === 0) {
    return {
      ok: true,
      bookingDay,
      rule: null
    };
  }

  const includesDay = rule.days.includes(bookingDay);

  const ok = rule.mode === "exclude" ? !includesDay : includesDay;

  return {
    ok,
    bookingDay,
    rule
  };
}

// --------------------
// Core evaluator
function evaluateOfferForFlight({
  offer,
  portal,
  baseAmount,
  eligibilityAmount,
  selectedPaymentMethods,
  isDomestic,
  cabin,
  flightAirlineName,
  tripType,
  passengers,
  allOffers = [],
}) {
  if (!offer) return { ok: false, reasons: ["NO_OFFER"] };
  if (!isTrustedPricingRule(offer)) {
  return { ok: false, reasons: ["NOT_TRUSTED_PRICING_RULE"] };
}

  if (!isFlightOffer(offer)) return { ok: false, reasons: ["NOT_FLIGHT_OFFER"] };
  if (isHotelOnlyOffer(offer)) return { ok: false, reasons: ["HOTEL_ONLY_OFFER"] };

  const nfBlob = `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.rawText || ""} ${offer?.terms || ""}`.toLowerCase();
  const mentionsFlight = /\bflight(s)?\b|\bair\s*ticket(s)?\b|\bairfare\b/.test(nfBlob);
  const mentionsNonFlight = /\btourism\b|\battraction(s)?\b|\bholiday(s)?\b|\bactivity\b|\bvisa\b|\bforex\b|\bbus(es)?\b|\bcab(s)?\b|\btrain(s)?\b|\bhotel(s)?\b/.test(nfBlob);

  if (mentionsNonFlight && !mentionsFlight) {
    return { ok: false, reasons: ["NON_FLIGHT_VERTICAL"] };
  }

  if (isHotelOnlyOffer(offer)) return { ok: false, reasons: ["HOTEL_ONLY"] };
  if (isFirstTimeOrNewUserOffer(offer)) return { ok: false, reasons: ["FIRST_TIME_OR_NEW_USER"] };

    if (isOfferExpired(offer)) return { ok: false, reasons: ["EXPIRED"] };

const bookingDayCheck = offerMatchesBookingDay(offer);
if (!bookingDayCheck.ok) {
  return {
    ok: false,
    reasons: ["BOOKING_DAY_MISMATCH"],
    bookingDay: bookingDayCheck.bookingDay,
    allowedBookingDays: bookingDayCheck.rule?.days || null
  };
}

if (!offerAppliesToPortal(offer, portal)) return { ok: false, reasons: ["PORTAL_MISMATCH"] };
if (!offerScopeMatchesTrip(offer, isDomestic, cabin)) return { ok: false, reasons: ["SCOPE_MISMATCH"] };

if (isSuspiciousGenericOffer(offer, allOffers || [])) {
  return { ok: false, reasons: ["SUSPICIOUS_GENERIC_VARIANT"] };
}

// Best-offer trust filter:
// allow display elsewhere, but never let non-deterministic / vague offers become applied winners
// Generic/portal deterministic offers are allowed to become best offers.
// Example: Goibibo "Domestic Flight Discount" FLAT ₹750 OFF with paymentMethods: [].
if (!isDeterministicPortalPricingOffer(offer) && !isValidBestOffer(offer)) {
  return { ok: false, reasons: ["NOT_VALID_BEST_OFFER"] };
}
  const rawDiscountText = String(
  offer?.rawDiscount ||
  offer?.parsedFields?.rawDiscount ||
  ""
).toLowerCase();

const hasTiers =
  Array.isArray(offer?.discountTiers) && offer.discountTiers.length > 0;

const structuredFlatAmount = Number(
  offer?.flatDiscountAmount ?? offer?.parsedFields?.flatDiscountAmount ?? 0
);

const structuredMaxCap = Number(
  offer?.maxDiscountAmount ?? offer?.parsedFields?.maxDiscountAmount ?? 0
);

const structuredPercent = Number(
  offer?.discountPercent ?? offer?.parsedFields?.discountPercent ?? 0
);

// For best-deal eligibility, only trust a percent clearly visible in the
// concise offer fields. Do NOT infer percent from long rawText here, because
// rawText can contain unrelated terms/tiers and can make cap-only "up to" offers
// look deterministic.
const conciseDiscountBlob = String(
  `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.parsedFields?.rawDiscount || ""}`
).toLowerCase();

const concisePercentMatch =
  conciseDiscountBlob.match(/(?:flat\s*)?(\d{1,2})\s*%\s*(?:instant\s*)?(?:discount|off)/i) ||
  conciseDiscountBlob.match(/(?:instant\s*)?(?:discount|off)[^%]{0,40}(\d{1,2})\s*%/i) ||
  conciseDiscountBlob.match(/\b(\d{1,2})\s*%\s*off\b/i);

const parsedPercent = concisePercentMatch
  ? Number(concisePercentMatch[1])
  : 0;

const hasStructuredFlat =
  Number.isFinite(structuredFlatAmount) && structuredFlatAmount > 0;

const hasStructuredCap =
  Number.isFinite(structuredMaxCap) && structuredMaxCap > 0;

const hasStructuredPercent =
  Number.isFinite(structuredPercent) && structuredPercent > 0;

const hasParsedPercent =
  Number.isFinite(parsedPercent) && parsedPercent > 0;

// Important:
// maxDiscountAmount is only a cap. It is NOT the actual discount by itself.
// A direct best deal must have a computable discount source:
// - discount tiers, OR
// - flat discount, OR
// - structured/parsed percentage.
// Cap-only / "up to ₹X" offers must not become applied winners.
const hasComputableDiscountStructure =
  hasTiers ||
  hasStructuredFlat ||
  hasStructuredPercent ||
  hasParsedPercent;

const isTrustedCappedPercentOffer =
  offer?.pricingEligible === true &&
  offer?.hasDeterministicDiscount === true &&
  (hasStructuredPercent || hasParsedPercent) &&
  (hasStructuredCap || hasStructuredFlat);

const isCapOnlyDiscount =
  hasStructuredCap && !hasComputableDiscountStructure;

const isUnsafeUpToOnly =
  /\bup\s*to\b|\bupto\b/.test(rawDiscountText) &&
  !hasComputableDiscountStructure &&
  !isTrustedCappedPercentOffer;

if (isCapOnlyDiscount) {
  return { ok: false, reasons: ["CAP_ONLY_NOT_DETERMINISTIC"] };
}

if (isUnsafeUpToOnly) {
  return { ok: false, reasons: ["UNSAFE_UPTO_OFFER"] };
}

if (isCashbackStyleOffer(offer)) {
  return { ok: false, reasons: ["CASHBACK_NOT_UPFRONT_PRICE"] };
}



  if (tripType === "one-way" && offerRequiresRoundTrip(offer)) {
    return { ok: false, reasons: ["ROUND_TRIP_ONLY"] };
  }
  const passengerRestriction = getPassengerRestrictionResult(offer, passengers);
  if (!passengerRestriction.ok) {
    return {
      ok: false,
      reasons: [passengerRestriction.reason || "PASSENGER_COUNT_RESTRICTED"],
    };
  }
  const hasExplicitPM = hasExplicitOfferPaymentMethods(offer);
const hasSelectedPM = Array.isArray(selectedPaymentMethods) && selectedPaymentMethods.length > 0;

// ✅ FIX: only block payment-type offers, not portal/airline offers
const offerKindCheck = getOfferKindForFlight(offer, selectedPaymentMethods, flightAirlineName);

if (
  hasExplicitPM &&
  !hasSelectedPM &&
  offerKindCheck.kind === null &&
  offerKindCheck.reason === "PAYMENT_REQUIRED_NOT_SELECTED"
) {
  return { ok: false, reasons: ["PAYMENT_REQUIRED_NOT_SELECTED"] };
}
  const kindInfo = getOfferKindForFlight(offer, selectedPaymentMethods, flightAirlineName);
  if (!kindInfo.kind) {
    return { ok: false, reasons: [kindInfo.reason || "NOT_ELIGIBLE"] };
  }

  const manualCabinScope = offerMatchesManualCabinScope(offer, cabin, isDomestic);
  if (!manualCabinScope.ok) {
    return {
      ok: false,
      reasons: [manualCabinScope.reason || "CABIN_CLASS_MISMATCH"],
      manualCabinScope,
    };
  }

  const minTxn = getMinTxnValue(offer);
  const totalAmount = Number(eligibilityAmount ?? baseAmount);
  const pax = Math.max(1, Number(passengers) || 1);
  const perPassengerAmount = totalAmount / pax;
  const isPerPax = offerIsPerPassenger(offer);

  if (Number.isFinite(minTxn) && minTxn > 0) {
    if (isPerPax) {
      if (perPassengerAmount < minTxn) {
        return { ok: false, reasons: ["MIN_TXN_NOT_MET_PER_PAX"], minTxn };
      }
    } else {
      if (totalAmount < minTxn) {
        return { ok: false, reasons: ["MIN_TXN_NOT_MET"], minTxn };
      }
    }
  }

  // Final deterministic-discount guard before price calculation.
  // A maxDiscountAmount is only a cap. It must not be treated as the discount itself.
  const directTiers =
    offer?.discountTiers ||
    offer?.parsedFields?.discountTiers ||
    [];

  const hasRealTierDiscount =
    Array.isArray(directTiers) &&
    directTiers.some((t) => {
      const tierFlat = Number(t?.flatDiscountAmount || t?.discountAmount || 0);
      const tierPct = Number(t?.discountPercent || 0);
      return tierFlat > 0 || tierPct > 0;
    });

  const directFlat = Number(
    offer?.flatDiscountAmount ??
    offer?.parsedFields?.flatDiscountAmount ??
    offer?.discountAmount ??
    offer?.parsedFields?.discountAmount ??
    0
  );

  const directPct = Number(
    offer?.discountPercent ??
    offer?.parsedFields?.discountPercent ??
    0
  );

  const directCap = Number(
    offer?.maxDiscountAmount ??
    offer?.parsedFields?.maxDiscountAmount ??
    0
  );

  const conciseDiscountText = String(
    `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.parsedFields?.rawDiscount || ""}`
  ).toLowerCase();

  const hasVisiblePct =
    /(?:flat\s*)?\d{1,2}\s*%\s*(?:instant\s*)?(?:discount|off)/i.test(conciseDiscountText) ||
    /(?:instant\s*)?(?:discount|off)[^%]{0,40}\d{1,2}\s*%/i.test(conciseDiscountText) ||
    /\b\d{1,2}\s*%\s*off\b/i.test(conciseDiscountText);

  const hasComputableDiscountBeforeCalc =
    hasRealTierDiscount ||
    (Number.isFinite(directFlat) && directFlat > 0) ||
    (Number.isFinite(directPct) && directPct > 0) ||
    hasVisiblePct;

  if (Number.isFinite(directCap) && directCap > 0 && !hasComputableDiscountBeforeCalc) {
    return { ok: false, reasons: ["CAP_ONLY_NOT_DETERMINISTIC"] };
  }

  // Final deterministic-discount guard before price calculation.
  // maxDiscountAmount is only a cap. It must not become the discount by itself.
  const finalGuardTiers =
    offer?.discountTiers ||
    offer?.parsedFields?.discountTiers ||
    [];

  const finalGuardHasTierDiscount =
    Array.isArray(finalGuardTiers) &&
    finalGuardTiers.some((t) => {
      const tierFlat = Number(t?.flatDiscountAmount || t?.discountAmount || 0);
      const tierPct = Number(t?.discountPercent || 0);
      return tierFlat > 0 || tierPct > 0;
    });

  const finalGuardFlat = Number(
    offer?.flatDiscountAmount ??
    offer?.parsedFields?.flatDiscountAmount ??
    offer?.discountAmount ??
    offer?.parsedFields?.discountAmount ??
    0
  );

  const finalGuardPct = Number(
    offer?.discountPercent ??
    offer?.parsedFields?.discountPercent ??
    0
  );

  const finalGuardCap = Number(
    offer?.maxDiscountAmount ??
    offer?.parsedFields?.maxDiscountAmount ??
    0
  );

  const finalGuardText = String(
    `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.parsedFields?.rawDiscount || ""}`
  ).toLowerCase();

  const finalGuardHasVisiblePct =
    /(?:flat\s*)?\d{1,2}\s*%\s*(?:instant\s*)?(?:discount|off)/i.test(finalGuardText) ||
    /(?:instant\s*)?(?:discount|off)[^%]{0,40}\d{1,2}\s*%/i.test(finalGuardText) ||
    /\b\d{1,2}\s*%\s*off\b/i.test(finalGuardText);

  const finalGuardHasComputableDiscount =
    finalGuardHasTierDiscount ||
    (Number.isFinite(finalGuardFlat) && finalGuardFlat > 0) ||
    (Number.isFinite(finalGuardPct) && finalGuardPct > 0) ||
    finalGuardHasVisiblePct;

  if (Number.isFinite(finalGuardCap) && finalGuardCap > 0 && !finalGuardHasComputableDiscount) {
    return { ok: false, reasons: ["CAP_ONLY_NOT_DETERMINISTIC"] };
  }

  const discounted = computeDiscountedPrice(
  offer,
  baseAmount,
  isDomestic,
  passengers,
  selectedPaymentMethods,
  eligibilityAmount,
  tripType
);
  const maxDiscountAmount = getOfferMaxDiscountAmount(offer);

  if (!Number.isFinite(discounted)) return { ok: false, reasons: ["DISCOUNT_NOT_COMPUTABLE"] };
  if (discounted >= baseAmount) return { ok: false, reasons: ["NO_IMPROVEMENT"] };

    return {
    ok: true,
    discounted,
    minTxn,
    maxDiscountAmount,
    offerKind: kindInfo.kind,
    offerTypeLabel: getOfferTypeLabel(kindInfo.kind, offer),
    channelLabel: getOfferChannelLabel(offer),
  };
}


function offerMatchesSelectedEmiTenureForInfo(offer, selectedPaymentMethods = []) {
  const selectedTenure = getSelectedEmiTenure(selectedPaymentMethods);

  // If user did not select EMI tenure, do not block info offers.
  if (!selectedTenure) return true;

  const offerPMs = extractOfferPaymentMethodsNoInference(offer);
  if (!Array.isArray(offerPMs) || offerPMs.length === 0) return true;

  const offerNorm = offerPMs
    .map((pm) => normalizeOfferPM(pm, offer))
    .filter((x) => x.typeNorm);

  const hasEmiPayment = offerNorm.some((o) => o.typeNorm === "EMI" || o.emiOnly === true);
  if (!hasEmiPayment) return true;

  return offerNorm.some((o) => {
    if (o.typeNorm !== "EMI" && o.emiOnly !== true) return false;

    if (Number.isFinite(o.tenureMonths) && o.tenureMonths > 0) {
      return Number(o.tenureMonths) === Number(selectedTenure);
    }

    if (Array.isArray(o.allowedTenures) && o.allowedTenures.length > 0) {
      return o.allowedTenures.includes(Number(selectedTenure));
    }

    // Generic EMI offer without tenure restriction can still be shown.
    return true;
  });
}
function shouldShowAsReferenceInfoOffer({
  offer,
  portal,
  selectedPaymentMethods,
  cabin,
  isDomestic,
  appliedCouponCode,
}) {
  if (!offer) return false;
  if (!isFlightOffer(offer)) return false;
  if (isHotelOnlyOffer(offer)) return false;
  if (isOfferExpired(offer)) return false;

  const bookingDayCheck = offerMatchesBookingDay(offer);
  if (!bookingDayCheck.ok) return false;

  if (!offerAppliesToPortal(offer, portal)) return false;

  const coupon =
    offer?.couponCode ||
    offer?.code ||
    offer?.parsedFields?.couponCode ||
    offer?.parsedFields?.code ||
    null;

  if (appliedCouponCode && coupon && coupon === appliedCouponCode) return false;

  const coreBlob = normalizeText(
    `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""}`
  );

  if (
    (normalizeCabinShort(cabin) === "economy" || normalizeCabinShort(cabin) === "premium") &&
    /\bbusiness class\b|\bfirst class\b/.test(coreBlob)
  ) {
    return false;
  }

  if (!offerScopeMatchesTrip(offer, isDomestic, cabin)) return false;

  const selected = Array.isArray(selectedPaymentMethods) ? selectedPaymentMethods : [];
  const hasExplicitPM = hasExplicitOfferPaymentMethods(offer);

  // If no payment selected, only show generic portal/airline references.
  if (selected.length === 0) {
    return !hasExplicitPM;
  }

  // If payment selected, show:
  // 1. exact payment matches
  // 2. same-bank alternatives
  // 3. generic portal/airline offers
  if (!hasExplicitPM) return true;

  if (offerMatchesSelectedPayment(offer, selected)) return true;

  const offerPMs = extractOfferPaymentMethodsNoInference(offer);
  const sameBank = offerPMs.some((pm) =>
    selected.some((sel) => {
      const offerBank = bankCanonicalFromAny(pm?.bankCanonical || pm?.bank || pm?.name || pm?.raw || "");
      const selectedBank = bankCanonicalFromAny(sel?.name || sel?.bank || "");
      return offerBank && selectedBank && offerBank === selectedBank;
    })
  );

  return sameBank;
}

function buildInfoOffersForPortal(
  offers,
  portal,
  selectedPaymentMethods,
  cabin,
  isDomestic,
  appliedCouponCode,
  limit = 5
) {
   
 const sel = Array.isArray(selectedPaymentMethods) ? selectedPaymentMethods : [];

  const info = [];
  const seen = new Set();

    for (const offer of offers) {
      // 🔥 REMOVE JUNK OFFERS HERE (MAIN FIX)
if (isJunkInfoOffer(offer)) continue;
       if (!isFlightOffer(offer)) continue;
if (isHotelOnlyOffer(offer)) continue;
if (isOfferExpired(offer)) continue;

const bookingDayCheck = offerMatchesBookingDay(offer);
if (!bookingDayCheck.ok) continue;

if (!offerAppliesToPortal(offer, portal)) continue;
if (isSuspiciousGenericOffer(offer, offers)) continue;
if (!offerMatchesSelectedEmiTenureForInfo(offer, selectedPaymentMethods)) continue;

    const coreBlob = normalizeText(
      `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""}`
    );

    const termsBlob = normalizeText(
      `${offer?.terms?.raw || offer?.terms || ""} ${offer?.parsedFields?.terms?.raw || ""}`
    );

    const scopeBlob = `${coreBlob} ${termsBlob}`;

    if (
      (normalizeCabinShort(cabin) === "economy" || normalizeCabinShort(cabin) === "premium") &&
      /\bbusiness class\b|\bfirst class\b/.test(scopeBlob)
    ) {
      continue;
    }

    if (isDomestic) {
      if (/\binternational flight(s)?\b/.test(scopeBlob) && !/\bdomestic flight(s)?\b/.test(scopeBlob)) {
        continue;
      }
    } else {
      if (/\bdomestic flight(s)?\b/.test(scopeBlob) && !/\binternational flight(s)?\b/.test(scopeBlob)) {
        continue;
      }
    }

   if (offerRequiresRoundTrip(offer) && appliedCouponCode) continue;

    const offerCouponCode =
      offer?.couponCode ||
      offer?.code ||
      offer?.parsedFields?.couponCode ||
      offer?.parsedFields?.code ||
      null;

    if (appliedCouponCode && offerCouponCode && offerCouponCode === appliedCouponCode) {
      continue;
    }

    const matchesNormally = offerMatchesSelectedPayment(offer, selectedPaymentMethods);
    const isSpecificFamilyInfoOnly = isSpecificFamilyOfferForGenericSelectedBank(
      offer,
      selectedPaymentMethods
    );

    const offerPMs =
      offer?.paymentMethods ||
      offer?.parsedFields?.paymentMethods ||
      offer?.eligiblePaymentMethods ||
      offer?.parsedFields?.eligiblePaymentMethods ||
      [];

    const isBroadBankMatch =
      Array.isArray(offerPMs) &&
      offerPMs.some((pm) =>
        selectedPaymentMethods?.some((selPm) => {
          const offerBank = normalizeBankName(pm?.bank || pm?.name || pm?.raw || "");
          const selectedBank = normalizeBankName(selPm?.name || selPm?.bank || "");
          return offerBank && selectedBank && offerBank === selectedBank;
        })
      );

  const infoEval = evaluateOfferForFlight({
  offer,
  portal,
  baseAmount: 10000,
  eligibilityAmount: 10000,
  selectedPaymentMethods,
  isDomestic,
  cabin,
  flightAirlineName: "",
  tripType: "one-way",
  passengers: 1,
  allOffers: offers,
});

const showReferenceInfo = shouldShowAsReferenceInfoOffer({
  offer,
  portal,
  selectedPaymentMethods,
  cabin,
  isDomestic,
  appliedCouponCode,
});

// NEW LOGIC — allow valid offers even if not applied

const infoEvalReasons = Array.isArray(infoEval?.reasons) ? infoEval.reasons : [];

const isValidButNotApplied =
  !infoEval.ok &&
  !infoEvalReasons.includes("BOOKING_DAY_MISMATCH") &&
  !infoEvalReasons.includes("EXPIRED") &&
  !infoEvalReasons.includes("NOT_FLIGHT_OFFER") &&
  !infoEvalReasons.includes("HOTEL_ONLY") &&
  !infoEvalReasons.includes("PORTAL_MISMATCH") &&
  !infoEvalReasons.includes("SCOPE_MISMATCH") &&
  !isOfferExpired(offer) &&
  isFlightOffer(offer);

const canBeShownAsMatchedInfo =
  infoEval.ok ||                 // applied
  showReferenceInfo ||           // reference
  isSpecificFamilyInfoOnly ||    // card mismatch
  isValidButNotApplied;          // 👈 NEW

if (!canBeShownAsMatchedInfo) continue;
    const dedupeKey = [
      offerCouponCode || "",
      String(offer?.title || "").trim().toLowerCase(),
      String(offer?.rawDiscount || "").trim().toLowerCase(),
      String(offer?.sourceMetadata?.sourcePortal || offer?.sourcePortal || portal).trim().toLowerCase()
    ].join("|");

    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

        const paymentHint =
      getMatchedSelectedPaymentLabel(offer, selectedPaymentMethods) ||
      (() => {
        const explicitPMs = extractOfferPaymentMethodsNoInference(offer);
        const firstPm = Array.isArray(explicitPMs) && explicitPMs.length > 0 ? explicitPMs[0] : null;
        if (!firstPm) return null;

        const rawBank = firstPm?.bank || firstPm?.name || firstPm?.raw || null;
        const rawType = firstPm?.type || firstPm?.methodCanonical || null;

        const bank = rawBank
          ? (normalizeBankDisplayName(rawBank) || rawBank)
          : null;

        const typeNorm = String(rawType || "").toUpperCase();
        const type =
          typeNorm === "EMI" ? "EMI" :
          typeNorm === "CREDIT_CARD" ? "Credit Card" :
          typeNorm === "DEBIT_CARD" ? "Debit Card" :
          typeNorm === "NET_BANKING" ? "Net Banking" :
          typeNorm === "UPI" ? "UPI" :
          typeNorm === "WALLET" ? "Wallet" :
          rawType || null;

        return [bank, type].filter(Boolean).join(" • ") || null;
      })();

        const validForBest = isValidBestOffer(offer);

     info.push({
      title: offer?.title || null,
      couponCode:
        offer?.couponCode ||
        offer?.code ||
        offer?.parsedFields?.couponCode ||
        offer?.parsedFields?.code ||
        null,
      rawDiscount: offer?.rawDiscount || offer?.parsedFields?.rawDiscount || null,
      offerSummary: offer?.offerSummary || offer?.parsedFields?.offerSummary || null,
      terms: offer?.terms || offer?.parsedFields?.terms || null,
      paymentHint:
  getMatchedSelectedPaymentLabel(offer, selectedPaymentMethods) ||
  (() => {
    const pm = extractOfferPaymentMethodsNoInference(offer)?.[0];
    if (!pm) return null;

    const bank = pm?.bank || pm?.name || null;
    const type = pm?.type || pm?.methodCanonical || null;

    return [bank, type].filter(Boolean).join(" • ") || null;
  })(),
      sourcePortal: offer?.sourceMetadata?.sourcePortal || offer?.sourcePortal || null,
      requiresSpecificCardType: isSpecificFamilyInfoOnly === true,
           infoLabel:
  isSpecificFamilyInfoOnly
    ? "Specific card required"
    : infoEval.ok
      ? "Applicable offer"
      : hasExplicitOfferPaymentMethods(offer)
        ? "Use this card to unlock"
        : "No payment restriction",
    });
  }

  return info
    .sort((a, b) => (b._score || 0) - (a._score || 0))
    .slice(0, limit)
    .map(({ _score, ...rest }) => rest);
}
function isKnownUnsafePricingOffer(offer) {
  const code = String(
    offer?.couponCode ||
    offer?.code ||
    offer?.parsedFields?.couponCode ||
    offer?.parsedFields?.code ||
    ""
  ).trim().toUpperCase();

  // Historical safety block:
  // HDFCEMI / HDFCINTEMI were previously blocked when MMT rows were cap-only / up-to-only.
  // After the June MMT refresh, allow them if deterministic discount tiers/flat/percent values exist.
  if (code === "HDFCEMI" || code === "HDFCINTEMI") {
    const tiers =
      offer?.discountTiers ||
      offer?.parsedFields?.discountTiers ||
      [];

    const hasTierDiscount =
      Array.isArray(tiers) &&
      tiers.some((t) => {
        const tierFlat = Number(t?.flatDiscountAmount || t?.discountAmount || 0);
        const tierPct = Number(t?.discountPercent || 0);
        return tierFlat > 0 || tierPct > 0;
      });

    const flat = Number(
      offer?.flatDiscountAmount ??
      offer?.parsedFields?.flatDiscountAmount ??
      offer?.discountAmount ??
      offer?.parsedFields?.discountAmount ??
      0
    );

    const pct = Number(
      offer?.discountPercent ??
      offer?.parsedFields?.discountPercent ??
      0
    );

    return !(
      hasTierDiscount ||
      (Number.isFinite(flat) && flat > 0) ||
      (Number.isFinite(pct) && pct > 0)
    );
  }

  return false;
}

function isDeterministicPortalPricingOffer(offer) {
  const kind = String(offer?.offerKind || offer?.parsedFields?.offerKind || "").toLowerCase();

  if (kind !== "portal" && kind !== "generic") return false;

  const hasPM =
    (Array.isArray(offer?.paymentMethods) && offer.paymentMethods.length > 0) ||
    (Array.isArray(offer?.eligiblePaymentMethods) && offer.eligiblePaymentMethods.length > 0) ||
    (Array.isArray(offer?.parsedFields?.paymentMethods) && offer.parsedFields.paymentMethods.length > 0) ||
    (Array.isArray(offer?.parsedFields?.eligiblePaymentMethods) && offer.parsedFields.eligiblePaymentMethods.length > 0);

  if (hasPM) return false;

  const flat = Number(
    offer?.flatDiscountAmount ??
    offer?.parsedFields?.flatDiscountAmount ??
    offer?.discountAmount ??
    offer?.parsedFields?.discountAmount ??
    0
  );

  const pct = Number(
    offer?.discountPercent ??
    offer?.parsedFields?.discountPercent ??
    0
  );

  const tiers =
    offer?.discountTiers ||
    offer?.parsedFields?.discountTiers ||
    [];

  const hasTier =
    Array.isArray(tiers) &&
    tiers.some((t) => {
      const tierFlat = Number(t?.flatDiscountAmount || t?.discountAmount || 0);
      const tierPct = Number(t?.discountPercent || 0);
      return tierFlat > 0 || tierPct > 0;
    });

  return (
    hasTier ||
    (Number.isFinite(flat) && flat > 0) ||
    (Number.isFinite(pct) && pct > 0)
  );
}

function isJunkInfoOffer(offer) {
  const title = String(offer?.title || "").toLowerCase();
  const rawDiscount = String(offer?.rawDiscount || "").toLowerCase();

  const blob = `${title} ${rawDiscount}`;

  // Remove card-tier noise, but do NOT treat "Business Class Flights" as junk.
  // Business-class flight offers are valid pricing rows.
  const isBusinessClassFlightOffer =
    /\bbusiness\s+class\b/i.test(blob) &&
    /\bflight(s)?\b/i.test(blob);

  if (/(rupay|platinum|select|corporate)/i.test(blob)) return true;

  if (/\bbusiness\b/i.test(blob) && !isBusinessClassFlightOffer) {
    return true;
  }

  // Remove generic "all cards" noise
  if (/(all cards|all users|all customers)/i.test(blob)) return true;

  // Remove offers without strong discount signal
  if (!/(%|rs|₹|discount|off)/i.test(blob)) return true;

  return false;
}

function cleanInfoOffers(infoOffers, limit = 5) {
  const seen = new Set();

 return (Array.isArray(infoOffers) ? infoOffers : [])
  .sort((a, b) => {
    const extract = (txt) => {
      const m = String(txt || "").match(/(\d+)%|(\d{3,5})/);
      return m ? Number(m[1] || m[2]) : 0;
    };
    return extract(b.rawDiscount) - extract(a.rawDiscount);
  })
    .filter((offer) => {
      const code = String(offer?.couponCode || "").trim().toUpperCase();
      const title = String(offer?.title || "").trim().toLowerCase();
      const rawDiscount = String(offer?.rawDiscount || "").trim().toLowerCase();

      const key = code || `${title}|${rawDiscount}`;

      if (!key) return false;
      if (seen.has(key)) return false;

      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function getActualDiscountAmount(basePrice, finalPrice) {
  const base = Number(basePrice);
  const final = Number(finalPrice);

  if (!Number.isFinite(base) || !Number.isFinite(final)) return null;

  const discount = Math.round((base - final) * 100) / 100;
  return discount > 0 ? discount : null;
}

function formatAppliedDiscountText(basePrice, finalPrice) {
  const discount = getActualDiscountAmount(basePrice, finalPrice);

  if (!Number.isFinite(discount) || discount <= 0) return null;

  return `Applied discount: ₹${Math.round(discount)}`;
}

async function applyOffersToFlight(
  flight,
  selectedPaymentMethods,
  offers,
  passengers = 1,
  cabin = "Economy",
  tripType = "one-way",
  isDomestic = true,
  pricingTiming = null,
  requestCache = null,
  genericDisplayContext = null
) {
  const base = typeof flight.price === "number" ? flight.price : 0;

  if (pricingTiming) {
    pricingTiming.flightsPriced = (pricingTiming.flightsPriced || 0) + 1;
  }
    

    const portalPrices = OTAS.map((portal) => {
    if (pricingTiming) {
      pricingTiming.portalRowsPriced = (pricingTiming.portalRowsPriced || 0) + 1;
    }

    const portalBase = Math.round(base);

    // FlightAPI/search result price is already the booking-level price for the requested passenger count.
    // Do not multiply by passengers again for min-transaction eligibility, or high-minimum offers
    // such as MMTONECARDINTEMI can incorrectly apply to multi-passenger bookings.
    const eligibilityAmount = portalBase;

  const pricingCandidateCache = requestCache?.pricingCandidatesByKey || null;
  const pricingCandidateKey = JSON.stringify({
    portal,
    isDomestic,
    cabin,
    tripType,
    passengers
  });

  let offersToEvaluate = offers;

  if (pricingCandidateCache && pricingCandidateCache.has(pricingCandidateKey)) {
    offersToEvaluate = pricingCandidateCache.get(pricingCandidateKey);
    if (pricingTiming) {
      pricingTiming.staticCandidateCacheHits = (pricingTiming.staticCandidateCacheHits || 0) + 1;
    }
  } else {
    const staticFilterStart = Date.now();

    offersToEvaluate = offers.filter((offer) => {
      try {
        if (!offer) return false;
        if (!isTrustedPricingRule(offer)) return false;
        if (!isFlightOffer(offer)) return false;
        if (isHotelOnlyOffer(offer)) return false;

        const nfBlob = `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.rawText || ""} ${offer?.terms || ""}`.toLowerCase();
        const mentionsFlight = /\bflight(s)?\b|\bair\s*ticket(s)?\b|\bairfare\b/.test(nfBlob);
        const mentionsNonFlight = /\btourism\b|\battraction(s)?\b|\bholiday(s)?\b|\bactivity\b|\bvisa\b|\bforex\b|\bbus(es)?\b|\bcab(s)?\b|\btrain(s)?\b|\bhotel(s)?\b/.test(nfBlob);

        if (mentionsNonFlight && !mentionsFlight) return false;
        if (isFirstTimeOrNewUserOffer(offer)) return false;
        if (isOfferExpired(offer)) return false;

        const bookingDayCheck = offerMatchesBookingDay(offer);
        if (!bookingDayCheck.ok) return false;

        if (!offerAppliesToPortal(offer, portal)) return false;
        if (!offerScopeMatchesTrip(offer, isDomestic, cabin)) return false;

        if (isSuspiciousGenericOffer(offer, offers || [])) return false;

        if (!isDeterministicPortalPricingOffer(offer) && !isValidBestOffer(offer)) return false;

        if (tripType === "one-way" && offerRequiresRoundTrip(offer)) return false;

        const passengerRestriction = getPassengerRestrictionResult(offer, passengers);
        if (!passengerRestriction.ok) return false;

        const manualCabinScope = offerMatchesManualCabinScope(offer, cabin, isDomestic);
        if (!manualCabinScope.ok) return false;

        return true;
      } catch {
        // Safety: if a prefilter check ever fails unexpectedly, keep the offer
        // so evaluateOfferForFlight remains the source of truth.
        return true;
      }
    });

    if (pricingCandidateCache) {
      pricingCandidateCache.set(pricingCandidateKey, offersToEvaluate);
    }

    if (pricingTiming) {
      pricingTiming.staticCandidateFilterMs = (pricingTiming.staticCandidateFilterMs || 0) + (Date.now() - staticFilterStart);
      pricingTiming.staticCandidateFilterInput = (pricingTiming.staticCandidateFilterInput || 0) + offers.length;
      pricingTiming.staticCandidateFilterOutput = (pricingTiming.staticCandidateFilterOutput || 0) + offersToEvaluate.length;
      pricingTiming.staticCandidateCacheMisses = (pricingTiming.staticCandidateCacheMisses || 0) + 1;
    }
  }

  const matchingCandidates = [];
  const candidateScanStart = Date.now();

for (const offer of offersToEvaluate) {
  if (!isDeterministicPortalPricingOffer(offer) && isJunkInfoOffer(offer)) continue;
  if (isKnownUnsafePricingOffer(offer)) continue;

  // Runtime safety: never allow cap-only / "up to ₹X" offers into pricing candidates.
  // maxDiscountAmount is only a cap, not the discount itself.
  const candidateTiers =
    offer?.discountTiers ||
    offer?.parsedFields?.discountTiers ||
    [];

  const candidateHasTierDiscount =
    Array.isArray(candidateTiers) &&
    candidateTiers.some((t) => {
      const tierFlat = Number(t?.flatDiscountAmount || t?.discountAmount || 0);
      const tierPct = Number(t?.discountPercent || 0);
      return tierFlat > 0 || tierPct > 0;
    });

  const candidateFlat = Number(
    offer?.flatDiscountAmount ??
    offer?.parsedFields?.flatDiscountAmount ??
    offer?.discountAmount ??
    offer?.parsedFields?.discountAmount ??
    0
  );

  const candidatePct = Number(
    offer?.discountPercent ??
    offer?.parsedFields?.discountPercent ??
    0
  );

  const candidateCap = Number(
    offer?.maxDiscountAmount ??
    offer?.parsedFields?.maxDiscountAmount ??
    0
  );

  const candidateText = String(
    `${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.parsedFields?.rawDiscount || ""}`
  ).toLowerCase();

  const candidateHasVisiblePct =
    /(?:flat\s*)?\d{1,2}\s*%\s*(?:instant\s*)?(?:discount|off)/i.test(candidateText) ||
    /(?:instant\s*)?(?:discount|off)[^%]{0,40}\d{1,2}\s*%/i.test(candidateText) ||
    /\b\d{1,2}\s*%\s*off\b/i.test(candidateText);

  const candidateHasComputableDiscount =
    candidateHasTierDiscount ||
    (Number.isFinite(candidateFlat) && candidateFlat > 0) ||
    (Number.isFinite(candidatePct) && candidatePct > 0) ||
    candidateHasVisiblePct;

  if (Number.isFinite(candidateCap) && candidateCap > 0 && !candidateHasComputableDiscount) {
    continue;
  }

  const evaluateStart = Date.now();
  const ev = evaluateOfferForFlight({
    offer,
    portal,
    baseAmount: portalBase,
    eligibilityAmount,
    selectedPaymentMethods,
    isDomestic,
    cabin,
    flightAirlineName: flight.airlineName,
    tripType,
    passengers,
    allOffers: offers,
  });

  if (pricingTiming) {
    pricingTiming.evaluateOfferMs = (pricingTiming.evaluateOfferMs || 0) + (Date.now() - evaluateStart);
    pricingTiming.evaluateOfferCalls = (pricingTiming.evaluateOfferCalls || 0) + 1;
  }

  if (!ev.ok) continue;

  matchingCandidates.push({
        offer,
        finalPrice: ev.discounted,
        offerKind: ev.offerKind,
        offerTypeLabel: ev.offerTypeLabel,
        channelLabel: ev.channelLabel,
        maxDiscountAmount: ev.maxDiscountAmount ?? null,
      });
    }
    if (pricingTiming) {
      pricingTiming.candidateScanMs = (pricingTiming.candidateScanMs || 0) + (Date.now() - candidateScanStart);
      pricingTiming.candidateEvaluations = (pricingTiming.candidateEvaluations || 0) + offersToEvaluate.length;
    }

       matchingCandidates.sort((a, b) => {
      if (a.finalPrice !== b.finalPrice) return a.finalPrice - b.finalPrice;

      const aRank =
        a.offerKind === "payment" ? 0 :
        a.offerKind === "airline" ? 1 : 2;

      const bRank =
        b.offerKind === "payment" ? 0 :
        b.offerKind === "airline" ? 1 : 2;

      return aRank - bRank;
    });

    const best = matchingCandidates.length > 0 ? matchingCandidates[0] : null;
    const otherMatchedOffers = matchingCandidates.slice(1);
      // ADD THIS BLOCK

const nonAppliedStart = Date.now();
const nonAppliedButRelevantOffers = offers
  .filter((offer) => {
    if (!isFlightOffer(offer)) return false;
    if (isOfferExpired(offer)) return false;
    if (!offerAppliesToPortal(offer, portal)) return false;
    if (isJunkInfoOffer(offer)) return false;

    // Do not show wrong-tenure EMI offers as related/info offers.
    // Example: if user selected 3-month HDFC EMI, do not show 6-month Yatra EMI in infoOffers.
    if (!offerMatchesSelectedEmiTenureForInfo(offer, selectedPaymentMethods)) return false;

    // skip already included
    const code =
      offer?.couponCode ||
      offer?.code ||
      offer?.parsedFields?.couponCode ||
      offer?.parsedFields?.code ||
      null;

    return !matchingCandidates.some((c) => {
      const cCode =
        c.offer?.couponCode ||
        c.offer?.code ||
        c.offer?.parsedFields?.couponCode ||
        c.offer?.parsedFields?.code ||
        null;

      return cCode === code;
    });
  })
  .slice(0, 5); // limit

if (pricingTiming) {
  pricingTiming.nonAppliedRelevantMs = (pricingTiming.nonAppliedRelevantMs || 0) + (Date.now() - nonAppliedStart);
  pricingTiming.nonAppliedRelevantScans = (pricingTiming.nonAppliedRelevantScans || 0) + offers.length;
}

const matchedPaymentLabel =
  best && best.offerKind === "payment"
    ? (getMatchedSelectedPaymentLabel(best.offer, selectedPaymentMethods) || null)
    : null;

const bestDeal = best
  ? {
      portal,
      finalPrice: best.finalPrice,
      basePrice: portalBase,
      applied: true,
      code:
        best.offer?.couponCode ||
        best.offer?.code ||
        best.offer?.parsedFields?.couponCode ||
        best.offer?.parsedFields?.code ||
        null,
      title: best.offer?.title || null,
      rawDiscount: best.offer?.rawDiscount || best.offer?.parsedFields?.rawDiscount || null,
      actualDiscount: getActualDiscountAmount(portalBase, best.finalPrice),
      appliedDiscountText: formatAppliedDiscountText(portalBase, best.finalPrice),
      constraints: extractOfferConstraints(best.offer),
      offerTypeLabel: best.offerTypeLabel || null,
      channelLabel: best.channelLabel || null,
      offerDisplayType: best.offerKind === "payment" ? "applied_payment_offer" : "applied_offer_rule",
      displayLabel: best.offerTypeLabel || "Applied offer",
      displaySubtext: null,
      displayAmount: getActualDiscountAmount(portalBase, best.finalPrice),
      displayCurrency: "INR",
      isExactPricing: true,
      isDisplayOnly: false,
    }
  : findGenericDisplayForPortal({
      genericDisplayContext,
      portal,
      isDomestic,
      tripType,
      portalBase,
      passengers
    });

const bestOfferId =
  best?.offer?._id?.toString?.() ||
  best?.offer?.couponCode ||
  best?.offer?.code ||
  null;

const otherMatchedOffersClean = otherMatchedOffers.filter((row) => {
  const id =
    row.offer?._id?.toString?.() ||
    row.offer?.couponCode ||
    row.offer?.code ||
    null;

  return id !== bestOfferId;
});

return {
  portal,
  basePrice: portalBase,
  finalPrice: bestDeal ? bestDeal.finalPrice : portalBase,
  applied: !!bestDeal,
  code: bestDeal?.code || null,
  title: bestDeal?.title || null,
  rawDiscount: bestDeal?.rawDiscount || null,
  actualDiscount: bestDeal?.actualDiscount || null,
  appliedDiscountText: bestDeal?.appliedDiscountText || null,
  terms: best?.offer?.terms || null,
  constraints: bestDeal?.constraints || null,
  paymentLabel: best
    ? (
        best.offerKind === "payment"
          ? (matchedPaymentLabel || paymentLabelFromSelection(selectedPaymentMethods) || "Payment required")
          : "No payment restriction"
      )
    : (bestDeal?.paymentLabel || null),
  offerTypeLabel: bestDeal?.offerTypeLabel || null,
  channelLabel: bestDeal?.channelLabel || null,
  offerDisplayType: bestDeal?.offerDisplayType || null,
  displayLabel: bestDeal?.displayLabel || null,
  displaySubtext: bestDeal?.displaySubtext || null,
  displayAmount: bestDeal?.displayAmount ?? bestDeal?.actualDiscount ?? null,
  displayCurrency: bestDeal?.displayCurrency || "INR",
  isExactPricing: bestDeal?.isExactPricing ?? null,
  isDisplayOnly: bestDeal?.isDisplayOnly ?? false,
  genericCandidateId: bestDeal?.genericCandidateId || null,
  genericCandidateStatus: bestDeal?.genericCandidateStatus || null,
  genericPricingReadiness: bestDeal?.genericPricingReadiness || null,
  explain: bestDeal?.explain || null,
       infoOffers: (() => {
  const buildInfoStart = Date.now();

  const excludedInfoCode =
    best?.offer?.couponCode ||
    best?.offer?.code ||
    best?.offer?.parsedFields?.couponCode ||
    best?.offer?.parsedFields?.code ||
    null;

  const infoCacheKey = JSON.stringify({
    portal,
    payment: selectedPaymentMethods,
    cabin,
    isDomestic,
    excludedInfoCode
  });

  const infoCache = requestCache?.infoOffersByKey;

  let builtInfoOffers;
  if (infoCache && infoCache.has(infoCacheKey)) {
    builtInfoOffers = infoCache.get(infoCacheKey);
    if (pricingTiming) {
      pricingTiming.buildInfoOffersCacheHits = (pricingTiming.buildInfoOffersCacheHits || 0) + 1;
    }
  } else {
    builtInfoOffers = buildInfoOffersForPortal(
      offers,
      portal,
      selectedPaymentMethods,
      cabin,
      isDomestic,
      excludedInfoCode,
      5
    );

    if (infoCache) {
      infoCache.set(infoCacheKey, builtInfoOffers);
    }

    if (pricingTiming) {
      pricingTiming.buildInfoOffersCacheMisses = (pricingTiming.buildInfoOffersCacheMisses || 0) + 1;
    }
  }

  if (pricingTiming) {
    pricingTiming.buildInfoOffersMs = (pricingTiming.buildInfoOffersMs || 0) + (Date.now() - buildInfoStart);
  }

  const cleanInfoStart = Date.now();

  const cleanedInfoOffers = cleanInfoOffers([
    ...builtInfoOffers,

    ...otherMatchedOffersClean.map((row) => ({
      title: row.offer?.title || null,
      couponCode:
        row.offer?.couponCode ||
        row.offer?.code ||
        row.offer?.parsedFields?.couponCode ||
        row.offer?.parsedFields?.code ||
        null,
      rawDiscount: row.offer?.rawDiscount || null,
      infoLabel: "Applicable offer",
    })),

    ...nonAppliedButRelevantOffers.map((offer) => ({
      title: offer?.title || null,
      couponCode:
        offer?.couponCode ||
        offer?.code ||
        offer?.parsedFields?.couponCode ||
        offer?.parsedFields?.code ||
        null,
      rawDiscount: offer?.rawDiscount || null,
      infoLabel: hasExplicitOfferPaymentMethods(offer)
        ? "Requires different card/payment"
        : "Available on this portal",
    }))
  ], 5);

  if (pricingTiming) {
    pricingTiming.cleanInfoOffersMs = (pricingTiming.cleanInfoOffersMs || 0) + (Date.now() - cleanInfoStart);
  }

  return cleanedInfoOffers;
})(),
  debugCounts: (() => {
  const debugCountsStart = Date.now();

  const out = {
    offersForPortal: offers.filter((o) => offerAppliesToPortal(o, portal)).length,
  };

  if (pricingTiming) {
    pricingTiming.debugCountsMs = (pricingTiming.debugCountsMs || 0) + (Date.now() - debugCountsStart);
  }

  return out;
})(),
};

  });

  const bestPortal = portalPrices.reduce((acc, p) => (acc == null || p.finalPrice < acc.finalPrice ? p : acc), null);
  const bestAppliedPortal = bestPortal?.applied ? bestPortal : null;

  return {
    ...flight,
    portalPrices,
    bestDeal: bestAppliedPortal
      ? {
          portal: bestAppliedPortal.portal,
          finalPrice: bestAppliedPortal.finalPrice,
          basePrice: bestAppliedPortal.basePrice,
          applied: true,
          code: bestAppliedPortal.code,
          title: bestAppliedPortal.title,
          rawDiscount: bestAppliedPortal.rawDiscount,
          actualDiscount: bestAppliedPortal.actualDiscount || null,
          appliedDiscountText: bestAppliedPortal.appliedDiscountText || null,
          constraints: bestAppliedPortal.constraints || null,
          paymentLabel: bestAppliedPortal.paymentLabel || null,
          offerTypeLabel: bestAppliedPortal.offerTypeLabel || null,
          channelLabel: bestAppliedPortal.channelLabel || null,
          offerDisplayType: bestAppliedPortal.offerDisplayType || null,
          displayLabel: bestAppliedPortal.displayLabel || null,
          displaySubtext: bestAppliedPortal.displaySubtext || null,
          displayAmount: bestAppliedPortal.displayAmount ?? bestAppliedPortal.actualDiscount ?? null,
          displayCurrency: bestAppliedPortal.displayCurrency || null,
          isExactPricing: bestAppliedPortal.isExactPricing ?? null,
          isDisplayOnly: bestAppliedPortal.isDisplayOnly ?? false,
          genericCandidateId: bestAppliedPortal.genericCandidateId || null,
          genericCandidateStatus: bestAppliedPortal.genericCandidateStatus || null,
          genericPricingReadiness: bestAppliedPortal.genericPricingReadiness || null,
          explain: `Best price is on ${bestAppliedPortal.portal} because ${bestAppliedPortal.code || "an offer"} reduced ₹${bestAppliedPortal.basePrice} → ₹${bestAppliedPortal.finalPrice}`,
        }
      : null,
  };
}

// --------------------
// ✅ RESTORED: Payment options (Mongo-driven, no fallback)
// --------------------
function canonicalTypeToFrontendBucket(methodCanonicalOrType) {
  const v = String(methodCanonicalOrType || "").toUpperCase();
  if (v === "EMI") return "EMI";
  if (v === "CREDIT_CARD") return "CreditCard";
  if (v === "DEBIT_CARD") return "DebitCard";
  if (v === "NET_BANKING") return "NetBanking";
  if (v === "UPI") return "UPI";
  if (v === "WALLET") return "Wallet";
  return null;
}

function offerPmToCanonical(pm) {
  const method = normalizeMethodCanonicalAlias(pm?.methodCanonical);
  if (method) return method;

  const t = String(pm?.type || "").toLowerCase().replace(/\s+/g, "");

  if (t.includes("emi")) return "EMI";
  if (t.includes("credit")) return "CREDIT_CARD";
  if (t.includes("debit")) return "DEBIT_CARD";
  if (t.includes("netbank") || t.includes("netbanking") || t.includes("internetbanking")) return "NET_BANKING";
  if (t.includes("upi")) return "UPI";
  if (t.includes("wallet")) return "WALLET";

  return null;
}
function canonicalTypeToUiLabel(bucket) {
  if (bucket === "CreditCard") return "Credit Card";
  if (bucket === "DebitCard") return "Debit Card";
  if (bucket === "NetBanking") return "Net Banking";
  return bucket;
}

function normalizeBankDisplayName(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;

  const u = s.toUpperCase().replace(/\s+/g, " ").trim();

  // Strong bank canonicalization for dropdown labels
  if (u.includes("FLIPKART") && u.includes("AXIS")) return "Flipkart Axis Bank";
  if (u.includes("AMAZON") && u.includes("ICICI")) return "Amazon Pay ICICI Bank";

  if (u === "AXIS" || u === "AXIS BANK") return "Axis Bank";
  if (u === "HDFC" || u === "HDFC BANK") return "HDFC Bank";
  if (u === "ICICI" || u === "ICICI BANK") return "ICICI Bank";
   if (u === "HSBC" || u === "HSBC BANK" || u === "HSBC CREDIT") return "HSBC";
  if (u === "STANDARD CHARTERED" || u === "STANDARD CHARTERED BANK" || u === "STANDARD_CHARTERED_BANK" || u === "STANCHART" || u === "SCB") return "Standard Chartered Bank";
  if (u === "SBI" || u === "STATE BANK OF INDIA") return "SBI";
  if (u === "KOTAK" || u === "KOTAK BANK" || u === "KOTAK MAHINDRA BANK" || u === "KOTAK BANK LTD") return "Kotak Bank";
  if (u === "YES" || u === "YES BANK" || u === "YES BANK LTD" || u === "YES BANK CREDIT CARD") return "Yes Bank";
  if (u === "RBL" || u === "RBL BANK" || u === "RBL BANK LTD") return "RBL Bank";
  if (u === "FEDERAL" || u === "FEDERAL BANK" || u === "FEDERAL BANK LTD" || u === "FEDERAL BANK CREDIT CARD") return "Federal Bank";
  if (u === "IDFC FIRST" || u === "IDFC FIRST BANK" || u === "IDFC FIRST BANK LTD" || u === "IDFC") return "IDFC First Bank";
  if (u === "AU" || u === "AU BANK" || u === "AU SMALL FINANCE BANK" || u === "AU SMALL BANK") return "AU Bank";
  if (u === "BOB" || u === "BANK OF BARODA" || u === "BOBCARD" || u === "BOBCARD LTD") return "Bank of Baroda";
  if (u === "AMERICAN EXPRESS" || u === "AMEX") return "American Express";
  if (u === "ONE" || u === "ONECARD" || u === "ONE CARD") return "OneCard";
  if (u === "CENTRAL BANK OF INDIA") return "Central Bank of India";
  if (u === "CANARA BANK") return "Canara Bank";
  if (u === "J&K BANK" || u === "J AND K BANK") return "J&K Bank";
  if (u === "BANK OF INDIA") return "Bank of India";
  if (u === "DBS") return "DBS";
    if (u === "CRED UPI") return "CRED";
  if (u === "UPI PAYMENTS" || u === "UPI") return "UPI";
    if (u === "RUPAY" || u === "RUPAY SELECT" || u === "RUPAY PLATINUM") return "RuPay";

  // Reject obvious non-bank / instruction-like junk
  if (
    /transaction only/i.test(s) ||
    /debit\/credit card/i.test(s) ||
    /net banking/i.test(s) ||
    /wallets?/i.test(s) ||
    /upi/i.test(s) ||
    /master cards?/i.test(s) ||
    /eligible cards?/i.test(s) ||
    /payment option/i.test(s)
  ) {
    return null;
  }

  return s.replace(/\s+/g, " ").trim();
}

function pickDisplayBankName(pm) {
  const raw =
    pm?.bank ||
    pm?.name ||
    pm?.bankCanonical ||
    pm?.raw ||
    "";

  const out = normalizeBankDisplayName(raw);
  return out || null;
}

async function computePaymentOptionsFromOffers() {
  const col = await getOffersCollection();
  const offers = await col.find({}, { projection: { _id: 0 } }).toArray();

  const buckets = {
    EMI: new Set(),
    CreditCard: new Set(),
    DebitCard: new Set(),
    NetBanking: new Set(),
    UPI: new Set(),
    Wallet: new Set(),
  };

  for (const offer of offers) {
    const pms = extractOfferPaymentMethods(offer); // includes inference if needed
    for (const pm of pms) {
      const canon = offerPmToCanonical(pm);
      const bucket = canonicalTypeToFrontendBucket(canon);
      if (!bucket) continue;

      const bank = pickDisplayBankName(pm);
      if (!bank) continue;

      buckets[bucket].add(bank);
    }
  }

    const creditCard = Array.from(buckets.CreditCard).sort();
  const debitCard = Array.from(buckets.DebitCard).sort();
  const netBanking = Array.from(buckets.NetBanking).sort();
  const emi = Array.from(buckets.EMI).sort();
  const upi = Array.from(buckets.UPI).sort();
  const wallet = Array.from(buckets.Wallet).sort();

  const options = {
    // Legacy keys used by frontend/tests
    EMI: emi,
    CreditCard: creditCard,
    DebitCard: debitCard,
    NetBanking: netBanking,
    UPI: upi,
    Wallet: wallet,

    // Friendly aliases for future UI
    "Credit Card": creditCard,
    "Debit Card": debitCard,
    "Net Banking": netBanking,
  };

  return { usedFallback: false, options };
}

// --------------------
// ✅ RESTORED: /payment-options
// --------------------
app.get("/payment-options", async (req, res) => {
  try {
    const out = await computePaymentOptionsFromOffers();
    res.json(out);
  } catch (e) {
    res.status(500).json({ usedFallback: false, error: e?.message || "Failed to load payment options" });
  }
});

// --------------------
// ✅ RESTORED: /debug/why-not-applied
// --------------------
app.get("/debug/why-not-applied", async (req, res) => {
  if (!requireDebugEnabled(req, res)) return;

  try {
    const portal = String(req.query.portal || "").trim();
    const bank = String(req.query.bank || "").trim();
    const type = String(req.query.type || "").trim(); // e.g. EMI
    const amount = Number(req.query.amount || 0) || 0;
    const q = req.query.q ? String(req.query.q).trim() : null;
    const from = String(req.query.from || "").trim().toUpperCase();
    const to = String(req.query.to || "").trim().toUpperCase();
    const debugIsDomestic =
      from && to
        ? isDomesticRoute(from, to)
        : String(req.query.isDomestic || "").toLowerCase() === "false"
          ? false
          : true;

    const debugCabin = normalizeCabin(req.query.travelClass || req.query.cabin || "Economy");

    // Debug-only: lets us test Monday-only or Tuesday-only offers without changing production /search behavior.
    const debugBookingDayOverrideRaw = String(req.query.bookingDayOverride || "").trim();
    const debugBookingDayOverride =
      /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(debugBookingDayOverrideRaw)
        ? debugBookingDayOverrideRaw.toLowerCase()
        : null;

const limit = Math.min(parseInt(req.query.limit || "10", 10), 200);

    if (!portal) {
  return res.status(400).json({ error: "Missing portal" });
}

    const tenureMonths = Number(req.query.tenureMonths || req.query.emiTenureMonths || 0);

const selectedPaymentMethods =
  bank && type
    ? [{
        type,
        name: bank,
        ...(req.query.network ? { network: String(req.query.network).trim() } : {}),
        ...(req.query.cardFamily ? { cardFamily: String(req.query.cardFamily).trim() } : {}),
        ...(req.query.cardVariant ? { cardVariant: String(req.query.cardVariant).trim() } : {}),
        ...(String(req.query.isCorporate || "").trim()
          ? { isCorporate: /^(true|1|yes)$/i.test(String(req.query.isCorporate).trim()) }
          : {}),
        ...(Number.isFinite(tenureMonths) && tenureMonths > 0
          ? { tenureMonths }
          : String(type || "").toLowerCase().includes("emi")
            ? { tenureMonths: 3, defaultedTenure: true }
            : {})
      }]
    : [];

        const col = await getOffersCollection();
    const offers = await col.find(
      {
        $or: [
          { sourcePortal: portal },
          { "sourceMetadata.sourcePortal": portal }
        ]
      },
      { projection: { _id: 0 } }
    ).toArray();
    const filteredOffers = q
  ? offers.filter((o) => {
      const blob = `${o?.title || ""} ${o?.rawDiscount || ""} ${o?.couponCode || o?.code || ""} ${o?.offerSummary?.headline || ""}`;
      return blob.toLowerCase().includes(q.toLowerCase());
    })
  : offers;

    const stats = {
      portal,
      portalTotal: offers.length,
      total: filteredOffers.length,
      ok: 0,
      notOk: 0,
      isFlight: 0,
      notExpired: 0,
      matchesPayment: 0,
      portalMatch: 0,
      scopeOK: 0,
      minTxnOK: 0,
      bookingDayOK: 0,
      wouldApplyNow: 0,
      hotelOnly: 0, // ✅ NEW stat
      inferredOnly: 0,
    };

    const samples = [];

    for (const offer of filteredOffers) {
      const failReasons = [];

      const disabledForPricing =
        offer?.pricingEligible === false ||
        offer?.disabledFromPricing === true ||
        offer?.sourceMetadata?.disabledFromPricing === true;

      if (disabledForPricing) {
        failReasons.push("DISABLED_FROM_PRICING");
      }

      const flight = isFlightOffer(offer);
      if (flight) stats.isFlight++;
      else failReasons.push("NOT_FLIGHT_OFFER");

      // ✅ NEW: explicitly track hotel-only rejects
      const hotelOnly = isHotelOnlyOffer(offer);
      if (hotelOnly) stats.hotelOnly++;
      if (hotelOnly) failReasons.push("HOTEL_ONLY");

      const expired = isOfferExpired(offer);
      if (!expired) stats.notExpired++;
      else failReasons.push("EXPIRED");

      const rawBookingDayCheck = offerMatchesBookingDay(offer);
      const overrideAllowed =
        debugBookingDayOverride &&
        Array.isArray(rawBookingDayCheck?.rule?.days) &&
        rawBookingDayCheck.rule.days
          .map((d) => String(d || "").trim().toLowerCase())
          .includes(debugBookingDayOverride);

      const bookingDayCheck = overrideAllowed
        ? {
            ...rawBookingDayCheck,
            ok: true,
            bookingDay: debugBookingDayOverride,
            debugBookingDayOverrideApplied: true
          }
        : rawBookingDayCheck;

      if (bookingDayCheck.ok) stats.bookingDayOK++;
      else failReasons.push("BOOKING_DAY_MISMATCH");

      const pMatch = offerAppliesToPortal(offer, portal);
      if (pMatch) stats.portalMatch++;
      else failReasons.push("PORTAL_MISMATCH");

      const scope = offerScopeMatchesTrip(offer, debugIsDomestic, debugCabin);
      const roundTripBlocked = offerRequiresRoundTrip(offer);
if (roundTripBlocked) failReasons.push("ROUND_TRIP_ONLY");
      
      if (scope) stats.scopeOK++;
      else failReasons.push("SCOPE_MISMATCH");

     const paymentRequired = hasExplicitOfferPaymentMethods(offer) && offer?.offerKind !== "portal" && offer?.offerKind !== "airline";
const pay = !paymentRequired || offerMatchesSelectedPayment(offer, selectedPaymentMethods);

if (pay) stats.matchesPayment++;
else failReasons.push("PAYMENT_MISMATCH");
      const offerPMs = extractOfferPaymentMethods(offer);
      const inferredOnly = Array.isArray(offerPMs) && offerPMs.length > 0 && offerPMs.every((pm) => pm?.inferred === true);
      if (inferredOnly) stats.inferredOnly++;
      if (inferredOnly) failReasons.push("PAYMENT_INFERRED_ONLY");

      const minTxn = getMinTxnValue(offer);
      const paxRestriction = getPassengerRestrictionResult(offer, 1);
      if (!paxRestriction.ok) failReasons.push(paxRestriction.reason || "PASSENGER_COUNT_RESTRICTED");
      if (!minTxn || amount >= minTxn) stats.minTxnOK++;
      else failReasons.push("MIN_TXN_NOT_MET");

      // Would apply now = all gates except improvement test
      // (hotel-only should block wouldApplyNow as well)
      const wouldApplyNow = failReasons.length === 0;

      if (wouldApplyNow) stats.wouldApplyNow++;

      // ok = wouldApplyNow AND compute yields improvement
      let ok = false;
      let discounted = null;
      let actualDiscount = null;

      if (wouldApplyNow) {
        discounted = computeDiscountedPrice(
          offer,
          amount,
          debugIsDomestic,
          1,
          selectedPaymentMethods,
          amount
        );

        ok = Number.isFinite(discounted) && discounted < amount;

        if (ok) {
          actualDiscount = Math.round((Number(amount) - Number(discounted)) * 100) / 100;
        }
      }

      if (ok) stats.ok++;
      else stats.notOk++;

     if (samples.length < limit) {
               samples.push({
          title: offer?.title || null,
          code: offer?.couponCode || offer?.code || null,
          couponCode: offer?.couponCode || offer?.code || null,
          rawDiscount: offer?.rawDiscount || null,
          debugCabin,
          debugIsDomestic,
          pricingEligible: offer?.pricingEligible ?? null,
          disabledFromPricing: offer?.disabledFromPricing ?? offer?.sourceMetadata?.disabledFromPricing ?? null,
          disabledReason: offer?.disabledReason || offer?.sourceMetadata?.disabledReason || null,
          discountPercent: offer?.discountPercent ?? offer?.parsedFields?.discountPercent ?? null,
          flatDiscountAmount: offer?.flatDiscountAmount ?? offer?.parsedFields?.flatDiscountAmount ?? null,
          maxDiscountAmount: offer?.maxDiscountAmount ?? offer?.parsedFields?.maxDiscountAmount ?? null,
          minTransactionValue: minTxn || 0,
          discountedPrice: Number.isFinite(discounted) ? discounted : null,
          actualDiscount,
          expired: !!expired,
          bookingDay: bookingDayCheck.bookingDay,
          allowedBookingDays: bookingDayCheck.rule?.days || null,
          bookingDayRuleMode: bookingDayCheck.rule?.mode || null,
          debugBookingDayOverride,
          debugBookingDayOverrideApplied: !!bookingDayCheck.debugBookingDayOverrideApplied,
          isFlight: !!flight,
          hotelOnly: !!hotelOnly,
          inferredOnly: inferredOnly,
          roundTripBlocked: !!roundTripBlocked,
          wouldApplyNow,
          failReasons,
        });
      }
    }

    res.json({
  selectedPaymentMethods,
  baseAmount: amount,
  from: from || null,
  to: to || null,
  isDomestic: debugIsDomestic,
  q,
  evaluatedCount: filteredOffers.length,
  stats,
  samples
});
  } catch (e) {
    res.status(500).json({ error: e?.message || "debug failed" });
  }
});

// --------------------
// Compare selected round-trip pair
// --------------------
app.get("/debug/generic-offers-count", async (req, res) => {
  if (!requireDebugEnabled(req, res)) return;

  try {
    const dbName = process.env.MONGODB_DB || "skydeal";
    const colName = process.env.MONGO_COL || "offer_rules";

    const col = await getOffersCollection();
    const offers = await col.find({}, { projection: { _id: 0 } }).toArray();

    const arr = (v) => Array.isArray(v) ? v : [];

    const getPortal = (o) =>
      o?.sourceMetadata?.sourcePortal ||
      o?.sourcePortal ||
      o?.portal ||
      o?.parsedFields?.sourcePortal ||
      "UNKNOWN";

    const hasPaymentMethods = (o) => {
      const lists = [
        o?.paymentMethods,
        o?.eligiblePaymentMethods,
        o?.parsedFields?.paymentMethods,
        o?.parsedFields?.eligiblePaymentMethods
      ];
      return lists.some((x) => Array.isArray(x) && x.length > 0);
    };

    const isGenericOffer = (o) => {
      const kind = String(o?.offerKind || o?.parsedFields?.offerKind || "").toLowerCase();
      if (kind === "payment") return false;
      if (hasPaymentMethods(o)) return false;
      return true;
    };

    const isDeterministicOffer = (o) => {
      const tiers = arr(o?.discountTiers || o?.parsedFields?.discountTiers);
      const hasTier = tiers.some((t) =>
        Number(t?.flatDiscountAmount || t?.discountAmount || 0) > 0 ||
        Number(t?.discountPercent || 0) > 0
      );

      const flat = Number(o?.flatDiscountAmount ?? o?.parsedFields?.flatDiscountAmount ?? 0);
      const pct = Number(o?.discountPercent ?? o?.parsedFields?.discountPercent ?? 0);

      const blob = `${o?.title || ""} ${o?.rawDiscount || ""} ${o?.offerSummary || ""} ${o?.parsedFields?.rawDiscount || ""}`.toLowerCase();

      const visiblePct =
        /(?:flat\s*)?\d{1,2}\s*%\s*(?:instant\s*)?(?:discount|off)/i.test(blob) ||
        /(?:instant\s*)?(?:discount|off)[^%]{0,40}\d{1,2}\s*%/i.test(blob) ||
        /\b\d{1,2}\s*%\s*off\b/i.test(blob);

      const visibleFlat =
        /\bflat\s*(?:rs\.?|inr|₹)\s*[\d,]+/i.test(blob) ||
        /(?:rs\.?|inr|₹)\s*[\d,]+\s*(?:off|discount)/i.test(blob);

      return hasTier || flat > 0 || pct > 0 || visiblePct || visibleFlat;
    };

    const flightOffers = offers.filter((o) => isFlightOffer(o) && !isHotelOnlyOffer(o));
    const genericFlightOffers = flightOffers.filter(isGenericOffer);
    const genericDeterministicFlightOffers = genericFlightOffers.filter(isDeterministicOffer);

    const byPortal = {};
    for (const o of genericDeterministicFlightOffers) {
      const p = getPortal(o);
      byPortal[p] = (byPortal[p] || 0) + 1;
    }

    res.json({
      dbName,
      colName,
      totalOfferRules: offers.length,
      totalFlightOffers: flightOffers.length,
      genericFlightOffers: genericFlightOffers.length,
      genericDeterministicFlightOffers: genericDeterministicFlightOffers.length,
      byPortal,
      samples: genericDeterministicFlightOffers.slice(0, 30).map((o) => ({
        portal: getPortal(o),
        title: o.title || null,
        code: o.couponCode || o.code || o?.parsedFields?.couponCode || null,
        rawDiscount: o.rawDiscount || o?.parsedFields?.rawDiscount || null,
        discountPercent: o.discountPercent ?? o?.parsedFields?.discountPercent ?? null,
        flatDiscountAmount: o.flatDiscountAmount ?? o?.parsedFields?.flatDiscountAmount ?? null,
        maxDiscountAmount: o.maxDiscountAmount ?? o?.parsedFields?.maxDiscountAmount ?? null,
        minTransactionValue: o.minTransactionValue ?? o?.parsedFields?.minTransactionValue ?? null,
        offerKind: o.offerKind || o?.parsedFields?.offerKind || null,
        paymentMethodsCount: arr(o.paymentMethods || o?.parsedFields?.paymentMethods).length,
        sourcePortal: o?.sourceMetadata?.sourcePortal || o?.sourcePortal || null
      }))
    });
  } catch (e) {
    res.status(500).json({
      error: e?.message || "generic offer count failed"
    });
  }
});

app.get("/debug/offer-rule-mix", async (req, res) => {
  if (!requireDebugEnabled(req, res)) return;

  try {
    const col = await getOffersCollection();
    const offers = await col.find({}, { projection: { _id: 0 } }).toArray();

    const arr = (v) => Array.isArray(v) ? v : [];

    const getPortal = (o) =>
      o?.sourceMetadata?.sourcePortal ||
      o?.sourcePortal ||
      o?.portal ||
      o?.parsedFields?.sourcePortal ||
      "UNKNOWN";

    const getKind = (o) =>
      String(o?.offerKind || o?.parsedFields?.offerKind || "MISSING").toLowerCase();

    const hasPM = (o) => {
      const lists = [
        o?.paymentMethods,
        o?.eligiblePaymentMethods,
        o?.parsedFields?.paymentMethods,
        o?.parsedFields?.eligiblePaymentMethods
      ];
      return lists.some((x) => Array.isArray(x) && x.length > 0);
    };

    const byKind = {};
    const byPortal = {};
    const byPaymentPresence = { hasPaymentMethods: 0, noPaymentMethods: 0 };

    for (const o of offers) {
      const kind = getKind(o);
      const portal = getPortal(o);

      byKind[kind] = (byKind[kind] || 0) + 1;
      byPortal[portal] = (byPortal[portal] || 0) + 1;

      if (hasPM(o)) byPaymentPresence.hasPaymentMethods++;
      else byPaymentPresence.noPaymentMethods++;
    }

    const noPaymentSamples = offers
      .filter((o) => !hasPM(o))
      .slice(0, 30)
      .map((o) => ({
        portal: getPortal(o),
        title: o.title || null,
        code: o.couponCode || o.code || o?.parsedFields?.couponCode || null,
        rawDiscount: o.rawDiscount || o?.parsedFields?.rawDiscount || null,
        offerKind: o.offerKind || o?.parsedFields?.offerKind || null,
        discountPercent: o.discountPercent ?? o?.parsedFields?.discountPercent ?? null,
        flatDiscountAmount: o.flatDiscountAmount ?? o?.parsedFields?.flatDiscountAmount ?? null,
        maxDiscountAmount: o.maxDiscountAmount ?? o?.parsedFields?.maxDiscountAmount ?? null,
        minTransactionValue: o.minTransactionValue ?? o?.parsedFields?.minTransactionValue ?? null,
        isFlight: isFlightOffer(o),
        isHotelOnly: isHotelOnlyOffer(o)
      }));

    res.json({
      total: offers.length,
      byKind,
      byPortal,
      byPaymentPresence,
      noPaymentSamples
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || "offer rule mix failed" });
  }
});

app.get("/debug/collections-summary", async (req, res) => {
  if (!requireDebugEnabled(req, res)) return;

  try {
    const dbName = process.env.MONGODB_DB || "skydeal";
    const knownCollections = [
      "offer_rules",
      "offer_review_queue",
      "display_offers",
      "offers"
    ];

    await getOffersCollection();
    const db = _mongoClient.db(MONGODB_DB);

    const existing = await db.listCollections().toArray();
    const existingNames = existing.map((c) => c.name);

    const arr = (v) => Array.isArray(v) ? v : [];

    const hasPaymentMethods = (o) => {
      const lists = [
        o?.paymentMethods,
        o?.eligiblePaymentMethods,
        o?.parsedFields?.paymentMethods,
        o?.parsedFields?.eligiblePaymentMethods
      ];
      return lists.some((x) => Array.isArray(x) && x.length > 0);
    };

    const isDeterministic = (o) => {
      const tiers = arr(o?.discountTiers || o?.parsedFields?.discountTiers);
      const hasTier = tiers.some((t) =>
        Number(t?.flatDiscountAmount || t?.discountAmount || 0) > 0 ||
        Number(t?.discountPercent || 0) > 0
      );

      const flat = Number(o?.flatDiscountAmount ?? o?.parsedFields?.flatDiscountAmount ?? 0);
      const pct = Number(o?.discountPercent ?? o?.parsedFields?.discountPercent ?? 0);

      const blob = `${o?.title || ""} ${o?.rawDiscount || ""} ${o?.offerSummary || ""} ${o?.parsedFields?.rawDiscount || ""}`.toLowerCase();

      const visiblePct =
        /(?:flat\s*)?\d{1,2}\s*%\s*(?:instant\s*)?(?:discount|off)/i.test(blob) ||
        /(?:instant\s*)?(?:discount|off)[^%]{0,40}\d{1,2}\s*%/i.test(blob) ||
        /\b\d{1,2}\s*%\s*off\b/i.test(blob);

      const visibleFlat =
        /\bflat\s*(?:rs\.?|inr|₹)\s*[\d,]+/i.test(blob) ||
        /(?:rs\.?|inr|₹)\s*[\d,]+\s*(?:off|discount)/i.test(blob);

      return hasTier || flat > 0 || pct > 0 || visiblePct || visibleFlat;
    };

    const getPortal = (o) =>
      o?.sourceMetadata?.sourcePortal ||
      o?.sourcePortal ||
      o?.portal ||
      o?.parsedFields?.sourcePortal ||
      "UNKNOWN";

    const summaries = {};

    for (const name of knownCollections) {
      if (!existingNames.includes(name)) {
        summaries[name] = { exists: false };
        continue;
      }

      const docs = await db.collection(name).find({}, { projection: { _id: 0 } }).toArray();

      const flightDocs = docs.filter((o) => {
        try {
          return isFlightOffer(o) && !isHotelOnlyOffer(o);
        } catch {
          return false;
        }
      });

      const noPaymentFlightDocs = flightDocs.filter((o) => !hasPaymentMethods(o));
      const genericDeterministic = noPaymentFlightDocs.filter(isDeterministic);

      const byPortal = {};
      for (const o of genericDeterministic) {
        const portal = getPortal(o);
        byPortal[portal] = (byPortal[portal] || 0) + 1;
      }

      summaries[name] = {
        exists: true,
        total: docs.length,
        flightDocs: flightDocs.length,
        withPaymentMethods: docs.filter(hasPaymentMethods).length,
        withoutPaymentMethods: docs.filter((o) => !hasPaymentMethods(o)).length,
        noPaymentFlightDocs: noPaymentFlightDocs.length,
        genericDeterministicFlightDocs: genericDeterministic.length,
        genericByPortal: byPortal,
        genericSamples: genericDeterministic.slice(0, 20).map((o) => ({
          portal: getPortal(o),
          title: o.title || null,
          code: o.couponCode || o.code || o?.parsedFields?.couponCode || null,
          rawDiscount: o.rawDiscount || o?.parsedFields?.rawDiscount || null,
          discountPercent: o.discountPercent ?? o?.parsedFields?.discountPercent ?? null,
          flatDiscountAmount: o.flatDiscountAmount ?? o?.parsedFields?.flatDiscountAmount ?? null,
          maxDiscountAmount: o.maxDiscountAmount ?? o?.parsedFields?.maxDiscountAmount ?? null,
          minTransactionValue: o.minTransactionValue ?? o?.parsedFields?.minTransactionValue ?? null,
          offerKind: o.offerKind || o?.parsedFields?.offerKind || null
        }))
      };
    }

    res.json({
      dbName,
      existingCollections: existingNames,
      summaries
    });
  } catch (e) {
    res.status(500).json({
      error: e?.message || "collections summary failed"
    });
  }
});

app.get("/debug/generic-offer-candidates", async (req, res) => {
  if (!requireDebugEnabled(req, res)) return;

  try {
    await getOffersCollection();
    const db = _mongoClient.db(MONGODB_DB);

    const collectionName = String(req.query.collection || "offer_review_queue");
    const limit = Math.min(Number(req.query.limit || 50), 200);

    const docs = await db.collection(collectionName).find({}, { projection: { _id: 0 } }).toArray();

    const arr = (v) => Array.isArray(v) ? v : [];

    const hasPaymentMethods = (o) => {
      const lists = [
        o?.paymentMethods,
        o?.eligiblePaymentMethods,
        o?.parsedFields?.paymentMethods,
        o?.parsedFields?.eligiblePaymentMethods
      ];
      return lists.some((x) => Array.isArray(x) && x.length > 0);
    };

    const isDeterministic = (o) => {
      const tiers = arr(o?.discountTiers || o?.parsedFields?.discountTiers);
      const hasTier = tiers.some((t) =>
        Number(t?.flatDiscountAmount || t?.discountAmount || 0) > 0 ||
        Number(t?.discountPercent || 0) > 0
      );

      const flat = Number(o?.flatDiscountAmount ?? o?.parsedFields?.flatDiscountAmount ?? 0);
      const pct = Number(o?.discountPercent ?? o?.parsedFields?.discountPercent ?? 0);

      const blob = `${o?.title || ""} ${o?.rawDiscount || ""} ${o?.offerSummary || ""} ${o?.parsedFields?.rawDiscount || ""}`.toLowerCase();

      const visiblePct =
        /(?:flat\s*)?\d{1,2}\s*%\s*(?:instant\s*)?(?:discount|off)/i.test(blob) ||
        /(?:instant\s*)?(?:discount|off)[^%]{0,40}\d{1,2}\s*%/i.test(blob) ||
        /\b\d{1,2}\s*%\s*off\b/i.test(blob);

      const visibleFlat =
        /\bflat\s*(?:rs\.?|inr|₹)\s*[\d,]+/i.test(blob) ||
        /(?:rs\.?|inr|₹)\s*[\d,]+\s*(?:off|discount)/i.test(blob);

      return hasTier || flat > 0 || pct > 0 || visiblePct || visibleFlat;
    };

    const getPortal = (o) =>
      o?.sourceMetadata?.sourcePortal ||
      o?.sourcePortal ||
      o?.portal ||
      o?.parsedFields?.sourcePortal ||
      "UNKNOWN";

    const candidates = docs
      .filter((o) => isFlightOffer(o) && !isHotelOnlyOffer(o))
      .filter((o) => !hasPaymentMethods(o))
      .filter(isDeterministic)
      .slice(0, limit)
      .map((o) => ({
        portal: getPortal(o),
        title: o.title || null,
        code: o.couponCode || o.code || o?.parsedFields?.couponCode || null,
        rawDiscount: o.rawDiscount || o?.parsedFields?.rawDiscount || null,
        discountPercent: o.discountPercent ?? o?.parsedFields?.discountPercent ?? null,
        flatDiscountAmount: o.flatDiscountAmount ?? o?.parsedFields?.flatDiscountAmount ?? null,
        maxDiscountAmount: o.maxDiscountAmount ?? o?.parsedFields?.maxDiscountAmount ?? null,
        minTransactionValue: o.minTransactionValue ?? o?.parsedFields?.minTransactionValue ?? null,
        offerKind: o.offerKind || o?.parsedFields?.offerKind || null,
        reviewQueueReasons: o.reviewQueueReasons || o.reviewReasons || o.reasons || [],
        sourceMetadata: o.sourceMetadata || null,
        sourceUrl: o.sourceUrl || o?.sourceMetadata?.sourceUrl || null,
        validityPeriod: o.validityPeriod || o?.parsedFields?.validityPeriod || null,
        travelPeriod: o.travelPeriod || o?.parsedFields?.travelPeriod || null,
        parsedApplicablePlatforms: o.parsedApplicablePlatforms || o?.parsedFields?.parsedApplicablePlatforms || [],
        offerCategories: o.offerCategories || o?.parsedFields?.offerCategories || []
      }));

    res.json({
      collectionName,
      totalDocs: docs.length,
      candidateCount: candidates.length,
      candidates
    });
  } catch (e) {
    res.status(500).json({
      error: e?.message || "generic candidates failed"
    });
  }
});

app.get("/debug/generic-apply-path", async (req, res) => {
  if (!requireDebugEnabled(req, res)) return;

  try {
    const from = String(req.query.from || "BLR").toUpperCase();
    const to = String(req.query.to || "DEL").toUpperCase();
    const amount = Number(req.query.amount || 20000);
    const portal = String(req.query.portal || "Goibibo");
    const titleQuery = String(req.query.q || "Domestic Flight Discount").toLowerCase();

    const col = await getOffersCollection();
    const offers = await col.find({}, { projection: { _id: 0 } }).toArray();

    const isDomestic = isDomesticRoute(from, to);

    const matchingDocs = offers
      .filter((o) => String(o?.sourcePortal || o?.sourceMetadata?.sourcePortal || o?.portal || "").toLowerCase() === portal.toLowerCase())
      .filter((o) => String(o?.title || "").toLowerCase().includes(titleQuery));

    const evals = matchingDocs.map((offer) => {
      const ev = evaluateOfferForFlight({
        offer,
        portal,
        baseAmount: amount,
        eligibilityAmount: amount,
        selectedPaymentMethods: [],
        isDomestic,
        cabin: "Economy",
        flightAirlineName: "IndiGo",
        tripType: "round-trip",
        passengers: 1,
        allOffers: offers
      });

      return {
        title: offer.title || null,
        sourcePortal: offer.sourcePortal || offer?.sourceMetadata?.sourcePortal || null,
        offerKind: offer.offerKind || null,
        paymentMethods: offer.paymentMethods || null,
        rawDiscount: offer.rawDiscount || null,
        flatDiscountAmount: offer.flatDiscountAmount ?? null,
        discountPercent: offer.discountPercent ?? null,
        maxDiscountAmount: offer.maxDiscountAmount ?? null,
        isJunkInfoOffer: isJunkInfoOffer(offer),
        isDeterministicPortalPricingOffer: isDeterministicPortalPricingOffer(offer),
        isKnownUnsafePricingOffer: isKnownUnsafePricingOffer(offer),
        offerAppliesToPortal: offerAppliesToPortal(offer, portal),
        isFlightOffer: isFlightOffer(offer),
        isHotelOnlyOffer: isHotelOnlyOffer(offer),
        isOfferExpired: isOfferExpired(offer),
        eval: ev
      };
    });

    const flight = {
      airlineName: "IndiGo",
      flightNumber: "6E DEBUG",
      price: amount
    };

    const applied = await applyOffersToFlight(
      flight,
      [],
      offers,
      1,
      "Economy",
      "round-trip",
      isDomestic
    );

    res.json({
      from,
      to,
      isDomestic,
      amount,
      offersLoaded: offers.length,
      matchingDocsCount: matchingDocs.length,
      evals,
      goibiboPortalRow: (applied.portalPrices || []).find((p) => p.portal === portal) || null,
      bestDeal: applied.bestDeal || null
    });
  } catch (e) {
    res.status(500).json({
      error: e?.message || "generic apply path debug failed",
      stack: e?.stack || null
    });
  }
});


app.get("/debug/offer-rules-audit-export", async (req, res) => {
  if (!requireDebugEnabled(req, res)) return;

  try {
    await getOffersCollection();
    const db = _mongoClient.db(MONGODB_DB);
    const rulesCol = db.collection("offer_rules");

    const portalFilter = req.query.portal ? String(req.query.portal).toLowerCase() : null;
    const includeDisabled = req.query.includeDisabled === "true";
    const limit = Math.min(Number(req.query.limit || 200), 500);

    const docs = await rulesCol.find({}, { projection: { _id: 0 } }).limit(limit).toArray();

    const getPortal = (o) =>
      o?.sourcePortal ||
      o?.sourceMetadata?.sourcePortal ||
      o?.portal ||
      o?.parsedFields?.sourcePortal ||
      "UNKNOWN";

    const arr = (v) => Array.isArray(v) ? v : [];

    const paymentSummary = (o) => {
      const methods = arr(
        o?.paymentMethods ||
        o?.eligiblePaymentMethods ||
        o?.parsedFields?.paymentMethods ||
        o?.parsedFields?.eligiblePaymentMethods
      );

      return methods.map((m) => ({
        type: m?.type || m?.method || m?.methodCanonical || null,
        bank: m?.bank || m?.name || m?.bankCanonical || null,
        network: m?.network || m?.networkCanonical || null,
        tenureMonths: m?.tenureMonths || m?.tenure || null
      }));
    };

    const rows = docs
      .filter((o) => includeDisabled || o.pricingEligible !== false)
      .filter((o) => !portalFilter || getPortal(o).toLowerCase() === portalFilter)
      .map((o, idx) => {
        const portal = getPortal(o);
        const code = o?.couponCode || o?.code || o?.parsedFields?.couponCode || o?.parsedFields?.code || null;
        const sourceUrl = o?.sourceUrl || o?.sourceMetadata?.sourceUrl || null;
        const sourceFileName = o?.sourceFileName || o?.sourceMetadata?.sourceFileName || null;

        return {
          auditIndex: idx + 1,
          portal,
          title: o?.title || null,
          code,
          rawDiscount: o?.rawDiscount || o?.parsedFields?.rawDiscount || null,
          discountPercent: o?.discountPercent ?? o?.parsedFields?.discountPercent ?? null,
          flatDiscountAmount: o?.flatDiscountAmount ?? o?.parsedFields?.flatDiscountAmount ?? null,
          maxDiscountAmount: o?.maxDiscountAmount ?? o?.parsedFields?.maxDiscountAmount ?? null,
          minTransactionValue: o?.minTransactionValue ?? o?.parsedFields?.minTransactionValue ?? null,
          discountTiers: o?.discountTiers || o?.parsedFields?.discountTiers || null,
          offerKind: o?.offerKind || o?.parsedFields?.offerKind || null,
          pricingEligible: o?.pricingEligible ?? null,
          disabledFromPricing: o?.disabledFromPricing ?? false,
          disabledReason: o?.disabledReason || null,
          validityPeriod: o?.validityPeriod || o?.parsedFields?.validityPeriod || null,
          travelPeriod: o?.travelPeriod || o?.parsedFields?.travelPeriod || null,
          offerCategories: o?.offerCategories || o?.parsedFields?.offerCategories || [],
          parsedApplicablePlatforms: o?.parsedApplicablePlatforms || o?.parsedFields?.parsedApplicablePlatforms || [],
          paymentMethods: paymentSummary(o),
          reviewQueueReasons: o?.reviewQueueReasons || o?.reviewReasons || [],
          sourceUrl,
          sourceFileName,
          sourceMetadata: o?.sourceMetadata || null,
          termsPreview: String(o?.terms || o?.parsedFields?.terms || "").slice(0, 500),
          rawTextPreview: String(o?.rawText || o?.sourceRawText || "").slice(0, 700),
          manualAuditVerdict: null,
          manualAuditNotes: null
        };
      });

    const byPortal = {};
    for (const r of rows) byPortal[r.portal] = (byPortal[r.portal] || 0) + 1;

    res.json({
      ok: true,
      dbName: MONGODB_DB,
      collection: "offer_rules",
      includeDisabled,
      portalFilter,
      totalReturned: rows.length,
      byPortal,
      rows
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e?.message || "offer rules audit export failed"
    });
  }
});


app.get("/debug/cleartrip-aucc-shape", async (req, res) => {
  if (!requireDebugEnabled(req, res)) return;

  try {
    await getOffersCollection();
    const db = _mongoClient.db(MONGODB_DB);
    const rulesCol = db.collection("offer_rules");

    const docs = await rulesCol.find({
      sourcePortal: "Cleartrip",
      $or: [
        { code: "AUCC" },
        { couponCode: "AUCC" }
      ]
    }).toArray();

    res.json({
      ok: true,
      count: docs.length,
      docs: docs.map((o) => ({
        _id: String(o._id),
        title: o.title || null,
        code: o.code || null,
        couponCode: o.couponCode || null,
        rawDiscount: o.rawDiscount || null,
        discountPercent: o.discountPercent ?? null,
        maxDiscountAmount: o.maxDiscountAmount ?? null,
        minTransactionValue: o.minTransactionValue ?? null,
        offerCategories: o.offerCategories ?? null,
        parsedFieldsOfferCategories: o?.parsedFields?.offerCategories ?? null,
        paymentMethods: o.paymentMethods ?? null,
        eligiblePaymentMethods: o.eligiblePaymentMethods ?? null,
        parsedFieldsPaymentMethods: o?.parsedFields?.paymentMethods ?? null,
        parsedFieldsEligiblePaymentMethods: o?.parsedFields?.eligiblePaymentMethods ?? null,
        sourcePortal: o.sourcePortal || null,
        sourceMetadata: o.sourceMetadata || null
      }))
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e?.message || "cleartrip aucc shape debug failed"
    });
  }
});


app.get("/debug/payment-match-trace", async (req, res) => {
  if (!requireDebugEnabled(req, res)) return;

  try {
    const portal = String(req.query.portal || "").trim();
    const q = String(req.query.q || "").trim();
    const bank = String(req.query.bank || "").trim();
    const type = String(req.query.type || "").trim();
    const tenureMonths = Number(req.query.tenureMonths || req.query.emiTenureMonths || 0);

    if (!portal || !q || !bank || !type) {
      return res.status(400).json({
        error: "Missing required query params: portal, q, bank, type"
      });
    }

    const selectedPaymentMethods = [{
      type,
      name: bank,
      ...(Number.isFinite(tenureMonths) && tenureMonths > 0 ? { tenureMonths } : {})
    }];

    await getOffersCollection();
    const col = await getOffersCollection();

    const offers = await col.find(
      {
        $or: [
          { sourcePortal: portal },
          { "sourceMetadata.sourcePortal": portal }
        ]
      },
      { projection: { _id: 0 } }
    ).toArray();

    const filteredOffers = offers.filter((o) => {
      const blob = `${o?.title || ""} ${o?.rawDiscount || ""} ${o?.couponCode || o?.code || ""} ${o?.offerSummary?.headline || ""}`;
      return blob.toLowerCase().includes(q.toLowerCase());
    });

    const selNorm = selectedPaymentMethods.map(normalizeSelectedPM).filter((x) => x.typeNorm);

    const traces = filteredOffers.map((offer) => {
      const offerPMs = extractOfferPaymentMethodsNoInference(offer);
      const offerNorm = offerPMs
        .map((pm) => normalizeOfferPM(pm, offer))
        .filter((x) => x.typeNorm);

      const matches = [];

      for (const s of selNorm) {
        for (const o of offerNorm) {
          matches.push({
            selectedType: s.typeNorm,
            offerType: o.typeNorm,
            selectedBankCanonical: s.bankCanonical,
            offerBankCanonical: o.bankCanonical,
            typeEqual: s.typeNorm === o.typeNorm,
            bankEqual: !!s.bankCanonical && !!o.bankCanonical && s.bankCanonical === o.bankCanonical,
            tenureSelected: s.tenureMonths || null,
            tenureAllowed: o.allowedTenures || null
          });
        }
      }

      return {
        title: offer.title || null,
        code: offer.couponCode || offer.code || null,
        rawDiscount: offer.rawDiscount || null,
        selectedPaymentMethods,
        selNorm,
        rawPaymentFields: {
          paymentMethods: offer.paymentMethods || null,
          eligiblePaymentMethods: offer.eligiblePaymentMethods || null,
          parsedFieldsPaymentMethods: offer?.parsedFields?.paymentMethods || null,
          parsedFieldsEligiblePaymentMethods: offer?.parsedFields?.eligiblePaymentMethods || null
        },
        extractedOfferPMs: offerPMs,
        offerNorm,
        matches,
        offerMatchesSelectedPayment: offerMatchesSelectedPayment(offer, selectedPaymentMethods)
      };
    });

    res.json({
      ok: true,
      portal,
      q,
      bank,
      type,
      selectedPaymentMethods,
      count: traces.length,
      traces
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e?.message || "payment match trace failed",
      stack: e?.stack || null
    });
  }
});

app.get("/debug/build-version", (req, res) => {
  res.json({
    service: "skydeal-backend",
    buildMarker: "flightapi-cache-retry-attempts-3-2026-06-20",
    expectedCommit: "8fb7c1d",
    deployedCheck: "FlightAPI retry, timeout, success cache, trimmed raw response, and 3-attempt default are deployed."
  });
});

app.post("/compare-selected-trip", async (req, res) => {
  const body = req.body || {};
  const meta = {
    source: "selected-trip-comparison",
    requestType: "round-trip-selected-pair",
    checkedAt: new Date().toISOString()
  };

  try {
    const outboundFlight = body.outboundFlight || null;
    const returnFlight = body.returnFlight || null;

    // Prefer explicit route fields, but selected-trip comparison often receives
    // from/to inside the selected flight objects only.
    const from = String(
      body.from ||
      outboundFlight?.from ||
      outboundFlight?.origin ||
      outboundFlight?.originCode ||
      ""
    ).trim().toUpperCase();

    const to = String(
      body.to ||
      outboundFlight?.to ||
      outboundFlight?.destination ||
      outboundFlight?.destinationCode ||
      ""
    ).trim().toUpperCase();

    const adults = Math.max(
      1,
      Math.floor(Number(body.adults ?? body.passengers ?? 1) || 1)
    );
    const cabin = normalizeCabin(body.travelClass || body.cabin);
    const routeIsDomestic = isDomesticRoute(from, to);

    const selectedPaymentMethodsRaw = Array.isArray(body.paymentMethods) ? body.paymentMethods : [];

    const selectedPaymentMethods = selectedPaymentMethodsRaw.map((pm) => {
      const type = String(pm?.type || "").toLowerCase();

      if (type.includes("emi") && !Number(pm?.tenureMonths)) {
        return {
          ...pm,
          tenureMonths: 3,
          defaultedTenure: true
        };
      }

      return pm;
    });

    const includeGenericDisplayOffers =
      body.includeGenericDisplayOffers === true ||
      String(body.includeGenericDisplayOffers || "").toLowerCase() === "true";

    meta.selectedPaymentMethods = selectedPaymentMethods;
    meta.mongoCollection = MONGO_COL;
    meta.mongoDb = MONGODB_DB;
    meta.isDomestic = routeIsDomestic;
    meta.includeGenericDisplayOffers = includeGenericDisplayOffers;

    if (!outboundFlight || !returnFlight) {
      return res.status(400).json({
        meta: {
          ...meta,
          error: "Missing outboundFlight or returnFlight"
        },
        tripComparison: null
      });
    }

    const outboundBase = Number(outboundFlight.price || outboundFlight.basePrice || 0);
    const returnBase = Number(returnFlight.price || returnFlight.basePrice || 0);

    if (!Number.isFinite(outboundBase) || outboundBase <= 0 || !Number.isFinite(returnBase) || returnBase <= 0) {
      return res.status(400).json({
        meta: {
          ...meta,
          error: "Invalid outbound or return flight price"
        },
        tripComparison: null
      });
    }

    const bundleBase = Math.round((outboundBase + returnBase) * 100) / 100;

    const col = await getOffersCollection();
    const offers = await col.find({}, { projection: { _id: 0 } }).toArray();
    meta.offersLoaded = offers.length;

    let genericDisplayContext = null;
    if (includeGenericDisplayOffers) {
      genericDisplayContext = await getGenericDisplayContextForSearch(meta);
    } else {
      meta.genericDisplayOffers = {
        enabled: false,
        mode: "disabled_by_request_flag"
      };
    }

    const bundleFlight = {
      airlineName: `${outboundFlight.airlineName || "Outbound"} + ${returnFlight.airlineName || "Return"}`,
      flightNumber: `${outboundFlight.flightNumber || ""}${outboundFlight.flightNumber && returnFlight.flightNumber ? " / " : ""}${returnFlight.flightNumber || ""}`.trim() || "Round Trip",
      departureTime: outboundFlight.departureTime || null,
      arrivalTime: returnFlight.arrivalTime || null,
      stops: Number(outboundFlight.stops || 0) + Number(returnFlight.stops || 0),
      price: bundleBase,
      priceSource: "selected_round_trip_bundle",
      bundle: {
        type: "round-trip",
        outboundFlight,
        returnFlight,
        outboundBase,
        returnBase,
        bundleBase
      }
    };

    const enrichedBundle = await applyOffersToFlight(
      bundleFlight,
      selectedPaymentMethods,
      offers,
      adults,
      cabin,
      "round-trip",
      routeIsDomestic,
      null,
      null,
      genericDisplayContext
    );

    const tripComparison = {
      tripType: "round-trip",
      bookingMode: "same-portal",
      note: "Prices assume outbound and return are booked together on the same portal.",
      outboundFlight,
      returnFlight,
      baseTotal: bundleBase,
      portalPrices: enrichedBundle.portalPrices || [],
      bestDeal: enrichedBundle.bestDeal || null
    };

    return res.json({
      meta,
      tripComparison
    });
  } catch (e) {
    return res.status(500).json({
      meta: {
        ...meta,
        error: e?.message || "Selected trip comparison failed"
      },
      tripComparison: null
    });
  }
});

// --------------------
// Search flights + apply offers
// --------------------
function slimOfferForSearchResponse(offer) {
  if (!offer || typeof offer !== "object") return offer || null;

  return {
    title: offer.title || null,
    couponCode: offer.couponCode || offer.code || null,
    code: offer.code || offer.couponCode || null,
    rawDiscount: offer.rawDiscount || null,
    offerSummary: offer.offerSummary
      ? {
          headline: offer.offerSummary.headline || null,
          keyFacts: Array.isArray(offer.offerSummary.keyFacts) ? offer.offerSummary.keyFacts.slice(0, 4) : [],
          keyTerms: Array.isArray(offer.offerSummary.keyTerms) ? offer.offerSummary.keyTerms.slice(0, 4) : [],
          displayBadge: offer.offerSummary.displayBadge || null
        }
      : null,
    paymentHint: offer.paymentHint || offer.paymentLabel || null,
    sourcePortal: offer.sourcePortal || offer.sourceMetadata?.sourcePortal || null,
    requiresSpecificCardType: !!offer.requiresSpecificCardType,
    infoLabel: offer.infoLabel || null
  };
}

function slimPortalPriceForSearchResponse(row) {
  if (!row || typeof row !== "object") return row || null;

  return {
    portal: row.portal || null,
    basePrice: row.basePrice ?? null,
    finalPrice: row.finalPrice ?? row.basePrice ?? null,
    applied: !!row.applied,
    code: row.code || row.couponCode || null,
    title: row.title || null,
    rawDiscount: row.rawDiscount || null,
    actualDiscount: row.actualDiscount ?? null,
    appliedDiscountText: row.appliedDiscountText || null,
    constraints: row.constraints || null,
    paymentLabel: row.paymentLabel || null,
    offerTypeLabel: row.offerTypeLabel || null,
    channelLabel: row.channelLabel || null,
    offerDisplayType: row.offerDisplayType || null,
    displayLabel: row.displayLabel || null,
    displaySubtext: row.displaySubtext || null,
    displayAmount: row.displayAmount ?? null,
    displayCurrency: row.displayCurrency || null,
    isExactPricing: row.isExactPricing ?? null,
    isDisplayOnly: row.isDisplayOnly ?? false,
    genericCandidateId: row.genericCandidateId || null,
    genericCandidateStatus: row.genericCandidateStatus || null,
    genericPricingReadiness: row.genericPricingReadiness || null,
    explain: row.explain || null,

    // Keep hints for "more offers", but remove huge terms/raw text from normal search response.
    infoOffers: Array.isArray(row.infoOffers)
      ? row.infoOffers.slice(0, 6).map(slimOfferForSearchResponse)
      : [],

    moreOffers: Array.isArray(row.moreOffers)
      ? row.moreOffers.slice(0, 6).map(slimOfferForSearchResponse)
      : [],

    debugCounts: row.debugCounts || null
  };
}


async function getOffersForSearch(meta = {}) {
  const now = Date.now();
  const cacheAgeMs = offersCacheData ? now - offersCacheLoadedAt : null;
  const cacheValid =
    Array.isArray(offersCacheData) &&
    cacheAgeMs !== null &&
    cacheAgeMs >= 0 &&
    cacheAgeMs < OFFERS_CACHE_TTL_MS;

  if (cacheValid) {
    meta.offersCache = "hit";
    meta.offersCacheAgeMs = cacheAgeMs;
    return offersCacheData;
  }

  const col = await getOffersCollection();
  const offers = await col.find({}, { projection: { _id: 0 } }).toArray();

  offersCacheData = offers;
  offersCacheLoadedAt = now;

  meta.offersCache = "miss";
  meta.offersCacheAgeMs = 0;
  meta.offersCacheTtlMs = OFFERS_CACHE_TTL_MS;

  return offers;
}


async function getGenericDisplayContextForSearch(meta = {}) {
  // Only loaded when includeGenericDisplayOffers=true is sent in /search.
  // Reads review/display-only collections and never modifies Mongo.
  await getOffersCollection();

  const db = _mongoClient.db(MONGODB_DB);

  const [verifiedGenericCoupons, conservativeDisplayOffers] = await Promise.all([
    db.collection("generic_checkout_coupon_rule_candidates")
      .find({
        status: "DRY_RUN_REVIEW_ONLY",
        shouldUploadToActiveOfferRules: false,
        pricingReadiness: "READY_FOR_MONGO_DRY_RUN_REVIEW"
      }, { projection: { _id: 0 } })
      .toArray(),

    db.collection("generic_checkout_display_offer_candidates")
      .find({
        status: "DISPLAY_REVIEW_ONLY",
        shouldApplyToLivePricing: false,
        shouldUploadToActiveOfferRules: false,
        pricingReadiness: "DISPLAY_ONLY_NOT_EXACT_PRICING"
      }, { projection: { _id: 0 } })
      .toArray()
  ]);

  meta.genericDisplayOffers = {
    enabled: true,
    verifiedGenericCouponCandidates: verifiedGenericCoupons.length,
    conservativeDisplayOfferCandidates: conservativeDisplayOffers.length,
    mode: "flag_controlled_search_display"
  };

  return {
    enabled: true,
    verifiedGenericCoupons,
    conservativeDisplayOffers
  };
}

function normalizeSearchDisplayText(value) {
  return String(value || "").trim().toLowerCase();
}

function genericCandidateMatchesSearch(candidate, portal, isDomestic, tripType) {
  const app = candidate?.applicability || {};
  const wantedRouteType = isDomestic ? "domestic" : "international";

  return (
    normalizeSearchDisplayText(candidate?.sourcePortal) === normalizeSearchDisplayText(portal) &&
    normalizeSearchDisplayText(app.routeType) === wantedRouteType &&
    normalizeSearchDisplayText(app.tripType) === normalizeSearchDisplayText(tripType)
  );
}

function buildVerifiedGenericCouponPortalDisplay({ candidate, portalBase, passengers }) {
  const rule = candidate?.proposedRule || {};
  const flatPerAdult = Number(rule.flatDiscountPerAdult || 0);
  const rawDiscount = Math.max(0, Math.round(flatPerAdult * passengers));
  const discountAmount = Math.min(rawDiscount, Math.max(0, portalBase));
  const finalPrice = Math.max(0, portalBase - discountAmount);

  if (!discountAmount) return null;

  return {
    finalPrice,
    actualDiscount: discountAmount,
    code: candidate?.couponCode || null,
    title: `${candidate?.couponCode || "Checkout coupon"} checkout coupon`,
    rawDiscount: `${candidate?.couponCode || "Checkout coupon"} checkout coupon`,
    appliedDiscountText: `Checkout coupon saving: ₹${discountAmount}`,
    paymentLabel: "No payment restriction",
    offerTypeLabel: "Checkout coupon",
    channelLabel: "Portal checkout",
    explain: `Checkout coupon ${candidate?.couponCode || ""} reduced ₹${portalBase} → ₹${finalPrice}`,
    offerDisplayType: "verified_generic_checkout_coupon",
    displayLabel: "Checkout coupon",
    displaySubtext: `${candidate?.couponCode || "Coupon"} checkout coupon observed`,
    displayAmount: discountAmount,
    displayCurrency: rule.currency || "INR",
    isExactPricing: true,
    isDisplayOnly: false,
    genericCandidateId: candidate?.ruleCandidateId || null,
    genericCandidateStatus: candidate?.status || null,
    genericPricingReadiness: candidate?.pricingReadiness || null
  };
}

function buildConservativeDisplayOfferPortalDisplay({ candidate, portalBase, passengers }) {
  const offer = candidate?.proposedDisplayOffer || {};
  let rawDiscount = 0;

  if (offer.discountType === "flat_per_adult") {
    rawDiscount = Number(offer.flatDiscountPerAdult || 0) * passengers;
  } else if (offer.discountType === "flat_total") {
    rawDiscount = Number(offer.flatDiscountAmount || 0);
  }

  const discountAmount = Math.min(
    Math.max(0, Math.round(rawDiscount)),
    Math.max(0, portalBase)
  );

  if (!discountAmount) return null;

  const finalPrice = Math.max(0, portalBase - discountAmount);

  return {
    finalPrice,
    actualDiscount: discountAmount,
    code: candidate?.couponCode || null,
    title: `${candidate?.couponCode || "Checkout coupon"} checkout offer`,
    rawDiscount: `${candidate?.couponCode || "Checkout offer"} checkout offer`,
    appliedDiscountText: `Offer applied: ₹${discountAmount}`,
    paymentLabel: "No payment restriction",
    offerTypeLabel: "Checkout offer",
    channelLabel: "Portal checkout",
    explain: `Checkout offer ${candidate?.couponCode || ""} reduced ₹${portalBase} → ₹${finalPrice}`,
    offerDisplayType: "conservative_generic_display_offer",
    displayLabel: "Checkout offer",
    displaySubtext: candidate?.couponCode ? `${candidate.couponCode}` : "Checkout coupon",
    displayAmount: discountAmount,
    displayCurrency: offer.currency || "INR",
    isExactPricing: false,
    isDisplayOnly: true,
    genericCandidateId: candidate?.displayCandidateId || null,
    genericCandidateStatus: candidate?.status || null,
    genericPricingReadiness: candidate?.pricingReadiness || null
  };
}

function findGenericDisplayForPortal({
  genericDisplayContext,
  portal,
  isDomestic,
  tripType,
  portalBase,
  passengers
}) {
  if (!genericDisplayContext?.enabled) return null;

  const verified = (genericDisplayContext.verifiedGenericCoupons || [])
    .find((candidate) => genericCandidateMatchesSearch(candidate, portal, isDomestic, tripType));

  if (verified) {
    const built = buildVerifiedGenericCouponPortalDisplay({
      candidate: verified,
      portalBase,
      passengers
    });

    if (built) return built;
  }

  const conservative = (genericDisplayContext.conservativeDisplayOffers || [])
    .find((candidate) => genericCandidateMatchesSearch(candidate, portal, isDomestic, tripType));

  if (conservative) {
    const built = buildConservativeDisplayOfferPortalDisplay({
      candidate: conservative,
      portalBase,
      passengers
    });

    if (built) return built;
  }

  return null;
}


function slimFlightForSearchResponse(flight) {
  if (!flight || typeof flight !== "object") return flight || null;

  return {
    ...flight,
    portalPrices: Array.isArray(flight.portalPrices)
      ? flight.portalPrices.map(slimPortalPriceForSearchResponse)
      : [],
    bestDeal: slimPortalPriceForSearchResponse(flight.bestDeal)
  };
}

app.post("/search", async (req, res) => {
  const body = req.body || {};
  const meta = { source: "flightapi", outStatus: 0, retStatus: 0, request: {} };
  const searchStartedAt = Date.now();
  const timings = {};
  const offerPricingRequestCache = {
    infoOffersByKey: new Map(),
    pricingCandidatesByKey: new Map()
  };

  try {
    const from = String(body.from || "").trim().toUpperCase();
    const to = String(body.to || "").trim().toUpperCase();
    const outDate = toISO(body.departureDate);
    const retDate = toISO(body.returnDate);

    const tripType = body.tripType === "round-trip" ? "round-trip" : "one-way";
    const adults = Math.max(
      1,
      Math.floor(Number(body.adults ?? body.passengers ?? 1) || 1)
    );
    const cabin = normalizeCabin(body.travelClass || body.cabin);
    const currency = "INR";

    const selectedPaymentMethodsRaw = Array.isArray(body.paymentMethods) ? body.paymentMethods : [];

    const selectedPaymentMethods = selectedPaymentMethodsRaw.map((pm) => {
      const type = String(pm?.type || "").toLowerCase();

      if (type.includes("emi") && !Number(pm?.tenureMonths)) {
        return {
          ...pm,
          tenureMonths: 3,
          defaultedTenure: true
        };
      }

      return pm;
    });

    meta.selectedPaymentMethods = selectedPaymentMethods;
    meta.ENABLE_ESTIMATED_DISCOUNTS = ENABLE_ESTIMATED_DISCOUNTS;

    const includeGenericDisplayOffers =
      body.includeGenericDisplayOffers === true ||
      String(body.includeGenericDisplayOffers || "").toLowerCase() === "true";

    meta.includeGenericDisplayOffers = includeGenericDisplayOffers;
    meta.usedFallback = false;
    meta.mongoCollection = MONGO_COL;
    meta.mongoDb = MONGODB_DB;

    if (!from || !to || !outDate) {
      return res.status(400).json({
        meta: { ...meta, error: "Missing from/to/departureDate" },
        outboundFlights: [],
        returnFlights: [],
      });
    }

    const mongoStart = Date.now();
    const offers = await getOffersForSearch(meta);
    timings.mongoOffersMs = Date.now() - mongoStart;
    meta.offersLoaded = offers.length;

    let genericDisplayContext = null;
    if (includeGenericDisplayOffers) {
      const genericDisplayStart = Date.now();
      genericDisplayContext = await getGenericDisplayContextForSearch(meta);
      timings.genericDisplayOffersMs = Date.now() - genericDisplayStart;
    } else {
      meta.genericDisplayOffers = {
        enabled: false,
        mode: "disabled_by_request_flag"
      };
    }

    async function buildLegFlights({
      direction,
      fromAirport,
      toAirport,
      date
    }) {
      const isReturn = direction === "return";
      const prefix = isReturn ? "ret" : "out";
      const directionLabel = isReturn ? "return" : "outbound";

      const flightApiTimingKey = isReturn ? "flightApiReturnMs" : "flightApiOutboundMs";
      const mapTimingKey = isReturn ? "mapReturnMs" : "mapOutboundMs";
      const pricingTimingKey = isReturn ? "offerPricingReturnMs" : "offerPricingOutboundMs";

      const triedKey = isReturn ? "retTried" : "outTried";
      const rawFlightsKey = isReturn ? "retRawFlights" : "outRawFlights";
      const returnedFlightsKey = isReturn ? "retReturnedFlights" : "outReturnedFlights";
      const statusKey = isReturn ? "retStatus" : "outStatus";
      const carrierRuleKey = isReturn ? "retCarrierPriceRule" : "outCarrierPriceRule";

      const legStart = Date.now();

      try {
        const res = await fetchOneWayTrip({
          from: fromAirport,
          to: toAirport,
          date,
          adults,
          cabin,
          currency
        });

        timings[flightApiTimingKey] = Date.now() - legStart;
        meta[statusKey] = res.status;
        meta.request[triedKey] = res.tried;

        if (!isReturn) {
          meta.flightApiRawShape = {
            topLevelKeys: Object.keys(res.data || {}),
            itineraries: Array.isArray(res.data?.itineraries) ? res.data.itineraries.length : 0,
            legs: Array.isArray(res.data?.legs) ? res.data.legs.length : 0,
            segments: Array.isArray(res.data?.segments) ? res.data.segments.length : 0,
            carriers: Array.isArray(res.data?.carriers) ? res.data.carriers.length : 0,
            agents: Array.isArray(res.data?.agents) ? res.data.agents.length : 0,
            quotes: Array.isArray(res.data?.quotes) ? res.data.quotes.length : 0,
            results: Array.isArray(res.data?.results) ? res.data.results.length : 0,
            data: Array.isArray(res.data?.data) ? res.data.data.length : 0
          };
        }

        const mapStart = Date.now();
        const flightsRaw = mapFlightsFromFlightAPI(res.data);
        const flightsLimited = limitAndSortFlights(flightsRaw).slice(0, 40);
        timings[mapTimingKey] = Date.now() - mapStart;

        meta[rawFlightsKey] = flightsRaw.length;
        meta[returnedFlightsKey] = flightsLimited.length;
        meta[carrierRuleKey] = {
          flightApiItineraries: Array.isArray(res.data?.itineraries) ? res.data.itineraries.length : 0,
          keptWithCarrierPrice: flightsRaw.length,
          skippedWithoutCarrierPrice:
            (Array.isArray(res.data?.itineraries) ? res.data.itineraries.length : 0) - flightsRaw.length,
          ...(!isReturn && String(process.env.INCLUDE_FLIGHTAPI_DEBUG_META || "false").toLowerCase() === "true"
            ? { debug: getFlightApiCarrierDebug(res.data) }
            : {})
        };

        const routeIsDomestic = isDomesticRoute(fromAirport, toAirport);

        const pricingStart = Date.now();
        const enriched = [];
        for (const f of flightsLimited) {
          enriched.push(
            await applyOffersToFlight(
              f,
              selectedPaymentMethods,
              offers,
              adults,
              cabin,
              tripType,
              routeIsDomestic,
              timings.offerPricingBreakdown || (timings.offerPricingBreakdown = {}),
              offerPricingRequestCache,
              genericDisplayContext
            )
          );
        }
        timings[pricingTimingKey] = Date.now() - pricingStart;

        return {
          ok: true,
          direction: directionLabel,
          flights: enriched,
          error: null
        };
      } catch (e) {
        const status = e?.status || e?.response?.status || 500;

        timings[flightApiTimingKey] = Date.now() - legStart;
        meta[statusKey] = status;
        meta.request[triedKey] = e?.tried || [];
        meta[rawFlightsKey] = null;
        meta[returnedFlightsKey] = null;

        const message = e?.message || `${directionLabel} FlightAPI search failed`;

        meta.legErrors = meta.legErrors || {};
        meta.legErrors[directionLabel] = {
          status,
          message
        };

        return {
          ok: false,
          direction: directionLabel,
          flights: [],
          error: message,
          status
        };
      }
    }

    let outboundResult = null;
    let returnResult = null;

    if (tripType === "round-trip" && retDate) {
      [outboundResult, returnResult] = await Promise.all([
        buildLegFlights({
          direction: "outbound",
          fromAirport: from,
          toAirport: to,
          date: outDate
        }),
        buildLegFlights({
          direction: "return",
          fromAirport: to,
          toAirport: from,
          date: retDate
        })
      ]);
    } else {
      outboundResult = await buildLegFlights({
        direction: "outbound",
        fromAirport: from,
        toAirport: to,
        date: outDate
      });

      returnResult = {
        ok: true,
        direction: "return",
        flights: [],
        error: null
      };
    }

    const outboundFlights = outboundResult?.flights || [];
    const returnFlights = returnResult?.flights || [];

    meta.partialResults = {
      enabled: tripType === "round-trip",
      outboundOk: Boolean(outboundResult?.ok),
      returnOk: tripType === "round-trip" && retDate ? Boolean(returnResult?.ok) : null,
      outboundCount: outboundFlights.length,
      returnCount: returnFlights.length
    };

    timings.totalMs = Date.now() - searchStartedAt;
    meta.timings = timings;

    const isRoundTripSearch = tripType === "round-trip" && retDate;

    if (!outboundResult?.ok && (!isRoundTripSearch || !returnResult?.ok)) {
      meta.error = isRoundTripSearch
        ? "Both outbound and return FlightAPI searches failed"
        : outboundResult?.error || "FlightAPI search failed";

      return res.status(500).json({
        meta,
        outboundFlights: [],
        returnFlights: []
      });
    }

    if (isRoundTripSearch && (!outboundResult?.ok || !returnResult?.ok)) {
      meta.warning = !outboundResult?.ok
        ? "Outbound FlightAPI search failed, but return results are available"
        : "Return FlightAPI search failed, but outbound results are available";
    }

    return res.json({
      meta,
      outboundFlights: outboundFlights.map(slimFlightForSearchResponse),
      returnFlights: returnFlights.map(slimFlightForSearchResponse)
    });
  } catch (e) {
    const status = e?.status || e?.response?.status || 500;
    meta.outStatus = meta.outStatus || status;
    meta.error = e?.message || "Search failed";
    meta.request.tried = e?.tried || [];
    timings.totalMs = Date.now() - searchStartedAt;
    meta.timings = timings;

    res.status(500).json({ meta, outboundFlights: [], returnFlights: [] });
  }
});

/* =========================================================
   Debug only: generic checkout coupon candidates
   ---------------------------------------------------------
   Reads review-only candidates from:
   generic_checkout_coupon_rule_candidates

   This route does NOT modify offer_rules.
   This route does NOT affect /search pricing.
   This route is only for simulating review candidates.
   ========================================================= */

let genericCouponMongoClient = null;

async function getGenericCouponDb() {
  const { MongoClient } = await import("mongodb");

  const uri =
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    process.env.ATLAS_URI;

  const dbName =
    process.env.MONGODB_DB ||
    process.env.MONGO_DB ||
    "skydeal";

  if (!uri) {
    throw new Error("Missing Mongo URI. Expected MONGODB_URI, MONGO_URI, or ATLAS_URI.");
  }

  if (!genericCouponMongoClient) {
    genericCouponMongoClient = new MongoClient(uri);
    await genericCouponMongoClient.connect();
  }

  return genericCouponMongoClient.db(dbName);
}

function normalizeDebugText(value) {
  return String(value || "").trim().toLowerCase();
}

function calculateGenericCouponCandidate(candidate, adults, basePrice) {
  const rule = candidate.proposedRule || {};
  const flatPerAdult = Number(rule.flatDiscountPerAdult || 0);

  const calculatedDiscount = Math.max(0, flatPerAdult * adults);
  const safeDiscount = Math.min(calculatedDiscount, Math.max(0, basePrice));

  return {
    ruleCandidateId: candidate.ruleCandidateId,
    sourcePortal: candidate.sourcePortal,
    couponCode: candidate.couponCode,
    status: candidate.status,
    shouldUploadToActiveOfferRules: candidate.shouldUploadToActiveOfferRules,
    confidence: candidate.confidence,
    pricingReadiness: candidate.pricingReadiness,
    applicability: candidate.applicability,
    proposedRule: candidate.proposedRule,
    input: {
      adults,
      basePrice
    },
    calculated: {
      discountAmount: safeDiscount,
      finalPrice: Math.max(0, basePrice - safeDiscount),
      formulaUsed: rule.formula || null
    }
  };
}

app.get("/debug/generic-coupon-candidates", async (req, res) => {
  try {
    const portal = normalizeDebugText(req.query.portal);
    const routeType = normalizeDebugText(req.query.routeType || "international");
    const tripType = normalizeDebugText(req.query.tripType || "one-way");

    const adults = Math.max(1, Number(req.query.adults || 1));
    const basePrice = Math.max(0, Number(req.query.basePrice || 0));

    const db = await getGenericCouponDb();

    const query = {
      status: "DRY_RUN_REVIEW_ONLY",
      shouldUploadToActiveOfferRules: false,
      pricingReadiness: "READY_FOR_MONGO_DRY_RUN_REVIEW"
    };

    if (portal) {
      query.sourcePortal = new RegExp(`^${portal}$`, "i");
    }

    const docs = await db
      .collection("generic_checkout_coupon_rule_candidates")
      .find(query)
      .project({
        _id: 0,
        ruleCandidateId: 1,
        sourcePortal: 1,
        couponCode: 1,
        status: 1,
        shouldUploadToActiveOfferRules: 1,
        applicability: 1,
        proposedRule: 1,
        confidence: 1,
        pricingReadiness: 1,
        evidenceSummary: 1
      })
      .sort({ sourcePortal: 1, couponCode: 1, ruleCandidateId: 1 })
      .toArray();

    const matchingCandidates = docs.filter((doc) => {
      const appData = doc.applicability || {};

      return (
        normalizeDebugText(appData.routeType) === routeType &&
        normalizeDebugText(appData.tripType) === tripType
      );
    });

    const simulated = matchingCandidates.map((candidate) =>
      calculateGenericCouponCandidate(candidate, adults, basePrice)
    );

    res.json({
      debugOnly: true,
      message:
        "This route simulates generic checkout coupon candidates only. It does not affect active offer_rules or /search pricing.",
      input: {
        portal: portal || null,
        routeType,
        tripType,
        adults,
        basePrice
      },
      collection: "generic_checkout_coupon_rule_candidates",
      totalCandidatesInReviewCollection: docs.length,
      matchingCandidateCount: matchingCandidates.length,
      simulated
    });
  } catch (error) {
    console.error("Error in /debug/generic-coupon-candidates:", error);
    res.status(500).json({
      error: "Failed to simulate generic coupon candidates",
      details: error.message
    });
  }
});




// Debug-only route for conservative generic checkout display-offer candidates.
// This reads from generic_checkout_display_offer_candidates only.
// It does not affect /search, offer_rules, or live pricing.
app.get("/debug/generic-display-offer-candidates", async (req, res) => {
  let client;

  try {
    const { MongoClient } = await import("mongodb");

    const mongoUri =
      process.env.MONGODB_URI ||
      process.env.MONGO_URI ||
      process.env.ATLAS_URI;

    const dbName =
      process.env.MONGODB_DB ||
      process.env.MONGO_DB ||
      "skydeal";

    if (!mongoUri) {
      return res.status(500).json({
        error: "Missing Mongo URI",
        expectedEnvVars: ["MONGODB_URI", "MONGO_URI", "ATLAS_URI"]
      });
    }

    const normalize = (value) =>
      String(value || "").trim().toLowerCase();

    const escapeRegExp = (value) =>
      String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const portal = normalize(req.query.portal);
    const routeType = normalize(req.query.routeType || "domestic");
    const tripType = normalize(req.query.tripType || "one-way");

    const adultsRaw = Number(req.query.adults || 1);
    const basePriceRaw = Number(req.query.basePrice || 0);

    const adults = Number.isFinite(adultsRaw) && adultsRaw > 0
      ? Math.floor(adultsRaw)
      : 1;

    const basePrice = Number.isFinite(basePriceRaw) && basePriceRaw > 0
      ? Math.round(basePriceRaw)
      : 0;

    client = new MongoClient(mongoUri);
    await client.connect();

    const db = client.db(dbName);
    const col = db.collection("generic_checkout_display_offer_candidates");

    const query = {
      status: "DISPLAY_REVIEW_ONLY",
      shouldApplyToLivePricing: false,
      shouldUploadToActiveOfferRules: false,
      pricingReadiness: "DISPLAY_ONLY_NOT_EXACT_PRICING"
    };

    if (portal) {
      query.sourcePortal = new RegExp(`^${escapeRegExp(portal)}$`, "i");
    }

    const candidates = await col
      .find(query)
      .project({
        _id: 0,
        displayCandidateId: 1,
        sourcePortal: 1,
        couponCode: 1,
        status: 1,
        shouldApplyToLivePricing: 1,
        shouldUploadToActiveOfferRules: 1,
        confidence: 1,
        pricingReadiness: 1,
        applicability: 1,
        proposedDisplayOffer: 1,
        reviewNotes: 1
      })
      .sort({ sourcePortal: 1 })
      .toArray();

    const matching = candidates.filter((candidate) => {
      const app = candidate.applicability || {};
      return (
        normalize(app.routeType) === routeType &&
        normalize(app.tripType) === tripType
      );
    });

    const simulated = matching.map((candidate) => {
      const offer = candidate.proposedDisplayOffer || {};
      let discountAmount = 0;

      if (offer.discountType === "flat_per_adult") {
        discountAmount = Number(offer.flatDiscountPerAdult || 0) * adults;
      } else if (offer.discountType === "flat_total") {
        discountAmount = Number(offer.flatDiscountAmount || 0);
      }

      discountAmount = Math.max(0, Math.round(discountAmount));

      if (basePrice > 0) {
        discountAmount = Math.min(discountAmount, basePrice);
      }

      const finalPrice = basePrice > 0
        ? Math.max(0, basePrice - discountAmount)
        : null;

      return {
        displayCandidateId: candidate.displayCandidateId,
        sourcePortal: candidate.sourcePortal,
        couponCode: candidate.couponCode,

        status: candidate.status,
        shouldApplyToLivePricing: candidate.shouldApplyToLivePricing,
        shouldUploadToActiveOfferRules: candidate.shouldUploadToActiveOfferRules,
        confidence: candidate.confidence,
        pricingReadiness: candidate.pricingReadiness,

        applicability: candidate.applicability,
        proposedDisplayOffer: candidate.proposedDisplayOffer,

        display: {
          displayLabel: offer.displayLabel || "Possible checkout saving",
          displaySubtext: offer.displaySubtext || null,
          displayAmount: discountAmount,
          displayCurrency: offer.currency || "INR",
          displayType: "conservative_generic_display_offer",
          isExactPricing: false,
          isDisplayOnly: true
        },

        input: {
          adults,
          basePrice
        },

        calculated: {
          discountAmount,
          finalPrice,
          formulaUsed: offer.formula || null
        }
      };
    });

    return res.json({
      debugOnly: true,
      message:
        "This route simulates conservative generic display-offer candidates only. It does not affect active offer_rules, /search pricing, or frontend pricing.",
      input: {
        portal,
        routeType,
        tripType,
        adults,
        basePrice
      },
      collection: "generic_checkout_display_offer_candidates",
      totalCandidatesInDisplayReviewCollection: candidates.length,
      matchingCandidateCount: simulated.length,
      simulated
    });
  } catch (err) {
    console.error("generic display offer debug route failed", err);
    return res.status(500).json({
      error: "generic display offer debug route failed",
      message: err.message
    });
  } finally {
    if (client) {
      await client.close();
    }
  }
});

app.listen(PORT, () => {
  console.log(`SkyDeal backend listening on ${PORT}`);
});

