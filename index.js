// SKYDEAL BACKEND — FlightAPI (path GET) + EC2 Mongo
import express from "express";
import cors from "cors";
import axios from "axios";
import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({ origin: "*", methods: ["GET","POST"] }));
const PORT = process.env.PORT || 10000;

/* ------------------ Mongo connect (smart) ------------------ */
async function tryConnect(uri, tag){
  try{
    await mongoose.connect(uri,{ serverSelectionTimeoutMS:8000, socketTimeoutMS:20000 });
    console.log(`MongoDB connected via ${tag}`);
    return true;
  }catch(e){
    console.error(`Mongo connect failed via ${tag}:`, e?.message||e);
    try{ await mongoose.disconnect(); }catch{}
    return false;
  }
}
async function connectMongo(){
  const raw = process.env.MONGODB_URI || process.env.MONGO_URI || "";
  if(!raw){ console.warn("Mongo URI not set"); return; }
  if(await tryConnect(raw,"env-uri")) return;

  const u = new URL(raw.replace(/^mongodb:\/\//,"http://"));
  const rebuild = (authSource)=>{
    const auth = u.username ? `${u.username}${u.password?":"+u.password:""}@` : "";
    const qs = new URLSearchParams(u.searchParams); qs.set("authSource", authSource);
    return `mongodb://${auth}${u.host}${u.pathname}?${qs.toString()}`;
  };
  if(await tryConnect(rebuild("admin"),"authSource=admin")) return;
  if(await tryConnect(rebuild("skydeal"),"authSource=skydeal")) return;
  console.error("❌ Mongo still failing after all fallbacks");
}
await connectMongo();

/* ------------------ Helpers ------------------ */
const buckets = () => ({ creditCard:[], debitCard:[], wallet:[], upi:[], netBanking:[], emi:[] });
const push = (out, typeRaw, nameRaw) => {
  const type=(typeRaw||"").toString().trim();
  const name=(nameRaw||"").toString().trim();
  if(!type || !name) return;
  const key = type.replace(/\s+/g,"");
  if(out[key] && !out[key].includes(name)) out[key].push(name);
};

/* ------------------ Payment methods (locked to yesterday’s shape) ------------------ */
app.get("/api/payment-methods", async (_req,res)=>{
  try{
    if(mongoose.connection.readyState!==1) return res.json(buckets());
    const db = mongoose.connection.db;

    // force the known collection (set in env)
    const names = (process.env.OFFER_COLLECTIONS||"offers")
      .split(",").map(s=>s.trim()).filter(Boolean);

    const out = buckets();
    let scanned = 0, found = 0;

    for(const name of names){
      const col = db.collection(name);
      // read ONLY what we used yesterday
      const cur = col.find({}, { projection:{ parsedFields:1, paymentMethods:1 } }).limit(20000);
      for await (const d of cur){
        scanned++;
        // primary: parsedFields.paymentMethods[]
        if(Array.isArray(d?.parsedFields?.paymentMethods)){
          for(const pm of d.parsedFields.paymentMethods){
            push(out, pm?.type||pm?.method||pm?.category, pm?.name||pm?.bank||pm?.issuer||pm?.label);
            found++;
          }
        }
        // fallback: paymentMethods[]
        if(Array.isArray(d?.paymentMethods)){
          for(const pm of d.paymentMethods){
            push(out, pm?.type||pm?.method||pm?.category, pm?.name||pm?.bank||pm?.issuer||pm?.label);
            found++;
          }
        }
      }
    }

    Object.keys(out).forEach(k=>out[k].sort((a,b)=>a.localeCompare(b)));
    console.log(`payment-methods: scanned=${scanned}, added=${found}, coll=${(process.env.OFFER_COLLECTIONS||"offers")}`);
    return res.json(out);
  }catch(e){
    console.error("payment-methods error:", e?.message||e);
    return res.json(buckets());
  }
});

/* ------------------ Flight search (FlightAPI path-style GET) ------------------ */
// https://api.flightapi.io/roundtrip/<key>/<from>/<to>/<dep>/<ret>/<adults>/<children>/<infants>/<cabin>/<currency>?region=IN
app.post("/search", async (req,res)=>{
  try{
    const BASE = process.env.FLIGHTAPI_URL;    // https://api.flightapi.io/roundtrip
    const KEY  = process.env.FLIGHTAPI_KEY;
    if(!BASE || !KEY) throw new Error("Missing FLIGHTAPI_URL or FLIGHTAPI_KEY");

    const { from, to, departureDate, returnDate, passengers, travelClass, tripType } = req.body;

    const adults   = Number(passengers||1);
    const children = Number(process.env.DEFAULT_CHILDREN || 0);
    const infants  = Number(process.env.DEFAULT_INFANTS  || 0);
    const currency = (process.env.DEFAULT_CURRENCY || "INR").toUpperCase();
    const region   = (process.env.DEFAULT_REGION   || "IN").toUpperCase();

    const cabin = (travelClass||"Economy").replace(/\s+/g,"_");
    const ret   = tripType==="round-trip" ? returnDate : (returnDate || departureDate);

    const url = [
      BASE.replace(/\/+$/,""),
      encodeURIComponent(KEY),
      encodeURIComponent(from),
      encodeURIComponent(to),
      encodeURIComponent(departureDate),
      encodeURIComponent(ret),
      String(adults),
      String(children),
      String(infants),
      encodeURIComponent(cabin),
      encodeURIComponent(currency)
    ].join("/");

    const finalUrl = `${url}?region=${encodeURIComponent(region)}`;
    const r = await axios.get(finalUrl, { timeout: 25000 });

    return res.json(normalizeFlightAPI(r.data));
  }catch(e){
    console.error("FlightAPI search error:", e.response?.data || e.message || e);
    return res.status(500).json({ error:"FlightAPI request failed" });
  }
});

/* ------------------ Normalizer ------------------ */
function normalizeFlightAPI(raw){
  const out={ outbound:[], inbound:[] };
  const items = raw?.results || raw?.data || raw?.flights || [];

  for(const r of items){
    const mk=(itin)=>{
      if(!itin) return null;
      const seg = Array.isArray(itin.segments) ? itin.segments[0] : itin;
      const airline = seg?.airlineName || seg?.airline || r?.airline || "Flight";
      const flightNo = seg?.flightNumber || seg?.number || "";
      const dep = (seg?.departureTime || seg?.departure || seg?.departure_at || "").slice(11,16) || seg?.departureTime || "";
      const arr = (seg?.arrivalTime || seg?.arrival || seg?.arrival_at || "").slice(11,16) || seg?.arrivalTime || "";
      const price = Number(r?.price?.total ?? r?.total ?? r?.price ?? 0);
      const stops = Math.max(0, (itin?.segments?.length ?? 1) - 1);
      return { airline, flightNumber:`${flightNo}`.trim(), departureTime:dep, arrivalTime:arr, price, stops };
    };

    const o = mk(r.outbound || r.out || r.itineraries?.[0]);
    if(o) out.outbound.push(o);
    const i = mk(r.inbound || r.in || r.itineraries?.[1]);
    if(i) out.inbound.push(i);
  }
  return out;
}

/* ------------------ Health ------------------ */
app.get("/", (_req,res)=>res.send("SkyDeal backend running (FlightAPI path GET, EC2 Mongo)."));
app.listen(PORT, ()=>console.log(`Server ON ${PORT} — FlightAPI only`));
