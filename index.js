// index.js — SkyDeal backend (FlightAPI + Mongo) with timeouts & dry-run

import express from "express";
import cors from "cors";
import { MongoClient, ServerApiVersion } from "mongodb";

const app = express();
const PORT = process.env.PORT || 10000;

const FLIGHTAPI_KEY = process.env.FLIGHTAPI_KEY || "";
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || "";
const MONGODB_DB = process.env.MONGODB_DB || "skydeal";
const OFFER_COLLECTIONS = process.env.OFFER_COLLECTIONS || "offers";

const PORTALS = ["MakeMyTrip", "Goibibo", "EaseMyTrip", "Yatra", "Cleartrip"];
const PORTAL_MARKUP_INR = 250;

const FLIGHTAPI_TIMEOUT_MS = Number(process.env.FLIGHTAPI_TIMEOUT_MS || 7000);

// -------- basic middleware & tiny logger --------
app.use((req, res, next) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(cors({ origin: true }));
app.use(express.json({ limit: "200kb" }));

app.use((req, res, next) => {
  const t0 = Date.now();
  res.on("finish", () => {
    console.log(`[REQ] ${req.method} ${req.path} ${res.statusCode} ${Date.now()-t0}ms`);
  });
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// -------- Mongo --------
let mongoClient, db;
async function initMongo() {
  if (!MONGO_URI) { console.warn("⚠️  MONGO_URI not set"); return null; }
  if (db) return db;
  mongoClient = new MongoClient(MONGO_URI, { serverApi: ServerApiVersion.v1 });
  await mongoClient.connect();
  db = mongoClient.db(MONGODB_DB);
  console.log("✅ Mongo connected:", MONGODB_DB);
  return db;
}

// -------- helpers --------
const tcase = s => String(s||"").replace(/\s+/g," ").trim().toLowerCase().replace(/\b[a-z]/g,c=>c.toUpperCase());
function normalizeBankName(raw){
  if(!raw) return "";
  let s = String(raw).trim().replace(/\s+/g," ").toLowerCase();
  s = s.replace(/\bltd\.?\b|\blimited\b|\bplc\b/g,"").trim();
  const map = [
    [/amazon\s*pay\s*icici/i,"ICICI Bank"], [/^icici\b/i,"ICICI Bank"],
    [/flipkart\s*axis/i,"Axis Bank"], [/^axis\b/i,"Axis Bank"],
    [/\bau\s*small\s*finance\b/i,"AU Small Finance Bank"],
    [/\bbobcard\b|bank\s*of\s*baroda|^bob\b/i,"Bank of Baroda"],
    [/\bsbi\b|state\s*bank\s*of\s*india/i,"State Bank of India"],
    [/hdfc/i,"HDFC Bank"], [/kotak/i,"Kotak"], [/yes\s*bank/i,"YES Bank"],
    [/idfc/i,"IDFC First Bank"], [/indusind/i,"IndusInd Bank"], [/federal/i,"Federal Bank"],
    [/rbl/i,"RBL Bank"], [/standard\s*chartered/i,"Standard Chartered"],
    [/hsbc/i,"HSBC"], [/canara/i,"Canara Bank"],
  ];
  for(const [rx,canon] of map) if(rx.test(raw)||rx.test(s)) return canon;
  const cleaned = s.replace(/\b(bank|card|cards)\b/g,"").trim();
  return cleaned ? cleaned.replace(/\b[a-z]/g,c=>c.toUpperCase()) : String(raw).trim();
}
const normTypeKey = t => {
  const x = String(t||"").toLowerCase();
  if(!x) return null;
  if(/\bemi\b/.test(x)) return "emi";
  if(/credit|cc/.test(x)) return "credit";
  if(/debit/.test(x)) return "debit";
  if(/net\s*bank/.test(x)) return "netbanking";
  if(/wallet/.test(x)) return "wallet";
  if(/\bupi\b/.test(x)) return "upi";
  return null;
};
function toISODateStr(d){
  try{
    if(!d) return null;
    const s = String(d).trim();
    const m1 = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if(m1){ const [,dd,mm,yyyy]=m1; return `${yyyy}-${mm}-${dd}`; }
    if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const dt = new Date(s); if(Number.isNaN(dt.getTime())) return null;
    return dt.toISOString().slice(0,10);
  }catch{ return null; }
}
async function fetchWithTimeout(url, init={}, ms=FLIGHTAPI_TIMEOUT_MS){
  const ac = new AbortController();
  const tid = setTimeout(()=>ac.abort(new Error("timeout")), ms);
  try{
    const r = await fetch(url, { ...init, headers:{ "User-Agent":"SkyDeal/1.0 (+render)", ...(init.headers||{}) }, signal: ac.signal });
    return r;
  } finally { clearTimeout(tid); }
}
function buildFlightApiUrl({ key, from, to, depISO, retISO, adults=1, cabin="economy", currency="INR" }){
  const c = String(cabin||"economy").toLowerCase();
  return `https://api.flightapi.io/roundtrip/${key}/${from}/${to}/${depISO}/${retISO}/${adults}/0/0/${c}/${currency}?region=IN`;
}
function extractFlights(fa){
  const itins = Array.isArray(fa?.itineraries)?fa.itineraries:[];
  const legs = new Map((fa?.legs||[]).map(l=>[String(l?.id??""),l]));
  const segs = new Map((fa?.segments||[]).map(s=>[String(s?.id??""),s]));
  const carriers = new Map((fa?.carriers||[]).map(c=>[String(c?.id??""), c?.name||""]));
  const out=[];
  for(const it of itins){
    const legId = it?.leg_ids?.[0]; if(!legId) continue;
    const leg = legs.get(String(legId)); if(!leg || !Array.isArray(leg.segment_ids)||!leg.segment_ids.length) continue;
    const firstSeg = segs.get(String(leg.segment_ids[0]));
    const cid = String(firstSeg?.marketing_carrier_id ?? firstSeg?.operating_carrier_id ?? "");
    const airline = carriers.get(cid) || cid || "—";
    const number = firstSeg?.number ?? "";
    const depT = leg?.departure ? new Date(leg.departure).toTimeString().slice(0,5) : "--:--";
    const arrT = leg?.arrival ? new Date(leg.arrival).toTimeString().slice(0,5) : "--:--";
    const amt = Number(it?.pricing_options?.[0]?.price?.amount ?? 0);
    out.push({
      flightNumber: `${cid}${number?` ${number}`:""}`.trim(),
      airlineName: airline,
      departure: depT,
      arrival: arrT,
      price: amt ? amt.toFixed(2) : "0.00",
      stops: Math.max(0,(leg.segment_ids||[]).length-1),
      carrierCode: cid
    });
  }
  return out;
}

// -------- payment-options --------
app.get("/payment-options", async (_req,res)=>{
  try{
    const database = await initMongo();
    if(!database){
      return res.json({ options:{ CreditCard:[], DebitCard:[], EMI:[], NetBanking:[], Wallet:[], UPI:[] }});
    }
    const col = database.collection(OFFER_COLLECTIONS);
    const today = new Date().toISOString().slice(0,10);
    const cur = col.find(
      { $or:[
        { isExpired:{ $ne:true } },
        { "validityPeriod.end":{ $gte:today } },
        { "validityPeriod.to":{ $gte:today } },
        { "validityPeriod.until":{ $gte:today } },
        { "validityPeriod.endDate":{ $gte:today } },
        { "validityPeriod.till":{ $gte:today } },
        { validityPeriod:{ $exists:false } },
      ]},
      { projection:{ paymentMethods:1 }, limit:5000 }
    );

    const sets = { CreditCard:new Set(), DebitCard:new Set(), EMI:new Set(), NetBanking:new Set(), Wallet:new Set(), UPI:new Set() };

    const pick = (o,keys)=> keys.map(k=>o?.[k]).find(v=>v!=null && v!=="");

    for await (const doc of cur){
      const arr = Array.isArray(doc?.paymentMethods)?doc.paymentMethods:[];
      for(const pm of arr){
        let typeKey, bankRaw;
        if (typeof pm === "string"){
          typeKey = normTypeKey(pm);
          bankRaw = pm.replace(/credit\s*card|debit\s*card|\bemi\b|net\s*bank(?:ing)?|upi|wallet/gi,"").trim();
        } else if (pm && typeof pm === "object"){
          typeKey = normTypeKey(pick(pm,["type","method","category","mode"]));
          bankRaw = pick(pm,["bank","cardBank","issuer","cardIssuer","provider","wallet","upi"]) || "";
        } else continue;

        const bank = tcase(normalizeBankName(bankRaw));
        if(!typeKey || !bank) continue;

        if (typeKey==="emi"){ sets.EMI.add(`${bank} (Credit Card EMI)`); sets.CreditCard.add(bank); }
        else if (typeKey==="credit") sets.CreditCard.add(bank);
        else if (typeKey==="debit") sets.DebitCard.add(bank);
        else if (typeKey==="netbanking") sets.NetBanking.add(bank);
        else if (typeKey==="wallet") sets.Wallet.add(bank);
        else if (typeKey==="upi") sets.UPI.add(bank);
      }
    }
    const options = Object.fromEntries(Object.entries(sets).map(([k,v])=>[k,[...v].sort()]));
    res.json({ options });
  }catch(e){
    console.error("X /payment-options:", e.message);
    res.status(200).json({ error:"Failed loading payment options" });
  }
});

// -------- debug-flightapi (supports dry=1) --------
app.post("/debug-flightapi", async (req,res)=>{
  try{
    const qdry = String(req.query.dry||"").trim()==="1";
    const { from, to, departureDate, returnDate, passengers=1, travelClass="economy", tripType="round-trip" } = req.body||{};
    const depISO = toISODateStr(departureDate);
    const retISO0 = toISODateStr(returnDate);
    const retISO = tripType==="round-trip" ? (retISO0||depISO) : depISO;
    const url = buildFlightApiUrl({ key:FLIGHTAPI_KEY, from:String(from||"").toUpperCase(), to:String(to||"").toUpperCase(), depISO, retISO, adults:passengers, cabin:travelClass, currency:"INR" });

    if (qdry) {
      return res.json({ ok:true, status:0, url, keys:[], hasItin:false, error:null, mode:"dry" });
    }

    let status=0, ok=false, parsed=null, keys=[], error=null;
    try{
      const r = await fetchWithTimeout(url);
      status = r.status; ok = r.ok;
      const txt = await r.text();
      if (txt.trim().startsWith("<")) throw new Error("flightapi_html");
      parsed = JSON.parse(txt); keys = Object.keys(parsed||{});
    }catch(e){ error = e.message||String(e); }

    res.json({ ok, status, url, keys, hasItin:Boolean(parsed?.itineraries?.length), error });
  }catch(e){
    res.status(200).json({ ok:false, error:String(e) });
  }
});

// -------- search (supports dry=1) --------
app.post("/search", async (req,res)=>{
  try{
    const qdry = String(req.query.dry||"").trim()==="1";
    const { from,to, departureDate,returnDate, passengers=1, travelClass="economy", tripType="round-trip" } = req.body||{};
    const depISO = toISODateStr(departureDate);
    const retISO0 = toISODateStr(returnDate);
    const retISO = tripType==="round-trip" ? (retISO0||depISO) : depISO;

    const missing=[];
    if(!from) missing.push("from");
    if(!to) missing.push("to");
    if(!depISO) missing.push("departureDate (invalid format)");
    if(!FLIGHTAPI_KEY) missing.push("FLIGHTAPI_KEY (env)");
    if(missing.length) return res.status(400).json({ error:"Missing required fields", missing });

    const ORG = String(from).trim().toUpperCase();
    const DST = String(to).trim().toUpperCase();
    const url = buildFlightApiUrl({ key:FLIGHTAPI_KEY, from:ORG, to:DST, depISO, retISO, adults:passengers, cabin:travelClass, currency:"INR" });

    if (qdry){
      // quick synthetic example so the frontend can flow
      const base = 12345;
      const portalPrices = PORTALS.map(p=>({ portal:p, basePrice:base, finalPrice:base+PORTAL_MARKUP_INR, source:"carrier+markup" }));
      return res.json({
        outboundFlights:[{ flightNumber:"6E 123", airlineName:"IndiGo", departure:"10:00", arrival:"12:15", price:String(base), stops:0, carrierCode:"32213", portalPrices }],
        returnFlights:[],
        meta:{ source:"dry" }
      });
    }

    let faJson;
    try{
      const r = await fetchWithTimeout(url);
      if(!r.ok) throw new Error(`flightapi_http_${r.status}`);
      const txt = await r.text();
      if (txt.trim().startsWith("<")) throw new Error("flightapi_html");
      faJson = JSON.parse(txt);
    }catch(e){
      console.error("X flightapi fetch:", e.message);
      return res.status(200).json({ outboundFlights:[], returnFlights:[], meta:{ source:"flightapi", reason: e.message==="timeout" ? "fetch-timeout" : "fetch-failed" }});
    }

    const flights = extractFlights(faJson);
    if(!flights.length){
      return res.status(200).json({
        outboundFlights:[], returnFlights:[],
        meta:{ source:"flightapi", reason:"no-itineraries",
          stats:{
            itinCount:Array.isArray(faJson?.itineraries)?faJson.itineraries.length:0,
            legCount:Array.isArray(faJson?.legs)?faJson.legs.length:0,
            segCount:Array.isArray(faJson?.segments)?faJson.segments.length:0,
            carrierCount:Array.isArray(faJson?.carriers)?faJson.carriers.length:0
          }
        }
      });
    }

    const withPortals = flights.map(f=>{
      const base = Number(f.price)||0;
      const portalPrices = PORTALS.map(portal=>({ portal, basePrice:base, finalPrice:base+PORTAL_MARKUP_INR, source:"carrier+markup" }));
      return { ...f, portalPrices };
    });

    res.json({ outboundFlights: withPortals, returnFlights: [], meta:{ source:"flightapi" }});
  }catch(err){
    console.error("X /search:", err.message);
    res.status(200).json({ outboundFlights:[], returnFlights:[], error:"search-failed" });
  }
});

// -------- start --------
app.listen(PORT, async ()=>{
  try{ await initMongo(); }catch(e){ console.error("Mongo init failed:", e.message); }
  if(!FLIGHTAPI_KEY) console.error("❌ Missing FLIGHTAPI_KEY");
  console.log(`🚀 SkyDeal backend running on ${PORT} (timeout ${FLIGHTAPI_TIMEOUT_MS}ms)`);
});
