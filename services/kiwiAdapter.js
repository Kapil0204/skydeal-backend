// services/kiwiAdapter.js — ESM

// ---- Core call to Kiwi via RapidAPI (round-trip) ----
export async function kiwiRoundTrip({
  from, to, departureDate, returnDate = "",
  adults = 1, travelClass = "economy", currency = "INR"
}) {
  const url = new URL("https://kiwi-com-cheap-flights.p.rapidapi.com/round-trip");
  url.searchParams.set("from", from);                 // IATA, e.g., BLR
  url.searchParams.set("to", to);                     // IATA, e.g., DEL
  url.searchParams.set("dateFrom", departureDate);    // YYYY-MM-DD
  url.searchParams.set("dateTo", departureDate);      // same day
  url.searchParams.set("returnFrom", returnDate || "");
  url.searchParams.set("returnTo", returnDate || "");
  url.searchParams.set("adults", String(adults));
  url.searchParams.set("selectedCabins", travelClass.toLowerCase()); // economy|business
  url.searchParams.set("currency", currency);

  const res = await fetch(url, {
    headers: {
      "X-RapidAPI-Key": process.env.RAPIDAPI_KEY,
      "X-RapidAPI-Host": "kiwi-com-cheap-flights.p.rapidapi.com"
    }
  });

  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`Kiwi API ${res.status}: ${body?.slice(0,300)}`);
  }
  return res.json();
}

async function safeText(res) {
  try { return await res.text(); } catch { return ""; }
}

// ---- Utility: collect airline codes/names found anywhere in the JSON ----
export function extractCarriers(json) {
  const carriers = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      const key = k.toLowerCase();
      if (typeof v === "string") {
        if (key.includes("airline") || key.includes("carrier")) carriers.add(v.toUpperCase());
      } else if (Array.isArray(v)) {
        if (key.includes("airlines") || key.includes("carriers")) {
          v.forEach(x => typeof x === "string" && carriers.add(x.toUpperCase()));
        }
        v.forEach(walk);
      } else if (typeof v === "object") {
        walk(v);
      }
    }
  };
  walk(json);
  return [...carriers].slice(0, 100);
}

// ---- Utility: find any plausible price number in the JSON (best-effort) ----
export function findAnyPrice(json) {
  let found = null;
  const walk = (node) => {
    if (found !== null || !node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (found !== null) break;
      if (typeof v === "number" && /price|total|amount|fare|value/i.test(k)) {
        found = v; break;
      }
      if (typeof v === "string" && /price|total|amount|fare|value/i.test(k)) {
        const n = parseFloat(v.replace(/[,₹$]/g, ""));
        if (!Number.isNaN(n)) { found = n; break; }
      }
      if (typeof v === "object") walk(v);
    }
  };
  walk(json);
  return found;
}

// ---- Utility: LCC presence check for India ----
export function lccPresence(json) {
  const carriers = extractCarriers(json);
  const asText = JSON.stringify(json).toUpperCase();

  const has = (codeOrName) =>
    carriers.includes(codeOrName) || asText.includes(codeOrName);

  return {
    indigo: has("6E") || has("INDIGO"),     // IndiGo
    akasa: has("QP") || has("AKASA"),       // Akasa Air
    spicejet: has("SG") || has("SPICEJET"), // SpiceJet
    carriersSample: carriers.slice(0, 20)
  };
}

