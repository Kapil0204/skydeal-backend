// SKYDEAL BACKEND — FlightAPI only, EC2 Mongo
// Fixes:
// 1) FlightAPI: auto fallback POST→GET when server says "Cannot POST", flexible key header.
// 2) Payment methods: scan one or MANY offers collections and multiple field paths.

import express from "express";
import cors from "cors";
import axios from "axios";
import mongoose from "mongoose";
import dotenv from "dotenv";
import { URL } from "url";
dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
const PORT = process.env.PORT || 10000;

/* ------------------ Mongo connect with smart authSource fallback ------------------ */
async function tryConnect(uri, label) {
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000, socketTimeoutMS: 20000 });
    console.log(`MongoDB connected via ${label}`);
    return true;
  } catch (e) {
    console.error(`Mongo connect failed via ${label}:`, e?.message || e);
    try { await mongoose.disconnect(); } catch {}
    return false;
  }
}
async function connectMongo() {
  const raw = process.env.MONGODB_URI || process.env.MONGO_URI || "";
  if (!raw) { console.warn("Mongo URI not set"); return; }
  if (await tryConnect(raw, "env-uri")) return;

  let u;
  try { u = new URL(raw.replace(/^mongodb:\/\//, "http://")); }
  catch { console.error("Invalid Mongo URI format"); return; }

  const rebuild = (authSource) => {
    const auth = u.username ? `${u.username}${u.password ? ":" + u.password : ""}@` : "";
    const qs = new URLSearchParams(u.searchParams); qs.set("authSource", authSource);
    return `mongodb://${auth}${u.host}${u.pathname}?${qs.toString()}`;
  };
  if (await tryConnect(rebuild("admin"), "authSource=admin")) return;
  if (await tryConnect(rebuild("skydeal"), "authSource=skydeal")) return;
  console.error("❌ Mongo still failing after all fallbacks");
}
await connectMongo();

/* ------------------ Helpers ------------------ */
function blankGroups() {
  return { creditCard: [], debitCard: [], wallet: [], upi: [], netBanking: [], emi: [] };
}
function pushGrouped(out, typeRaw, nameRaw) {
  const type = (typeRaw || "").toString().trim();
  const name = (nameRaw || "").toString().trim();
  if (!type || !name) return;
  const key = type.replace(/\s+/g, ""); // "net banking" → "netbanking"
  if (out[key] && !out[key].includes(name)) out[key].push(name);
}

/* ------------------ Payment methods API ------------------ */
/*
 * Reads from:
 *  - collection(s): default "offers"; OR comma-separated via OFFER_COLLECTIONS;
 *    if not set, will auto-scan all collections whose name contains "offer".
 *  - fields: paymentMethods[], parsedFields.paymentMethods[], rawFields.paymentMethods[]
 */
app.get("/api/payment-methods", async (_req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) return res.json(blankGroups());

    const db = mongoose.connection.db;

    // Resolve which collections to scan
    let collNames = [];
    if (process.env.OFFER_COLLECTIONS) {
      collNames = process.env.OFFER_COLLECTIONS.split(",").map(s => s.trim()).filter(Boolean);
    } else {
      const list = await db.listCollections().toArray();
      collNames = list
        .map(c => c.name)
        .filter(n => /offer/i.test(n)); // any name containing "offer" (offers / structured_offers / etc.)
      if (collNames.length === 0) collNames = ["offers"]; // fallback
    }

    const out = blankGroups();

    for (const name of collNames) {
      const col = db.collection(name);
      // project only the bits we need
      const cursor = col.find({}, { projection: { paymentMethods: 1, parsedFields: 1, rawFields: 1 } }).limit(10000);
      // iterate
      for await (const d of cursor) {
        const pools = [];
        if (Array.isArray(d?.paymentMethods)) pools.push(d.paymentMethods);
        if (Array.isArray(d?.parsedFields?.paymentMethods)) pools.push(d.parsedFields.paymentMethods);
        if (Array.isArray(d?.rawFields?.paymentMethods)) pools.push(d.rawFields.paymentMethods);

        for (const arr of pools) {
          for (const pm of arr) {
            pushGrouped(out, pm?.type || pm?.method || pm?.category, pm?.name || pm?.bank || pm?.issuer || pm?.label);
          }
        }
      }
    }

    Object.keys(out).forEach(k => out[k].sort((a, b) => a.localeCompare(b)));
    return res.json(out);
  } catch (e) {
    console.error("payment-methods error:", e?.message || e);
    return res.json(blankGroups());
  }
});

/* ------------------ Flight search (FlightAPI only) ------------------ */
/*
 * Works with providers that expect either:
 *  - POST body (default), or
 *  - GET query string (auto-fallback if server responds with HTML/“Cannot POST”)
 * Headers:
 *  - default key header "X-API-Key", override with FLIGHTAPI_KEY_HEADER
 *  - alternatively, set FLIGHTAPI_BEARER=1 to send the key as Authorization: Bearer <key>
 */
app.post("/search", async (req, res) => {
  try {
    const baseUrl = process.env.FLIGHTAPI_URL;
    const key = process.env.FLIGHTAPI_KEY;
    const preferVerb = (process.env.FLIGHTAPI_METHOD || "POST").toUpperCase();
    const keyHeader = process.env.FLIGHTAPI_KEY_HEADER || "X-API-Key";
    const useBearer = process.env.FLIGHTAPI_BEARER === "1";

    if (!baseUrl || !key) throw new Error("Missing FLIGHTAPI_URL or FLIGHTAPI_KEY");

    const { from, to, departureDate, returnDate, passengers, travelClass, tripType } = req.body;
    const payload = {
      from, to,
      departureDate,
      returnDate: tripType === "round-trip" ? returnDate : "",
      passengers, travelClass, tripType,
      currency: "INR",
    };

    const headers = { "Content-Type": "application/json" };
    if (useBearer) headers["Authorization"] = `Bearer ${key}`;
    else headers[keyHeader] = key;

    // Primary attempt
    let resp;
    if (preferVerb === "GET") {
      resp = await axios.get(baseUrl, { params: payload, headers, timeout: 20000, validateStatus: () => true });
    } else {
      resp = await axios.post(baseUrl, payload, { headers, timeout: 20000, validateStatus: () => true });
    }

    // If provider responds with HTML "Cannot POST ..." or non-2xx, try GET automatically
    const isHtml = typeof resp.data === "string" && /^\s*<!DOCTYPE html>/i.test(resp.data);
    const cannotPost = isHtml && /Cannot\s+POST/i.test(resp.data);
    if ((resp.status < 200 || resp.status >= 300) || cannotPost) {
      // Retry with GET
      const retry = await axios.get(baseUrl, { params: payload, headers, timeout: 20000, validateStatus: () => true });
      if (retry.status < 200 || retry.status >= 300 || (typeof retry.data === "string" && /^\s*<!DOCTYPE html>/i.test(retry.data))) {
        throw new Error(`FlightAPI HTTP ${retry.status} ${cannotPost ? "(Cannot POST → GET retried)" : ""}`);
      }
      return res.json(normalizeFlightAPI(retry.data));
    }

    return res.json(normalizeFlightAPI(resp.data));
  } catch (e) {
    console.error("FlightAPI search error:", e.response?.data || e.message || e);
    return res.status(500).json({ error: "FlightAPI request failed" });
  }
});

/* ------------------ Normalizer (tolerant) ------------------ */
function normalizeFlightAPI(raw) {
  const out = { outbound: [], inbound: [] };
  const items = raw?.results || raw?.data || raw?.flights || [];

  for (const r of items) {
    const mk = (itin) => {
      if (!itin) return null;
      const seg = Array.isArray(itin.segments) ? itin.segments[0] : itin;
      const airline = seg?.airlineName || seg?.airline || r?.airline || "Flight";
      const flightNo = seg?.flightNumber || seg?.number || "";
      const dep = (seg?.departureTime || seg?.departure || seg?.departure_at || "").slice(11, 16) || seg?.departureTime || "";
      const arr = (seg?.arrivalTime || seg?.arrival || seg?.arrival_at || "").slice(11, 16) || seg?.arrivalTime || "";
      const price = Number(r?.price?.total ?? r?.total ?? r?.price ?? 0);
      const stops = Math.max(0, (itin?.segments?.length ?? 1) - 1);
      return { airline, flightNumber: `${flightNo}`.trim(), departureTime: dep, arrivalTime: arr, price, stops };
    };

    const o = mk(r.outbound || r.out || r.itineraries?.[0]);
    if (o) out.outbound.push(o);
    const i = mk(r.inbound || r.in || r.itineraries?.[1]);
    if (i) out.inbound.push(i);
  }

  return out;
}

/* ------------------ Health ------------------ */
app.get("/", (_req, res) => res.send("SkyDeal backend running (FlightAPI only, EC2 Mongo)."));

app.listen(PORT, () => console.log(`Server ON ${PORT} — FlightAPI only`));
