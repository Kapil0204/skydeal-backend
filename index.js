import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ===== Mongo (EC2) =====
const MONGODB_URI = process.env.MONGODB_URI;
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || 'skydeal';
const MONGO_COLLECTION = process.env.MONGO_COLLECTION || 'offers';

let mongoClient;
let offersCollection;

async function initMongo() {
  if (!MONGODB_URI) {
    console.warn('⚠️ MONGODB_URI not set — offers will be skipped.');
    return;
  }
  mongoClient = new MongoClient(MONGODB_URI, { ignoreUndefined: true });
  await mongoClient.connect();
  const db = mongoClient.db(MONGO_DB_NAME);
  offersCollection = db.collection(MONGO_COLLECTION);
  console.log('✅ Connected to MongoDB for offers');
}

// ===== Amadeus OAuth =====
async function getAccessToken() {
  const url = 'https://test.api.amadeus.com/v1/security/oauth2/token';
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.AMADEUS_CLIENT_ID,
    client_secret: process.env.AMADEUS_CLIENT_SECRET
  });
  const response = await axios.post(url, body);
  return response.data.access_token;
}

// ===== Helpers =====
function formatFlight(itinerary, price) {
  const segment = itinerary.segments[0];
  return {
    flightNumber: `${segment.carrierCode} ${segment.number}`,
    airlineName: segment.carrierCode,
    departure: segment.departure.at.slice(11, 16),
    arrival: segment.arrival.at.slice(11, 16),
    price: price.total,
    stops: itinerary.segments.length - 1
  };
}

function toNumber(val, fallback = 0) {
  if (val === undefined || val === null) return fallback;
  if (typeof val === 'number') return val;
  const n = parseFloat(String(val).replace(/[^\d.]/g, ''));
  return isNaN(n) ? fallback : n;
}

function getEndDateValue(validityPeriod = {}) {
  return (
    validityPeriod.end ||
    validityPeriod.to ||
    validityPeriod.endDate ||
    validityPeriod.till ||
    validityPeriod.until ||
    null
  );
}

function isNotExpired(offer) {
  if (offer.isExpired === true) return false;
  const endRaw = getEndDateValue(offer?.validityPeriod || {});
  if (!endRaw) return true;
  const end = new Date(endRaw);
  const today = new Date(new Date().toISOString().slice(0, 10));
  return end >= today;
}

// ===== Payment matching (credit matches EMI too) =====
const GENERIC_WORDS = new Set(['bank', 'card', 'cards', 'emi', 'and', '&']);
const TYPES = ['credit', 'debit', 'netbanking', 'net', 'banking', 'wallet', 'upi'];

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/net\s+banking/g, 'netbanking')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function extractBankAndType(s) {
  const txt = norm(s);
  const tokens = txt.split(' ').filter(Boolean);
  let type = null;
  for (const t of tokens) {
    if (TYPES.includes(t)) type = (t === 'net' || t === 'banking') ? 'netbanking' : t;
  }
  let bank = null;
  for (const t of tokens) {
    if (!GENERIC_WORDS.has(t) && !TYPES.includes(t)) { bank = t; break; }
  }
  return { bank, type, raw: txt };
}
function offerPaymentStrings(offer) {
  const pm = offer?.paymentMethods || [];
  if (Array.isArray(pm)) {
    return pm.map(x => {
      if (typeof x === 'string') return x;
      if (x && typeof x === 'object') {
        const parts = [x.bank, x.type, x.cardNetwork].filter(Boolean);
        return parts.length ? parts.join(' ') : JSON.stringify(x);
      }
      return String(x);
    });
  }
  return [];
}
function matchesAnyPayment(offer, selectedPayments) {
  if (!Array.isArray(selectedPayments) || selectedPayments.length === 0) return false;
  const offerPMs = offerPaymentStrings(offer).map(norm);
  if (offerPMs.length === 0) return false;
  const parsedSelections = selectedPayments.map(extractBankAndType);

  return parsedSelections.some(sel => {
    if (!sel.bank && !sel.type) return false;
    return offerPMs.some(pmStr => {
      const hasBank = sel.bank ? pmStr.includes(sel.bank) : true;

      // credit selection matches either "credit" OR "emi"
      const pmHasCredit = pmStr.includes('credit') || pmStr.includes('emi');
      const hasType = sel.type
        ? (sel.type === 'credit' ? pmHasCredit : pmStr.includes(sel.type))
        : true;

      return hasBank && hasType;
    });
  });
}

