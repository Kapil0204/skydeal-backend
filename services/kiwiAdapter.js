// services/kiwiAdapter.js — ESM
// Uses global fetch (Node 18+). Ensure RAPIDAPI_KEY is set in your env.

/**
 * Convert a date (ISO 'YYYY-MM-DD', JS Date, or already 'DD/MM/YYYY')
 * into 'DD/MM/YYYY' which Kiwi expects.
 */
function toDDMMYYYY(input) {
  if (!input) return "";

  if (typeof input === "string") {
    const iso = input.trim();

    // Already DD/MM/YYYY?
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(iso)) return iso;

    // YYYY-MM-DD -> DD/MM/YYYY
    const mIso = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (mIso) {
      const [, yyyy, mm, dd] = mIso;
      return `${dd}/${mm}/${yyyy}`;
    }

    // YYYY/MM/DD -> DD/MM/YYYY
    const mSlash = iso.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
    if (mSlash) {
      const [, yyyy, mm, dd] = mSlash;
      return `${dd}/${mm}/${yyyy}`;
    }

    // Fallback: try to parse as Date
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) {
      const dd = String(d.getDate()).padStart(2, "0");
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const yyyy = d.getFullYear();
      return `${dd}/${mm}/${yyyy}`;
    }

    // If unknown format, return as-is (Kiwi may error but we'll surface it)
    return iso;
  }

  // Date object
  const d = new Date(input);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/**
 * Safely read response as text (for better error messages).
 */
async function safeText(res) {
  try { return await res.text(); } catch { return ""; }
}

/**
 * Core: call Kiwi "round-trip" via RapidAPI.
 * For one-way, send empty return dates.
 *
 * @param {Object} params
 * @param {string} params.from - IATA code (e.g., BLR)
 * @param {string} params.to - IATA code (e.g., DEL)
 * @param {string|Date} params.departureDate - YYYY-MM-DD or Date
 * @param {string|Date} [params.returnDate] - optional; YYYY-MM-DD or Date
 * @param {number} [params.adults=1]
 * @param {string} [params.travelClass="economy"] - economy|business|first|premium_economy
 * @param {string} [params.currency="INR"]
 */
export async function kiwiRoundTrip({
  from, to, departureDate, returnDate = "",
  adults = 1, travelClass = "economy", currency = "INR"
}) {
  if (!process.env.RAPIDAPI_KEY) {
    throw new Error("RAPIDAPI_KEY not set. Add it to your Render env (or local env).");
  }
  if (!from || !to || !departureDate) {
    throw new Error("from, to, and departureDate are required.");
  }

  const url = new URL("https://kiwi-com-cheap-flights.p.rapidapi.com/round-trip");

  // Kiwi prefers DD/MM/YYYY
  const dep = toDDMMYYYY(departureDate);
  url.searchParams.set("from", from.toUpperCase());
  url.searchParams.set("to", to.toUpperCase());
  url.searchParams.set("dateFrom", dep);
  url.searchParams.set("dateTo", dep);

  if (returnDate) {
    const ret = toDDMMYYYY(returnDate);
    url.searchParams.set("returnFrom", ret);
    url.searchParams.set("returnTo", ret);
  } else {
    url.searchParams.set("returnFrom", "");
    url.searchParams.set("returnTo", "");
  }

  url.searchParams.set("adults", String(adults));
  url.searchParams.set("selectedCabins", String(travelClass || "economy").toLowerCase());
  url.searchParams.set("currency", currency || "INR");

  const res = await fetch(url, {
    headers: {
      "X-RapidAPI-Key": process.env.RAPIDAPI_KEY,
      "X-RapidAPI-Host": "kiwi-com-cheap-flights.p.rapidapi.com"
    }
  });

  // We purposely don't treat non-200 as ok; surface text
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`Kiwi API ${res.status}: ${body?.slice(0, 500)}`);
  }

  // Some RapidAPI providers return 200 with an error payload; let caller inspect content
  return res.json();
}

/**
 * Recursively collect airline codes/names (best-effort across unknown shapes).
 * Returns an array of uppercased strings.
 */
export function extractCarriers(json) {
  const carriers = new Set();

  const walk = (node, keyHint = "") => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach((v) => walk(v));
      return;
    }
    if (typeof node !== "object") return;

    for (const [k, v] of Object.entries(node)) {
      const lk = k.toLowerCase();

      if (typeof v === "string") {
        if (lk.includes("airline") || lk.includes("carrier") || lk === "marketingCarrier" || lk === "operatingCarrier") {
          carriers.add(v.toUpperCase());
        }
      } else if (Array.isArray(v)) {
        if (lk.includes("airlines") || lk.includes("carriers")) {
          v.forEach((x) => typeof x === "string" && carriers.add(x.toUpperCase()));
        }
        v.forEach((x) => walk(x, lk));
      } else if (typeof v === "object") {
        // Sometimes carrier code/name fields are nested
        if (v && typeof v.code === "string" && (lk.includes("airline") || lk.includes("carrier"))) {
          carriers.add(v.code.toUpperCase());
        }
        if (v && typeof v.name === "string" && (lk.includes("airline") || lk.includes("carrier"))) {
          carriers.add(v.name.toUpperCase());
        }
        walk(v, lk);
      }
    }
  };

  walk(json);
  return [...carriers].slice(0, 100);
}

/**
 * Best-effort scan for any plausible price number.
 * (Different providers/versions use different fields.)
 */
export function findAnyPrice(json) {
  let found = null;

  const walk = (node) => {
    if (found !== null || !node) return;
    if (Array.isArray(node)) {
      for (const v of node) {
        if (found !== null) break;
        walk(v);
      }
      return;
    }
    if (typeof node !== "object") return;

    for (const [k, v] of Object.entries(node)) {
      if (found !== null) break;

      if (typeof v === "number" && /price|total|amount|fare|value|grand/i.test(k)) {
        found = v; break;
      }

      if (typeof v === "string" && /price|total|amount|fare|value|grand/i.test(k)) {
        const n = parseFloat(v.replace(/[, ₹$€]/g, ""));
        if (!Number.isNaN(n)) { found = n; break; }
      }

      if (typeof v === "object") walk(v);
    }
  };

  walk(json);
  return found;
}

/**
 * Quick presence check for key Indian LCCs.
 * Looks for code or name anywhere in the payload.
 */
export function lccPresence(json) {
  const carriers = extractCarriers(json);
  const asText = JSON.stringify(json).toUpperCase();

  const has = (token) =>
    carriers.includes(token) || asText.includes(token);

  return {
    indigo: has("6E") || has("INDIGO"),
    akasa: has("QP") || has("AKASA"),
    spicejet: has("SG") || has("SPICEJET"),
    carriersSample: carriers.slice(0, 20),
  };
}
