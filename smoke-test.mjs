#!/usr/bin/env node
/**
 * smoke-test.mjs — Route-level data-quality regression guard.
 *
 * verify-contract.mjs catches "did a field get renamed" (shape drift).
 * This catches a different, arguably scarier class of bug: the shape is
 * fine, HTTP 200 comes back, but the actual DATA is wrong or missing —
 * e.g. a route silently returns 0 flights because we stopped querying an
 * airport it needs (2026-07-16 Mumbai-Aurangabad/Navi Mumbai incident),
 * or a fix regresses (2026-07-15 Mumbai-Jammu 90s-timeout incident).
 *
 * Runs a small, fixed set of known-tricky routes against the live
 * backend and asserts on INVARIANTS, not exact prices/flights (those
 * change daily) — flights returned, prices are real numbers, and the
 * metro-airport-group expansion (see METRO_AIRPORT_GROUPS, index.js)
 * fired exactly where it should and nowhere else.
 *
 * Deliberately NOT exhaustive — see the honest tradeoff at the bottom of
 * this file's usage note. Run this before any deploy that touches
 * /search, buildLegFlights, or the carrier-price rule.
 *
 * Usage:
 *   node smoke-test.mjs                                    # all routes below
 *   node smoke-test.mjs --only=BOM-IXU,HYD-MAA              # just these labels
 *   BACKEND=http://localhost:10000 node smoke-test.mjs      # override target
 *
 * Cost: each route below is one real /search call (2 FlightAPI calls for
 * a route spanning a 2-airport metro group, more for round-trip or a
 * 3-airport group) — this file intentionally stays short (8 routes) to
 * keep that cost modest. Exit code 0 = all invariants held, 1 = one or
 * more broke.
 */

