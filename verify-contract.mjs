#!/usr/bin/env node
/**
 * verify-contract.mjs — Frontend ↔ Backend contract smoke test.
 *
 * Actively catches the "silent drift" risk (CURRENT_BUGS.md #3): if a field
 * the frontend depends on gets renamed or removed on the backend, this fails
 * LOUDLY instead of the product silently breaking. Run it before any deploy.
 *
 * Source of truth for the shapes checked here: CONTRACT.md.
 *
 * Usage:
 *   node verify-contract.mjs                 # checks /payment-options only (FREE, no FlightAPI quota)
 *   node verify-contract.mjs --live          # ALSO checks /search + /compare-selected-trip (uses ~2 FlightAPI calls)
 *   BACKEND=http://localhost:10000 node verify-contract.mjs   # override target
 *
 * Exit code 0 = contract intact, 1 = a checked field is missing/wrong.
 */

const BACKEND = process.env.BACKEND || "https://skydeal-backend.onrender.com";
const RUN_LIVE = process.argv.includes("--live") || process.env.RUN_LIVE === "1";
const TIMEOUT_MS = Number(process.env.CONTRACT_TIMEOUT_MS || 60000);

let failures = 0;
let checks = 0;

function check(label, condition) {
  checks += 1;
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    failures += 1;
    console.log(`  ❌ ${label}`);
  }
}

async function fetchJson(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BACKEND}${path}`, { ...options, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* leave null */ }
    return { res, json, text };
  } finally {
    clearTimeout(timer);
  }
}

function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }

// --- 1. GET /payment-options (free) --------------------------------------
async function checkPaymentOptions() {
  console.log("\n[1] GET /payment-options");
  const { res, json } = await fetchJson("/payment-options");
  check("HTTP 200", res.status === 200);
  check("body is JSON object", isObj(json));
  check("has `options` object", isObj(json?.options));
  const firstKey = json?.options ? Object.keys(json.options)[0] : null;
  check("at least one payment-type key", Boolean(firstKey));
  check("payment-type value is an array", Array.isArray(json?.options?.[firstKey]));
}

// --- 2. POST /search (uses 1 FlightAPI call) -----------------------------
async function checkSearch() {
  console.log("\n[2] POST /search  (one-way, uses FlightAPI quota)");
  const payload = {
    from: "DEL",
    to: "BOM",
    departureDate: nextWeekISO(),
    returnDate: "",
    tripType: "one-way",
    passengers: 1,
    travelClass: "economy",
    includeGenericDisplayOffers: true,
    paymentMethods: []
  };
  const { res, json } = await fetchJson("/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  check("HTTP 200", res.status === 200);
  check("has `meta` object", isObj(json?.meta));
  check("has `outboundFlights` array", Array.isArray(json?.outboundFlights));
  check("has `returnFlights` array", Array.isArray(json?.returnFlights));

  // When /search is non-200 but the SHAPE is intact, it's a runtime problem
  // (usually FlightAPI slowness/timeout), not a contract drift. Surface the
  // reason so the failure is self-explanatory.
  if (res.status !== 200) {
    console.log(`  ⚠️  runtime (not contract): meta.error=${JSON.stringify(json?.meta?.error)} outStatus=${json?.meta?.outStatus}`);
    const tried = json?.meta?.request?.outTried || json?.meta?.request?.tried || [];
    if (Array.isArray(tried) && tried.length) {
      console.log(`  ⚠️  FlightAPI attempts: ${tried.map((t) => t.status).join(", ")}`);
    }
  }

  const f = json?.outboundFlights?.[0];
  if (!f) {
    console.log("  ⚠️  no flights returned — skipping Flight/PortalPrice field checks (route/date may be empty or FlightAPI timed out)");
    return;
  }
  check("Flight has airlineName", "airlineName" in f);
  check("Flight has flightNumber", "flightNumber" in f);
  check("Flight has departureTime", "departureTime" in f);
  check("Flight has arrivalTime", "arrivalTime" in f);
  check("Flight has portalPrices array", Array.isArray(f.portalPrices));
  check("Flight has bestDeal key", "bestDeal" in f);

  const pp = f.portalPrices?.[0];
  if (pp) {
    check("PortalPrice has portal", "portal" in pp);
    check("PortalPrice has basePrice", "basePrice" in pp);
    check("PortalPrice has finalPrice", "finalPrice" in pp);
    check("PortalPrice has applied", "applied" in pp);
    check("PortalPrice has infoOffers array", Array.isArray(pp.infoOffers));
    check("PortalPrice has moreOffers array", Array.isArray(pp.moreOffers));
  }
}

// --- 3. POST /compare-selected-trip (uses FlightAPI indirectly) ----------
async function checkCompare() {
  console.log("\n[3] POST /compare-selected-trip  (round-trip)");
  const slim = (fn) => ({
    airlineName: "Test Air",
    flightNumber: fn,
    departureTime: "10:00",
    arrivalTime: "12:00",
    stops: 0,
    price: 5000
  });
  const payload = {
    from: "DEL",
    to: "BOM",
    tripType: "round-trip",
    adults: 1,
    passengers: 1,
    travelClass: "economy",
    paymentMethods: [],
    includeGenericDisplayOffers: true,
    outboundFlight: slim("AI101"),
    returnFlight: slim("AI102")
  };
  const { res, json } = await fetchJson("/compare-selected-trip", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  check("HTTP 200", res.status === 200);
  check("has `tripComparison` object", isObj(json?.tripComparison));
  check("tripComparison has baseTotal", json?.tripComparison && "baseTotal" in json.tripComparison);
  check("tripComparison has portalPrices array", Array.isArray(json?.tripComparison?.portalPrices));
  check("tripComparison has bestDeal key", json?.tripComparison && "bestDeal" in json.tripComparison);
}

function nextWeekISO() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d.toISOString().slice(0, 10);
}

async function main() {
  console.log(`SkyDeal contract check → ${BACKEND}`);
  console.log(RUN_LIVE ? "Mode: FULL (uses FlightAPI quota)" : "Mode: FREE (/payment-options only — pass --live for the rest)");

  await checkPaymentOptions();
  if (RUN_LIVE) {
    await checkSearch();
    await checkCompare();
  }

  console.log(`\n${failures === 0 ? "✅ PASS" : "❌ FAIL"} — ${checks - failures}/${checks} checks passed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n❌ Contract check crashed:", err?.message || err);
  process.exit(1);
});
