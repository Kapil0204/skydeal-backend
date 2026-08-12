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
const OTAS = ["Goibibo", "MakeMyTrip", "Yatra", "EaseMyTrip", "Cleartrip", "Ixigo"];

// Single source of truth for "/search's page size" and "how many pages
// ever get fetched" - every other cap/margin that depends on "max flights
// per leg" derives from these two instead of duplicating its own literal.
// This is the fix for the exact bug class that bit us twice already
// (2026-07): PAYMENT_RECOMMENDATION_CONFIG.maxFlightsPerLeg used to be a
// hardcoded 40 that silently went stale the moment /search grew a second
// page, and RECOMMENDATION_SCORE_WEIGHTS.easeUnit's safety margin then
// went stale a second time when maxFlightsPerLeg was hand-bumped to 80
// without updating it. Change SEARCH_RESULTS_PAGE_SIZE or
// SEARCH_MAX_PAGES here and both now update themselves automatically.
const SEARCH_RESULTS_PAGE_SIZE = 40;
const SEARCH_MAX_PAGES = 2; // today: page 1 (initial) + page 2 (background prefetch) - see prefetchNextPage in script.js
const SEARCH_MAX_FLIGHTS_PER_LEG = SEARCH_RESULTS_PAGE_SIZE * SEARCH_MAX_PAGES;

// Phase 1 intelligent payment guide — tunables kept in one place.
const PAYMENT_RECOMMENDATION_CONFIG = {
  minAbsoluteSavingInr: 150,
  minPercentSaving: 0.02,        // 2%
  maxSuggestions: 2,
  maxFlightsPerLeg: SEARCH_MAX_FLIGHTS_PER_LEG, // validation cap only — derived from SEARCH_RESULTS_PAGE_SIZE/SEARCH_MAX_PAGES above, not a separate literal
  maxCandidatesPerRequest: 50,    // computation guard
  // EMI tenure candidates only exist for the (typically 1-3) already-
  // selected credit cards, unlike the 50-cap above which spans every
  // bank/type combo - so this can afford real headroom. Raised from 6
  // (every real tenure found gets fully reprice-tested and compared
  // anyway; a low cap only risked silently dropping a legitimate tenure
  // before it was ever evaluated, on a bank with an unusually large
  // number of distinct EMI plans).
  maxEmiTenureVariantsPerBank: 12,
  softTimeBudgetMs: 20000,        // stop testing further candidates past this
  suggestionsCacheTtlMs: 15000,   // Phase 2: dedupe repeat identical /payment-suggestions calls
  // 2026-08-07 (founder call): repricing EVERY relevant candidate against
  // every loaded flight (could be 40-80 after a page-2 prefetch) was the
  // dominant cost of /payment-suggestions - confirmed live at ~13s per
  // candidate on an 80-flight search. Screening pass reprices against only
  // the cheapest N flights (same sampling Phase 3's timing insights
  // already use) to cheaply rank every candidate; only the top few from
  // that ranking get a second, full-precision pass (see
  // candidateRefineBuffer) against the complete flight set, so the rupee
  // saving and "improves N flights" numbers actually shown to the user are
  // always exact, never sampled estimates - only the ranking that decides
  // WHICH candidates get shown is approximate.
  candidateScreeningFlightSample: 10,
  // How many extra candidates beyond maxSuggestions get the full-precision
  // refine pass - a small buffer against the sampled screening ranking
  // putting the true top candidates just outside the cut.
  candidateRefineBuffer: 2
};

// Phase 2 — recommendation scoring. Ranking precedence is: relevance tier
// > additional saving > ease of adoption > flights improved > breadth.
// Rather than a multi-key comparator, each level gets a multiplier large
// enough that a single unit of difference at that level always outweighs
// the ENTIRE realistic range of every level after it combined — so a
// plain descending sort on the resulting number reproduces the exact
// precedence order safely (no risk of a lower-precedence factor ever
// flipping a higher-precedence comparison), while still yielding one
// transparent, comparable score per suggestion. Never sent to the client.
const REC_SCORE_FLIGHT_UNIT = 100;
const REC_SCORE_BREADTH_UNIT = 1;
// Max realistic combined flights+breadth contribution: every affected
// flight on both legs (SEARCH_MAX_FLIGHTS_PER_LEG x 2) at flightUnit, plus
// a maxed-out 100% breadth at breadthUnit. Derived, not hand-counted, so
// it can never again go stale the way it did when maxFlightsPerLeg was
// bumped without this margin being revisited.
const REC_SCORE_MAX_FLIGHT_BREADTH_CONTRIBUTION =
  (SEARCH_MAX_FLIGHTS_PER_LEG * 2) * REC_SCORE_FLIGHT_UNIT + 100 * REC_SCORE_BREADTH_UNIT;

const RECOMMENDATION_SCORE_WEIGHTS = {
  // Relevance tier (1 = same bank ... higher = less relevant). One tier
  // step is worth far more than the maximum plausible combined value of
  // saving+ease+flights+breadth below, so relevance always wins first.
  tierUnit: 1_000_000_000_000,
  // ₹1 of additional saving. Even an absurd, never-realistic ₹1,000,000
  // saving would only tie (not exceed) a single tier step - real fare
  // differences are nowhere close to that, so in every real-world case
  // saving only ever matters as a tiebreaker within the same tier.
  savingUnit: 1_000_000,
  // One ease-of-adoption level (0-3, see easeOfAdoptionScore) must always
  // exceed the max *combined* flights+breadth contribution above, so ease
  // only ever matters once saving is tied. A flat 2x safety margin over
  // the derived max, rather than a hand-picked number, so this stays
  // correct automatically if SEARCH_MAX_FLIGHTS_PER_LEG ever changes again.
  easeUnit: REC_SCORE_MAX_FLIGHT_BREADTH_CONTRIBUTION * 2,
  // One flight improved (outbound+return combined). breadthPercent is
  // *derived* from this same count (breadthPercent = affected/tested*100),
  // so the two always move together rather than being independently
  // adversarial - one flight of difference is never actually offset by
  // breadth.
  flightUnit: REC_SCORE_FLIGHT_UNIT,
  // 1 percentage point of flights-tested that improved (0-100) - the
  // final, lowest-precedence tiebreaker.
  breadthUnit: REC_SCORE_BREADTH_UNIT
};

// Phase 3 — single application timezone. getBookingDayName() already
// hard-coded Asia/Kolkata correctly for weekday names; this constant lets
// isOfferExpired() and the timing-insight day simulation share the exact
// same anchor, instead of isOfferExpired's previous reliance on the
// server process's local/UTC clock (a real inconsistency: on a
// UTC-hosted server, "today" could disagree between the two by up to
// ~5.5 hours around IST midnight).
const APP_TIMEZONE = process.env.APP_TIMEZONE || "Asia/Kolkata";

// Intl.DateTimeFormat construction (not formatting - construction) is
// genuinely expensive in Node. Phase 3's date-scan calls
// getTimezoneDateOnly/getBookingDayName thousands of times per request
// (methods x offers x horizon-days) - constructing a fresh formatter
// each call measurably pushed a real ~40-flight request past 25s.
// Reusing one cached formatter per timezone turns that into a
// microseconds-per-call operation.
const DATE_ONLY_FORMATTER_CACHE = new Map();
function getDateOnlyFormatter(timeZone) {
  let f = DATE_ONLY_FORMATTER_CACHE.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    DATE_ONLY_FORMATTER_CACHE.set(timeZone, f);
  }
  return f;
}

// Returns a Date anchored at UTC-midnight of `date`'s calendar day *as
// observed in `timeZone`* - not a real instant, just a stable, comparable
// stand-in for "which calendar day is this" that two calls with the same
// timezone can safely compare with < / > / ===, regardless of the
// server's own local timezone.
function getTimezoneDateOnly(date = new Date(), timeZone = APP_TIMEZONE) {
  const parts = getDateOnlyFormatter(timeZone).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return new Date(`${y}-${m}-${d}T00:00:00.000Z`);
}

function addDaysToDateOnly(dateOnly, days) {
  return new Date(dateOnly.getTime() + days * 24 * 60 * 60 * 1000);
}

// Phase 3 timing-guidance tunables, kept in one place. Saving thresholds
// intentionally reuse PAYMENT_RECOMMENDATION_CONFIG rather than
// introducing a second, possibly-conflicting bar.
const PAYMENT_TIMING_CONFIG = {
  futureLookaheadDays: 7,   // never scan further ahead than this, and never past the travel date
  endingSoonDays: 3,        // "expires within N days" window for AVAILABLE_TODAY_ENDS_SOON
  maxUrgentInsights: 1,
  maxFutureInsights: 1,
  timezone: APP_TIMEZONE,
  // Hard guards found necessary after measuring real traffic: with a
  // realistic ~40-flight search, a handful of confirmatory reprice calls
  // (one per method that clears the cheap date-scan) pushed a single
  // /payment-suggestions call past 30s, timing out the client and taking
  // Phase 1/2's suggestions down with it (they share one request). Never
  // let Phase 3 risk the overall response time again.
  timingBudgetMs: 3500,          // stop scanning further methods once this much time has been spent inside buildTimingInsights
  maxMethodsScanned: 6,          // hard cap on how many methods-of-interest are even considered
  maxFlightsPerMethodCheck: 5    // confirmatory reprice uses only the cheapest N loaded flights per leg, not all of them
};

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

// Same volatility profile as the main offers cache above (both refreshed
// by the same scraper pipeline) - getGenericDisplayContextForSearch()
// used to run 2 fresh Mongo queries on every single call (2026-07-15
// finding: this was pure overhead in /payment-suggestions, called fresh
// on every request with no caching at all, unlike the main offers read).
let genericDisplayContextCacheData = null;
let genericDisplayContextCacheLoadedAt = 0;

const FLIGHTAPI_CACHE_TTL_MS = Number(process.env.FLIGHTAPI_CACHE_TTL_MS || 600000);
const flightApiSuccessCache = new Map();