// ===== Offer rules =====
function applyOfferRules(baseFare, offer) {
  const hasCoupon = !!(offer?.couponCode && String(offer.couponCode).trim());
  if (!hasCoupon) return null;
  if (!isNotExpired(offer)) return null;

  const minTxn = toNumber(offer?.minTransactionValue, 0);
  if (baseFare < minTxn) return null;

  const pct = toNumber(offer?.discountPercent, 0);
  const maxAmt =
    offer?.maxDiscountAmount !== undefined && offer?.maxDiscountAmount !== null
      ? toNumber(offer.maxDiscountAmount, Infinity)
      : Infinity;

  if (pct <= 0 && !isFinite(maxAmt)) return null;

  let discount = baseFare * (pct / 100);
  if (isFinite(maxAmt) && discount > maxAmt) discount = maxAmt;

  const finalPrice = Math.max(0, baseFare - discount);

  return {
    discount,
    finalPrice,
    applied: {
      couponCode: offer?.couponCode || null,
      discountPercent: pct || null,
      maxDiscountAmount: isFinite(maxAmt) ? maxAmt : null,
      minTransactionValue: minTxn || null,
      validityPeriod: offer?.validityPeriod || null,
      rawDiscount: offer?.rawDiscount || null,
      title: offer?.title || null,
      offerId: String(offer?._id || '')
    }
  };
}
function pickBestOfferForPortal(baseFare, offers) {
  let best = null;
  for (const offer of offers) {
    const result = applyOfferRules(baseFare, offer);
    if (!result) continue;
    if (!best || result.finalPrice < best.finalPrice) {
      best = { ...result, offer };
    }
  }
  return best;
}

// ===== Search =====
app.post('/search', async (req, res) => {
  try {
    const {
      from, to, departureDate, returnDate,
      passengers, travelClass, tripType,
      paymentMethods = []
    } = req.body;

    const token = await getAccessToken();

    const params = {
      originLocationCode: from,
      destinationLocationCode: to,
      departureDate,
      returnDate: tripType === 'round-trip' ? returnDate : undefined,
      adults: passengers,
      travelClass,
      currencyCode: 'INR',
      nonStop: false,
      max: 100,
    };

    const response = await axios.get('https://test.api.amadeus.com/v2/shopping/flight-offers', {
      headers: { Authorization: `Bearer ${token}` },
      params
    });

    const rawFlights = response.data.data || [];
    const outboundFlights = [];
    const returnFlights = [];

    rawFlights.forEach(flight => {
      const itineraries = flight.itineraries;
      const price = flight.price;

      if (tripType === 'round-trip' && itineraries.length === 2) {
        outboundFlights.push(formatFlight(itineraries[0], price));
        returnFlights.push(formatFlight(itineraries[1], price));
      } else if (tripType === 'one-way' && itineraries.length === 1) {
        outboundFlights.push(formatFlight(itineraries[0], price));
      }
    });

    if (!offersCollection) {
      return res.json({ outboundFlights, returnFlights });
    }

    const PORTALS = ['MakeMyTrip', 'Goibibo', 'EaseMyTrip', 'Yatra', 'Cleartrip'];
    const todayISO = new Date().toISOString().slice(0, 10);

    const mongoFilter = {
      'sourceMetadata.sourcePortal': { $in: PORTALS },
      couponCode: { $exists: true, $ne: '' },
      isExpired: { $ne: true },
      $or: [
        { validityPeriod: { $exists: false } },
        {
          $and: [
            { 'validityPeriod.end': { $exists: false } },
            { 'validityPeriod.to': { $exists: false } },
            { 'validityPeriod.endDate': { $exists: false } },
            { 'validityPeriod.till': { $exists: false } },
            { 'validityPeriod.until': { $exists: false } }
          ]
        },
        { 'validityPeriod.end': { $gte: todayISO } },
        { 'validityPeriod.to': { $gte: todayISO } },
        { 'validityPeriod.endDate': { $gte: todayISO } },
        { 'validityPeriod.till': { $gte: todayISO } },
        { 'validityPeriod.until': { $gte: todayISO } }
      ]
    };

    const allCandidateOffers = await offersCollection.find(mongoFilter).toArray();
    const filteredByPayment = allCandidateOffers.filter(o => matchesAnyPayment(o, paymentMethods));

    const offersByPortal = PORTALS.reduce((acc, p) => (acc[p] = [], acc), {});
    for (const offer of filteredByPayment) {
      const portal = offer?.sourceMetadata?.sourcePortal;
      if (PORTALS.includes(portal)) offersByPortal[portal].push(offer);
    }

    function attachPortalPrices(flight) {
      const baseFare = toNumber(flight.price, 0);
      const portalPrices = PORTALS.map(portal => {
        const best = pickBestOfferForPortal(baseFare, offersByPortal[portal]);
        if (!best) {
          return {
            portal,
            basePrice: baseFare,
            finalPrice: baseFare,
            appliedOffer: null
          };
        }
        return {
          portal,
          basePrice: baseFare,
          finalPrice: Math.round(best.finalPrice),
          discountApplied: Math.round(best.discount),
          appliedOffer: {
            portal,
            couponCode: best.applied.couponCode,
            discountPercent: best.applied.discountPercent,
            maxDiscountAmount: best.applied.maxDiscountAmount,
            minTransactionValue: best.applied.minTransactionValue,
            validityPeriod: best.applied.validityPeriod,
            rawDiscount: best.applied.rawDiscount,
            title: best.applied.title,
            offerId: best.applied.offerId
          }
        };
      });
      return { ...flight, portalPrices };
    }

    const outboundWithPrices = outboundFlights.map(attachPortalPrices);
    const returnWithPrices = returnFlights.map(attachPortalPrices);

    return res.json({ outboundFlights: outboundWithPrices, returnFlights: returnWithPrices });

  } catch (err) {
    if (err.response) {
      console.error('❌ Amadeus error:', JSON.stringify(err.response.data, null, 2));
    } else {
      console.error('❌ Search error:', err.message);
    }
    res.status(500).json({ error: 'Failed to fetch flights' });
  }
});