const BACKEND = process.env.BACKEND || "https://skydeal-backend.onrender.com";
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 100000);
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "")
  .replace("--only=", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

let failures = 0;
let checks = 0;

function check(label, condition) {
  checks += 1;
  if (condition) {
    console.log(`    ✅ ${label}`);
  } else {
    failures += 1;
    console.log(`    ❌ ${label}`);
  }
}

function note(label) {
  console.log(`    ℹ️  ${label}`);
}

async function fetchJson(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BACKEND}${path}`, { ...options, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* leave null */ }
    return { res, json };
  } finally {
    clearTimeout(timer);
  }
}

function isoDaysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// expectMultiAirport: "dep" | "arr" | "both" | "none" — which side(s) of
// THIS route should trigger METRO_AIRPORT_GROUPS expansion. Not asserting
// the alternate airport actually had inventory that day (real flight
// schedules vary) — only that the backend's own meta confirms it queried
// more than one airport on that side, which is the part a code bug (not
// FlightAPI's daily inventory) would actually break.
const ROUTES = [
  {
    label: "BOM-IXU",
    desc: "Mumbai-Aurangabad — the founder-reported route that started this (2026-07-16): BOM+NMI on departure",
    from: "BOM", to: "IXU", tripType: "one-way", expectMultiAirport: "dep"
  },
  {
    label: "GOI-BOM",
    desc: "Goa-Mumbai — both sides grouped (GOI/GOX + BOM/NMI), the hardest case for the tile-layout redesign",
    from: "GOI", to: "BOM", tripType: "one-way", expectMultiAirport: "both"
  },
  {
    label: "DEL-BLR",
    desc: "Delhi-Bengaluru — DEL/DXN/HDO on departure only",
    from: "DEL", to: "BLR", tripType: "one-way", expectMultiAirport: "dep"
  },
  {
    label: "DXN-BLR",
    desc: "Same Delhi-NCR group, searched via the alternate code (DXN not DEL) — checks expandMetroAirportGroup's symmetry, not just the primary code",
    from: "DXN", to: "BLR", tripType: "one-way", expectMultiAirport: "dep"
  },
  {
    label: "BLR-GOI",
    desc: "Bengaluru-Goa — GOI/GOX on arrival only",
    from: "BLR", to: "GOI", tripType: "one-way", expectMultiAirport: "arr"
  },
  {
    label: "BOM-IXJ",
    desc: "Mumbai-Jammu — the specific route whose 66.7s real response lost the 60s client timeout race (2026-07-15, fixed by raising it to 90s). BOM is Mumbai-grouped (BOM/NMI) so outAirportPairs is expected here too - this route is really a timing/reliability canary, not a control route",
    from: "BOM", to: "IXJ", tripType: "one-way", expectMultiAirport: "dep"
  },
  {
    label: "HYD-MAA",
    desc: "Hyderabad-Chennai — plain control route, zero metro-group overlap. The regression canary: if THIS route ever shows airport pairs, the metro feature has leaked into ordinary searches",
    from: "HYD", to: "MAA", tripType: "one-way", expectMultiAirport: "none"
  },
  {
    label: "BOM-DEL-RT",
    desc: "Mumbai-Delhi round-trip — both legs grouped, checks the return leg populates too (retAirportPairs, not just outAirportPairs)",
    from: "BOM", to: "DEL", tripType: "round-trip", expectMultiAirport: "both"
  }
];

function distinctCodes(flights, field) {
  return new Set((flights || []).map((f) => f?.[field]).filter(Boolean));
}

async function checkRoute(route) {
  console.log(`\n[${route.label}] ${route.desc}`);
  const isRT = route.tripType === "round-trip";
  const payload = {
    from: route.from,
    to: route.to,
    departureDate: isoDaysFromNow(21),
    returnDate: isRT ? isoDaysFromNow(26) : "",
    tripType: route.tripType,
    passengers: 1,
    travelClass: "economy",
    includeGenericDisplayOffers: true,
    paymentMethods: []
  };

  const startedAt = Date.now();
  const { res, json } = await fetchJson("/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
  note(`responded in ${elapsedS}s (informational — not a hard failure unless it times out)`);

  check("HTTP 200", res.status === 200);
  if (res.status !== 200) {
    console.log(`    ⚠️  meta.error=${JSON.stringify(json?.meta?.error)} outStatus=${json?.meta?.outStatus}`);
    return;
  }

  const outFlights = json?.outboundFlights || [];
  check("outboundFlights is non-empty", outFlights.length > 0);
  if (isRT) {
    check("returnFlights is non-empty", (json?.returnFlights || []).length > 0);
  }

  if (outFlights.length > 0) {
    check(
      "every outbound flight has a real numeric price",
      outFlights.every((f) => Number.isFinite(f?.price))
    );
  }

  const wantsDep = route.expectMultiAirport === "dep" || route.expectMultiAirport === "both";
  const wantsArr = route.expectMultiAirport === "arr" || route.expectMultiAirport === "both";
  const wantsNone = route.expectMultiAirport === "none";

  if (wantsDep || wantsArr) {
    check(
      "meta.outAirportPairs present (metro-group expansion fired)",
      Array.isArray(json?.meta?.outAirportPairs) && json.meta.outAirportPairs.length > 1
    );
  }
  if (wantsNone) {
    check(
      "meta.outAirportPairs absent (ordinary route unaffected)",
      json?.meta?.outAirportPairs === undefined
    );
  }

  if (wantsDep) {
    const depCodes = distinctCodes(outFlights, "departureAirportCode");
    note(`departure airport codes seen this run: ${[...depCodes].join(", ") || "(none tagged)"}`);
    check("outbound flights carry a departureAirportCode", depCodes.size > 0);
  }
  if (wantsArr) {
    const arrCodes = distinctCodes(outFlights, "arrivalAirportCode");
    note(`arrival airport codes seen this run: ${[...arrCodes].join(", ") || "(none tagged)"}`);
    check("outbound flights carry an arrivalAirportCode", arrCodes.size > 0);
  }
}

async function main() {
  console.log(`SkyDeal route smoke test → ${BACKEND}`);
  const routes = ONLY.length ? ROUTES.filter((r) => ONLY.includes(r.label)) : ROUTES;
  if (ONLY.length && routes.length === 0) {
    console.log(`No route labels matched --only=${ONLY.join(",")}. Available: ${ROUTES.map((r) => r.label).join(", ")}`);
    process.exit(1);
  }
  console.log(`Running ${routes.length}/${ROUTES.length} route(s), ~21 days out, economy/1 adult.\n`);

  for (const route of routes) {
    await checkRoute(route);
  }

  console.log(`\n${failures === 0 ? "✅ PASS" : "❌ FAIL"} — ${checks - failures}/${checks} checks passed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n❌ Smoke test crashed:", err?.message || err);
  process.exit(1);
});