// Page-2 prefetch is speculative (only useful if the user clicks "next
// page") and CPU-bound in the exact same way the payment-suggestions
// head start is - on Render's single dedicated core, both fully-loaded
// requests can't actually run at once, they queue behind each other.
// Measured live (2026-08-03): decode's own computation stayed ~3.3-3.4s
// across 3 samples, but the client-perceived wait was consistently
// ~8.8-8.9s whenever a page-2 prefetch's request window overlapped it -
// almost exactly decode's missing ~5s. Since decode is what the user is
// actively looking at and prefetch only matters later (if at all), page-2
// requests wait for any currently in-flight suggestion work to clear
// first, capped so a stuck/slow computation can't wedge prefetch forever.
const PAGE2_PREFETCH_DEFER_CAP_MS = Number(process.env.PAGE2_PREFETCH_DEFER_CAP_MS || 6000);
// --------------------
// Route geography helpers
// --------------------
const INDIAN_IATA_AIRPORTS = new Set([
  "AMD","ATQ","BBI","BDQ","BHO","BHU","BLR","BOM","CCJ","CCU","CJB","COK","DED","DEL","DMU",
  "GAU","GOI","GOP","GWL","HBX","HYD","IDR","IXA","IXB","IXC","IXD","IXE","IXG","IXJ","IXL",
  "IXM","IXR","IXS","IXU","JAI","JDH","JGA","JLR","JRG","JSA","IXY","JGB","KNU","LKO","MAA",
  "MYQ","NAG","PAT","PNQ","RJA","RPR","SAG","SLV","SXR","STV","SXV","TRV","TRZ","UDR","VGA",
  "VNS","VTZ","PNY","AGX","DIB","IMF","SHL","AIP","NDC","TIR","RDP","JRH","TEZ","TCR","TCR",
  "COH","DHM","KUU","LEH","SBI","TCR","UDR","BEP","HJR","JLG","AJL","IXK","ISK","JAI","NMI",
  "DXN","HDO","GOX",
  // Added 2026-08-03 (found live while investigating a domestic-route
  // foreign-layover bug report): both are real, operating Indian
  // airports missing from this list - HSR (Rajkot/Hirasar, Gujarat,
  // opened 2023) and DBR (Darbhanga, Bihar, commercial ops since 2020).
  // This list is manually maintained and will keep needing occasional
  // additions as new airports open; see resolveAirportCountryCode below
  // for a self-updating alternative used specifically for the new
  // foreign-layover filter, so THAT check doesn't depend on this list
  // staying perfectly current.
  "HSR","DBR"
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

// Metro areas served by more than one operational airport (2026-07-16,
// founder-reported Mumbai-Aurangabad gap: other OTAs merge Navi Mumbai
// International into a "Mumbai" search, SkyDeal only ever queried BOM).
// Every code in a group expands to the FULL group (symmetric) - searching
// any one of them pulls in flights from all of them. Kept to a short,
// explicit, manually-verified list rather than inferring from city names
// in the airport dataset (which is crowdsourced and inconsistent - see
// the Jewar/Noida naming note elsewhere in this file).
const METRO_AIRPORT_GROUPS = {
  BOM: ["BOM", "NMI"],
  NMI: ["BOM", "NMI"],
  DEL: ["DEL", "DXN", "HDO"],
  DXN: ["DEL", "DXN", "HDO"],
  HDO: ["DEL", "DXN", "HDO"],
  GOI: ["GOI", "GOX"],
  GOX: ["GOI", "GOX"]
};

function expandMetroAirportGroup(code) {
  const upper = String(code || "").trim().toUpperCase();
  return METRO_AIRPORT_GROUPS[upper] || [upper];
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

// FlightAPI real-world finding (2026-07-15, BOM->IXU): the FIRST call for a
// brand-new route/date can come back HTTP 200 with a genuine `itineraries`
// array, but FlightAPI's own `stats.itineraries.total.count` (and every
// other stat) is still zeroed out - a "search job hasn't finished
// populating yet" snapshot, not a real error. Confirmed directly: two
// immediate follow-up calls for the identical route/date returned the full
// 53 itineraries with internally-consistent stats. Our retry loop
// previously only inspected HTTP status/error text, so it accepted and
// CACHED (10 min) whatever thin snapshot came back first - in the observed
// case, exactly 1 itinerary instead of 53, which is what a real user saw.
// This checks for that specific internal inconsistency as a retry signal;
// a genuinely thin route (few real options) won't trip it, since its own
// stats would consistently match its own itineraries count.
function looksLikeIncompleteFlightApiResponse(parsedData) {
  const itineraries = Array.isArray(parsedData?.itineraries) ? parsedData.itineraries : [];
  if (itineraries.length === 0) return false;

  const statsTotal = parsedData?.stats?.itineraries?.total?.count;
  if (!Number.isFinite(statsTotal)) return false;

  return statsTotal !== itineraries.length;
}

// Air India's non-stop inventory occasionally disappears from FlightAPI's
// response for a few minutes at a time (confirmed via repeated live
// re-checks: a route showing 0 non-stop Air India itineraries one moment
// shows 20-30 fully-priced ones minutes later on an identical query - see
// FLIGHTAPI_CARRIER_PRICING_AUDIT_2026-07.md). This is transient, not a
// persistent coverage gap, so a single bounded retry is worth attempting -
// but it must never hold up the rest of the search past a tight budget.
function hasNonStopAirIndiaItinerary(parsedData) {
  const itineraries = Array.isArray(parsedData?.itineraries) ? parsedData.itineraries : [];
  if (itineraries.length === 0) return true; // no data at all - not this bug, don't retry

  const legs = Object.fromEntries((parsedData.legs || []).map((l) => [l.id, l]));
  const carriers = Object.fromEntries((parsedData.carriers || []).map((c) => [String(c.id), c]));

  for (const it of itineraries) {
    const legId = (it.leg_ids || [])[0];
    const leg = legId ? legs[legId] : null;
    const carrierId = leg?.marketing_carrier_ids?.[0];
    const carrierName = carriers[String(carrierId)]?.name || "";
    if (carrierName === "Air India" && leg?.stop_count === 0) {
      return true;
    }
  }

  return false;
}

const AIRINDIA_RETRY_TIMEOUT_MS = Number(process.env.FLIGHTAPI_AIRINDIA_RETRY_TIMEOUT_MS || 5000);

// Fires at most ONE extra fetch, capped at AIRINDIA_RETRY_TIMEOUT_MS (default
// 5s) - deliberately much shorter than the main FLIGHTAPI_TIMEOUT_MS/retry
// loop above, since this must never turn into a 5-10s wait. Fails open: any
// error, timeout, or still-empty result just falls back to the original
// (already-successful) response rather than throwing.
async function maybeRetryForMissingAirIndiaNonStop(parsedData, activeUrl, tried) {
  if (hasNonStopAirIndiaItinerary(parsedData)) return parsedData;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AIRINDIA_RETRY_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const res = await fetch(activeUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      tried.push({ airIndiaNonStopRetry: true, status: res.status, elapsedMs: Date.now() - startedAt });
      return parsedData;
    }

    const text = await res.text();
    const retriedData = JSON.parse(text);
    const recovered = hasNonStopAirIndiaItinerary(retriedData);

    tried.push({
      airIndiaNonStopRetry: true,
      status: res.status,
      recovered,
      elapsedMs: Date.now() - startedAt,
    });

    return recovered ? retriedData : parsedData;
  } catch (err) {
    clearTimeout(timeout);
    tried.push({
      airIndiaNonStopRetry: true,
      error: err?.name === "AbortError"
        ? `timed out after ${AIRINDIA_RETRY_TIMEOUT_MS}ms`
        : (err?.message || String(err)),
      elapsedMs: Date.now() - startedAt,
    });
    return parsedData;
  }
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
  // Holds the last successfully-parsed-but-suspiciously-incomplete
  // response (see looksLikeIncompleteFlightApiResponse) so a route that
  // genuinely never stabilizes across every attempt still returns
  // something, rather than erroring out entirely.
  let lastIncompleteResult = null;

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

          if (looksLikeIncompleteFlightApiResponse(parsedData)) {
            triedRow.incompleteSnapshot = true;
            triedRow.itinerariesCount = Array.isArray(parsedData?.itineraries) ? parsedData.itineraries.length : 0;
            triedRow.statsTotalCount = parsedData?.stats?.itineraries?.total?.count ?? null;
            lastIncompleteResult = { status: res.status, data: parsedData, tried };

            if (attempt < maxAttempts) {
              // Don't cache or return yet - retry, since FlightAPI's own
              // stats disagree with the itineraries it just sent, a sign
              // its search job hadn't finished populating (see
              // looksLikeIncompleteFlightApiResponse above).
            } else {
              // Out of attempts - better to return the incomplete
              // snapshot than nothing, but never cache it, so the next
              // request gets a fresh chance at a stable response instead
              // of being locked into this one for FLIGHTAPI_CACHE_TTL_MS.
              return lastIncompleteResult;
            }
          } else {
            const finalData = await maybeRetryForMissingAirIndiaNonStop(parsedData, activeUrl, tried);

            flightApiSuccessCache.set(cacheKey, {
              loadedAt: Date.now(),
              data: finalData
            });

            return {
              status: res.status,
              data: finalData,
              tried,
            };
          }
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

// 2026-07-23: live-audited Akasa Air's FlightAPI carrier-direct price
// against real OTA pages (Yatra, cross-checked against Cleartrip/Ixigo/
// MakeMyTrip/Goibibo for one flight) for 11 flights - 3 routes (BOM-DEL,
// BOM-BLR, BLR-DEL), dates 13 Aug and 20 Nov 2026 (3.5 months apart),
// prices from Rs.5,101 to Rs.10,016. Every single one was EXACTLY Rs.350
// higher on FlightAPI than the real OTA price - not approximately, not a
// percentage (the gap didn't scale across a ~2x price range, so this is a
// flat offset, not a fare-class percentage markup). Investigated the raw
// FlightAPI response directly: Akasa itineraries only ever expose ONE
// carrier-attributed pricing_option (no separate cheaper "Saver" option
// to select instead) - the gap can't be fixed by picking a different
// pricing_option, only by correcting the number itself. See DECISIONS.md
// (2026-07-23) for the full investigation and evidence table. Flat
// per-carrier Rupee amounts (not percentages) since that's what the
// evidence actually showed - revisit if a future audit finds this no
// longer holds, or if a fare-class/convenience-fee explanation surfaces
// that would make a percentage more correct.
//
// 2026-07-24: live-audited SpiceJet the same way. First pass (5 flights,
// mixed quote ages up to ~22hrs stale) looked messy/inconsistent - gaps of
// Rs.350-931 vs MMT. Root cause was staleness, not a real inconsistent
// gap: re-tested with ONLY fresh quotes (quote_age <= 30min, confirmed via
// FlightAPI's own quote_age field) across 5 flights, 3 routes (DEL-BOM,
// BOM-BLR, DEL-CCU), and got EXACTLY Rs.350 every single time vs MMT - same
// amount as Akasa, confirmed coincidental (unrelated carriers/routes/fare
// structure). Also confirmed structurally clean: every SpiceJet
// carrier-tagged pricing option's fare-basis code ends in "SAV" (USAV/
// VSAV/ASAV - varying only by booking-class letter U/V/A, the same "Saver"
// fare product every time), so unlike Air India Express there's no
// competing fare-bucket to accidentally pick the wrong one from. Yatra's
// gap vs FlightAPI was messier (Rs.518-906) but decomposes cleanly once
// you subtract the same Rs.350 base: the remainder (Rs.168/168/168/556/288)
// matches the shape of Yatra's separate, still-unexplained "Instant
// Discount" mechanism found during the Air India Express investigation -
// not a different SpiceJet-specific rule. Deliberately NOT modeling
// Yatra's extra discount here (no reliable formula yet); applying the same
// flat Rs.350 to Yatra as every other portal is conservative (may slightly
// understate Yatra's real saving, never overstates it - see conservative
// discount principle in DECISIONS.md).
const CARRIER_FARE_CORRECTIONS_INR = {
  akasa: 350,
  spicejet: 350
};

function applyCarrierFareCorrection(amount, airlineName) {
  const normalized = normalizeForMatch(airlineName);
  for (const [alias, correctionInr] of Object.entries(CARRIER_FARE_CORRECTIONS_INR)) {
    if (normalized.includes(alias)) {
      return Math.max(0, amount - correctionInr);
    }
  }
  return amount;
}

// 2026-07-23: live-audited IndiGo's FlightAPI carrier price the same way
// as Akasa above, but the result was a different shape - portal-specific
// and stop-count-dependent, not a single flat number. Confirmed across 3
// non-stop flights (BOM-DEL, BOM-BLR, BLR-DEL; Rs.6,015-9,844 price
// range, tight time-sync between the FlightAPI read and each portal
// check to rule out ordinary fare drift): Yatra's real price is exactly
// Rs.41 higher than FlightAPI's number every time; Cleartrip/Ixigo/
// MakeMyTrip/Goibibo/EaseMyTrip agree with EACH OTHER exactly and are
// Rs.56 higher, every time. A 4th flight (1-stop, same route/price
// range) showed next to no gap (+8/-7, noise) - so this is deliberately
// scoped to non-stop only; applying it to connecting itineraries would
// overshoot and make things worse, not better. See DECISIONS.md
// (2026-07-23) for the full evidence table.
const INDIGO_NONSTOP_PORTAL_CORRECTIONS_INR = {
  Yatra: 41,
  // Goibibo/MakeMyTrip/EaseMyTrip/Cleartrip/Ixigo all shared this exact
  // number across every flight checked - not five separate guesses.
  __default: 56
};

function applyIndigoNonstopPortalCorrection(portalBase, flight, portal) {
  const airline = normalizeForMatch(flight?.airlineName);
  if (!airline.includes("indigo")) return portalBase;
  if (Number(flight?.stops) !== 0) return portalBase;

  const correctionInr = Object.prototype.hasOwnProperty.call(INDIGO_NONSTOP_PORTAL_CORRECTIONS_INR, portal)
    ? INDIGO_NONSTOP_PORTAL_CORRECTIONS_INR[portal]
    : INDIGO_NONSTOP_PORTAL_CORRECTIONS_INR.__default;

  return portalBase + correctionInr;
}

// 2026-07-24: live-audited Air India's FlightAPI carrier-direct price the
// same way as Akasa/IndiGo above: 5 non-stop flights, 5 different routes
// (BOM-DEL, BLR-DEL, DEL-BOM, BOM-BLR, DEL-BLR), dates 14-18 Aug 2026,
// prices Rs.6,222-10,100. All 5 portals except Yatra matched FlightAPI's
// Air India price exactly - Yatra was exactly Rs.15 cheaper on all 5. This
// is deliberately scoped to non-stop only (the only condition tested);
// revisit if a future audit finds connecting Air India flights behave
// differently.
const AIRINDIA_NONSTOP_PORTAL_CORRECTIONS_INR = {
  Yatra: -15
  // No __default entry - every other portal matched FlightAPI's carrier
  // price exactly, so they get no correction.
};

function applyAirIndiaNonstopPortalCorrection(portalBase, flight, portal) {
  const airline = normalizeForMatch(flight?.airlineName);
  // Air India Express is a separate carrier (code IX) and contains "air
  // india" as a substring - explicitly excluded so this never misfires on it.
  if (airline.includes("air india express")) return portalBase;
  if (!airline.includes("air india")) return portalBase;
  if (Number(flight?.stops) !== 0) return portalBase;

  const correctionInr = Object.prototype.hasOwnProperty.call(AIRINDIA_NONSTOP_PORTAL_CORRECTIONS_INR, portal)
    ? AIRINDIA_NONSTOP_PORTAL_CORRECTIONS_INR[portal]
    : 0;

  return portalBase + correctionInr;
}

// 2026-07-24/25: regional carriers (Star Air and Alliance Air confirmed,
// Fly91/IndiaOne Air likely a different problem - see
// FLIGHTAPI_CARRIER_PRICING_AUDIT_2026-07.md) never expose a carrier-direct
// price via FlightAPI at all - only third-party resellers (Kiwi.com,
// Trip.com, Kissandfly, BudgetAir, eDreams). The strict "no carrier price =
// drop the flight" rule elsewhere in mapFlightsFromFlightAPI means these
// carriers were invisible on SkyDeal entirely, even though real, bookable
// flights and market prices exist for them.
//
// IMPORTANT MATH NOTE: the "gap %" measured in each audit below is
// (source - real) / real, i.e. how much the source overshoots the real
// price. The discount applied here is (source - real) / source, i.e. how
// much to cut OFF the source. These are NOT the same percentage for the
// same flight (discount is always the smaller number) - e.g. a source
// that's 16.2% above real only needs a 13.96% discount to reach it exactly
// (5294 * (1 - 0.1396) = 4555), NOT 16.2% (which would overshoot PAST real
// and undershoot the discount ceiling). Each carrier's chosen discount
// below is calibrated off this break-even math on its OWN tightest/lowest-
// gap flight, then given a couple more points of safety margin - never off
// the raw average gap.
//
// Live-audited Star Air: 5 flights, 3 routes (BLR-NDC, BLR-VDY, BLR-GBI),
// against real MMT prices. The CHEAPEST available reseller price was
// closest to the real price on all 5 (not always the same named source -
// Kiwi.com twice, Kissandfly once, Trip.com twice - so the rule is "take
// the minimum," not "trust one specific reseller"). Gap ranged 9.6%-18.1%
// above real; tightest flight's break-even discount was 8.76% (GBI:
// 4086->3728). Chose 8%, safely below that ceiling - stays at/above the
// real price on all 5 tested flights (margins Rs.31-326). A flat 10%
// would have UNDERSHOT on 2 of the 5 (by Rs.21 and Rs.51).
//
// Live-audited Alliance Air: 5 flights (4 distinct - one repeated on a
// second date, same price both times), 2 routes (BLR-HYD/HYD-BLR, DEL-JAI)
// against real MMT prices. Same "take the minimum" rule holds - BudgetAir
// won once, Trip.com won on the other 4. Explicitly re-checked live
// whether Trip.com alone could be trusted as a simpler single-source rule
// (it was closest on 4/5) - re-queried the one flight where it wasn't
// (9I-517 BLR-HYD) and confirmed LIVE, with a fresh 17-minute-old quote,
// that Trip.com was still genuinely ~2.75x the real price (Rs.11,295 vs
// Rs.4,109) - not stale data, a real outlier. So "minimum of whatever
// sources exist" stays the rule; a Trip.com-only shortcut would have
// badly failed on this flight. Gap ranged 16.2%-26.8% above real; tightest
// flight's break-even discount was 13.96% (HYD-BLR 9I-519: 5294->4555).
// Chose 12%, safely below that ceiling.
//
// Both are explicitly rough estimates from small samples, not confirmed
// exact matches like the flat/portal corrections above - flagged via
// priceSource: "estimated_min_reseller" wherever used, so they stay
// distinguishable from a verified carrier price. Revisit with more data
// before extending to any other carrier - each needs its own evidence,
// this is NOT assumed to generalize.
const NO_CARRIER_PRICE_ESTIMATE_DISCOUNT = {
  "star air": 0.08,
  "alliance air": 0.12
};

function estimateNoCarrierPriceFallback(airlineName, nonCarrierAmounts) {
  const normalized = normalizeForMatch(airlineName);

  for (const [alias, discount] of Object.entries(NO_CARRIER_PRICE_ESTIMATE_DISCOUNT)) {
    if (!normalized.includes(alias)) continue;
    if (!Array.isArray(nonCarrierAmounts) || nonCarrierAmounts.length === 0) return null;

    const minAmount = Math.min(...nonCarrierAmounts);
    return Math.round(minAmount * (1 - discount));
  }

  return null;
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

function pricingOptionLooksLikeCarrierSource(opt, aliases, agentById) {
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

  const allAgentText = Array.from(agentIds)
    .map((id) => getAgentText(id, agentById))
    .join(" ");

  return aliases.some((alias) => {
    if (!alias) return false;
    return allAgentText.includes(alias);
  });
}

// A connecting itinerary's leg can be made of segments operated/marketed by
// DIFFERENT carriers (a genuine interline connection, e.g. Air India ->
// Cathay Pacific on one ticket) - not just repeats of one carrier. Returns
// every distinct carrier across the leg's segments, in flight order.
function getLegCarriers(leg, segmentById, carrierById) {
  const segIds = Array.isArray(leg?.segment_ids) ? leg.segment_ids : [];
  const seen = new Set();
  const result = [];

  for (const segId of segIds) {
    const seg = segmentById[segId];
    const carrierId = seg?.marketing_carrier_id;
    if (carrierId == null) continue;

    const key = String(carrierId);
    if (seen.has(key)) continue;
    seen.add(key);

    result.push({ carrierId: key, carrier: carrierById[key] || null });
  }

  return result;
}

// Aliases (name + code + known-shorthand variants) across EVERY carrier
// involved in a leg, not just the first segment's. This is what lets a
// pricing option sold directly by a LATER segment's carrier (e.g. Cathay
// Pacific selling an Air India + Cathay Pacific itinerary) still count as a
// trusted carrier-direct price - the same trust tier SkyDeal already
// applies to single-carrier itineraries, just checked against the right
// carrier.
function getMultiCarrierAliases(legCarriers) {
  const aliases = new Set();

  for (const { carrier } of legCarriers) {
    const name = carrier?.name || carrier?.display_name || carrier?.code || "";
    getCarrierAliases(name, carrier).forEach((a) => aliases.add(a));
  }

  return Array.from(aliases);
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
// FlightAPI's own places array is a walkable hierarchy - Airport ->
// (parent_id) -> City -> (parent_id) -> Country, each entry typed
// ("Airport"/"City"/"Country") with the Country entry's alt_id being a
// real ISO country code (e.g. "IN", "SA", "BH") - verified live
// (2026-08-03) against a raw response. Used instead of a hardcoded
// per-airport allowlist for the domestic foreign-layover filter below,
// since that kind of list inevitably misses newly-opened airports (see
// the HSR/DBR note on INDIAN_IATA_AIRPORTS above, found via this exact
// investigation) - this resolves from the API's own authoritative data
// instead, so it can never go stale the same way.
function resolveAirportCountryCode(place, placeById) {
  let current = place;
  const seen = new Set();
  while (current && current.parent_id != null && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = placeById[current.parent_id];
    if (!parent) break;
    if (parent.type === "Country") return parent.alt_id || null;
    current = parent;
  }
  return null;
}

// A leg's stop_ids/segment_ids let us tell the user WHERE a connection is
// and how long the layover is (FlightAPI has no terminal-change data
// anywhere in its schema, so we only surface what we can actually verify -
// airport/city and duration, not a terminal claim).
function getLegLayovers(leg, segmentById, placeById) {
  const segIds = Array.isArray(leg?.segment_ids) ? leg.segment_ids : [];
  const stopIdGroups = Array.isArray(leg?.stop_ids) ? leg.stop_ids : [];
  const layovers = [];

  for (let i = 0; i < segIds.length - 1; i++) {
    const segA = segmentById[segIds[i]];
    const segB = segmentById[segIds[i + 1]];

    const stopPlaceIds = stopIdGroups[i];
    const placeId = Array.isArray(stopPlaceIds) ? stopPlaceIds[0] : stopPlaceIds;
    const place = placeId != null ? placeById[placeId] : null;

    // FlightAPI's places array links an airport to its parent CITY entity
    // (place.parent_id). Most airports' own name already reads as a city
    // name (e.g. "Mumbai"), but some don't (e.g. "Noida International" ->
    // parent city is actually named "Jewar" in this data) - resolving the
    // real parent city is more correct than guessing/trimming the airport
    // name string.
    const parentPlace = place?.parent_id != null ? placeById[place.parent_id] : null;
    const cityName = (parentPlace?.type === "City" ? parentPlace?.name : null) || place?.name || null;

    let durationMinutes = null;
    if (segA?.arrival && segB?.departure) {
      const ms = new Date(segB.departure).getTime() - new Date(segA.arrival).getTime();
      if (Number.isFinite(ms) && ms >= 0) durationMinutes = Math.round(ms / 60000);
    }

    layovers.push({
      airportCode: place?.display_code || place?.alt_id || null,
      airportName: place?.name || null,
      cityName,
      durationMinutes,
      countryCode: place ? resolveAirportCountryCode(place, placeById) : null,
    });
  }

  return layovers;
}

function mapFlightsFromFlightAPI(raw) {
  const itineraries = Array.isArray(raw?.itineraries) ? raw.itineraries : [];
  const legs = Array.isArray(raw?.legs) ? raw.legs : [];
  const carriers = Array.isArray(raw?.carriers) ? raw.carriers : [];
  const segments = Array.isArray(raw?.segments) ? raw.segments : [];
  const agents = Array.isArray(raw?.agents) ? raw.agents : [];
  const places = Array.isArray(raw?.places) ? raw.places : [];

  const legById = Object.fromEntries(legs.map((l) => [l.id, l]));
  const carrierById = Object.fromEntries(carriers.map((c) => [String(c.id), c]));
  const segmentById = Object.fromEntries(segments.map((s) => [s.id, s]));
  const agentById = Object.fromEntries(agents.map((a) => [String(a.id), a]));
  const placeById = Object.fromEntries(places.map((p) => [p.id, p]));

  const flights = [];

  for (const it of itineraries) {
    const legId = Array.isArray(it.leg_ids) ? it.leg_ids[0] : null;
    const leg = legId ? legById[legId] : null;

    // A leg can be a genuine interline connection - segments operated/
    // marketed by DIFFERENT carriers on one itinerary. legCarriers holds
    // every distinct carrier across the leg's segments, in flight order.
    const legCarriers = getLegCarriers(leg, segmentById, carrierById);
    const primaryCarrier = legCarriers[0]?.carrier || null;

    // airlineName stays the PRIMARY (first-segment) carrier only, unchanged
    // from before - this is what offer-matching (getOfferKindForFlight /
    // offerTargetsThisAirline) already relies on, and is not being touched
    // here. displayAirlineName/allAirlineNames below are additive fields
    // purely for showing the true multi-carrier itinerary to users.
    const airlineName = primaryCarrier?.name || primaryCarrier?.display_name || primaryCarrier?.code || "-";

    const allAirlineNames = Array.from(new Set(
      legCarriers
        .map(({ carrier: c }) => c?.name || c?.display_name || c?.code)
        .filter(Boolean)
    ));
    const isMixedCarrierItinerary = allAirlineNames.length > 1;
    const displayAirlineName = isMixedCarrierItinerary ? allAirlineNames.join(" + ") : airlineName;

    const pricingOptions = Array.isArray(it.pricing_options) ? it.pricing_options : [];

    // Check a pricing option's agent against EVERY carrier involved in the
    // itinerary, not just the first segment's. This recovers genuine
    // interline fares sold directly by a LATER segment's carrier (e.g.
    // Cathay Pacific selling an Air India + Cathay Pacific itinerary) -
    // still a carrier-direct price, just previously missed because only
    // the first carrier's aliases were ever checked. Itineraries with NO
    // carrier-direct price at all (only global OTA/meta-agents like
    // eDreams/BYOjet) are still correctly dropped below - this does not
    // relax that rule.
    const carrierAliases = getMultiCarrierAliases(legCarriers);
    const carrierPricingOptions = pricingOptions.filter((opt) =>
      pricingOptionLooksLikeCarrierSource(opt, carrierAliases, agentById)
    );

    const carrierAmounts = carrierPricingOptions
      .map(getPricingOptionAmount)
      .filter((n) => typeof n === "number" && Number.isFinite(n) && n > 0);

    let carrierAmountRaw;
    let carrierAmount;
    let priceSource;

    if (carrierAmounts.length > 0) {
      // Correct known carrier-specific gaps between FlightAPI's reported
      // carrier-direct price and the real, live OTA price - see
      // CARRIER_FARE_CORRECTIONS_INR above for the evidence. A no-op for
      // every carrier not in that list (the overwhelming majority).
      carrierAmountRaw = Math.min(...carrierAmounts);
      carrierAmount = applyCarrierFareCorrection(carrierAmountRaw, airlineName);
      priceSource = "carrier_airline";
    } else {
      // Strict SkyDeal rule: if FlightAPI does not expose the
      // carrier-airline price, do not use OTA/cheapest price - EXCEPT for
      // the specific regional carriers evidenced in
      // NO_CARRIER_PRICE_ESTIMATE_DISCOUNT above, where no carrier price
      // is ever available at all and the alternative is showing the
      // flight not at all.
      const nonCarrierAmounts = pricingOptions
        .map(getPricingOptionAmount)
        .filter((n) => typeof n === "number" && Number.isFinite(n) && n > 0);

      const estimate = estimateNoCarrierPriceFallback(airlineName, nonCarrierAmounts);
      if (estimate == null) {
        continue;
      }

      carrierAmountRaw = estimate;
      carrierAmount = estimate;
      priceSource = "estimated_min_reseller";
    }

    // allFlightNumbers and segmentAirlineNames are built together, one
    // entry PER SEGMENT (not deduped) so the two stay index-aligned -
    // allAirlineNames above is deduped for the "A + B" display join, which
    // would misalign against a per-segment array whenever a carrier
    // repeats across segments (e.g. a 2-stop leg operated by the same
    // carrier on 2 of its 3 segments).
    let flightNumber = "-";
    const allFlightNumbers = [];
    const segmentAirlineNames = [];
    if (Array.isArray(leg?.segment_ids) && leg.segment_ids.length > 0) {
      for (const segId of leg.segment_ids) {
        const seg = segmentById[segId];
        const num = seg?.flight_number || seg?.marketing_flight_number;
        if (num) allFlightNumbers.push(String(num));

        const segCarrier = seg?.marketing_carrier_id != null
          ? carrierById[String(seg.marketing_carrier_id)]
          : null;
        segmentAirlineNames.push(segCarrier?.name || segCarrier?.display_name || segCarrier?.code || null);
      }
      if (allFlightNumbers.length > 0) flightNumber = allFlightNumbers[0];
    }

    const departureTime = leg?.departure || null;
    const arrivalTime = leg?.arrival || null;
    const stops = typeof leg?.stop_count === "number" ? leg.stop_count : 0;

    const layovers = getLegLayovers(leg, segmentById, placeById);

    const carrierAgentIds = Array.from(new Set(
      carrierPricingOptions.flatMap((opt) => [
        ...(Array.isArray(opt?.agent_ids) ? opt.agent_ids : []),
        ...(Array.isArray(opt?.items) ? opt.items.map((item) => item?.agent_id).filter(Boolean) : [])
      ]).map(String)
    ));

    const flight = {
      airlineName,
      displayAirlineName,
      isMixedCarrierItinerary,
      allAirlineNames,
      flightNumber,
      allFlightNumbers,
      segmentAirlineNames,
      departureTime,
      arrivalTime,
      stops,
      layovers,
      price: carrierAmount,
      priceSource,
      carrierAgentIds,
      pricingOptionCount: pricingOptions.length,
      carrierPricingOptionCount: carrierPricingOptions.length,
      ...(carrierAmount !== carrierAmountRaw ? { carrierPriceRawFromFlightApi: carrierAmountRaw } : {}),
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

// True when an offer requires a specific card/bank the user hasn't
// selected. Distinguishes "add ICICI net-banking, you already bank with
// ICICI" (same-bank, actionable) from "get a Kotak card" (a different bank
// entirely - not something you decide while comparing one flight) so
// cross-bank offers can be kept out of the compare card's info-offer list.
function offerRequiresDifferentBank(offer, selectedPaymentMethods = []) {
  if (!hasExplicitOfferPaymentMethods(offer)) return false;

  const selected = Array.isArray(selectedPaymentMethods) ? selectedPaymentMethods : [];
  if (selected.length === 0) return true;

  const offerPMs = extractOfferPaymentMethodsNoInference(offer);
  if (!Array.isArray(offerPMs) || offerPMs.length === 0) return true;

  const sameBank = offerPMs.some((pm) =>
    selected.some((sel) => {
      const offerBank = bankCanonicalFromAny(pm?.bankCanonical || pm?.bank || pm?.name || pm?.raw || "");
      const selectedBank = bankCanonicalFromAny(sel?.name || sel?.bank || "");
      return offerBank && selectedBank && offerBank === selectedBank;
    })
  );

  return !sameBank;
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

// Phase 3: evaluationDate lets timing-simulation code ask "would this
// offer be expired if evaluated on day X" using the exact same logic as
// real pricing - defaults to real "now" so every existing caller
// (all of which pass only `offer`) is unaffected.
function isOfferExpired(offer, evaluationDate = new Date()) {
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
      // IST-anchored calendar-day comparison (was previously raw
      // server-local Date math here, while booking-day weekday checks
      // were already IST-anchored - the two could disagree by up to
      // ~5.5h around IST midnight on a UTC-hosted server). Inclusive of
      // the expiry day itself, matching the original semantics.
      const expiryDay = getTimezoneDateOnly(t);
      const today = getTimezoneDateOnly(evaluationDate);

      return today.getTime() > expiryDay.getTime();
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

  const expiryDay = getTimezoneDateOnly(latest);
  const today = getTimezoneDateOnly(evaluationDate);

  return today.getTime() > expiryDay.getTime();
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
// Every distinct EMI tenure currently in play, as a Set - not just one.
// expandEmiPaymentMethods (see below) can put several tenure candidates
// for the same bank into selectedPaymentMethods simultaneously (one per
// real tenure that bank offers, since there's no explicit tenure picker),
// so anything downstream that reasons about "the" selected tenure must
// consider all of them, not just whichever happened to come first.
function getSelectedEmiTenures(selectedPaymentMethods = []) {
  const tenures = new Set();
  if (!Array.isArray(selectedPaymentMethods)) return tenures;

  for (const pm of selectedPaymentMethods) {
    const type = String(pm?.type || "").toLowerCase();
    const tenure = Number(pm?.tenureMonths || pm?.emiTenureMonths || 0);

    if (type.includes("emi") && Number.isFinite(tenure) && tenure > 0) {
      tenures.add(tenure);
    }
  }

  return tenures;
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

  const selectedTenures = getSelectedEmiTenures(selectedPaymentMethods);

  const eligibleFiltered = tiers
    .filter((t) => {
      if (!tierScopeMatchesTrip(t, isDomestic)) return false;
      if (!tierTripTypeMatchesRequest(t, tripType)) return false;
      if (!tierPassengerCountMatchesRequest(t, passengers)) return false;

      const min = Number(t?.minTransactionValue || 0);
      if (min > 0 && amount < min) return false;

      const max = Number(t?.maxTransactionValue || 0);
      if (max > 0 && amount > max) return false;

      const tierTenure = Number(t?.tenureMonths || 0);

      // A tenure-specific tier is only eligible if that exact tenure is one
      // of the ones actually being tried - expandEmiPaymentMethods can put
      // several real tenures for the same bank into selectedPaymentMethods
      // simultaneously (no explicit tenure picker), so "the selected
      // tenure" is now a set, not a single value. No tenure being tried at
      // all -> only generic (tenure-less) tiers apply, same as before.
      if (selectedTenures.size > 0) {
        if (tierTenure > 0 && !selectedTenures.has(tierTenure)) return false;
      } else {
        if (tierTenure > 0) return false;
      }

      const flat = Number(t?.flatDiscountAmount || t?.discountAmount || 0);
      const pct = Number(t?.discountPercent || 0);

      return flat > 0 || pct > 0;
    });

  // Two or more tiers can legitimately coexist for different real reasons
  // (different tenures, different price brackets) - the sort below picks
  // the best genuine one among those. But when tiers share the EXACT SAME
  // bracket (same min/max transaction value, same tenure, same scope) and
  // still disagree on the discount amount, that's not a legitimate choice
  // between real options - it's ambiguous/conflicting source data
  // (confirmed live, 2026-08-10: HDFCEMI's own DB record carries two
  // separate "INR 7,500 - INR 14,999" tiers, one worth ₹750 and one worth
  // ₹1,250, with nothing else distinguishing them - picking the larger one
  // applied a discount MMT's own checkout didn't actually honor, shown to
  // the user as "14% off" against a real ~10%). Collapsing same-bracket
  // duplicates to their minimum value first, before the normal
  // best-of-distinct-options sort runs, is the conservative choice - this
  // app's whole premise is the TRUE final price, so understating an
  // uncertain discount is a far smaller trust cost than promising one that
  // turns out wrong at checkout. Distinct, non-duplicate tiers (different
  // brackets or tenures) are completely unaffected.
  const bracketKey = (t) => [
    Number(t?.minTransactionValue || 0),
    Number(t?.maxTransactionValue || 0),
    Number(t?.tenureMonths || 0),
    String(t?.scope || "")
  ].join("|");
  const tierValue = (t) => Number(t?.flatDiscountAmount || t?.discountAmount || t?.discountPercent || 0);

  const minByBracket = new Map();
  for (const t of eligibleFiltered) {
    const key = bracketKey(t);
    const existing = minByBracket.get(key);
    if (!existing || tierValue(t) < tierValue(existing)) {
      minByBracket.set(key, t);
    }
  }

  const eligible = Array.from(minByBracket.values())
    .sort((a, b) => {
      // Best true value to the user wins first - with several tenures now
      // potentially eligible at once, this is what "try every real tenure,
      // best price wins" actually means at the tier level (not just at the
      // whole-offer level where it already worked this way).
      const aVal = Number(a?.flatDiscountAmount || a?.discountAmount || a?.maxDiscountAmount || 0);
      const bVal = Number(b?.flatDiscountAmount || b?.discountAmount || b?.maxDiscountAmount || 0);
      if (aVal !== bVal) return bVal - aVal;

      // Tie-break for equal-value ties (or percent-only tiers this rough
      // value estimate can't distinguish): higher applicable slab first,
      // then exact tenure over generic.
      const aMin = Number(a?.minTransactionValue || 0);
      const bMin = Number(b?.minTransactionValue || 0);
      if (aMin !== bMin) return bMin - aMin;

      const aTenure = Number(a?.tenureMonths || 0);
      const bTenure = Number(b?.tenureMonths || 0);

      if (selectedTenures.size > 0) {
        const aExact = selectedTenures.has(aTenure) ? 1 : 0;
        const bExact = selectedTenures.has(bTenure) ? 1 : 0;
        if (aExact !== bExact) return bExact - aExact;
      } else {
        const aGeneric = aTenure === 0 ? 1 : 0;
        const bGeneric = bTenure === 0 ? 1 : 0;
        if (aGeneric !== bGeneric) return bGeneric - aGeneric;
      }

      return 0;
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

// Single source of truth for card-family/product-name canonicalization,
// shared by the SELECTION side (normalizeSelectedPM, reading the user's own
// cardFamily/cardVariant pick) and the OFFER side
// (extractOfferCardFamilyRestrictions, text-mining an offer's own
// title/rawDiscount/terms/structured eligiblePaymentMethods). These two used
// to be independently hand-maintained lists and had already drifted - e.g.
// "Select" (IDFC First's card tier) existed only on the selection side, so
// an IDFC First Select-exclusive offer could never be recognized as
// family-restricted and would incorrectly apply to any IDFC First card
// (extractOfferCardFamilyRestrictions had no rule for it at all).
//
// Each rule's `terms` are ALL required (AND, any order, anywhere in the
// blob) rather than one literal phrase - this is what fixes the
// AMAZON_PAY_ICICI matching bug: real scraped offer titles read "ICICI
// Bank Amazon Pay Credit Card...", not "Amazon Pay ICICI" in that order, so
// a rule requiring that exact contiguous phrase silently failed on real
// data (verified 2026-08-04 against a live offer title). Requiring "amazon
// pay" and "icici" as independent terms - or just "amazon pay" alone,
// since it's an ICICI-exclusive product in India - matches regardless of
// word order.
//
// Tier names that are common English words shared across many banks' base
// products (Platinum, Gold, Signature, Select, Wealth, Premier) are scoped
// to also require their own bank's name in the blob, so e.g. IDFC First's
// "Select" tier doesn't accidentally match unrelated boilerplate text, or
// a different bank's own "Select"/"Premier" tier.
const CARD_FAMILY_RULES = [
  { code: "FLIPKART_AXIS", terms: [/\bflipkart\b/, /\baxis\b/] },
  { code: "AXIS_ATLAS", terms: [/\baxis\b/, /\batlas\b/] },
  { code: "AXIS_ACE", terms: [/\baxis\b/, /\bace\b/] },
  { code: "AXIS_NEO", terms: [/\baxis\b/, /\bneo\b/] },
  { code: "AXIS_REWARDS", terms: [/\baxis\b/, /\brewards\b/] },
  { code: "AXIS_VISTARA", terms: [/\baxis\b/, /\bvistara\b/] },
  { code: "AXIS_MAGNUS", terms: [/\baxis\b/, /\bmagnus\b/] },
  { code: "AXIS_RESERVE", terms: [/\baxis\b/, /\breserve\b/] },
  { code: "AXIS_SELECT", terms: [/\baxis\b/, /\bselect\b/] },
  { code: "AXIS_MYZONE", terms: [/\baxis\b/, /\bmyzone\b/] },
  { code: "AMAZON_PAY_ICICI", terms: [/\bamazon\s*pay\b/] },
  { code: "MMT_ICICI", terms: [/\b(mmt|makemytrip)\b/, /\bicici\b/] },
  { code: "TATA_NEU", terms: [/\btata\s*neu\b/] },
  { code: "SWIGGY_HDFC", terms: [/\bswiggy\b/, /\bhdfc\b/] },
  { code: "DINERS", terms: [/\bdiners\b/] },
  { code: "INFINIA", terms: [/\binfinia\b/] },
  { code: "REGALIA_GOLD", terms: [/\bregalia\b/, /\bgold\b/] },
  { code: "REGALIA", terms: [/\bregalia\b/] },
  { code: "MILLENNIA", terms: [/\bmillennia\b/] },
  { code: "HDFC_MONEYBACK_PLUS", terms: [/\bhdfc\b/, /\bmoneyback\b/] },
  { code: "HDFC_FREEDOM", terms: [/\bhdfc\b/, /\bfreedom\b/] },
  { code: "MARRIOTT_HDFC", terms: [/\bmarriott\b/] },
  { code: "INDIANOIL_HDFC", terms: [/\bindianoil\b/, /\bhdfc\b/] },
  { code: "INDIGO_HDFC", terms: [/\b6e\s*rewards\b/] },
  { code: "SBI_CASHBACK", terms: [/\bsbi\b/, /\bcashback\b/] },
  { code: "SIMPLYCLICK", terms: [/\bsimplyclick\b/] },
  { code: "SIMPLYSAVE", terms: [/\bsimplysave\b/] },
  { code: "SBI_AURUM", terms: [/\bsbi\b/, /\baurum\b/] },
  { code: "SBI_IRCTC", terms: [/\birctc\b/, /\bsbi\b/] },
  { code: "SBI_BPCL", terms: [/\bbpcl\b/, /\bsbi\b/] },
  { code: "CORAL", terms: [/\bcoral\b/] },
  { code: "RUBYX", terms: [/\brubyx\b/] },
  { code: "SAPPHIRO", terms: [/\bsapphiro\b/] },
  { code: "EMERALDE", terms: [/\bemeralde\b/] },
  { code: "HSBC_TRAVELONE", terms: [/\btravelone\b/] },
  { code: "HSBC_CASHBACK", terms: [/\bhsbc\b/, /\bcashback\b/] },
  { code: "HSBC_PREMIER", terms: [/\bhsbc\b/, /\bpremier\b/] },
  { code: "MYNTRA_KOTAK", terms: [/\bmyntra\b/, /\bkotak\b/] },
  { code: "KOTAK_WHITE", terms: [/\bkotak\b/, /\bwhite\b/] },
  { code: "KOTAK_LEAGUE", terms: [/\bkotak\b/, /\bleague\b/] },
  { code: "KOTAK_ZEN", terms: [/\bkotak\b/, /\bzen\b/] },
  { code: "KOTAK_811", terms: [/\bkotak\b/, /\b811\b/] },
  { code: "KOTAK_ROYALE", terms: [/\bkotak\b/, /\broyale\b/] },
  { code: "AMEX_MEMBERSHIP_REWARDS", terms: [/\bmembership\s*rewards\b/] },
  { code: "AMEX_SMARTEARN", terms: [/\bsmartearn\b/] },
  { code: "AMEX_PLATINUM_TRAVEL", terms: [/\bplatinum\s*travel\b/] },
  { code: "AMEX_PLATINUM_RESERVE", terms: [/\bplatinum\s*reserve\b/] },
  { code: "INDUSIND_LEGEND", terms: [/\bindusind\b/, /\blegend\b/] },
  { code: "INDUSIND_TIGER", terms: [/\bindusind\b/, /\btiger\b/] },
  { code: "INDUSIND_PINNACLE", terms: [/\bindusind\b/, /\bpinnacle\b/] },
  { code: "INDUSIND_AVIOS", terms: [/\bindusind\b/, /\bavios\b/] },
  { code: "INDUSIND_EAZYDINER", terms: [/\bindusind\b/, /\beazydiner\b/] },
  { code: "IDFC_SELECT", terms: [/\bidfc\b/, /\bselect\b/] },
  { code: "IDFC_WEALTH", terms: [/\bidfc\b/, /\bwealth\b/] },
  { code: "IDFC_MILLENNIA", terms: [/\bidfc\b/, /\bmillennia\b/] },
  { code: "IDFC_MAYURA", terms: [/\bidfc\b/, /\bmayura\b/] },
  { code: "AU_ALTURA", terms: [/\baltura\b/] },
  { code: "AU_ZENITH", terms: [/\bzenith\b/] },
  { code: "AU_VETTA", terms: [/\bvetta\b/] },
  { code: "YES_PROSPERITY", terms: [/\bprosperity\b/] },
  { code: "YES_MARQUEE", terms: [/\byes\s*bank\b/, /\bmarquee\b/] },
  { code: "YES_FIRST_PREFERRED", terms: [/\byes\s*bank\b/, /\bfirst\s*preferred\b/] },
  { code: "YES_PRIVATE", terms: [/\byes\s*bank\b/, /\bprivate\b/] },
  { code: "SCAPIA_FEDERAL", terms: [/\bscapia\b/] },
  { code: "FEDERAL_IMPERIO", terms: [/\bfederal\b/, /\bimperio\b/] },
  { code: "FEDERAL_CELESTA", terms: [/\bfederal\b/, /\bcelesta\b/] },
  { code: "BOB_ETERNA", terms: [/\b(bank\s*of\s*baroda|bobcard|bob)\b/, /\beterna\b/] },
  { code: "BOB_PREMIER", terms: [/\b(bank\s*of\s*baroda|bobcard|bob)\b/, /\bpremier\b/] },
  { code: "BOB_SELECT", terms: [/\b(bank\s*of\s*baroda|bobcard|bob)\b/, /\bselect\b/] },
  { code: "ONECARD", terms: [/\bonecard\b/] },
  { code: "PNB_LUXURA", terms: [/\bluxura\b/] },
  { code: "SC_EASEMYTRIP", terms: [/\beasemytrip\b/, /\b(standard\s*chartered|stanchart|scb)\b/] },
  { code: "BUSINESS_PLATINUM", terms: [/\bbusiness\s*platinum\b/] },
  { code: "PLATINUM", terms: [/\bplatinum\b/] },
  { code: "SIGNATURE", terms: [/\bsignature\b/] },
  { code: "GOLD", terms: [/\bgold\b/] },
];

// Selection side: a user's own card can only be one family at a time, so
// return the first matching rule. Order matters - specific/unique product
// names are listed above the generic shared-tier fallbacks (Platinum,
// Signature, Gold) so those never shadow a more specific match.
function canonicalizeCardFamily(text) {
  // Hyphens get silently dropped (not spaced) by normalizeText's punctuation
  // strip, which would merge a hyphenated name like "MMT-ICICI" into one
  // unmatchable token "mmticici" - replace with a space first so each half
  // stays a separate word for the \b-bounded terms below.
  const blob = normalizeText(String(text || "").replace(/-/g, " "));
  if (!blob) return null;
  for (const rule of CARD_FAMILY_RULES) {
    if (rule.terms.every((re) => re.test(blob))) return rule.code;
  }
  return null;
}

// Offer side: an offer's eligibility text could in principle mention more
// than one family (rare in practice), so collect every match rather than
// stopping at the first.
function canonicalizeAllCardFamilies(text) {
  const blob = normalizeText(String(text || "").replace(/-/g, " "));
  if (!blob) return [];
  const codes = [];
  for (const rule of CARD_FAMILY_RULES) {
    if (rule.terms.every((re) => re.test(blob))) codes.push(rule.code);
  }
  return codes;
}

function normalizeSelectedPM(pm) {
  const typeRaw = String(pm?.type || "").trim();
  const t = typeRaw.toLowerCase().replace(/\s+/g, "");

  const typeNorm =
    /emi/.test(t) ? "EMI" :
    /credit/.test(t) ? "CREDIT_CARD" :
    /debit/.test(t) ? "DEBIT_CARD" :
    /netbank/.test(t) || /netbanking/.test(t) ? "NET_BANKING" :
    /upi/.test(t) ? "UPI" :
    /wallet/.test(t) ? "WALLET" :
    null;

  // For a UPI selection, the app identity lives in pm.provider, not
  // pm.name - buildSelectedPaymentMethod() (skydeal-frontend/script.js)
  // always sets name to the literal string "UPI" and puts the real app
  // name ("MobiKwik", "Google Pay", etc) in provider. Falling back to
  // pm.name/pm.bank here meant every UPI selection canonicalized to the
  // same generic "UPI" bank identity regardless of which app was picked,
  // so a bank/app-restricted UPI offer (e.g. MobiKwik's MBKUPI) could
  // never match no matter what the user selected (QC-caught, 2026-08-11).
  // Every other type keeps reading pm.name/pm.bank exactly as before.
  const nameRaw = (typeNorm === "UPI" && pm?.provider)
    ? String(pm.provider).trim()
    : String(pm?.name || pm?.bank || "").trim();

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
  // Include the selected bank name (nameRaw) in the blob so bank-scoped
  // generic-tier rules (e.g. IDFC_SELECT, HSBC_PREMIER) can match even
  // though the picker's own cardFamily string is just "Select"/"Premier"
  // without repeating the bank name.
  const cardFamilyCanonical = canonicalizeCardFamily(`${nameRaw} ${cardFamilyRaw}`);
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
  // pm?.bank/pm?.cardVariant are the scraper's own structured fields when
  // present (cleaner and more reliable than mining title/rawDiscount text) -
  // folding them into the blob lets bank-scoped generic-tier rules (e.g.
  // IDFC_SELECT) match even when the offer's freeform text never states
  // the bank name right next to the tier word.
  //
  // Note: a bare "select cards" phrase (e.g. "Applicable to select AU Small
  // Finance Bank credit cards") means "eligible cards", not IDFC's "Select"
  // product - IDFC_SELECT's rule requires "idfc" in the same blob, so this
  // kind of unrelated-bank boilerplate can't false-positive it.
  const blob = `${pm?.bank || ""} ${pm?.cardVariant || ""} ${pm?.raw || ""} ${pm?.conditions || ""} ${offer?.title || ""} ${offer?.rawDiscount || ""} ${offer?.offerSummary || ""} ${offer?.rawText || ""} ${offer?.terms?.raw || offer?.terms || ""}`;

  return canonicalizeAllCardFamilies(blob);
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

const PAYMENT_TYPE_DISPLAY_LABEL = {
  emi: "EMI",
  netbanking: "Net Banking",
  creditcard: "Credit Card",
  debitcard: "Debit Card",
  upi: "UPI",
  wallet: "Wallet",
};

// Same matching as getMatchedSelectedPaymentLabel, but returns the matched
// selected-method's own clean {name, type} instead of a pre-joined string -
// needed because a bank can be selected as MULTIPLE variants at once (e.g.
// "ICICI Bank" as both Credit Card and EMI), and only this offer-vs-offerPM
// match tells us which variant actually won, not just which name matches.
function getMatchedSelectedPaymentMethod(offer, selectedPaymentMethods) {
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
      return { name: match.rawName, type: PAYMENT_TYPE_DISPLAY_LABEL[match.type] || match.type };
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

// Cached for the same reason as getDateOnlyFormatter above - constructing
// a fresh Intl.DateTimeFormat per call is expensive and this is now
// called thousands of times per request by Phase 3's date scan.
const BOOKING_DAY_NAME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  timeZone: APP_TIMEZONE
});

function getBookingDayName(date = new Date()) {
  return BOOKING_DAY_NAME_FORMATTER.format(date);
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

  // Prefer the structured day-of-week restriction the scrapers already produce
  // (e.g. dayOfWeekRestrictions: ["Monday"] = valid ONLY on those days). This is
  // authoritative and avoids depending on the day word surviving in the free-text
  // summary — which MMT strips, silently dropping real restrictions and making
  // offers over-show (FLYMONEMI/FLYMON/MMTBOBEMI/SBIDC/MMTAUDC were showing every day).
  const structuredDays = (
    Array.isArray(offer?.dayOfWeekRestrictions) ? offer.dayOfWeekRestrictions :
    Array.isArray(offer?.parsedFields?.dayOfWeekRestrictions) ? offer.parsedFields.dayOfWeekRestrictions :
    []
  ).map(normalizeWeekdayToken).filter(Boolean);
  if (structuredDays.length > 0) {
    return rememberBookingDayRule(offer, {
      mode: "include",
      days: structuredDays,
      source: "dayOfWeekRestrictions"
    });
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
  requestCache = null,
  // Phase 3: optional hypothetical booking date (Date object), mirrors
  // applyOffersToFlight's own evaluationBookingDate - defaults to real
  // "now" for every existing caller. Must also be part of the eligibility
  // memo key below (see pricingCandidateKey upstream for the same
  // "today result must never be served for a simulated day" hazard).
  evaluationBookingDate = null,
}) {
  if (!offer) return { ok: false, reasons: ["NO_OFFER"] };
  // --- Fare-independent eligibility gauntlet -------------------------------
  // These checks depend only on (offer, portal, isDomestic, cabin, allOffers),
  // all constant across the flights in a single search, so re-running them per
  // flight (~1,320x) is pure waste. When requestCache.perfEligibilityMemo is on,
  // memoize the exact verdict per (offer, portal) — a rejection object, or null
  // for "passed" — preserving identical behavior (including any thrown-check
  // path, since the first real evaluation is what gets cached). Gated by a
  // request flag so it is a strict no-op until explicitly enabled/verified.
  const __frontMemo =
    requestCache && requestCache.perfEligibilityMemo
      ? requestCache.frontEligibilityMemo
      : null;

  // evaluationBookingDate is part of the memo key for the same reason
  // pricingCandidateKey upstream includes it - a real "today" verdict must
  // never be served for a simulated "tomorrow" evaluation sharing the same
  // requestCache, and vice versa.
  const __frontMemoKey = `${portal}|${evaluationBookingDate ? evaluationBookingDate.toISOString().slice(0, 10) : "now"}`;

  let __frontResult;
  if (__frontMemo) {
    const __perOffer = __frontMemo.get(offer);
    if (__perOffer && __perOffer.has(__frontMemoKey)) {
      __frontResult = __perOffer.get(__frontMemoKey);
    }
  }

  if (__frontResult === undefined) {
    __frontResult = (() => {
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

      if (isOfferExpired(offer, evaluationBookingDate || undefined)) return { ok: false, reasons: ["EXPIRED"] };

      const bookingDayCheck = offerMatchesBookingDay(offer, evaluationBookingDate || undefined);
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

      return null;
    })();

    if (__frontMemo) {
      let __perOffer = __frontMemo.get(offer);
      if (!__perOffer) {
        __perOffer = new Map();
        __frontMemo.set(offer, __perOffer);
      }
      __perOffer.set(__frontMemoKey, __frontResult);
    }
  }

  if (__frontResult) return __frontResult;
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
  const selectedTenures = getSelectedEmiTenures(selectedPaymentMethods);

  // If user did not select EMI tenure, do not block info offers.
  if (selectedTenures.size === 0) return true;

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
      return selectedTenures.has(Number(o.tenureMonths));
    }

    if (Array.isArray(o.allowedTenures) && o.allowedTenures.length > 0) {
      return o.allowedTenures.some((t) => selectedTenures.has(Number(t)));
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
  // Phase 3: same evaluationBookingDate override as evaluateOfferForFlight -
  // without this, the "use this card to unlock" hint bubbles would keep
  // reflecting today's day-of-week eligibility during a simulated "what if
  // a different day" reprice, even after the actual price calculation was
  // fixed to respect it.
  evaluationBookingDate = null,
}) {
  if (!offer) return false;
  if (!isFlightOffer(offer)) return false;
  if (isHotelOnlyOffer(offer)) return false;
  if (isOfferExpired(offer, evaluationBookingDate || undefined)) return false;

  const bookingDayCheck = offerMatchesBookingDay(offer, evaluationBookingDate || undefined);
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
  limit = 5,
  evaluationBookingDate = null
) {
   
 const sel = Array.isArray(selectedPaymentMethods) ? selectedPaymentMethods : [];

  const info = [];
  const seen = new Set();

    for (const offer of offers) {
      // 🔥 REMOVE JUNK OFFERS HERE (MAIN FIX)
if (isJunkInfoOffer(offer)) continue;
       if (!isFlightOffer(offer)) continue;
if (isHotelOnlyOffer(offer)) continue;
if (isOfferExpired(offer, evaluationBookingDate || undefined)) continue;

const bookingDayCheck = offerMatchesBookingDay(offer, evaluationBookingDate || undefined);
if (!bookingDayCheck.ok) continue;

if (!offerAppliesToPortal(offer, portal)) continue;
if (isSuspiciousGenericOffer(offer, offers)) continue;
if (!offerMatchesSelectedEmiTenureForInfo(offer, selectedPaymentMethods)) continue;
if (offerRequiresDifferentBank(offer, selectedPaymentMethods)) continue;

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
  evaluationBookingDate,
});

const showReferenceInfo = shouldShowAsReferenceInfoOffer({
  offer,
  portal,
  selectedPaymentMethods,
  cabin,
  isDomestic,
  appliedCouponCode,
  evaluationBookingDate,
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
  !isOfferExpired(offer, evaluationBookingDate || undefined) &&
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
  genericDisplayContext = null,
  // Phase 3: optional hypothetical booking date (Date object) for "what
  // if this were booked on day X" timing simulation. Defaults to real
  // "now" for every existing caller - behavior is unchanged unless a
  // caller explicitly passes this.
  evaluationBookingDate = null
) {
  const base = typeof flight.price === "number" ? flight.price : 0;

  if (pricingTiming) {
    pricingTiming.flightsPriced = (pricingTiming.flightsPriced || 0) + 1;
  }
    

    const portalPrices = OTAS.map((portal) => {
    if (pricingTiming) {
      pricingTiming.portalRowsPriced = (pricingTiming.portalRowsPriced || 0) + 1;
    }

    const portalBaseAfterIndigo = applyIndigoNonstopPortalCorrection(Math.round(base), flight, portal);
    const portalBase = applyAirIndiaNonstopPortalCorrection(portalBaseAfterIndigo, flight, portal);

    // FlightAPI/search result price is already the booking-level price for the requested passenger count.
    // Do not multiply by passengers again for min-transaction eligibility, or high-minimum offers
    // such as MMTONECARDINTEMI can incorrectly apply to multi-passenger bookings.
    const eligibilityAmount = portalBase;

  const pricingCandidateCache = requestCache?.pricingCandidatesByKey || null;
  // evaluationBookingDate is part of the key: the static filter's
  // expiry/booking-day checks below depend on it, so a "today" result
  // must never be served for a simulated "tomorrow" evaluation and vice
  // versa, even when both share one requestCache within a request.
  const pricingCandidateKey = JSON.stringify({
    portal,
    isDomestic,
    cabin,
    tripType,
    passengers,
    evaluationBookingDate: evaluationBookingDate ? evaluationBookingDate.toISOString().slice(0, 10) : null
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
        if (isOfferExpired(offer, evaluationBookingDate || undefined)) return false;

        const bookingDayCheck = offerMatchesBookingDay(offer, evaluationBookingDate || undefined);
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
    requestCache,
    evaluationBookingDate,
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
    if (isOfferExpired(offer, evaluationBookingDate || undefined)) return false;
    if (!offerAppliesToPortal(offer, portal)) return false;
    if (isJunkInfoOffer(offer)) return false;

    // Do not show wrong-tenure EMI offers as related/info offers.
    // Example: if user selected 3-month HDFC EMI, do not show 6-month Yatra EMI in infoOffers.
    if (!offerMatchesSelectedEmiTenureForInfo(offer, selectedPaymentMethods)) return false;

    // Cross-bank offers ("get a Kotak card") aren't actionable from the
    // compare card the way a same-bank EMI/net-banking nudge is - price
    // intelligence already covers that upstream, so drop the noise here.
    if (offerRequiresDifferentBank(offer, selectedPaymentMethods)) return false;

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
    excludedInfoCode,
    // Same reasoning as pricingCandidateKey/__frontMemoKey - a real-"today"
    // info-offers list must never be served for a simulated day and vice
    // versa, even sharing one requestCache within a request.
    evaluationBookingDate: evaluationBookingDate ? evaluationBookingDate.toISOString().slice(0, 10) : null
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
      5,
      evaluationBookingDate
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

  // On an exact price tie, `<` alone would silently pick whichever portal
  // happens to come first in OTAS (an arbitrary, unrelated ordering) -
  // break ties alphabetically instead, so the winner is deterministic and
  // explainable rather than a coincidence of array position.
  const minFinalPrice = portalPrices.reduce(
    (min, p) => (min == null || p.finalPrice < min ? p.finalPrice : min),
    null
  );
  const tiedAtMin = portalPrices.filter((p) => p.finalPrice === minFinalPrice);
  const bestPortal = tiedAtMin.length > 0
    ? [...tiedAtMin].sort((a, b) => String(a.portal).localeCompare(String(b.portal)))[0]
    : null;
  const bestAppliedPortal = bestPortal?.applied ? bestPortal : null;

  // Only worth telling the user about a tie when every side of it is a
  // real, verified price - a display-only estimate that happens to match
  // isn't the same guarantee as two confirmed exact prices, so it isn't
  // surfaced as a "same price" claim.
  const tiedWithPortals = bestAppliedPortal?.isExactPricing === true
    ? tiedAtMin
        .filter((p) => p !== bestAppliedPortal && p.isExactPricing === true)
        .map((p) => p.portal)
    : [];

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
          tiedWithPortals: tiedWithPortals.length > 0 ? tiedWithPortals : null,
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
  if (u === "DBS" || u === "DBS BANK") return "DBS Bank";
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

// Optional preloadedOffers param (2026-07-15): callers that already have
// the cached offers array in scope (e.g. buildCandidatePaymentMethods,
// itself already called with `offers` in hand) can pass it directly and
// skip a completely redundant Mongo round-trip - this function used to
// always re-query the exact same collection getOffersForSearch() already
// caches with a 10-min TTL, on every single call. Callers with no offers
// in scope (e.g. GET /payment-options) still get the cached path via
// getOffersForSearch() instead of a fresh uncached query.
async function computePaymentOptionsFromOffers(preloadedOffers = null) {
  const offers = Array.isArray(preloadedOffers) ? preloadedOffers : await getOffersForSearch({});

  const buckets = {
    EMI: new Set(),
    CreditCard: new Set(),
    DebitCard: new Set(),
    NetBanking: new Set(),
    UPI: new Set(),
    Wallet: new Set(),
  };

  // bucket -> bank -> Set of offer indices (dedupes multiple pm entries
  // for the same bank within one offer, so the count reflects distinct
  // live offers, not raw payment-method rows).
  const bucketBankOfferIdx = {
    EMI: {},
    CreditCard: {},
    DebitCard: {},
    NetBanking: {},
    UPI: {},
    Wallet: {},
  };

  offers.forEach((offer, offerIdx) => {
    if (isOfferExpired(offer)) return; // offers with no stated validity are treated as ongoing, not skipped

    const pms = extractOfferPaymentMethods(offer); // includes inference if needed
    for (const pm of pms) {
      const canon = offerPmToCanonical(pm);
      const bucket = canonicalTypeToFrontendBucket(canon);
      if (!bucket) continue;

      const bank = pickDisplayBankName(pm);
      if (!bank) continue;

      buckets[bucket].add(bank);

      if (!bucketBankOfferIdx[bucket][bank]) bucketBankOfferIdx[bucket][bank] = new Set();
      bucketBankOfferIdx[bucket][bank].add(offerIdx);
    }
  });

    const creditCard = Array.from(buckets.CreditCard).sort();
  const debitCard = Array.from(buckets.DebitCard).sort();
  const netBanking = Array.from(buckets.NetBanking).sort();
  const emi = Array.from(buckets.EMI).sort();
  const upi = Array.from(buckets.UPI).sort();
  const wallet = Array.from(buckets.Wallet).sort();

  const options = {
    EMI: emi,
    "Credit Card": creditCard,
    "Debit Card": debitCard,
    "Net Banking": netBanking,
    UPI: upi,
    Wallet: wallet,
  };

  // Additive, non-breaking: how many live offers back each bank/app, so the
  // frontend can show a "N offers" signal without changing `options`' shape
  // (an array of plain name strings, per CONTRACT.md).
  const buildCounts = (bucketKey) => {
    const out = {};
    for (const [bank, idxSet] of Object.entries(bucketBankOfferIdx[bucketKey] || {})) {
      out[bank] = idxSet.size;
    }
    return out;
  };

  const offerCounts = {
    EMI: buildCounts("EMI"),
    "Credit Card": buildCounts("CreditCard"),
    "Debit Card": buildCounts("DebitCard"),
    "Net Banking": buildCounts("NetBanking"),
    UPI: buildCounts("UPI"),
    Wallet: buildCounts("Wallet"),
  };

  // Additive, non-breaking (same pattern as offerCounts above): a light
  // per-offer summary - just title + the offer's own stated discount/
  // condition text, both already on the offer document - so the frontend
  // can show *what* is being counted, not just the number. Capped at 6
  // per bank to keep the response small (matches the existing infoOffers
  // cap elsewhere). Deliberately not a live eligibility check against a
  // specific search (no route/portal/cabin context exists at this stage) -
  // it's the offer's own general conditions, e.g. "Domestic flights only,
  // Min transaction Rs.10,000", not a promise it applies to any one trip.
  const buildSummaries = (bucketKey) => {
    const out = {};
    for (const [bank, idxSet] of Object.entries(bucketBankOfferIdx[bucketKey] || {})) {
      const summaries = Array.from(idxSet)
        .slice(0, 6)
        .map((idx) => {
          const offer = offers[idx];
          return {
            title: offer?.title || null,
            rawDiscount: offer?.rawDiscount || offer?.parsedFields?.rawDiscount || null,
          };
        })
        .filter((o) => o.title || o.rawDiscount);
      if (summaries.length > 0) out[bank] = summaries;
    }
    return out;
  };

  const offerSummaries = {
    EMI: buildSummaries("EMI"),
    "Credit Card": buildSummaries("CreditCard"),
    "Debit Card": buildSummaries("DebitCard"),
    "Net Banking": buildSummaries("NetBanking"),
    UPI: buildSummaries("UPI"),
    Wallet: buildSummaries("Wallet"),
  };

  return { usedFallback: false, options, offerCounts, offerSummaries };
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
          // Surfaces the actual per-slab structure a tiered offer (e.g.
          // "up to ₹7,500 instant discount") resolves against - the
          // top-level discountPercent/flatDiscountAmount fields above are
          // null for these, so without this there was no way to see WHICH
          // slab's amount actually produced discountedPrice/actualDiscount
          // (Kapil ask, 2026-08-10: verify a displayed 14% against the
          // real offer doc).
          discountTiers: offer?.discountTiers || offer?.parsedFields?.discountTiers || null,
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

    const includeGenericDisplayOffers =
      body.includeGenericDisplayOffers === true ||
      String(body.includeGenericDisplayOffers || "").toLowerCase() === "true";

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

    // See expandEmiPaymentMethods - a tenure-less EMI selection expands into
    // one candidate per real tenure that bank offers, now that offers is
    // loaded, rather than defaulting every one to a hard-coded 3 months.
    const selectedPaymentMethods = expandEmiPaymentMethods(selectedPaymentMethodsRaw, offers);
    meta.selectedPaymentMethods = selectedPaymentMethods;

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
    tiedWithPortals: row.tiedWithPortals || null,

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
  const now = Date.now();
  const cacheAgeMs = genericDisplayContextCacheData ? now - genericDisplayContextCacheLoadedAt : null;
  const cacheValid =
    genericDisplayContextCacheData !== null &&
    cacheAgeMs !== null &&
    cacheAgeMs >= 0 &&
    cacheAgeMs < OFFERS_CACHE_TTL_MS;

  if (cacheValid) {
    meta.genericDisplayContextCache = "hit";
    meta.genericDisplayContextCacheAgeMs = cacheAgeMs;
    return genericDisplayContextCacheData;
  }

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
  meta.genericDisplayContextCache = "miss";
  meta.genericDisplayContextCacheAgeMs = 0;

  genericDisplayContextCacheData = {
    enabled: true,
    verifiedGenericCoupons,
    conservativeDisplayOffers
  };
  genericDisplayContextCacheLoadedAt = now;

  return genericDisplayContextCacheData;
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
    pricingCandidatesByKey: new Map(),
    // Per-request memo of the fare-independent eligibility gauntlet in
    // evaluateOfferForFlight. Verified price-identical vs. unmemoized output
    // (2026-07-08/09) — enabled by default. Kill switch: a request can send
    // __perfEligibilityMemo: false to instantly disable it without a redeploy.
    frontEligibilityMemo: new Map(),
    perfEligibilityMemo: body.__perfEligibilityMemo !== false
  };
  meta.perfEligibilityMemo = offerPricingRequestCache.perfEligibilityMemo;

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

    meta.ENABLE_ESTIMATED_DISCOUNTS = ENABLE_ESTIMATED_DISCOUNTS;

    const includeGenericDisplayOffers =
      body.includeGenericDisplayOffers === true ||
      String(body.includeGenericDisplayOffers || "").toLowerCase() === "true";

    meta.includeGenericDisplayOffers = includeGenericDisplayOffers;
    meta.usedFallback = false;
    meta.mongoCollection = MONGO_COL;
    meta.mongoDb = MONGODB_DB;

    // Pagination (2026-07-24): page 1 = today's original top-40 behavior.
    // page 2 requests the NEXT 40 (ranks 41-80) instead of silently
    // dropping them - see FLIGHTAPI_CARRIER_PRICING_AUDIT_2026-07.md for
    // why this matters (an entire carrier, e.g. Air India Express, could
    // rank just past 40 on a busy multi-airport route and never be shown
    // at all). Re-uses fetchOneWayTrip's existing 10-min FlightAPI cache,
    // so a page-2 request for the same search doesn't re-hit FlightAPI -
    // only the additional 40 flights get priced against offers.
    const PAGE_SIZE = SEARCH_RESULTS_PAGE_SIZE;
    const page = Math.max(1, Math.floor(Number(body.page) || 1));
    const pageStart = (page - 1) * PAGE_SIZE;
    const pageEnd = pageStart + PAGE_SIZE;
    meta.page = page;
    meta.pageSize = PAGE_SIZE;

    if (!from || !to || !outDate) {
      return res.status(400).json({
        meta: { ...meta, error: "Missing from/to/departureDate" },
        outboundFlights: [],
        returnFlights: [],
      });
    }

    // See PAGE2_PREFETCH_DEFER_CAP_MS above - give any in-flight sairro
    // decode computation priority over this speculative page-2 prefetch,
    // since both are CPU-bound and Render's single core can't run them
    // at once. paymentSuggestionsInFlight is declared further down in
    // this file but already fully initialized by the time any real
    // request reaches this handler (plain module-level const, same as
    // every other shared cache this file already uses this way).
    if (page > 1 && paymentSuggestionsInFlight.size > 0) {
      const deferStart = Date.now();
      await Promise.race([
        Promise.allSettled(Array.from(paymentSuggestionsInFlight.values())),
        new Promise((resolve) => setTimeout(resolve, PAGE2_PREFETCH_DEFER_CAP_MS))
      ]);
      timings.page2DeferredForDecodeMs = Date.now() - deferStart;
    }

    const mongoStart = Date.now();
    const offers = await getOffersForSearch(meta);
    timings.mongoOffersMs = Date.now() - mongoStart;
    meta.offersLoaded = offers.length;

    // Tenure-less EMI selections ("Show EMI offers" toggled on, no tenure
    // chosen - see expandEmiPaymentMethods) expand into one candidate per
    // real tenure that bank offers, now that offers is loaded. Moved here
    // (was previously computed before offers existed, defaulting every
    // tenure-less EMI selection to a hard-coded 3 months) per founder call
    // 2026-08-05: rather than an explicit tenure picker, just try every
    // real tenure and let the existing best-price-across-everything-
    // selected logic surface whichever one wins.
    const selectedPaymentMethods = expandEmiPaymentMethods(selectedPaymentMethodsRaw, offers);
    meta.selectedPaymentMethods = selectedPaymentMethods;

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
        // Metro-group expansion (2026-07-16): if either side belongs to a
        // multi-airport metro area (see METRO_AIRPORT_GROUPS), query every
        // airport in that group and merge - e.g. a Mumbai search becomes
        // BOM+NMI, not just BOM. Reduces to exactly the original single
        // call when neither side is grouped (fromGroup/toGroup are each
        // [code]), so an ungrouped route's cost/behavior is unchanged.
        const fromGroup = expandMetroAirportGroup(fromAirport);
        const toGroup = expandMetroAirportGroup(toAirport);
        const airportPairs = [];
        for (const f of fromGroup) {
          for (const t of toGroup) {
            airportPairs.push({ from: f, to: t });
          }
        }

        const pairResults = await Promise.allSettled(
          airportPairs.map((pair) =>
            fetchOneWayTrip({
              from: pair.from,
              to: pair.to,
              date,
              adults,
              cabin,
              currency
            })
          )
        );

        timings[flightApiTimingKey] = Date.now() - legStart;

        const triedAll = [];
        let combinedFlightsRaw = [];
        let combinedItinerariesCount = 0;
        let lastStatus = 0;
        let firstRawShape = null;

        pairResults.forEach((settled, i) => {
          const pair = airportPairs[i];

          if (settled.status !== "fulfilled") {
            triedAll.push({
              from: pair.from,
              to: pair.to,
              status: "ERROR",
              error: settled.reason?.message || String(settled.reason)
            });
            return;
          }

          const res = settled.value;
          lastStatus = res.status;
          triedAll.push(...(res.tried || []).map((t) => ({ ...t, pairFrom: pair.from, pairTo: pair.to })));

          const itinerariesCount = Array.isArray(res.data?.itineraries) ? res.data.itineraries.length : 0;
          combinedItinerariesCount += itinerariesCount;

          if (!firstRawShape) {
            firstRawShape = {
              topLevelKeys: Object.keys(res.data || {}),
              itineraries: itinerariesCount,
              legs: Array.isArray(res.data?.legs) ? res.data.legs.length : 0,
              segments: Array.isArray(res.data?.segments) ? res.data.segments.length : 0,
              carriers: Array.isArray(res.data?.carriers) ? res.data.carriers.length : 0,
              agents: Array.isArray(res.data?.agents) ? res.data.agents.length : 0,
              quotes: Array.isArray(res.data?.quotes) ? res.data.quotes.length : 0,
              results: Array.isArray(res.data?.results) ? res.data.results.length : 0,
              data: Array.isArray(res.data?.data) ? res.data.data.length : 0
            };
          }

          const pairFlights = mapFlightsFromFlightAPI(res.data);
          // Each pair's own from/to is exactly which physical airport its
          // flights use - no need to parse it back out of FlightAPI's raw
          // places data, we already know it from the query itself.
          pairFlights.forEach((f) => {
            f.departureAirportCode = pair.from;
            f.arrivalAirportCode = pair.to;
          });

          // Domestic-route sanity filter (2026-08-03, founder report): a
          // domestic (India-to-India) search should never surface an
          // itinerary that connects through a foreign city - FlightAPI's
          // underlying data can include these (a carrier selling a
          // same-day connection via its own overseas hub, for example),
          // but no domestic traveler expects or wants a layover abroad on
          // a purely domestic trip. Non-stop flights have no layovers and
          // are unaffected. A layover whose airport we can't resolve to a
          // known Indian code is treated as foreign (excluded) rather
          // than assumed domestic - if we can't confirm it's safe, don't
          // show it, matching "never show that" rather than "show it
          // unless we can prove it's foreign." Filtered here (not inside
          // mapFlightsFromFlightAPI) since "domestic" is a property of
          // THIS pair's own query (pair.from/pair.to), not of the raw
          // itinerary data itself - metro-group expansion never mixes
          // domestic and foreign airports, so pair.from/pair.to always
          // agrees with the route the user actually searched.
          const pairIsDomestic = isIndianAirportIata(pair.from) && isIndianAirportIata(pair.to);
          const domesticSafeFlights = pairIsDomestic
            ? pairFlights.filter((f) => (f.layovers || []).every((l) => l.countryCode === "IN"))
            : pairFlights;

          combinedFlightsRaw = combinedFlightsRaw.concat(domesticSafeFlights);
        });

        if (combinedFlightsRaw.length === 0 && pairResults.every((s) => s.status !== "fulfilled")) {
          // Every single pair failed outright (not just "0 flights") -
          // surface this the same way a single-pair failure used to, so
          // the existing error-handling/UI path is unaffected.
          const firstRejection = pairResults.find((s) => s.status === "rejected");
          throw firstRejection?.reason || new Error(`${directionLabel} FlightAPI search failed`);
        }

        meta[statusKey] = lastStatus;
        meta.request[triedKey] = triedAll;

        if (!isReturn && firstRawShape) {
          meta.flightApiRawShape = firstRawShape;
        }

        if (airportPairs.length > 1) {
          meta[isReturn ? "retAirportPairs" : "outAirportPairs"] = airportPairs;
        }

        const mapStart = Date.now();
        const flightsRaw = combinedFlightsRaw;
        const flightsSorted = limitAndSortFlights(flightsRaw);
        const flightsLimited = flightsSorted.slice(pageStart, pageEnd);
        timings[mapTimingKey] = Date.now() - mapStart;

        meta[rawFlightsKey] = flightsRaw.length;
        meta[returnedFlightsKey] = flightsLimited.length;
        meta[isReturn ? "retHasMore" : "outHasMore"] = flightsSorted.length > pageEnd;
        meta[carrierRuleKey] = {
          flightApiItineraries: combinedItinerariesCount,
          keptWithCarrierPrice: flightsRaw.length,
          skippedWithoutCarrierPrice: combinedItinerariesCount - flightsRaw.length
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

    // "Server-side head start" (2026-08-03): sairro decode's own
    // /payment-suggestions call always fires right after the frontend
    // renders these results, for this exact route/selection/flight list -
    // so start that computation now, server-side, instead of waiting for
    // the client round-trip. Fire-and-forget: never awaited, never allowed
    // to affect or delay this response (a failure here is silently
    // swallowed - the frontend's own follow-up call still works exactly
    // as before, it just won't find a head start waiting for it). Uses the
    // full (unslimmed) flight objects already sitting in memory - the
    // same ones bestFinalPriceOf/buildSuggestionsCacheKey read via
    // /payment-suggestions today, just without the client having to send
    // them back over the wire first.
    //
    // page === 1 only (2026-08-03 fix): the page-2 prefetch is itself a
    // /search call and was hitting this same branch, firing a SECOND,
    // entirely wasted head start for its own partial (ranks 41-80) flight
    // subset - nothing ever queries suggestions for that subset, since
    // fetchPaymentSuggestions() only ever sends the page-1 flights the
    // frontend actually rendered. That wasted computation was itself
    // competing for the same single CPU core as the real page-1 head
    // start, on top of the page-2/decode contention this whole change was
    // meant to fix in the first place - confirmed live via a temporary
    // debug field (removed here) showing page-2's own request reaching
    // this branch with attempted:true.
    // Root cause of the head start never actually being found by the
    // client's real /payment-suggestions call (found live, 2026-08-03):
    // this object must produce the EXACT SAME cache key
    // (buildSuggestionsCacheKey) as validatePaymentRepriceRequest builds
    // from the client's own request, or the dedup can never match and
    // every real call silently computes fresh anyway. Two mismatches:
    // (1) outDate/retDate come from toISO(), which returns "" (not null)
    // for a missing date - for a one-way search retDate is "", but the
    // client sends returnTravelDate: lastSearchPayload.returnDate || null
    // (i.e. null for one-way), and validatePaymentRepriceRequest's own
    // regex normalization also collapses anything non-YYYY-MM-DD to null
    // - so this object had "" where the real request had null, a
    // genuinely different JSON.stringify key, for every single one-way
    // search. (2) selectedPaymentMethods here was /search's own
    // EMI-tenure-defaulted version (adds tenureMonths:3/defaultedTenure
    // for a tenure-less EMI selection) - validatePaymentRepriceRequest
    // does no such enrichment on the client's raw payload, so an EMI
    // selection with no explicit tenure would also mismatch. Both are
    // fixed here by deriving this object the same way
    // validatePaymentRepriceRequest does, not by reusing /search's own
    // already-normalized locals.
    const dateOrNull = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || "")) ? d : null);

    if (page === 1 && outboundFlights.length > 0) {
      getOrComputePaymentSuggestions(
        {
          from,
          to,
          travelClass: cabin,
          tripType,
          passengers: adults,
          selectedPaymentMethods: selectedPaymentMethodsRaw,
          outboundFlights,
          returnFlights,
          outboundTravelDate: dateOrNull(outDate),
          returnTravelDate: dateOrNull(retDate)
        },
        PAYMENT_RECOMMENDATION_CONFIG
      ).catch((err) => {
        console.error("[SkyDeal] payment-suggestions head start failed", err);
      });
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

// =========================================================
// Phase 1: Intelligent payment guide
// Reuses the exact same offer engine as /search (applyOffersToFlight,
// evaluateOfferForFlight, computeDiscountedPrice) against client-held
// flight data. No FlightAPI calls happen in this section.
// =========================================================

async function repriceFlightsForPaymentMethods(flights, selectedPaymentMethods, ctx) {
  const results = [];
  for (const f of flights) {
    const enriched = await applyOffersToFlight(
      f,
      selectedPaymentMethods,
      ctx.offers,
      ctx.passengers,
      ctx.cabin,
      ctx.tripType,
      ctx.isDomestic,
      null,
      ctx.requestCache,
      ctx.genericDisplayContext,
      // Phase 3: only set when ctx carries a hypothetical booking-date
      // simulation (see buildTimingInsights) - undefined for every
      // existing call, preserving real "now" behavior.
      ctx.evaluationBookingDate || null
    );
    results.push({
      portalPrices: (enriched.portalPrices || []).map(slimPortalPriceForSearchResponse),
      bestDeal: slimPortalPriceForSearchResponse(enriched.bestDeal)
    });
  }
  return results;
}

// Reads the current best final price off a flight object that already
// carries a computed bestDeal (i.e. a flight as returned by /search).
function bestFinalPriceOf(flightLike) {
  const bd = flightLike?.bestDeal;
  if (bd && bd.applied && Number.isFinite(bd.finalPrice)) return bd.finalPrice;
  return Number(flightLike?.price) || 0;
}

// Reads the final price off a row produced by repriceFlightsForPaymentMethods
// (which only carries portalPrices/bestDeal, not the original flight's price),
// falling back to the original flight's base price when no offer applied.
function finalPriceFromRepriced(row, originalFlight) {
  if (row?.bestDeal?.applied && Number.isFinite(row.bestDeal.finalPrice)) return row.bestDeal.finalPrice;
  return Number(originalFlight?.price) || 0;
}

// Same idea as finalPriceFromRepriced, but the BEFORE-discount price - used
// to compute a candidate's own true percentage (QC-caught, 2026-08-11:
// newBestPrice/additionalSaving are a "best across all loaded flights"
// aggregate, not tied to any single flight's fare, so borrowing a
// DIFFERENT flight's base price to compute "%" produced a real but
// inexact number, e.g. a genuine 10% offer showing as 12%). Pairing each
// candidate's newBestPrice with the SAME flight's own base price (see
// findBestIndexAndBasePrice below) makes the percentage exact by
// construction, not approximated from an unrelated flight.
function basePriceFromRepriced(row, originalFlight) {
  if (row?.bestDeal?.applied && Number.isFinite(row.bestDeal.basePrice)) return row.bestDeal.basePrice;
  return Number(originalFlight?.price) || 0;
}

// Finds the index achieving the minimum final price in a repriced batch,
// returning both that price and the SAME flight's own base price - so a
// candidate's discount percentage can always be computed same-flight,
// never mixed across two different flights' fares.
function findBestIndexAndBasePrice(repriced, originalFlights) {
  let bestIdx = 0;
  let bestFinal = Infinity;
  for (let i = 0; i < repriced.length; i++) {
    const final = finalPriceFromRepriced(repriced[i], originalFlights[i]);
    if (final < bestFinal) {
      bestFinal = final;
      bestIdx = i;
    }
  }
  const bestBase = repriced.length > 0 ? basePriceFromRepriced(repriced[bestIdx], originalFlights[bestIdx]) : 0;
  return { bestFinal: repriced.length > 0 ? bestFinal : 0, bestBase };
}

function validatePaymentRepriceRequest(body, cfg) {
  const errors = [];
  const from = String(body?.from || "").trim().toUpperCase();
  const to = String(body?.to || "").trim().toUpperCase();
  const tripType = body?.tripType === "round-trip" ? "round-trip" : "one-way";
  const passengers = Math.floor(Number(body?.passengers ?? 1));
  const selectedPaymentMethods = Array.isArray(body?.selectedPaymentMethods) ? body.selectedPaymentMethods : null;
  const outboundFlights = Array.isArray(body?.outboundFlights) ? body.outboundFlights : null;
  const returnFlightsRaw = body?.returnFlights;
  const returnFlights = Array.isArray(returnFlightsRaw) ? returnFlightsRaw : [];

  if (!from) errors.push("Missing from");
  if (!to) errors.push("Missing to");
  if (!Number.isFinite(passengers) || passengers < 1) errors.push("Invalid passengers");
  if (!selectedPaymentMethods) errors.push("selectedPaymentMethods must be an array");
  if (!outboundFlights) errors.push("outboundFlights must be an array");
  if (tripType === "round-trip" && !Array.isArray(returnFlightsRaw)) {
    errors.push("returnFlights must be an array for round-trip");
  }

  if (outboundFlights && outboundFlights.length > cfg.maxFlightsPerLeg) {
    errors.push(`outboundFlights exceeds max of ${cfg.maxFlightsPerLeg}`);
  }
  if (returnFlights.length > cfg.maxFlightsPerLeg) {
    errors.push(`returnFlights exceeds max of ${cfg.maxFlightsPerLeg}`);
  }

  const allFlights = [...(outboundFlights || []), ...returnFlights];
  for (const f of allFlights) {
    if (!Number.isFinite(Number(f?.price)) || Number(f.price) <= 0) {
      errors.push("Every flight entry requires a positive numeric price");
      break;
    }
  }

  // Phase 3: optional travel dates (YYYY-MM-DD) - purely additive, not
  // required, so /reprice-flights and existing /payment-suggestions
  // callers that omit them are entirely unaffected. Used only to bound
  // the timing-insight lookahead horizon and check travel-period
  // eligibility; never used for pricing/eligibility itself.
  const outboundTravelDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body?.outboundTravelDate || "")) ? body.outboundTravelDate : null;
  const returnTravelDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body?.returnTravelDate || "")) ? body.returnTravelDate : null;

  return {
    ok: errors.length === 0,
    errors,
    from,
    to,
    travelClass: normalizeCabin(body?.travelClass || body?.cabin),
    tripType,
    passengers,
    selectedPaymentMethods: selectedPaymentMethods || [],
    outboundFlights: outboundFlights || [],
    returnFlights,
    outboundTravelDate,
    returnTravelDate
  };
}

app.post("/reprice-flights", async (req, res) => {
  const cfg = PAYMENT_RECOMMENDATION_CONFIG;
  const v = validatePaymentRepriceRequest(req.body, cfg);

  if (!v.ok) {
    return res.status(400).json({ error: v.errors.join("; ") });
  }

  try {
    const offers = await getOffersForSearch({});
    const genericDisplayContext = await getGenericDisplayContextForSearch({});
    const isDomestic = isDomesticRoute(v.from, v.to);
    const requestCache = {
      infoOffersByKey: new Map(),
      pricingCandidatesByKey: new Map(),
      frontEligibilityMemo: new Map(),
      perfEligibilityMemo: true
    };

    const ctx = {
      offers,
      genericDisplayContext,
      passengers: v.passengers,
      cabin: v.travelClass,
      tripType: v.tripType,
      isDomestic,
      requestCache
    };

    // See expandEmiPaymentMethods - the client sends its raw selection
    // (e.g. just {type:"Credit Card", name:"HDFC Bank"} even with "Show
    // EMI offers" toggled on), so without this every EMI-typed offer is
    // invisible here and the repriced cards would silently show non-EMI
    // pricing after a toggle-only update (no fresh /search).
    const selectedPaymentMethods = expandEmiPaymentMethods(v.selectedPaymentMethods, offers);

    const outboundFlights = await repriceFlightsForPaymentMethods(v.outboundFlights, selectedPaymentMethods, ctx);
    const returnFlights = v.tripType === "round-trip"
      ? await repriceFlightsForPaymentMethods(v.returnFlights, selectedPaymentMethods, ctx)
      : [];

    return res.json({ outboundFlights, returnFlights });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Reprice failed" });
  }
});

function selectedPmKey(pm) {
  return `${String(pm?.type || "").trim().toLowerCase()}|${String(pm?.name || "").trim().toLowerCase()}`;
}

function candidateKey(c) {
  return [
    String(c.type || "").toLowerCase(),
    String(c.name || "").toLowerCase(),
    c.tenureMonths ?? "",
    String(c.network || "").toLowerCase(),
    String(c.cardFamily || "").toLowerCase(),
    c.isCorporate ?? ""
  ].join("|");
}

// Relevance hierarchy for Phase 1/2 suggestions - determines both whether
// a candidate is shown at all (tier 5 is excluded) and how results are
// ranked. Never alters eligibility/pricing, which always comes from the
// real offer engine - this only decides which engine-verified results are
// plausible enough to surface.
//
// Tier 1 - same bank as an already-selected method (different mode), using
//          bankCanonicalFromAny() so display-name spelling differences
//          ("HDFC" vs "HDFC Bank") don't cause a false "unrelated" result -
//          the same normalisation the real offer-matching engine uses.
// Tier 2 - UPI (generic, bank-agnostic).
// Tier 3 - Wallet (generic, bank-agnostic) - kept as its own rung below
//          UPI per Phase 2's explicit ranking order (UPI ranked above
//          "relevant wallet"), even though both were merged in Phase 1.
// Tier 4 - reserved for a future "other method already known in the
//          user's session" rule; nothing in the candidate set populates
//          this yet, kept as an explicit extension point rather than
//          guessed at (documented the same way in Phase 1 and still not
//          part of the required test list).
// Tier 5 - an unrelated bank - excluded from automatic suggestions
//          entirely (filtered out before the reprice loop runs, not just
//          ranked last).
function candidateRelevanceTier(candidate, selectedPaymentMethods) {
  const candidateBankCanon = bankCanonicalFromAny(candidate?.name);
  // Reuses normalizeSelectedPM's bank-identity resolution (not a raw
  // bankCanonicalFromAny(pm?.name) read) so a selected UPI method is
  // correctly identified by its real app (pm.provider), not the generic
  // literal "UPI" every UPI selection's pm.name holds - same root cause
  // as the offer-matching fix (2026-08-11): without this, a user who had
  // already selected e.g. "UPI: MobiKwik" themselves would never be
  // recognized as "same brand" against a MobiKwik candidate of another type.
  const sameBank = !!candidateBankCanon && (selectedPaymentMethods || []).some(
    (pm) => normalizeSelectedPM(pm).bankCanonical === candidateBankCanon
  );
  if (sameBank) return 1;

  if (candidate?.type === "UPI") return 2;
  if (candidate?.type === "Wallet") return 3;

  return 5;
}

function candidateCategoryLabel(tier) {
  if (tier === 1) return "same_bank_mode";
  if (tier === 2) return "upi_or_wallet";
  if (tier === 3) return "upi_or_wallet";
  if (tier === 4) return "other_profile_method";
  return "other_bank";
}

// Ease of adoption (Phase 2) - a same-bank credit-card holder is far more
// likely to actually have/activate an EMI plan or their own debit card
// than to go acquire net banking access, and UPI needs no card at all.
// Only meaningfully differentiates within tier 1 today (UPI/Wallet are
// single, uniform candidate types), but is defined generally per type.
function easeOfAdoptionScore(candidate) {
  const type = String(candidate?.type || "");
  if (type === "EMI") return 3;
  if (type === "UPI") return 3;
  if (type === "Debit Card") return 2;
  if (type === "Net Banking") return 1;
  return 0;
}

// (10 - tier) so tier 1 gets the largest multiple; tier is capped to a
// small known range so this never goes negative for any real tier value.
function computeRecommendationScore({ tier, additionalSaving, easeScore, totalAffectedFlights, breadthPercent }) {
  const w = RECOMMENDATION_SCORE_WEIGHTS;
  return (
    (10 - tier) * w.tierUnit +
    Math.max(0, additionalSaving) * w.savingUnit +
    Math.max(0, easeScore) * w.easeUnit +
    Math.max(0, totalAffectedFlights) * w.flightUnit +
    Math.max(0, breadthPercent) * w.breadthUnit
  );
}

// Builds the list of not-yet-selected payment methods worth testing,
// entirely from live data (computePaymentOptionsFromOffers' catalog plus
// real EMI tenures read off the offers collection) — no hard-coded banks.
// Providers never actively SUGGESTED to add, even when they have a live
// offer - founder call (2026-08-04): recommending them reads as SkyDeal
// promoting a specific app, and low-adoption providers (a user may not
// already have the app) make for a pushy, low-value nudge. Still fully
// selectable by hand in the payment picker for anyone who already uses
// one - this only removes it from the proactive "Add X" suggestion path.
const SUGGESTION_EXCLUDED_PROVIDERS = new Set(["mobikwik"]);

// Real EMI tenures a bank actually offers, read live off the offers
// collection - shared by every place that needs to turn a tenure-less EMI
// selection into real, priceable candidates (was previously duplicated
// inline inside buildCandidatePaymentMethods below).
// sawGenericEmiOffer: true if at least one EMI-like offer for this bank
// exists but never states specific tenures (e.g. "interest-free EMI"
// with no month breakdown) - such an offer should still be triable via a
// single tenureMonths:null candidate even when no concrete tenure number
// was ever found.
function findRealEmiTenuresForBank(bankName, offers, maxTenures = 12) {
  const bankCanon = bankCanonicalFromAny(bankName);
  if (!bankCanon) return { tenures: [], sawGenericEmiOffer: false };

  const tenureSet = new Set();
  let sawGenericEmiOffer = false;

  for (const offer of offers) {
    if (isOfferExpired(offer)) continue;
    const pms = extractOfferPaymentMethodsNoInference(offer);

    for (const pm of pms) {
      const norm = normalizeOfferPM(pm, offer);
      const isEmiLike = norm.typeNorm === "EMI" || (norm.typeNorm === "CREDIT_CARD" && norm.emiOnly === true);
      if (!isEmiLike) continue;
      if (!norm.bankCanonical || norm.bankCanonical !== bankCanon) continue;

      if (Array.isArray(norm.allowedTenures) && norm.allowedTenures.length > 0) {
        norm.allowedTenures.forEach((t) => tenureSet.add(t));
      } else {
        sawGenericEmiOffer = true;
      }
    }
  }

  // Sorted numerically first so that if a bank genuinely has more distinct
  // tenures than the cap, which ones get dropped is at least deterministic
  // rather than depending on arbitrary Mongo document order.
  const tenures = Array.from(tenureSet).sort((a, b) => a - b).slice(0, maxTenures);
  return { tenures, sawGenericEmiOffer };
}

// Turns a tenure-less EMI selection ("Show EMI offers" toggled on, no
// specific tenure chosen) into one candidate per real tenure that bank
// actually offers, rather than silently defaulting to 3 months. Founder
// call (2026-08-05): an explicit tenure picker was judged too much UI
// complexity for most users to have a real opinion on, so instead try
// every real tenure and let the existing "best price across everything
// you selected" logic surface whichever one wins - the winning offer's
// own title/rawDiscount text already states its tenure, so the user still
// sees it, just as part of the result rather than as an upfront choice.
// An entry with an explicit tenureMonths already set (e.g. from a debug
// endpoint, or a future picker) passes through untouched - this only
// fills in for the "no preference stated" case.
function expandEmiPaymentMethods(selectedPaymentMethodsRaw, offers) {
  const out = [];
  for (const pm of (selectedPaymentMethodsRaw || [])) {
    const type = String(pm?.type || "").toLowerCase();
    if (type.includes("emi") && !Number(pm?.tenureMonths)) {
      const { tenures, sawGenericEmiOffer } = findRealEmiTenuresForBank(pm?.name || pm?.bank, offers);
      if (tenures.length === 0) {
        // No concrete tenure ever found for this bank - fall back to the
        // old default rather than dropping EMI matching for it entirely,
        // unless there's a generic (tenure-unstated) EMI offer to try as-is.
        out.push({ ...pm, tenureMonths: sawGenericEmiOffer ? null : 3, defaultedTenure: !sawGenericEmiOffer });
      } else {
        for (const t of tenures) {
          out.push({ ...pm, tenureMonths: t });
        }
      }
    } else {
      out.push(pm);
    }
  }
  return out;
}

async function buildCandidatePaymentMethods(selectedPaymentMethods, offers, cfg) {
  const catalog = await computePaymentOptionsFromOffers(offers);
  const selectedSet = new Set((selectedPaymentMethods || []).map(selectedPmKey));
  const candidates = [];

  const CANONICAL_TYPES = ["Credit Card", "Debit Card", "Net Banking", "UPI", "Wallet"];

  for (const uiType of CANONICAL_TYPES) {
    const banks = catalog.options?.[uiType] || [];
    const counts = catalog.offerCounts?.[uiType] || {};

    for (const bank of banks) {
      if (SUGGESTION_EXCLUDED_PROVIDERS.has(String(bank).toLowerCase().trim())) {
        // The exclusion exists to avoid proactively pushing an app the user
        // has never indicated they have (founder call, 2026-08-04). That
        // rationale doesn't apply once they've already selected this exact
        // brand under a different payment type (e.g. Wallet: MobiKwik) -
        // suggesting MobiKwik's own UPI offer at that point isn't "SkyDeal
        // promoting a new app," it's surfacing a different payment mode
        // within an app they already told us they use (Kapil, 2026-08-11).
        const bankCanon = bankCanonicalFromAny(bank);
        const alreadyUsesThisBrand = bankCanon && (selectedPaymentMethods || []).some(
          (pm) => normalizeSelectedPM(pm).bankCanonical === bankCanon
        );
        if (!alreadyUsesThisBrand) continue;
      }

      const count = Number(counts[bank] ?? counts[String(bank).toLowerCase()] ?? 0);
      if (count <= 0) continue;

      const key = `${uiType.toLowerCase()}|${String(bank).toLowerCase()}`;
      if (selectedSet.has(key)) continue;

      candidates.push({
        type: uiType,
        name: bank,
        provider: uiType === "UPI" ? bank : null,
        network: null,
        cardFamily: null,
        cardVariant: null,
        isCorporate: null,
        tenureMonths: null,
        _priority: count
      });
    }
  }

  // Same-bank EMI variants for already-selected credit cards, using real
  // tenure data read off live offers via findRealEmiTenuresForBank — no
  // hard-coded default tenure.
  const selectedCreditCards = (selectedPaymentMethods || []).filter(
    (pm) => String(pm?.type || "").toLowerCase() === "credit card"
  );

  for (const cc of selectedCreditCards) {
    const alreadyHasEmi = (selectedPaymentMethods || []).some(
      (pm) =>
        String(pm?.type || "").toLowerCase() === "emi" &&
        String(pm?.name || "").toLowerCase().trim() === String(cc?.name || "").toLowerCase().trim()
    );
    if (alreadyHasEmi) continue;

    const { tenures: foundTenures, sawGenericEmiOffer } = findRealEmiTenuresForBank(cc.name, offers, cfg.maxEmiTenureVariantsPerBank);
    const tenures = foundTenures.length === 0 && sawGenericEmiOffer ? [null] : foundTenures;

    for (const tenure of tenures) {
      candidates.push({
        type: "EMI",
        name: cc.name,
        provider: null,
        network: cc.network || null,
        cardFamily: cc.cardFamily || null,
        cardVariant: cc.cardVariant || null,
        isCorporate: cc.isCorporate ?? null,
        tenureMonths: tenure,
        _priority: Number.MAX_SAFE_INTEGER
      });
    }
  }

  // Dedupe (keep the highest-priority version of any duplicate), then cap.
  const seen = new Map();
  for (const c of candidates) {
    const key = candidateKey(c);
    const existing = seen.get(key);
    if (!existing || c._priority > existing._priority) seen.set(key, c);
  }

  return Array.from(seen.values())
    .sort((a, b) => b._priority - a._priority)
    .slice(0, cfg.maxCandidatesPerRequest);
}

// Drops a trailing " Bank" from a bank's own display name only - not any
// occurrence of the substring "Bank" (e.g. "Bank of Baroda" is left
// untouched, since "Bank" isn't its last word there). "ICICI Bank Credit
// Card" read as a redundant double financial-institution marker; "ICICI
// Credit Card" matches how people actually refer to their own card
// (Kapil, 2026-08-12).
function stripTrailingBankWord(name) {
  return String(name || "").replace(/\s+Bank$/i, "").trim();
}

// Shared instrument-label builder (Kapil, 2026-08-12). EMI in this
// catalog is always a credit card converted to EMI, not its own
// instrument - "ICICI EMI" alone doesn't say what unlocks the EMI,
// "ICICI Credit Card EMI" does. Every other type keeps its own name.
function formatBankTypeLabel(name, type) {
  const shortName = stripTrailingBankWord(name);
  if (!shortName) return type || "";
  if (!type) return shortName;
  if (String(type).toUpperCase() === "EMI") return `${shortName} Credit Card EMI`;
  return `${shortName} ${type}`;
}

// Always names the exact instrument (bank + type), not just the bank - a
// user with a bank selected as more than one variant (e.g. "ICICI Bank" as
// both Credit Card and EMI) can't tell which one a message is about
// otherwise (confirmed live 2026-08-08: copy said "ICICI Bank" for both).
function paymentMethodShortLabel(pm) {
  if (pm.type === "UPI") return pm.provider || pm.name || "UPI";
  if (!pm.name) return pm.type || "this option";
  if (!pm.type) return stripTrailingBankWord(pm.name);
  return formatBankTypeLabel(pm.name, pm.type);
}

// Stable, machine-readable reason per suggestion (Phase 2) - a display
// concern only, never used for eligibility/pricing.
function reasonCodeFor(candidate, tier) {
  if (tier === 1) {
    if (candidate.type === "EMI") return "SAME_BANK_EMI_BETTER";
    if (candidate.type === "Debit Card") return "SAME_BANK_DEBIT_BETTER";
    if (candidate.type === "Net Banking") return "SAME_BANK_NETBANKING_BETTER";
    return "SAME_BANK_MODE_BETTER";
  }
  if (tier === 2) return "UPI_BETTER_OFFER";
  if (tier === 3) return "WALLET_BETTER_OFFER";
  return "OTHER_METHOD_BETTER_OFFER";
}

// One compact badge per suggestion (Phase 2) - only ever one, chosen by
// precedence: a concrete relevance signal (same bank / UPI) first, since
// that's the clearest "why", then comparative signals that only make
// sense once the final (<=2) list is known, then a generic ease signal.
// Returns null when nothing genuinely supports a label.
function pickSuggestionLabel(suggestion, finalSuggestions) {
  if (suggestion.relevanceTier === 1) return "Same bank";
  if (suggestion.relevanceTier === 2) return "UPI option";

  if (finalSuggestions.length > 1) {
    const maxSaving = Math.max(...finalSuggestions.map((s) => s.additionalSaving));
    if (suggestion.additionalSaving === maxSaving) return "Best saving";

    const maxFlights = Math.max(...finalSuggestions.map((s) => s.affectedFlights));
    if (suggestion.affectedFlights === maxFlights && suggestion.affectedFlights > 0) {
      return "Works on more flights";
    }
  }

  if (suggestion._easeScore >= 3) return "Easy to add";

  return null;
}

// Builds display copy for a suggestion. Only two real inputs vary the
// framing: relevance tier (same-bank vs UPI/wallet vs other) and whether
// this suggestion's label is "Works on more flights" - in which case the
// heading leads with flight coverage instead of the rupee saving, per the
// "UPI lowers more flight options" example.
function buildSuggestionCopy({ candidate, tier, additionalSaving, totalAffectedFlights, label }) {
  const shortLabel = paymentMethodShortLabel(candidate);
  const flightsPhrase = totalAffectedFlights > 1 ? ` and lowers ${totalAffectedFlights} flight options` : "";

  if (label === "Works on more flights") {
    return {
      heading: `${shortLabel} lowers more flight options`,
      message: `Paying by ${shortLabel} improves ${totalAffectedFlights} flights and reduces your best final price by ₹${additionalSaving}.`,
      primaryActionLabel: `Add ${shortLabel}`
    };
  }

  if (tier === 1) {
    return {
      heading: `You could save ₹${additionalSaving} more`,
      message: `${shortLabel} gives a better offer than your selected ${candidate.name}${flightsPhrase}.`,
      primaryActionLabel: `Add ${shortLabel}`
    };
  }

  if (tier === 2 || tier === 3) {
    return {
      heading: `Pay by ${shortLabel} and save ₹${additionalSaving} more`,
      message: `A ${shortLabel} offer currently gives a lower final price than your selected payment methods${flightsPhrase}.`,
      primaryActionLabel: `Add ${shortLabel}`
    };
  }

  // Defensive fallback - tier 5 ("other_bank") is filtered out before
  // this point and should never actually reach here.
  return {
    heading: `Do you also have a ${candidate.name} ${String(candidate.type || "").toLowerCase()}?`,
    message: `A ${shortLabel} offer could reduce your best final price by ₹${additionalSaving}.`,
    primaryActionLabel: `Add ${shortLabel}`
  };
}

// Phase 2 lightweight cache - avoids redundant candidate evaluation for
// an identical (search + selected-payment) state, e.g. an accidental
// double "Check for more options" click. Invalidated by: a different key
// (different route/selection/flights - the common case), TTL expiry, or
// the underlying offers data having refreshed since the entry was cached
// (reuses the existing offersCacheLoadedAt signal - no new infrastructure).
const paymentSuggestionsCache = new Map();

function buildSuggestionsCacheKey(v) {
  return JSON.stringify({
    from: v.from,
    to: v.to,
    travelClass: v.travelClass,
    tripType: v.tripType,
    passengers: v.passengers,
    selectedPaymentMethods: v.selectedPaymentMethods,
    outboundFlights: v.outboundFlights.map((f) => [f.price, f.airlineName, f.bestDeal?.applied, f.bestDeal?.finalPrice]),
    returnFlights: v.returnFlights.map((f) => [f.price, f.airlineName, f.bestDeal?.applied, f.bestDeal?.finalPrice]),
    // Phase 3: cached timingInsights are date-sensitive - a different
    // travel date (or the same request on a different calendar day) must
    // never reuse a stale cached entry.
    outboundTravelDate: v.outboundTravelDate,
    returnTravelDate: v.returnTravelDate,
    cacheDay: getTimezoneDateOnly(new Date()).toISOString().slice(0, 10)
  });
}

// =========================================================
// Phase 3: payment-timing intelligence
// Reuses isOfferExpired/offerMatchesBookingDay/offerMatchesSelectedPayment
// (via their new optional evaluation-date parameters) and
// repriceFlightsForPaymentMethods for the actual saving comparison - no
// separate/simplified date-eligibility engine.
// =========================================================

// Validity START date (offer.validityPeriod.from) is never read anywhere
// else in the codebase today (confirmed by inspection before building
// this) - this is new, narrowly-scoped logic, not a duplicate of
// isOfferExpired (which only ever reads .to/.endDate). Fails open (no
// start date recorded -> treated as already open), matching the same
// conservative fallback philosophy isOfferExpired itself uses.
function offerValidityStartOk(offer, evaluationDate) {
  const fromRaw =
    offer?.validityPeriod?.from ||
    offer?.parsedFields?.validityPeriod?.from ||
    null;
  if (!fromRaw) return true;

  const start = getTimezoneDateOnly(new Date(String(fromRaw)));
  if (isNaN(start.getTime())) return true;

  const today = getTimezoneDateOnly(evaluationDate);
  return today.getTime() >= start.getTime();
}

// Travel-period eligibility does not exist as logic anywhere else in the
// codebase (confirmed by inspection - offer.travelPeriod is currently
// only ever surfaced in two debug/admin endpoints, never read for
// eligibility). This is genuinely new. It fails open when the field is
// absent or unparseable - and in a live sample of 82 real production
// offers, 0 had a usable structured travelPeriod.from/to, so in practice
// this will rarely if ever restrict anything until the scraper/parser
// pipeline populates it - flagged explicitly rather than assumed reliable.
function offerMatchesTravelPeriod(offer, travelDateISO) {
  if (!travelDateISO) return true;

  const tp = offer?.travelPeriod || offer?.parsedFields?.travelPeriod || null;
  const fromRaw = tp?.from || null;
  const toRaw = tp?.to || null;
  if (!fromRaw && !toRaw) return true;

  const travelDay = getTimezoneDateOnly(new Date(String(travelDateISO)));
  if (isNaN(travelDay.getTime())) return true;

  if (fromRaw) {
    const from = getTimezoneDateOnly(new Date(String(fromRaw)));
    if (!isNaN(from.getTime()) && travelDay.getTime() < from.getTime()) return false;
  }
  if (toRaw) {
    const to = getTimezoneDateOnly(new Date(String(toRaw)));
    if (!isNaN(to.getTime()) && travelDay.getTime() > to.getTime()) return false;
  }
  return true;
}

// Cheap relevance pre-filter for the date scan below - reuses
// offerMatchesSelectedPayment (the same payment-matching function the
// real pricing engine uses), never a separate matching rule. Purely
// decides "is this offer even worth date-scanning for this method",
// not a source of truth for eligibility/pricing.
function relevantOffersForMethod(offers, method) {
  return offers.filter((o) => {
    try {
      return offerMatchesSelectedPayment(o, [method]);
    } catch {
      return false;
    }
  });
}

// Pure date arithmetic, no repricing: for each day in [0..horizonDays]
// (0 = today), is at least one of this method's relevant offers
// date-eligible (not expired, booking-day matches, validity started,
// travel period allows the trip)? Used only to find which single day is
// worth testing with a real (expensive) reprice call afterward.
function scanMethodDateEligibility(relevantOffers, todayDateOnly, horizonDays, travelDateISO) {
  const days = [];
  for (let i = 0; i <= horizonDays; i++) {
    const day = addDaysToDateOnly(todayDateOnly, i);
    const eligible = relevantOffers.some(
      (o) =>
        !isOfferExpired(o, day) &&
        offerMatchesBookingDay(o, day).ok &&
        offerValidityStartOk(o, day) &&
        offerMatchesTravelPeriod(o, travelDateISO)
    );
    days.push({ dayIndex: i, date: day, eligible });
  }
  return days;
}

// Turns a day-eligibility scan into (at most) one Phase 3 classification
// for this method. isSelected methods are checked for "stops being
// eligible soon" when eligible today; not-yet-selected methods are
// checked for "becomes eligible soon" (mirrors, and is ranked below,
// Phase 1/2's normal same-day suggestions - if it were eligible today,
// Phase 1/2 would already be showing it). A selected method that is
// NOT eligible today (e.g. a booking-day-restricted offer like a
// Monday-only coupon, checked on a Sunday) falls through to that same
// "becomes eligible soon" scan below - it's already the user's own
// payment method, so this is the one case where surfacing it matters
// most, and the forward scan is identical either way.
function classifyMethodTiming(dayScan, isSelected, endingSoonDays) {
  if (!dayScan.length) return null;
  const todayEligible = dayScan[0].eligible;

  if (isSelected && todayEligible) {
    let endDayIndex = null;
    for (let i = 1; i < dayScan.length; i++) {
      if (!dayScan[i].eligible) { endDayIndex = i; break; }
    }
    if (endDayIndex === null) return null; // stays eligible through the whole scanned window

    if (endDayIndex === 1) return { type: "AVAILABLE_TODAY_ENDS_TODAY", endDayIndex };
    if (endDayIndex <= endingSoonDays) return { type: "AVAILABLE_TODAY_ENDS_SOON", endDayIndex };
    return { type: "EXPIRES_BEFORE_TRAVEL_BUT_BOOKABLE", endDayIndex };
  }

  if (!isSelected && todayEligible) return null; // already surfaced as a normal Phase 1/2 suggestion if it clears the saving bar

  for (let i = 1; i < dayScan.length; i++) {
    if (dayScan[i].eligible) {
      return i === 1
        ? { type: "AVAILABLE_TOMORROW", startDayIndex: i }
        : { type: "AVAILABLE_UPCOMING_DAY", startDayIndex: i };
    }
  }
  return null;
}

function formatTimingDate(dateOnly, style) {
  // dateOnly is already a UTC-midnight stand-in for an IST calendar day
  // (see getTimezoneDateOnly) - format it back out in UTC so we don't
  // apply a second timezone conversion on top of the first.
  if (style === "weekday") {
    return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(dateOnly);
  }
  if (style === "short") {
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(dateOnly);
  }
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "UTC" }).format(dateOnly);
}

const URGENT_TIMING_TYPES = new Set([
  "AVAILABLE_TODAY_ENDS_TODAY",
  "EXPIRES_BEFORE_TRAVEL_BUT_BOOKABLE",
  "AVAILABLE_TODAY_ENDS_SOON"
]);
const URGENT_TIMING_RANK = { AVAILABLE_TODAY_ENDS_TODAY: 0, EXPIRES_BEFORE_TRAVEL_BUT_BOOKABLE: 1, AVAILABLE_TODAY_ENDS_SOON: 2 };
// ROUND_TRIP_MAY_UNLOCK ranks last among future insights - it's a hedged,
// no-real-fare-fetch estimate (see buildTimingInsights below), so a
// concrete date-based insight ("available Monday") should win the single
// future-insight slot (maxFutureInsights: 1) when both are present.
const FUTURE_TIMING_RANK = { AVAILABLE_TOMORROW: 0, AVAILABLE_UPCOMING_DAY: 1, ROUND_TRIP_MAY_UNLOCK: 2 };

// Plain-language copy only - no jargon like "payment-adjusted price" or
// "eligible travel date". Users read these as a quick reason + a rupee
// number, not a precise technical description of what the pricing engine
// did. Kept in one place so every timing-insight scenario stays equally
// simple, not just whichever one prompted the last fix.
function buildTimingInsightCopy({ method, classification, potentialSaving, currentBestPrice, hypotheticalBestPrice, todayDateOnly, evalDay }) {
  const shortLabel = paymentMethodShortLabel(method);
  const methodType = String(method?.type || "");
  const isEmiMethod = methodType.toUpperCase() === "EMI";

  if (classification.type === "AVAILABLE_TODAY_ENDS_TODAY") {
    return {
      heading: `Your saving may end today`,
      message: `This ${shortLabel} offer saves ₹${potentialSaving} right now, but may not work tomorrow.`,
      label: "Ends today",
      disclaimer: null,
      estimatedFinalPrice: currentBestPrice,
      // Raw numbers, not just the pre-formatted rupee string above - so
      // callers that want a percentage (the decode hierarchy's own copy,
      // which talks in "N% off" rather than rupees) don't have to parse
      // one back out of message text.
      potentialSaving,
      currentBestPrice
    };
  }

  if (classification.type === "EXPIRES_BEFORE_TRAVEL_BUT_BOOKABLE" || classification.type === "AVAILABLE_TODAY_ENDS_SOON") {
    const lastUsableDay = addDaysToDateOnly(todayDateOnly, classification.endDayIndex - 1);
    return {
      heading: `Use this offer before ${formatTimingDate(lastUsableDay, "long")}`,
      message: `You could save about ₹${potentialSaving} with ${shortLabel} if you book before then.`,
      label: `Book by ${formatTimingDate(lastUsableDay, "short")}`,
      disclaimer: null,
      estimatedFinalPrice: currentBestPrice,
      potentialSaving,
      currentBestPrice
    };
  }

  if (classification.type === "AVAILABLE_TOMORROW" || classification.type === "AVAILABLE_UPCOMING_DAY") {
    const when = classification.type === "AVAILABLE_TOMORROW" ? "tomorrow" : formatTimingDate(evalDay, "weekday");
    // Previously had a "Don't want EMI? A non-EMI X offer unlocks..." framing
    // for any Credit Card/Debit Card method, on the assumption that the
    // method's TYPE could in general have an EMI variant somewhere in the
    // catalog. That premise doesn't hold for this specific insight though -
    // relevantOffersForMethod (above) filters strictly by
    // offerMatchesSelectedPayment(offer, [method]), which only matches
    // offers whose typeNorm equals this method's own type. A Credit Card
    // selection can therefore never be driven by an EMI-typed offer here -
    // there's no EMI in the picture to "not want". Founder-caught
    // (2026-08-04): a user with a plain (non-EMI) ICICI credit card
    // selected, with no EMI offer active today, saw "Don't want EMI? A
    // non-EMI ICICI Bank offer unlocks Monday" - a real, honest "this
    // becomes available Monday" insight wrapped in a false premise about
    // EMI that was never actually true for their selection.
    // Doc's D-section splits this three ways (EMI / non-EMI card / UPI &
    // wallet) - "without using EMI" only makes sense to say for an actual
    // card, so it stays its own branch rather than folding into the
    // generic UPI/wallet phrasing.
    const isCardMethod = /credit|debit/i.test(methodType);
    let heading, message;
    if (isEmiMethod) {
      heading = `A lower price may unlock ${when}`;
      message = `Your ${shortLabel} EMI option could save about ₹${potentialSaving}.`;
    } else if (isCardMethod) {
      heading = `Your card offer unlocks ${when}`;
      message = `You could save about ₹${potentialSaving} without using EMI.`;
    } else {
      heading = `Your ${shortLabel} offer unlocks ${when}`;
      message = `You could save about ₹${potentialSaving} by paying with ${shortLabel}.`;
    }
    return {
      heading,
      message,
      label: `Available ${when}`,
      disclaimer: "Prices may change before then.",
      estimatedFinalPrice: hypotheticalBestPrice,
      potentialSaving,
      currentBestPrice
    };
  }

  return null;
}

// Main Phase 3 entry point, called from /payment-suggestions with data it
// already loaded (offers/ctx/currentBestPrice) - no separate endpoint, no
// extra Mongo/FlightAPI calls. Returns an array ready to attach as
// timingInsights, already capped to maxUrgentInsights + maxFutureInsights.
async function buildTimingInsights({
  selectedPaymentMethods,
  offers,
  ctx,
  currentBestPrice,
  outboundFlights,
  returnFlights,
  tripType,
  outboundTravelDateISO,
  recCfg,
  // Phase 1/2 already computed and tier-filtered this list moments ago in
  // the same request - reusing it avoids a second, redundant
  // buildCandidatePaymentMethods() pass (which itself re-hits Mongo via
  // computePaymentOptionsFromOffers).
  precomputedCandidates
}) {
  const timingCfg = PAYMENT_TIMING_CONFIG;
  const startedAt = Date.now();
  if (!outboundFlights.length) return [];

  const todayDateOnly = getTimezoneDateOnly(new Date());

  let horizonDays = timingCfg.futureLookaheadDays;
  if (outboundTravelDateISO) {
    const travelDay = getTimezoneDateOnly(new Date(outboundTravelDateISO));
    if (!isNaN(travelDay.getTime())) {
      const daysUntilTravel = Math.round((travelDay.getTime() - todayDateOnly.getTime()) / 86400000);
      horizonDays = Math.max(0, Math.min(horizonDays, daysUntilTravel));
    }
  }

  // Methods of interest: every already-selected method (checked for
  // "ending soon"), plus Phase 1/2's own relevant not-yet-selected
  // candidates (tier <= 3, i.e. same-bank/UPI/Wallet - never an unrelated
  // bank), checked for "becoming available soon".
  const relevantCandidates = (precomputedCandidates || [])
    .filter((c) => candidateRelevanceTier(c, selectedPaymentMethods) <= 3)
    .sort((a, b) => (b._priority || 0) - (a._priority || 0));

  const methodsOfInterest = [
    ...selectedPaymentMethods.map((m) => ({ method: m, isSelected: true })),
    ...relevantCandidates.map((c) => ({ method: c, isSelected: false }))
  ].slice(0, timingCfg.maxMethodsScanned);

  // The confirmatory reprice call is the expensive step (scales with
  // flight count x portals x offers). Phase 3 is a secondary, at-most-2,
  // purely informational signal - not the primary price shown to the
  // user - so it checks only the cheapest N loaded flights per leg
  // (where any improvement is most likely to matter) rather than every
  // loaded flight, unlike Phase 1/2's main suggestion engine.
  const byCurrentPrice = (a, b) => bestFinalPriceOf(a) - bestFinalPriceOf(b);
  const outboundSample = [...outboundFlights].sort(byCurrentPrice).slice(0, timingCfg.maxFlightsPerMethodCheck);
  const returnSample = [...returnFlights].sort(byCurrentPrice).slice(0, timingCfg.maxFlightsPerMethodCheck);

  const urgent = [];
  const future = [];

  for (const { method, isSelected } of methodsOfInterest) {
    if (Date.now() - startedAt > timingCfg.timingBudgetMs) break;

    const relevantOffers = relevantOffersForMethod(offers, method);
    if (relevantOffers.length === 0) continue;

    const dayScan = scanMethodDateEligibility(relevantOffers, todayDateOnly, horizonDays, outboundTravelDateISO);
    const classification = classifyMethodTiming(dayScan, isSelected, timingCfg.endingSoonDays);
    if (!classification) continue;

    const evalDayIndex = classification.endDayIndex ?? classification.startDayIndex;
    const evalDay = addDaysToDateOnly(todayDateOnly, evalDayIndex);
    const hypothetical = isSelected ? selectedPaymentMethods : [...selectedPaymentMethods, method];
    const simCtx = { ...ctx, evaluationBookingDate: evalDay };

    const outboundSim = await repriceFlightsForPaymentMethods(outboundSample, hypothetical, simCtx);
    const { bestFinal: newOutboundBest, bestBase: newOutboundBestBase } = findBestIndexAndBasePrice(outboundSim, outboundSample);

    let newReturnBest = 0;
    let newReturnBestBase = 0;
    if (tripType === "round-trip" && returnSample.length > 0) {
      const returnSim = await repriceFlightsForPaymentMethods(returnSample, hypothetical, simCtx);
      ({ bestFinal: newReturnBest, bestBase: newReturnBestBase } = findBestIndexAndBasePrice(returnSim, returnSample));
    }

    const hypotheticalBestPrice = newOutboundBest + newReturnBest;
    const diff = hypotheticalBestPrice - currentBestPrice;
    // "ends" family: tomorrow/soon is more expensive (diff > 0) - the
    // saving being lost. "becomes available" family: the future day is
    // cheaper (diff < 0) - the saving on offer.
    const potentialSaving = Math.round(Math.abs(diff));
    const isEndingFamily = URGENT_TIMING_TYPES.has(classification.type);
    const isMeaningful = isEndingFamily ? diff > 0 : diff < 0;
    if (!isMeaningful) continue;

    const isValid =
      potentialSaving >= recCfg.minAbsoluteSavingInr ||
      (currentBestPrice > 0 && potentialSaving / currentBestPrice >= recCfg.minPercentSaving);
    if (!isValid) continue;

    // For the "becomes available" (future) family only: replace
    // potentialSaving with the offer's own true saving, computed
    // same-flight against newOutboundBestBase/newReturnBestBase - NOT the
    // gap-against-currentBestPrice value computed above, which is really
    // "how much better than today's realistic fallback" (itself possibly
    // already reduced by an unrelated generic coupon), not the offer's
    // own rate. The "ending" family's copy ("it's saving you ₹X right
    // now, won't work tomorrow") is a legitimately different,
    // vs-realistic-fallback claim and keeps the original value; only the
    // future family's "you could save ₹X by paying with X" claims to
    // describe the OFFER'S OWN value (QC-caught from a live screenshot,
    // 2026-08-12: a real ~10% ICICI offer was showing as "save 4%").
    // isMeaningful/isValid above stay gated on the original vs-fallback
    // diff - that decides whether this is worth surfacing at all, a
    // separate question from what number to display once it is.
    const trueBasePrice = newOutboundBestBase + newReturnBestBase;
    const trueSaving = Math.round(Math.max(0, trueBasePrice - hypotheticalBestPrice));
    const displaySaving = isEndingFamily ? potentialSaving : (trueSaving || potentialSaving);

    const copy = buildTimingInsightCopy({
      method,
      classification,
      potentialSaving: displaySaving,
      currentBestPrice,
      hypotheticalBestPrice,
      todayDateOnly,
      evalDay
    });
    if (!copy) continue;

    const insight = {
      type: classification.type,
      urgency: isEndingFamily ? (classification.type === "AVAILABLE_TODAY_ENDS_TODAY" ? "high" : "medium") : "medium",
      paymentMethod: { type: method.type, name: method.name },
      currentDate: todayDateOnly.toISOString().slice(0, 10),
      availableFrom: isEndingFamily ? todayDateOnly.toISOString().slice(0, 10) : evalDay.toISOString().slice(0, 10),
      availableUntil: isEndingFamily ? addDaysToDateOnly(todayDateOnly, classification.endDayIndex - 1).toISOString().slice(0, 10) : null,
      potentialSaving: displaySaving,
      // trueBasePrice: additive, future-family only - lets tier3PercentPhrase
      // compute this offer's own real discount % same-flight-exact, instead
      // of against currentBestPrice (see comment above).
      trueBasePrice: !isEndingFamily && trueBasePrice > 0 ? trueBasePrice : null,
      currentBestPrice,
      estimatedFinalPrice: copy.estimatedFinalPrice,
      isOfferOnlyEstimate: !isEndingFamily,
      heading: copy.heading,
      message: copy.message,
      label: copy.label,
      disclaimer: copy.disclaimer
    };

    if (isEndingFamily) urgent.push(insight);
    else future.push(insight);
  }

  // Round-trip min-transaction hint (2026-08-06: moved here from a
  // standalone note in /search into the decode timing-insights panel,
  // where this class of "your price could be different under a specific
  // condition" signal already lives). Not a date-axis signal like the loop
  // above (which scans forward in days) - trip TYPE, not time, is the
  // variable - so it's computed separately: a one-way search sometimes has
  // a real, matching offer rejected purely because the fare doesn't reach
  // its minimum transaction value, and a round-trip fare is a genuinely
  // different (higher) amount that might clear it. Deliberately not a real
  // round-trip price fetch (a second full FlightAPI search) - just a
  // directional check against 2x the cheapest one-way fare already in
  // hand, with a margin so it doesn't fire right at the edge and then not
  // actually clear it.
  if (tripType === "one-way" && selectedPaymentMethods.length > 0 && outboundFlights.length > 0) {
    const cheapestPricePerPortal = {};
    for (const f of outboundFlights) {
      for (const p of (f.portalPrices || [])) {
        const price = Number(p.basePrice);
        if (Number.isFinite(price) && price > 0) {
          if (!cheapestPricePerPortal[p.portal] || price < cheapestPricePerPortal[p.portal]) {
            cheapestPricePerPortal[p.portal] = price;
          }
        }
      }
    }
    const portalEntries = Object.entries(cheapestPricePerPortal);

    if (portalEntries.length > 0) {
      const ROUND_TRIP_HINT_MARGIN = 1.15; // require 2x to clear the threshold with room, not just barely
      let bestCandidate = null;

      for (const offer of offers) {
        if (Date.now() - startedAt > timingCfg.timingBudgetMs) break;
        if (!offerMatchesSelectedPayment(offer, selectedPaymentMethods)) continue;

        for (const [portal, cheapestPrice] of portalEntries) {
          const ev = evaluateOfferForFlight({
            offer,
            portal,
            baseAmount: cheapestPrice,
            eligibilityAmount: cheapestPrice,
            selectedPaymentMethods,
            isDomestic: ctx.isDomestic,
            cabin: ctx.cabin,
            flightAirlineName: null,
            tripType,
            passengers: ctx.passengers,
            allOffers: offers,
            requestCache: ctx.requestCache,
            evaluationBookingDate: null,
          });

          const isMinTxnOnlyRejection =
            !ev.ok &&
            Array.isArray(ev.reasons) &&
            ev.reasons.length === 1 &&
            (ev.reasons[0] === "MIN_TXN_NOT_MET" || ev.reasons[0] === "MIN_TXN_NOT_MET_PER_PAX") &&
            Number.isFinite(ev.minTxn) &&
            ev.minTxn > 0;

          if (isMinTxnOnlyRejection && cheapestPrice * 2 >= ev.minTxn * ROUND_TRIP_HINT_MARGIN) {
            const discountValue = extractBestNumericDiscountValue(offer);
            if (!bestCandidate || discountValue > bestCandidate.discountValue) {
              const rawBank =
                offer?.eligiblePaymentMethods?.[0]?.bank ||
                offer?.paymentMethods?.[0]?.bank ||
                null;
              bestCandidate = {
                discountValue,
                minTxn: ev.minTxn,
                bank: rawBank ? (normalizeBankDisplayName(rawBank) || rawBank) : null,
              };
            }
            break; // found a qualifying portal for this offer - move to the next offer
          }
        }
      }

      if (bestCandidate) {
        future.push({
          type: "ROUND_TRIP_MAY_UNLOCK",
          urgency: "medium",
          paymentMethod: null,
          currentDate: todayDateOnly.toISOString().slice(0, 10),
          availableFrom: null,
          availableUntil: null,
          potentialSaving: bestCandidate.discountValue || 0,
          estimatedFinalPrice: null,
          isOfferOnlyEstimate: true,
          heading: `${bestCandidate.bank ? bestCandidate.bank + "'s" : "A"} offer needs a bigger booking`,
          message: `It needs a minimum spend of ₹${bestCandidate.minTxn.toLocaleString("en-IN")}, more than this one-way fare - a round-trip search may clear it.`,
          label: "Try round-trip",
          disclaimer: "Estimated by doubling your one-way fare, not a real round-trip search."
        });
      }
    }
  }

  urgent.sort((a, b) => (URGENT_TIMING_RANK[a.type] - URGENT_TIMING_RANK[b.type]) || (b.potentialSaving - a.potentialSaving));
  future.sort((a, b) => (FUTURE_TIMING_RANK[a.type] - FUTURE_TIMING_RANK[b.type]) || (b.potentialSaving - a.potentialSaving));

  return [
    ...urgent.slice(0, timingCfg.maxUrgentInsights),
    ...future.slice(0, timingCfg.maxFutureInsights)
  ];
}

// ---------- Sairro decode: primary message priority hierarchy ----------
// Unifies what used to be two independent, always-visible sections
// (Phase 1/2 "suggestions" and Phase 3 "timing insights") into one
// ordered message, per founder direction (2026-08-08):
//   Tier 1 - a live offer for exactly the payment method(s) selected
//   Tier 2 - a better SAME-BANK option addable right now (EMI/debit/net
//            banking, or a bank-linked UPI/wallet - never an unrelated
//            bank, and never a generic UPI/Wallet suggestion)
//   Tier 3 - the selected method's OWN offer unlocking soon
//   Tier 4 - fallback reassurance, so the message never ends on silence
// Urgency (an offer ending imminently) is NOT a separate tier - it's a
// color/warning variant of whichever tier it belongs to. See
// DECISIONS.md ("Sairro decode priority hierarchy") for the full
// rationale and the founder conversation that shaped these rules.

// Traces a slim bestDeal (from /search, already fully computed) back to
// its source offer_rules document via coupon code / title, purely to
// read a field the slim response never carried (the structured expiry
// date) - never re-derives pricing, which stays trusted as-is.
function findOfferSourceDoc(bestDeal, offers) {
  if (!bestDeal || !Array.isArray(offers)) return null;
  const code = bestDeal.code || null;
  const title = bestDeal.title || null;
  if (!code && !title) return null;

  return offers.find((o) => {
    const oCode = o?.couponCode || o?.code || o?.parsedFields?.couponCode || o?.parsedFields?.code || null;
    if (code && oCode && String(oCode).toLowerCase() === String(code).toLowerCase()) return true;
    const oTitle = o?.title || null;
    if (title && oTitle && String(oTitle) === String(title)) return true;
    return false;
  }) || null;
}

// Only surfaced when genuinely imminent (founder direction: within 2-3
// days) - a distant expiry date is noise, not something worth
// interrupting the message for.
function findImminentExpiry(bestDeal, offers, todayDateOnly, maxDays = 3) {
  const offer = findOfferSourceDoc(bestDeal, offers);
  if (!offer) return null;

  const toDateRaw =
    offer?.validityPeriod?.to ||
    offer?.parsedFields?.validityPeriod?.to ||
    offer?.validityPeriod?.endDate ||
    offer?.parsedFields?.validityPeriod?.endDate ||
    null;
  if (!toDateRaw) return null;

  const expiryDay = getTimezoneDateOnly(new Date(toDateRaw));
  if (isNaN(expiryDay.getTime())) return null;

  const daysUntil = Math.round((expiryDay.getTime() - todayDateOnly.getTime()) / 86400000);
  if (daysUntil < 0 || daysUntil > maxDays) return null;

  return { daysUntil, expiryDateISO: expiryDay.toISOString().slice(0, 10) };
}

// Finds whichever already-loaded flight (outbound, and return if
// round-trip) achieves the current best combined price, and returns its
// bestDeal - this is already fully computed by /search; nothing here
// re-prices anything.
function findBestDealsForCurrentPrice(outboundFlights, returnFlights, tripType) {
  const bestOutbound = outboundFlights.length
    ? outboundFlights.reduce((a, b) => (bestFinalPriceOf(a) <= bestFinalPriceOf(b) ? a : b))
    : null;
  const bestReturn = (tripType === "round-trip" && returnFlights.length)
    ? returnFlights.reduce((a, b) => (bestFinalPriceOf(a) <= bestFinalPriceOf(b) ? a : b))
    : null;
  return { outboundBestDeal: bestOutbound?.bestDeal || null, returnBestDeal: bestReturn?.bestDeal || null };
}

function formatDiscountPhrase(bestDeal) {
  if (bestDeal?.appliedDiscountText) return bestDeal.appliedDiscountText;
  if (Number.isFinite(bestDeal?.actualDiscount) && bestDeal.actualDiscount > 0) {
    return `₹${Math.round(bestDeal.actualDiscount).toLocaleString("en-IN")} off`;
  }
  return "a lower price";
}

// The agreed decode-hierarchy mockup (2026-08-08, decode_priority_hierarchy_mock.html)
// talks in percentages ("10% off", "save 15% today"), never rupees - a
// discount is easier to size up at a glance as a percent than as a bare
// rupee figure without its base price for context. Returns null (never a
// misleading 0%/NaN) when there isn't a clean base price to divide by, so
// callers can fall back to the rupee phrasing instead.
function computeDiscountPercent(basePrice, discountAmount) {
  const base = Number(basePrice);
  const discount = Number(discountAmount);
  if (!(Number.isFinite(base) && base > 0 && Number.isFinite(discount) && discount > 0)) return null;
  const pct = Math.round((discount / base) * 100);
  return pct > 0 ? pct : null;
}

// Approximates a live generic/checkout discount as a percentage, for the
// "a site discount's already applied" family of tips - "applied" alone
// doesn't say how much, which reads as vague rather than reassuring
// (Kapil, 2026-08-12). Rounds UP, not to nearest - the copy always says
// "about X%", so it should never be an understatement.
function genericDiscountApproxPercent(deal) {
  const base = Number(deal?.basePrice);
  const discount = Number(deal?.actualDiscount);
  if (!(Number.isFinite(base) && base > 0 && Number.isFinite(discount) && discount > 0)) return null;
  const pct = Math.ceil((discount / base) * 100);
  return pct > 0 ? pct : null;
}

function formatDiscountPercentPhrase(bestDeal) {
  const pct = computeDiscountPercent(bestDeal?.basePrice, bestDeal?.actualDiscount);
  if (pct != null) return `${pct}% off`;
  // Flat-amount offers with no clean base (rare) - a rupee figure is still
  // honest here, just not the preferred phrasing.
  return formatDiscountPhrase(bestDeal);
}

// tier2 (a Phase 1/2 suggestion) carries additionalSaving/newBestPrice as
// raw rupee numbers - newBestPrice + additionalSaving is the price WITHOUT
// this option, i.e. the base a "% off" should be computed against, UNLESS
// a true (pre-any-discount) base price is passed in separately.
//
// That second case matters: when Tier 2 is shown alongside an ALREADY-
// winning Tier 1 (the sameBankAsTier1 branch and the cross-bank CTA
// branch below), "the price WITHOUT this option" is Tier 1's own
// already-discounted price, not the fare's true original price - so the
// percentage this used to compute was "how much cheaper is switching
// than your ALREADY-discounted price", a genuinely small number, while
// reading exactly like "this offer's own discount is only N%". A real
// example: ICICI Credit Card at 10% off (₹8724 -> ₹7852) with ICICI EMI
// as Tier 2 said "EMI saves 2% instead" - mathematically correct for
// what it measured (2% cheaper than the ALREADY-discounted ₹7852), but
// EMI's own real discount off the true ₹8724 base is closer to 12%
// (founder-caught, 2026-08-10: "is it even true?" - it was true for a
// metric nobody was claiming to show). Passing trueBasePrice (the
// tier1Deal's own basePrice, when a Tier 1 winner exists) makes this
// consistent with how Tier 1's own "N% off" is computed - the same
// fare's true original price - so the two percentages are directly
// comparable instead of one being quietly measured against the other.
function tier2PercentAndLabel(tier2, trueBasePrice) {
  const label = paymentMethodShortLabel(tier2?.paymentMethod || {});
  const saving = Number(tier2?.additionalSaving);
  const newBest = Number(tier2?.newBestPrice);
  const candidateBase = Number(tier2?.newBestBasePrice);

  // Prefer the candidate's OWN same-flight base price (newBestBasePrice,
  // added 2026-08-11) - exact by construction, since it's the true fare of
  // the SAME flight newBestPrice was actually achieved on.
  // newBestPrice/additionalSaving are a "best achievable across every
  // loaded flight" aggregate, not tied to any one flight, so an
  // externally-passed trueBasePrice (e.g. a DIFFERENT flight's
  // tier1Deal.basePrice) could silently mismatch and produce a
  // real-but-inexact percentage (QC-caught: a genuine 10% offer read as
  // 12% this way, one flight's true base subtracted against a cheaper
  // flight's discounted price). trueBasePrice is kept only as a
  // defensive fallback for the case newBestBasePrice wasn't computed.
  if (Number.isFinite(candidateBase) && candidateBase > 0 && Number.isFinite(newBest)) {
    const pct = computeDiscountPercent(candidateBase, candidateBase - newBest);
    if (pct != null) return { label, pct };
  }

  if (Number.isFinite(saving) && saving > 0 && Number.isFinite(newBest)) {
    const hasTrueBase = Number.isFinite(trueBasePrice) && trueBasePrice > 0;
    const base = hasTrueBase ? trueBasePrice : (newBest + saving);
    const discount = hasTrueBase ? (trueBasePrice - newBest) : saving;
    const pct = computeDiscountPercent(base, discount);
    if (pct != null) return { label, pct };
  }
  return { label, pct: null };
}

// A future timing insight (Tier 3) stores its rupee saving pre-formatted
// into .message text - this pulls the raw numbers to compute the same
// kind of percentage instead. Prefers trueBasePrice (the SAME flight's
// real fare the offer's own discount was computed against, added
// 2026-08-12) over currentBestPrice - the latter is today's realistic
// fallback price, not the offer's own base, and dividing by it produced a
// real-but-wrong percentage (QC-caught from a live screenshot: a genuine
// ~10% ICICI offer read as "save 4%").
function tier3PercentPhrase(tier3) {
  const base = Number.isFinite(tier3?.trueBasePrice) && tier3.trueBasePrice > 0
    ? tier3.trueBasePrice
    : tier3?.currentBestPrice;
  const pct = computeDiscountPercent(base, tier3?.potentialSaving);
  return pct != null ? `${pct}%` : null;
}

// bestDeal.paymentLabel is built by getMatchedSelectedPaymentLabel() as
// "{rawName} • {normalizePaymentType(...)}" - that second part is an
// internal canonical matching key ("creditcard", "netbanking", never
// meant for display), not display copy, confirmed live (2026-08-08:
// showed "IDBI Bank • creditcard" verbatim in production).
//
// Resolves a clean {name, type, label} from the SAME selected method's own
// already-correct fields - via getMatchedSelectedPaymentMethod, which
// re-matches against the actual winning offer document, not just a
// same-name lookup. A same-name lookup alone is wrong whenever a bank is
// selected as more than one variant at once (e.g. "ICICI Bank" as both
// Credit Card and EMI): it would silently return whichever variant happens
// to be listed first, even when the OTHER variant is the one that actually
// won (confirmed live 2026-08-08: EMI won the price but the card read
// "ICICI Bank Credit Card"). Returning the raw {name} (not just a joined
// string) also lets callers check whether a Tier 2 candidate is the SAME
// bank the user already picked, or a genuinely different one.
function resolveTier1Match(bestDeal, selectedPaymentMethods, offers) {
  const offer = findOfferSourceDoc(bestDeal, offers);
  const matched = offer ? getMatchedSelectedPaymentMethod(offer, selectedPaymentMethods) : null;
  if (matched?.name) {
    return { name: matched.name, type: matched.type, label: formatBankTypeLabel(matched.name, matched.type) };
  }

  const rawLabel = bestDeal?.paymentLabel || "";
  const namePart = rawLabel.split("•")[0].trim();
  return { name: namePart || null, type: null, label: stripTrailingBankWord(namePart) || "Your payment method" };
}

// Whether a SPECIFIC selected method (this exact bank+type, not just the
// bank generally) has a live applied_payment_offer on ANY currently-loaded
// flight, not just whichever flight happens to be cheapest overall - used
// for the Tier 1 + cross-bank-Tier 2 parenthetical ("X, your other
// selected card, has no live offer today"), which is a claim about that
// card across the whole loaded search, not about a single flight.
function selectedMethodHasLiveOffer(pm, outboundFlights, returnFlights, offers) {
  const allFlights = [...(outboundFlights || []), ...(returnFlights || [])];
  for (const f of allFlights) {
    const bd = f?.bestDeal;
    if (!bd?.applied || bd.offerDisplayType !== "applied_payment_offer") continue;
    const offer = findOfferSourceDoc(bd, offers);
    const matched = offer ? getMatchedSelectedPaymentMethod(offer, [pm]) : null;
    if (matched?.name) return true;
  }
  return false;
}

function resolvePrimaryDecodeMessage({
  selectedPaymentMethods,
  outboundFlights,
  returnFlights,
  tripType,
  suggestions,
  timingInsights,
  offers
}) {
  if (!Array.isArray(selectedPaymentMethods) || selectedPaymentMethods.length === 0) {
    // Nothing selected yet - the existing "add a payment method" prompt
    // already covers this; this hierarchy only applies once there's an
    // actual selection to evaluate.
    return null;
  }

  const todayDateOnly = getTimezoneDateOnly(new Date());
  const { outboundBestDeal, returnBestDeal } = findBestDealsForCurrentPrice(outboundFlights, returnFlights, tripType);

  // A round trip's two legs can win via different offers/portals, but the
  // message only ever names one - outbound (the leg shown first) wins
  // ties, matching what the user sees at the top of the results.
  const candidateDeals = [outboundBestDeal, returnBestDeal].filter(Boolean);
  const tier1Deal = candidateDeals.find((d) => d?.applied && d?.offerDisplayType === "applied_payment_offer") || null;

  // Tier 2: the best genuinely-same-bank candidate, already ranked by the
  // existing suggestion engine (candidateRelevanceTier === 1 covers same
  // bank in ANY form - EMI/debit/net banking, or a bank-linked UPI/wallet
  // if one exists) - generic UPI/Wallet suggestions unrelated to a
  // selected bank are deliberately excluded from this hierarchy.
  const tier2 = (suggestions || []).find((s) => s.relevanceTier === 1) || null;

  // Tier 3: the selected method's OWN offer unlocking soon - cross-
  // referenced against selectedPaymentMethods since buildTimingInsights's
  // returned objects don't carry an isSelected flag directly. Restricted
  // to the "future" family (URGENT_TIMING_TYPES excluded) so it never
  // overlaps with the urgency check just below, for whatever Tier 1 is
  // currently winning.
  const tier3 = (timingInsights || []).find((t) =>
    !URGENT_TIMING_TYPES.has(t.type) &&
    selectedPaymentMethods.some((pm) => pm.type === t.paymentMethod?.type && pm.name === t.paymentMethod?.name)
  ) || null;

  const tier1Match = tier1Deal ? resolveTier1Match(tier1Deal, selectedPaymentMethods, offers) : null;

  // Urgency is a color/warning variant of Tier 1, not a separate tier.
  //
  // Two independent signals can establish it, checked in this order:
  //
  // 1. A matching URGENT-family timing insight (AVAILABLE_TODAY_ENDS_TODAY /
  //    AVAILABLE_TODAY_ENDS_SOON / EXPIRES_BEFORE_TRAVEL_BUT_BOOKABLE) for
  //    the SAME bank+type currently winning Tier 1. These come from
  //    buildTimingInsights's day-by-day eligibility scan
  //    (scanMethodDateEligibility/classifyMethodTiming), which understands
  //    booking-day restrictions - e.g. a "Monday only" coupon - via
  //    offerMatchesBookingDay, and is reprice-verified (it actually checks
  //    tomorrow's eligibility, not just a date field).
  // 2. Only when no such insight exists (timing budget exceeded, this ran
  //    outside /payment-suggestions, etc.) - findImminentExpiry()'s much
  //    dumber check of the offer's raw validityPeriod.to date range.
  //
  // findImminentExpiry() alone used to be the ONLY signal here, and it has
  // no concept of booking-day restrictions at all - a live-today,
  // gone-tomorrow Monday-only offer produced no urgency warning whatsoever
  // (founder-caught, 2026-08-10), even though the day-aware scan already
  // existed and already correctly classified that exact case for other
  // purposes (buildTimingInsightCopy's "won't work tomorrow" copy).
  const tier1UrgentInsight = tier1Match
    ? (timingInsights || []).find((t) =>
        URGENT_TIMING_TYPES.has(t.type) &&
        t.paymentMethod?.type === tier1Match.type &&
        normalizeBankName(t.paymentMethod?.name) === normalizeBankName(tier1Match.name)
      ) || null
    : null;
  const tier1ExpiryFallback = (!tier1UrgentInsight && tier1Deal)
    ? findImminentExpiry(tier1Deal, offers, todayDateOnly)
    : null;
  const tier1Urgent = !!tier1UrgentInsight || !!tier1ExpiryFallback;
  const tier1EndsToday = tier1UrgentInsight
    ? tier1UrgentInsight.type === "AVAILABLE_TODAY_ENDS_TODAY"
    : (tier1ExpiryFallback ? tier1ExpiryFallback.daysUntil === 0 : false);
  // The insight's own copy (buildTimingInsightCopy) is already specific
  // and reprice-verified ("It's saving you ₹X right now, but won't work
  // tomorrow.") - only fall back to the generic date-based sentence when
  // urgency came from the raw validityPeriod check instead.
  const tier1UrgentWarning = tier1UrgentInsight
    ? tier1UrgentInsight.message
    : (tier1ExpiryFallback
        ? (tier1EndsToday
            ? "This offer ends today - book now to lock it in."
            : `This offer ends ${tier1ExpiryFallback.expiryDateISO} - book soon to lock it in.`)
        : null);

  // Tier 4 signal: something WAS applied, just not payment-specific - the
  // reassurance line only makes this claim when it's actually true. Covers
  // both a real DB-backed offer rule AND a generic checkout-coupon display
  // estimate (Yatra FREEFLY etc, built by findGenericDisplayForPortal) -
  // the latter is flagged isDisplayOnly/non-exact but is still genuinely
  // reflected in the price shown on the flight card, so it's just as true
  // a "we already applied something" claim (founder catch, 2026-08-09:
  // ICICI-only search had a live Yatra FREEFLY discount on the card, but
  // the decode message never mentioned it because this check only ever
  // matched "applied_offer_rule", a string real generic-display offers
  // don't use).
  const genericDealApplied = candidateDeals.some((d) => d?.applied && (
    d?.offerDisplayType === "applied_offer_rule" ||
    d?.offerDisplayType === "conservative_generic_display_offer" ||
    d?.offerDisplayType === "verified_generic_checkout_coupon"
  ));

  // Built by whichever tier branch below matches, then run through one
  // shared post-processing step (the round-trip-min-txn tip, see below)
  // before the single return at the end - so that fix, and any future
  // one like it, automatically applies to every tier instead of needing
  // to be copy-pasted into each branch separately (founder direction,
  // 2026-08-10: "fix them logically so all such errors won't happen in
  // future").
  let message = null;

  if (tier1Deal) {
    const bankLabel = tier1Match.label;
    const portal = tier1Deal.portal || "the portal";
    const tier1Pct = computeDiscountPercent(tier1Deal.basePrice, tier1Deal.actualDiscount);
    const discountPhrase = formatDiscountPercentPhrase(tier1Deal);

    message = {
      tier: 1,
      urgent: tier1Urgent,
      // "Same bank" made sense on Tier 2-alone's tag (it explicitly pivots
      // to a DIFFERENT card, so naming whose bank it is matters), but on
      // Tier 1's own card there's no comparison happening in the tag
      // itself - it read as unexplained internal jargon ("same bank as
      // what?"), not something a user could parse (Kapil feedback,
      // 2026-08-10). Just state the plain fact this tag is actually for.
      tag: tier1Urgent ? (tier1EndsToday ? "Ends today" : "Ends soon") : "Live today",
      tagVariant: tier1Urgent ? "urgent" : "live",
      heading: `Your ${bankLabel} gets you the best price`,
      // The actual price transition, for the decode card's own price
      // hero - only ever set when both numbers are real (an applied
      // Tier 1 deal always has them), never a guess.
      priceNow: Number.isFinite(tier1Deal.finalPrice) ? tier1Deal.finalPrice : null,
      priceWas: Number.isFinite(tier1Deal.basePrice) ? tier1Deal.basePrice : null,
      message: `${discountPhrase} on ${portal}.`,
      warning: tier1UrgentWarning,
      tip: null,
      cta: null,
      skip: null,
      upsell: null,
      mirror: null,
      // Condensed one-line version for the sticky banner shown once the
      // full card scrolls out of view - same underlying fact, just short
      // enough for a single line.
      sticky: tier1Urgent
        ? `${discountPhrase} with ${bankLabel} — ${tier1EndsToday ? "ends today" : "ends soon"}`
        : `${discountPhrase} with your ${bankLabel} on ${portal}`
    };

    // Whether Tier 2 is a different variant of the SAME bank the user
    // already matched on (e.g. Credit Card vs EMI) or a genuinely
    // different bank changes the MESSAGING (a quiet same-bank nudge vs a
    // more assertive cross-bank pitch) but not whether a CTA belongs here.
    // buildCandidatePaymentMethods explicitly excludes anything already in
    // selectedPaymentMethods (selectedSet.has(key) -> skip; alreadyHasEmi
    // -> skip) before it ever becomes a suggestion, so tier2 - in BOTH
    // branches - is always a genuinely not-yet-added method, never
    // something the user already has. The old "same bank = quiet FYI
    // about their own card, they'd just be re-choosing between two things
    // they already picked" reasoning was factually wrong: there was
    // nothing to click, so "Comfortable with EMI?" had no way to actually
    // answer yes (Kapil feedback, 2026-08-10). Both branches now offer the
    // same real Add action.
    const sameBankAsTier1 = !!(tier2 && tier1Match.name && tier2.paymentMethod?.name
      && normalizeBankName(tier2.paymentMethod.name) === normalizeBankName(tier1Match.name));

    if (tier2 && tier2.additionalSaving > 0 && sameBankAsTier1) {
      const { label, pct: tier2Pct } = tier2PercentAndLabel(tier2, tier1Deal.basePrice);
      const promptWord = tier2.paymentMethod?.type || "a different way to pay";
      if (tier1Pct != null) message.heading = `Your ${bankLabel} already saves you ${tier1Pct}%`;
      message.message = tier2Pct != null
        ? `Comfortable with ${promptWord}? ${label} saves ${tier2Pct}% instead.`
        : `Comfortable with ${promptWord}? ${label} could save you more.`;
      message.cta = {
        label: tier2Pct != null ? `Add ${label} (save ${tier2Pct}%)` : (tier2.primaryActionLabel || `Add ${label}`),
        paymentMethod: tier2.paymentMethod
      };
      message.skip = "Not for me";
      if (tier1Pct != null && tier2Pct != null) {
        message.sticky = `${tier1Pct}% off now — ${label} could save ${tier2Pct}%`;
      }
    } else if (tier2 && tier2.additionalSaving > 0) {
      const { label, pct } = tier2PercentAndLabel(tier2, tier1Deal.basePrice);
      message.cta = {
        label: pct != null ? `Add ${label} (save ${pct}% instead)` : (tier2.primaryActionLabel || `Add ${label}`),
        paymentMethod: tier2.paymentMethod
      };
      message.skip = "Not for me";
      if (tier1Pct != null && pct != null) {
        message.sticky = `${tier1Pct}% off with ${bankLabel} — or ${pct}% via ${label}`;
      }

      // Tier 2 here is a genuinely different selected bank/card, not just
      // a not-yet-selected candidate - if THAT card's own selection also
      // has nothing live today, say so, so the user understands why
      // today's win came from the OTHER card they picked, not this one.
      const otherSelected = (selectedPaymentMethods || []).find((pm) =>
        pm?.name && normalizeBankName(pm.name) !== normalizeBankName(tier1Match.name)
      );
      if (otherSelected && !selectedMethodHasLiveOffer(otherSelected, outboundFlights, returnFlights, offers)) {
        const otherLabel = paymentMethodShortLabel(otherSelected);
        message.message = `${discountPhrase} on ${portal}. (${otherLabel}, your other selected card, has no live offer today.)`;
      }
    } else if (tier3 && !tier1Urgent) {
      // The "mirror" case: today's pick already wins, but a different
      // variant of the SAME selected method (e.g. non-EMI vs EMI)
      // genuinely unlocks soon - worth a mention, not an upsell push.
      const tier3Pct = tier3PercentPhrase(tier3);
      const tier3Label = paymentMethodShortLabel(tier3.paymentMethod || {});
      const tier3When = tier3.label ? tier3.label.replace(/^Available\s+/, "") : "soon";
      if (tier1Pct != null) message.heading = `Your ${bankLabel} already saves you ${tier1Pct}%`;
      message.mirror = tier3Pct != null
        ? `Prefer not to use ${tier1Match.type || "this method"}? A ${tier3Label} offer opens ${tier3When}, saving ${tier3Pct}.`
        : (tier3.message || tier3.heading);
      message.warning = `Fare may change before ${tier3When} - this isn't a locked-in price.`;
      if (tier1Pct != null && tier3Pct != null) {
        message.sticky = `${tier1Pct}% off with ${bankLabel} — ${tier3Label} opens ${tier3When} for ${tier3Pct}`;
      }
    }
  } else if (tier3) {
    // No Tier 1 match - Tier 3 (the selected method unlocking soon), with
    // Tier 2 offered alongside if it exists, else Tier 4 reassurance.
    const tier3Tag = tier3.label ? tier3.label.replace(/^Available\s+/, "Opens ") : "Opens soon";
    const tier3Pct = tier3PercentPhrase(tier3);
    const tier3Label = paymentMethodShortLabel(tier3.paymentMethod || {});
    const whenMatch = /^Opens\s+(.+)/.exec(tier3Tag);
    const whenPhrase = whenMatch ? whenMatch[1] : "soon";
    const hasTier2 = !!(tier2 && tier2.additionalSaving > 0);

    message = {
      tier: 3,
      urgent: false,
      tag: tier3Tag,
      tagVariant: "warn",
      // Matches the doc's D-section "unlocks {when}" framing (copy audit,
      // 2026-08-11) - leads with the upcoming opportunity, not with what's
      // currently absent.
      heading: `Your ${tier3Label} offer unlocks ${whenPhrase}`,
      // The percent claim only appears alongside a genuine live
      // alternative (hasTier2) - without one, all this can honestly say
      // is when it opens, not what it's worth doing about it today.
      message: hasTier2 && tier3Pct != null
        ? `It opens ${whenPhrase} - you'd save ${tier3Pct} then, though the fare may change before you book.`
        : `It opens ${whenPhrase}, though the fare may change before you book.`,
      warning: `Estimated only - the fare shown today may not match ${whenPhrase}'s price.`,
      tip: null,
      cta: null,
      skip: null,
      ctaGeneric: null,
      upsell: null,
      mirror: null,
      sticky: `${tier3Label} offer opens ${whenPhrase}`
    };

    if (hasTier2) {
      // A bare CTA button with no explanation left the user guessing why
      // they'd bother (founder catch, 2026-08-09: EMI already had a live
      // offer right now, but nothing on the card said so - only the credit
      // card's future date was mentioned).
      //
      // Same "% off the TRUE base, not off an already-discounted price"
      // fix as the Tier 1 branch above: no tier1Deal exists here, but a
      // GENERIC (non-payment-specific) discount can still be reducing
      // currentBestPrice (genericDealApplied) - if so, that applied
      // deal's own basePrice is the fare's real original price, not
      // currentBestPrice itself.
      const genericBaseDeal = genericDealApplied ? candidateDeals.find((d) => d?.applied) : null;
      const { label, pct } = tier2PercentAndLabel(tier2, genericBaseDeal?.basePrice);
      message.cta = {
        label: pct != null ? `Add ${label} (save ${pct}% today)` : (tier2.primaryActionLabel || `Add ${label}`),
        paymentMethod: tier2.paymentMethod
      };
      message.skip = "I'll wait";
      if (tier3Pct != null && pct != null) {
        message.sticky = `Opens ${whenPhrase} for ${tier3Pct} off — or save ${pct}% today with ${label}`;
      }
      // A same-bank EMI CTA and a generic site discount aren't mutually
      // exclusive facts - both can genuinely be true at once (founder
      // catch, 2026-08-09: exact scenario above), so this used to be an
      // "else if" that silently dropped the site-discount tip whenever a
      // Tier 2 CTA was also shown.
      if (genericDealApplied) {
        // Quantified, not just "applied" - a bare "applied" doesn't say
        // how much, which reads as vague (Kapil, 2026-08-12).
        const genericPct = genericDiscountApproxPercent(genericBaseDeal);
        message.tip = genericPct != null
          ? `Not into EMI? We've found a site discount worth about ${genericPct}% either way.`
          : "Not into EMI? A site discount's already applied either way.";
      }
    } else if (genericDealApplied) {
      // No same-bank alternative either - offer the one real next step
      // (a different card/UPI/wallet entirely) instead of a dead end.
      const genericBaseDealNoTier2 = candidateDeals.find((d) => d?.applied);
      const genericPctNoTier2 = genericDiscountApproxPercent(genericBaseDealNoTier2);
      message.tip = genericPctNoTier2 != null
        ? `Not into EMI? No worries - we've found a site discount worth about ${genericPctNoTier2}% for you.`
        : "Not into EMI? No worries - we've already applied a site discount for you.";
      message.ctaGeneric = "Add other payment options";
    }
  } else if (tier2 && tier2.additionalSaving > 0) {
    // Tier 2 alone - selected method has nothing live or upcoming, but a
    // same-bank alternative genuinely does.
    //
    // The #1 rule of this whole hierarchy (founder's own priority order:
    // "the payment method selected as is > immediate payment method offers
    // > tips and warnings") is that the heading states the truth about the
    // SELECTED method first, even when that truth is "nothing" - every
    // other branch already does this (Tier 3's own heading, Tier 4's
    // "We checked your X"). This branch alone skipped straight to the
    // alternative, which read as if sairro just didn't bother checking
    // their actual pick (founder catch, 2026-08-10). "Nearby" in the tag
    // was also wrong on its own terms - a live, same-bank, right-now offer
    // isn't "nearby", it's exactly as live and real as Tier 1's own tag
    // says, so it reuses that same tag text.
    //
    // Same "% off the TRUE base, not off an already-discounted price" fix
    // as the Tier 1 and Tier 3-alone branches (2026-08-10, commit
    // 5b60474) - this call site was missed in that pass. No tier1Deal
    // exists here, but a GENERIC (non-payment-specific) discount can still
    // be reducing currentBestPrice (genericDealApplied) - if so, that
    // applied deal's own basePrice is the fare's real original price, not
    // currentBestPrice itself (QC-caught, 2026-08-11: a real 10% Kotak EMI
    // offer was displaying as "save 6%").
    const genericBaseDealForTier2Alone = genericDealApplied ? candidateDeals.find((d) => d?.applied) : null;
    const { label, pct } = tier2PercentAndLabel(tier2, genericBaseDealForTier2Alone?.basePrice);
    const tier2MethodNames = [...new Set(selectedPaymentMethods.map((m) => m.name).filter(Boolean))];
    const tier2MethodLabel = tier2MethodNames.length ? tier2MethodNames.join(" or ") : "your selected method";
    message = {
      tier: 2,
      urgent: false,
      tag: "Same bank • live today",
      tagVariant: "live",
      heading: `No ${tier2MethodLabel} offer right now`,
      message: pct != null
        ? `${label}, though, has a live offer today - save ${pct}% by switching.`
        : `${label}, though, has a live offer today.`,
      warning: null,
      tip: null,
      cta: { label: pct != null ? `Add ${label} (save ${pct}%)` : (tier2.primaryActionLabel || `Add ${label}`), paymentMethod: tier2.paymentMethod },
      // QC-caught (copy audit, 2026-08-11): every other CTA-bearing branch
      // pairs its "Add X" button with a way to say no - this one didn't.
      skip: "Not for me",
      upsell: null,
      mirror: null,
      sticky: pct != null
        ? `No ${tier2MethodLabel} offer — ${label} saves ${pct}% instead`
        : `No ${tier2MethodLabel} offer — ${label} has one`
    };
  } else {
    // Tier 4 alone - nothing above found anything for the selected method(s).
    const methodNames = [...new Set(selectedPaymentMethods.map((m) => m.name).filter(Boolean))];
    const methodLabel = methodNames.length ? methodNames.join(" or ") : "your selected method";

    // Matches SAIRRO_VOICE_AND_CONTENT.md's A6 Case 3 ("Selected payment
    // method has no offer"): leads with "we checked" + reassurance that a
    // real best-available price was still found, instead of a checklist
    // ("credit card, debit card, and EMI options") followed by a bare
    // negative - the doc's own core principle is "never make the user
    // feel they failed to save money" (copy audit, 2026-08-11).
    // Quantified, not just "applied" - see genericDiscountApproxPercent
    // (Kapil, 2026-08-12).
    const genericBaseDealTier4 = genericDealApplied ? candidateDeals.find((d) => d?.applied) : null;
    const genericPctTier4 = genericDiscountApproxPercent(genericBaseDealTier4);

    message = {
      tier: 4,
      urgent: false,
      tag: genericPctTier4 != null ? `~${genericPctTier4}% site discount` : (genericDealApplied ? "Site discount applied" : "Nothing live today"),
      tagVariant: "live",
      heading: `We checked your ${methodLabel}`,
      message: `This didn't unlock a lower price for this flight. We still found the best available deal across portals.`,
      warning: null,
      tip: genericDealApplied
        ? (genericPctTier4 != null
            ? `Don't worry - we've found a site discount worth about ${genericPctTier4}% for you.`
            : "Don't worry - we've already applied a site discount for you.")
        : null,
      cta: null,
      skip: null,
      ctaGeneric: "Add other payment options",
      upsell: null,
      mirror: null,
      sticky: genericDealApplied
        ? (genericPctTier4 != null
            ? `Checked your ${methodLabel} — about ${genericPctTier4}% site discount found`
            : `Checked your ${methodLabel} — a site discount's already applied`)
        : `Checked your ${methodLabel} — best available price shown`
    };
  }

  // Cross-tier signal, not specific to any one tier's own logic: a
  // selected method's real offer was rejected ONLY because this fare is
  // below its minimum transaction amount, and a round-trip search would
  // likely clear that minimum (buildTimingInsights's ROUND_TRIP_MAY_UNLOCK,
  // computed generically off whatever offers/prices this search actually
  // has - never hardcoded to a specific bank/offer). It used to be
  // computed correctly but silently dropped: the insight is built with
  // paymentMethod:null (it isn't about one method), while Tier 3's own
  // selection above requires a paymentMethod match, so it could never be
  // picked up there (founder-caught, 2026-08-10). Applying it once, here,
  // after every tier branch has already had a chance to set its own tip,
  // means it fills the gap on whichever tier didn't already have one
  // instead of needing to be wired into each branch separately.
  if (message && !message.tip) {
    const roundTripHint = (timingInsights || []).find((t) => t.type === "ROUND_TRIP_MAY_UNLOCK") || null;
    if (roundTripHint) {
      message.tip = roundTripHint.message;
    }
  }

  return message;
}

// Everything /payment-suggestions actually computes, minus request
// validation and the cache/dedup lookup around it - factored out so
// /search can also call it (see getOrComputePaymentSuggestions and the
// "server-side head start" call site inside app.post("/search", ...)),
// 2026-08-03. Takes the same validated `v` shape either caller produces.
async function computePaymentSuggestionsCore(v, cfg) {
  const startedAt = Date.now();
  const selectedPaymentMethodCount = v.selectedPaymentMethods.length;

  if (v.outboundFlights.length === 0) {
    return {
      currentBestPrice: 0,
      suggestions: [],
      summary: { selectedPaymentMethodCount, matchedOfferCount: 0, isOptimised: true },
      timingInsights: [],
      meta: { truncated: false }
    };
  }

  const bestOf = (flights) => Math.min(...flights.map(bestFinalPriceOf));
  const baselineOutboundBest = bestOf(v.outboundFlights);
  const baselineReturnBest = (v.tripType === "round-trip" && v.returnFlights.length > 0) ? bestOf(v.returnFlights) : 0;
  const currentBestPrice = baselineOutboundBest + baselineReturnBest;

  // How many of the currently-loaded flights already have an offer
  // applied under the current selection - a concrete, honest reading of
  // "offers matched", not a claim about the full live offer catalog.
  const baselineFlights = [...v.outboundFlights, ...v.returnFlights];
  const matchedOfferCount = baselineFlights.filter((f) => f?.bestDeal?.applied === true).length;

  // Temporary timing instrumentation (2026-07-15) to diagnose the ~10s
  // first-load latency reported for Price intelligence - mirrors
  // /search's own `timings` object. Cheap (a handful of Date.now()
  // calls), safe to leave in the response long-term like /search does.
  const timings = {};
  let tMark = Date.now();
  const mark = (label) => {
    const now = Date.now();
    timings[label] = now - tMark;
    tMark = now;
  };

  const offers = await getOffersForSearch({});
  mark("offersLoadMs");

  const genericDisplayContext = await getGenericDisplayContextForSearch({});
  mark("genericDisplayContextMs");
  const isDomestic = isDomesticRoute(v.from, v.to);
  const requestCache = {
    infoOffersByKey: new Map(),
    pricingCandidatesByKey: new Map(),
    frontEligibilityMemo: new Map(),
    perfEligibilityMemo: true
  };
    const ctx = {
      offers,
      genericDisplayContext,
      passengers: v.passengers,
      cabin: v.travelClass,
      tripType: v.tripType,
      isDomestic,
      requestCache
    };

    // fetchPaymentSuggestions (frontend) sends the client's raw selection -
    // e.g. just {type:"Credit Card", name:"HDFC Bank"} even when "Show EMI
    // offers" is toggled on, since that toggle's own EMI expansion only
    // ever happened inside /search's payload construction, never here.
    // Without this, every EMI-typed offer is invisible to this whole
    // function (offerMatchesSelectedPayment requires an exact type match,
    // and nothing here ever carries type "EMI") - both the Phase 1/2
    // suggestions AND the Phase 3 round-trip hint below silently can never
    // see them. Same expansion /search and /compare-selected-trip already
    // apply, kept separate from v.selectedPaymentMethods (used below only
    // for the user-facing "N payment methods selected" count, which should
    // stay the count of what the user actually picked, not the tenure
    // variants being tried on their behalf).
    const selectedPaymentMethods = expandEmiPaymentMethods(v.selectedPaymentMethods, offers);

    const candidates = await buildCandidatePaymentMethods(selectedPaymentMethods, offers, cfg);
    mark("buildCandidatesMs");

    // Relevance filter runs before the (expensive) reprice loop: tier-5
    // "unrelated bank" candidates are dropped entirely here, not merely
    // ranked last - so a larger saving from an unrelated bank can never
    // outrank, or even appear alongside, a same-bank/UPI/wallet suggestion.
    const relevantCandidates = candidates.filter(
      (c) => candidateRelevanceTier(c, selectedPaymentMethods) <= 4
    );

    const flightsTested = v.outboundFlights.length + (v.tripType === "round-trip" ? v.returnFlights.length : 0);
    let truncated = false;
    const perCandidateMs = []; // temporary (2026-07-15) - see mark() above

    // Phase A - screening: reprice every relevant candidate against only
    // the cheapest candidateScreeningFlightSample flights per leg (see
    // config comment) instead of everything loaded - this is what was
    // actually taking ~13s per candidate on a real 80-flight search.
    // affectedFlights/breadthPercent here are estimates from the sample,
    // good enough to RANK candidates; the numbers actually shown to the
    // user come from the exact refine pass below.
    const screeningOutbound = [...v.outboundFlights]
      .sort((a, b) => bestFinalPriceOf(a) - bestFinalPriceOf(b))
      .slice(0, cfg.candidateScreeningFlightSample);
    const screeningReturn = v.tripType === "round-trip"
      ? [...v.returnFlights].sort((a, b) => bestFinalPriceOf(a) - bestFinalPriceOf(b)).slice(0, cfg.candidateScreeningFlightSample)
      : [];

    const screened = [];

    for (const candidate of relevantCandidates) {
      if (Date.now() - startedAt > cfg.softTimeBudgetMs) {
        truncated = true;
        break;
      }

      const __candidateStart = Date.now();
      const hypothetical = [...selectedPaymentMethods, candidate];

      const outboundRepriced = await repriceFlightsForPaymentMethods(screeningOutbound, hypothetical, ctx);
      const newOutboundBest = Math.min(
        ...outboundRepriced.map((r, i) => finalPriceFromRepriced(r, screeningOutbound[i]))
      );
      const affectedOutboundFlights = outboundRepriced.filter(
        (r, i) => finalPriceFromRepriced(r, screeningOutbound[i]) < bestFinalPriceOf(screeningOutbound[i])
      ).length;

      let newReturnBest = 0;
      let affectedReturnFlights = 0;

      if (v.tripType === "round-trip" && screeningReturn.length > 0) {
        const returnRepriced = await repriceFlightsForPaymentMethods(screeningReturn, hypothetical, ctx);
        newReturnBest = Math.min(
          ...returnRepriced.map((r, i) => finalPriceFromRepriced(r, screeningReturn[i]))
        );
        affectedReturnFlights = returnRepriced.filter(
          (r, i) => finalPriceFromRepriced(r, screeningReturn[i]) < bestFinalPriceOf(screeningReturn[i])
        ).length;
      }

      const newBestPrice = newOutboundBest + newReturnBest;
      const additionalSaving = Math.round(currentBestPrice - newBestPrice);

      perCandidateMs.push({ candidate: `${candidate.type}|${candidate.name}|${candidate.tenureMonths ?? ""}`, ms: Date.now() - __candidateStart });

      const isValid =
        additionalSaving >= cfg.minAbsoluteSavingInr ||
        (currentBestPrice > 0 && additionalSaving / currentBestPrice >= cfg.minPercentSaving);

      if (!isValid) continue;

      const tier = candidateRelevanceTier(candidate, selectedPaymentMethods);
      const totalAffectedFlights = affectedOutboundFlights + affectedReturnFlights;
      const sampleSize = screeningOutbound.length + screeningReturn.length;
      const breadthPercent = sampleSize > 0 ? (totalAffectedFlights / sampleSize) * 100 : 0;
      const easeScore = easeOfAdoptionScore(candidate);
      const screeningScore = computeRecommendationScore({ tier, additionalSaving, easeScore, totalAffectedFlights, breadthPercent });

      screened.push({ candidate, relevanceTier: tier, easeScore, _screeningScore: screeningScore });
    }
    mark("screeningLoopMs");

    // When the same bank surfaces more than once (e.g. multiple valid EMI
    // tenures), keep only the single highest-screening-score suggestion
    // for it before spending a refine pass on it.
    const bestScreenedByKey = new Map();
    for (const r of screened) {
      const key = `${r.candidate.type}|${r.candidate.name}`.toLowerCase();
      const existing = bestScreenedByKey.get(key);
      if (!existing || r._screeningScore > existing._screeningScore) bestScreenedByKey.set(key, r);
    }
    const screenedRanked = Array.from(bestScreenedByKey.values()).sort((a, b) => b._screeningScore - a._screeningScore);
    const isOptimised = screenedRanked.length === 0;

    // Phase B - refine: only the handful of candidates that could
    // plausibly make the final cut (maxSuggestions + a small buffer, in
    // case the sampled screening ranking put the true top candidates just
    // outside the cut) get re-priced against the COMPLETE loaded flight
    // set, so the rupee saving and "improves N flights" numbers actually
    // shown to the user are always exact, never sampled estimates.
    const refineCandidates = screenedRanked.slice(0, cfg.maxSuggestions + cfg.candidateRefineBuffer);
    const results = [];

    for (const r of refineCandidates) {
      if (Date.now() - startedAt > cfg.softTimeBudgetMs) {
        truncated = true;
        break;
      }

      const hypothetical = [...selectedPaymentMethods, r.candidate];

      const outboundRepriced = await repriceFlightsForPaymentMethods(v.outboundFlights, hypothetical, ctx);
      const { bestFinal: newOutboundBest, bestBase: newOutboundBestBase } = findBestIndexAndBasePrice(outboundRepriced, v.outboundFlights);
      const affectedOutboundFlights = outboundRepriced.filter(
        (rr, i) => finalPriceFromRepriced(rr, v.outboundFlights[i]) < bestFinalPriceOf(v.outboundFlights[i])
      ).length;

      let newReturnBest = 0;
      let newReturnBestBase = 0;
      let affectedReturnFlights = 0;

      if (v.tripType === "round-trip" && v.returnFlights.length > 0) {
        const returnRepriced = await repriceFlightsForPaymentMethods(v.returnFlights, hypothetical, ctx);
        ({ bestFinal: newReturnBest, bestBase: newReturnBestBase } = findBestIndexAndBasePrice(returnRepriced, v.returnFlights));
        affectedReturnFlights = returnRepriced.filter(
          (rr, i) => finalPriceFromRepriced(rr, v.returnFlights[i]) < bestFinalPriceOf(v.returnFlights[i])
        ).length;
      }

      const newBestPrice = newOutboundBest + newReturnBest;
      // The SAME-flight base price behind newBestPrice above - lets any
      // consumer compute this candidate's own true discount percentage
      // (newBestBasePrice - newBestPrice) / newBestBasePrice exactly,
      // instead of approximating with a different flight's fare or the
      // already-discounted currentBestPrice (QC-caught, 2026-08-11).
      const newBestBasePrice = newOutboundBestBase + newReturnBestBase;
      const additionalSaving = Math.round(currentBestPrice - newBestPrice);
      const totalAffectedFlights = affectedOutboundFlights + affectedReturnFlights;
      const breadthPercent = flightsTested > 0 ? (totalAffectedFlights / flightsTested) * 100 : 0;
      const score = computeRecommendationScore({
        tier: r.relevanceTier,
        additionalSaving,
        easeScore: r.easeScore,
        totalAffectedFlights,
        breadthPercent
      });

      results.push({
        candidate: r.candidate,
        relevanceTier: r.relevanceTier,
        category: candidateCategoryLabel(r.relevanceTier),
        additionalSaving,
        newBestPrice,
        newBestBasePrice,
        affectedOutboundFlights,
        affectedReturnFlights,
        affectedFlights: totalAffectedFlights,
        _easeScore: r.easeScore,
        _score: score
      });
    }
    mark("repriceLoopMs");

    // A single descending sort on _score reproduces the full precedence
    // order (relevance tier > saving > ease of adoption > flights
    // improved > breadth) - see RECOMMENDATION_SCORE_WEIGHTS for why this
    // is safe rather than approximate. Re-sorting here (rather than
    // trusting screening order) since the refine pass's exact numbers can
    // reorder a close screening ranking.
    const ranked = results.sort((a, b) => b._score - a._score);

    const finalList = ranked.slice(0, cfg.maxSuggestions);

    // Label/copy are computed only after the final (<=2) list is fixed,
    // since "Best saving" / "Works on more flights" are comparative
    // within that shown pair, not across the whole candidate pool.
    const suggestions = finalList.map((r) => {
      const label = pickSuggestionLabel(r, finalList);
      const reasonCode = reasonCodeFor(r.candidate, r.relevanceTier);
      const copy = buildSuggestionCopy({
        candidate: r.candidate,
        tier: r.relevanceTier,
        additionalSaving: r.additionalSaving,
        totalAffectedFlights: r.affectedFlights,
        label
      });

      return {
        type: "ADD_PAYMENT_METHOD",
        paymentMethod: {
          type: r.candidate.type,
          name: r.candidate.name,
          provider: r.candidate.provider,
          network: r.candidate.network,
          cardFamily: r.candidate.cardFamily,
          cardVariant: r.candidate.cardVariant,
          isCorporate: r.candidate.isCorporate,
          tenureMonths: r.candidate.tenureMonths
        },
        category: r.category,
        label,
        additionalSaving: r.additionalSaving,
        newBestPrice: r.newBestPrice,
        newBestBasePrice: r.newBestBasePrice,
        affectedFlights: r.affectedFlights,
        affectedOutboundFlights: r.affectedOutboundFlights,
        affectedReturnFlights: r.affectedReturnFlights,
        relevanceTier: r.relevanceTier,
        reasonCode,
        heading: copy.heading,
        message: copy.message,
        primaryActionLabel: copy.primaryActionLabel
      };
    });

    // Phase 3 timing insights - reuses the same offers/ctx/currentBestPrice
    // already computed above; wrapped defensively so a timing-specific
    // failure degrades to an empty array rather than breaking Phase 1/2
    // suggestions (which have already been fully computed by this point).
    let timingInsights = [];
    try {
      timingInsights = await buildTimingInsights({
        selectedPaymentMethods,
        offers,
        ctx,
        currentBestPrice,
        outboundFlights: v.outboundFlights,
        returnFlights: v.returnFlights,
        tripType: v.tripType,
        outboundTravelDateISO: v.outboundTravelDate,
        recCfg: cfg,
        precomputedCandidates: candidates
      });
    } catch (timingErr) {
      console.error("[SkyDeal] timing insights failed", timingErr);
      timingInsights = [];
    }
    mark("timingInsightsMs");

    // Sairro decode priority hierarchy (2026-08-08) - reuses suggestions/
    // timingInsights/offers already computed above, never re-prices
    // anything. Wrapped defensively like timing insights: a failure here
    // degrades to null (frontend falls back to its prior rendering) and
    // never breaks suggestions/timingInsights, which are already done.
    let primaryDecodeMessage = null;
    try {
      primaryDecodeMessage = resolvePrimaryDecodeMessage({
        selectedPaymentMethods,
        outboundFlights: v.outboundFlights,
        returnFlights: v.returnFlights,
        tripType: v.tripType,
        suggestions,
        timingInsights,
        offers
      });
    } catch (primaryMsgErr) {
      console.error("[SkyDeal] primary decode message failed", primaryMsgErr);
      primaryDecodeMessage = null;
    }
    mark("primaryDecodeMessageMs");

    timings.totalMs = Date.now() - startedAt;
    timings.candidatesConsidered = relevantCandidates.length;
    timings.flightsTested = flightsTested;
    timings.perCandidateMs = perCandidateMs;

  return {
    currentBestPrice,
    suggestions,
    summary: { selectedPaymentMethodCount, matchedOfferCount, isOptimised },
    timingInsights,
    primaryDecodeMessage,
    meta: { truncated, timings }
  };
}

// Phase 2 cache (unchanged semantics from before the 2026-08-03 refactor):
// identical (route/selection/flights) state within the TTL, and no live
// offer refresh since, skips candidate generation and the entire reprice
// loop entirely.
//
// paymentSuggestionsInFlight is new: a request for a key that's already
// being computed - most commonly /search's own fire-and-forget warm-up
// (see the "server-side head start" call site in app.post("/search",
// ...)) still running when the frontend's real /payment-suggestions call
// lands moments later - awaits that SAME promise instead of starting a
// second, fully redundant pass. Populated synchronously before the first
// await inside, so a near-simultaneous second caller always finds it.
const paymentSuggestionsInFlight = new Map();

async function getOrComputePaymentSuggestions(v, cfg) {
  const cacheKey = buildSuggestionsCacheKey(v);

  const cached = paymentSuggestionsCache.get(cacheKey);
  const nowTs = Date.now();
  if (
    cached &&
    (nowTs - cached.cachedAt) < cfg.suggestionsCacheTtlMs &&
    cached.offersCacheLoadedAtSnapshot === offersCacheLoadedAt
  ) {
    return cached.result;
  }

  const inFlight = paymentSuggestionsInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  const promise = computePaymentSuggestionsCore(v, cfg)
    .then((result) => {
      paymentSuggestionsCache.set(cacheKey, {
        result,
        cachedAt: Date.now(),
        offersCacheLoadedAtSnapshot: offersCacheLoadedAt
      });
      // Simple unbounded-growth guard - not a real LRU, just a safety net.
      if (paymentSuggestionsCache.size > 200) paymentSuggestionsCache.clear();
      return result;
    })
    .finally(() => {
      paymentSuggestionsInFlight.delete(cacheKey);
    });

  paymentSuggestionsInFlight.set(cacheKey, promise);
  return promise;
}

app.post("/payment-suggestions", async (req, res) => {
  const cfg = PAYMENT_RECOMMENDATION_CONFIG;
  const v = validatePaymentRepriceRequest(req.body, cfg);

  if (!v.ok) {
    return res.status(400).json({ error: v.errors.join("; ") });
  }

  try {
    const responseBody = await getOrComputePaymentSuggestions(v, cfg);
    return res.json(responseBody);
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Payment suggestions failed" });
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