// ===== /payment-methods (normalize + collapse EMI into Credit Card) =====
function canonicalizeLabel(label) {
  if (!label) return '';
  let s = String(label).toLowerCase();

  // unify plurals / spacing
  s = s.replace(/\bcards\b/g, 'card');
  s = s.replace(/\bcredit\s*cards?\b/g, 'credit card');
  s = s.replace(/\bdebit\s*cards?\b/g, 'debit card');
  s = s.replace(/\bnet\s*banking\b/g, 'netbanking');

  // strip punctuation & cleanup
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

  // collapse EMI -> credit card (so picker never shows "... EMI")
  s = s.replace(/\bcredit card emi\b/g, 'credit card');
  s = s.replace(/\bemi\b/g, '');
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}
function displayLabelFromKey(key) {
  const UPPER = new Set(['ICICI','HDFC','HSBC','SBI','RBL','IDBI','PNB','AU','BOB','BOBCARD','DBS','YES','J&K']);
  return key.split(' ').map(w => {
    const up = w.toUpperCase();
    if (UPPER.has(up)) return up;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}

app.get('/payment-methods', async (req, res) => {
  try {
    if (!offersCollection) return res.json({ methods: [] });

    const PORTALS = ['MakeMyTrip','Goibibo','EaseMyTrip','Yatra','Cleartrip'];
    const todayISO = new Date().toISOString().slice(0, 10);

    const mongoFilter = {
      'sourceMetadata.sourcePortal': { $in: PORTALS },
      couponCode: { $exists: true, $ne: '' },
      isExpired: { $ne: true },
      $or: [
        { validityPeriod: { $exists: false } },
        {
          $and: [
            { 'validityPeriod.end': { $exists: false } },
            { 'validityPeriod.to': { $exists: false } },
            { 'validityPeriod.endDate': { $exists: false } },
            { 'validityPeriod.till': { $exists: false } },
            { 'validityPeriod.until': { $exists: false } }
          ]
        },
        { 'validityPeriod.end': { $gte: todayISO } },
        { 'validityPeriod.to': { $gte: todayISO } },
        { 'validityPeriod.endDate': { $gte: todayISO } },
        { 'validityPeriod.till': { $gte: todayISO } },
        { 'validityPeriod.until': { $gte: todayISO } }
      ]
    };

    const offers = await offersCollection.find(mongoFilter, { projection: { paymentMethods: 1 } }).toArray();

    const canonicalToDisplay = new Map();
    for (const off of offers) {
      const pm = off?.paymentMethods || [];
      for (const x of pm) {
        let raw =
          typeof x === 'string'
            ? x.trim()
            : (x && typeof x === 'object')
              ? [x.bank, x.type, x.cardNetwork].filter(Boolean).join(' ').trim()
              : '';
        if (!raw) continue;

        const key = canonicalizeLabel(raw);
        if (!key) continue;

        if (!canonicalToDisplay.has(key)) {
          canonicalToDisplay.set(key, displayLabelFromKey(key));
        }
      }
    }

    const methods = Array.from(canonicalToDisplay.values()).sort((a, b) => a.localeCompare(b));
    methods.push('Other');

    res.json({ methods });
  } catch (e) {
    console.error('❌ /payment-methods error:', e);
    res.status(500).json({ methods: [] });
  }
});

// ===== Start =====
app.listen(PORT, async () => {
  try { await initMongo(); } catch (e) { console.error('❌ Mongo init failed:', e.message); }
  console.log(`🚀 Server running on port ${PORT}`);
});
