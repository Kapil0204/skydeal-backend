// SKYDEAL BACKEND — FlightAPI only, robust payment methods, EC2 Mongo
import express from "express";
import cors from "cors";
import axios from "axios";
import mongoose from "mongoose";
import dotenv from "dotenv";
import { URL } from "url";
dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({ origin: "*", methods: ["GET","POST"] }));
const PORT = process.env.PORT || 10000;

/* ------------------ Mongo connect with smart authSource fallback ------------------ */
async function tryConnect(uri, label){
  try{
    await mongoose.connect(uri,{ serverSelectionTimeoutMS:8000, socketTimeoutMS:20000 });
    console.log(`MongoDB connected via ${label}`);
    return true;
  }catch(e){
    console.error(`Mongo connect failed via ${label}:`, e?.message||e);
    try{ await mongoose.disconnect(); }catch{}
    return false;
  }
}
async function connectMongo(){
  const raw = process.env.MONGODB_URI || process.env.MONGO_URI || "";
  if(!raw){ console.warn("Mongo URI not set"); return; }
  if(await tryConnect(raw,"env-uri")) return;

  let u;
  try{ u = new URL(raw.replace(/^mongodb:\/\//,"http://")); }
  catch{ console.error("Invalid Mongo URI format"); return; }

  const rebuild = (authSource)=>{
    const auth = u.username ? `${u.username}${u.password?":"+u.password:""}@` : "";
    const qs = new URLSearchParams(u.searchParams);
    qs.set("authSource", authSource);
    return `mongodb://${auth}${u.host}${u.pathname}?${qs.toString()}`;
  };
  if(await tryConnect(rebuild("admin"),"authSource=admin")) return;
  if(await tryConnect(rebuild("skydeal"),"authSource=skydeal")) return;
  console.error("❌ Mongo still failing after all fallbacks");
}
await connectMongo();

const OfferSchema = new mongoose.Schema({}, { strict:false, collection:"offers" });
const Offer = mongoose.models.Offer || mongoose.model("Offer", OfferSchema);

/* ------------------ Payment methods API (robust extraction) ------------------ */
app.get("/api/payment-methods", async (_req,res)=>{
  try{
    if(mongoose.connection.readyState!==1){
      return res.json(blankOpts());
    }

    // Pull only the fields we care about; cap to a sane number
    const docs = await Offer.find({}, { paymentMethods:1, parsedFields:1, rawFields:1 }).limit(5000).lean();

    const out = groups();
    for(const d of docs){
      const sources = [];
      if(Array.isArray(d?.paymentMethods)) sources.push(d.paymentMethods);
      if(Array.isArray(d?.parsedFields?.paymentMethods)) sources.push(d.parsedFields.paymentMethods);
      if(Array.isArray(d?.rawFields?.paymentMethods)) sources.push(d.rawFields.paymentMethods);

      for(const arr of sources){
        for(const pm of arr){
          const type = (pm?.type||pm?.method||pm?.category||"").toString().trim();
          const name = (pm?.name||pm?.bank||pm?.issuer||pm?.label||"").toString().trim();
          if(!type || !name) continue;

          const key = type.replace(/\s+/g,""); // "net banking" -> "netbanking"
          if(out[key] && !out[key].includes(name)) out[key].push(name);
        }
      }
    }
    Object.keys(out).forEach(k=>out[k].sort((a,b)=>a.localeCompare(b)));
    return res.json(out);
  }catch(e){
    console.error("payment-methods error:", e?.message||e);
    return res.json(blankOpts());
  }
});
function groups(){
  return { creditCard:[], debitCard:[], wallet:[], upi:[], netBanking:[], emi:[] };
}
function blankOpts(){ return groups(); }

/* ------------------ Flight search (FlightAPI only) ------------------ */
app.post("/search", async (req,res)=>{
  try{
    const url   = process.env.FLIGHTAPI_URL;
    const key   = process.env.FLIGHTAPI_KEY;
    const verb  = (process.env.FLIGHTAPI_METHOD||"POST").toUpperCase();
    const hdr   = process.env.FLIGHTAPI_KEY_HEADER || "X-API-Key";

    if(!url || !key) throw new Error("Missing FLIGHTAPI_URL or FLIGHTAPI_KEY");

    const { from, to, departureDate, returnDate, passengers, travelClass, tripType } = req.body;

    // unified payload
    const payload = {
      from, to,
      departureDate,
      returnDate: tripType==="round-trip" ? returnDate : "",
      passengers, travelClass, tripType,
      currency:"INR"
    };

    let faRes;
    if(verb==="GET"){
      const params = { ...payload };
      // optional: restrict params if provider expects exact keys
      if(process.env.FLIGHTAPI_QUERY_KEYS){
        const allow = new Set(process.env.FLIGHTAPI_QUERY_KEYS.split(",").map(s=>s.trim()));
        Object.keys(params).forEach(k=>{ if(!allow.has(k)) delete params[k]; });
      }
      faRes = await axios.get(url, { params, headers:{ [hdr]: key }, timeout:20000 });
    }else{
      faRes = await axios.post(url, payload, { headers:{ "Content-Type":"application/json", [hdr]: key }, timeout:20000 });
    }

    return res.json(normalizeFlightAPI(faRes.data));
  }catch(e){
    console.error("FlightAPI search error:", e.response?.data || e.message || e);
    return res.status(500).json({ error:"FlightAPI request failed" });
  }
});

/* ------------------ Normalizer (tolerant) ------------------ */
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
app.get("/", (_req,res)=>res.send("SkyDeal backend running (FlightAPI only, EC2 Mongo)."));

app.listen(PORT, ()=>console.log(`Server ON ${PORT} — FlightAPI only`));
