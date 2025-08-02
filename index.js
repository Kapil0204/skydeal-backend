// ----------------------
// Imports and Setup
// ----------------------
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import * as dotenv from 'dotenv';
import qs from 'qs';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ----------------------
// Test Route
// ----------------------
app.get('/', (req, res) => {
  res.send('SkyDeal backend is running.');
});

// ----------------------
// Simulated Flights (for testing)
// ----------------------
app.post('/simulated-flights', (req, res) => {
  const { from, to, departureDate, returnDate, passengers, travelClass, paymentMethods, tripType } = req.body;

  const bestDeals = {
    'ICICI Bank': { portal: 'MakeMyTrip', offer: '10% off', code: 'SKYICICI10', price: 4900 },
    'HDFC Bank': { portal: 'Goibibo', offer: '12% off', code: 'SKYHDFC12', price: 4700 },
    'Axis Bank': { portal: 'EaseMyTrip', offer: '15% off', code: 'SKYAXIS15', price: 4500 }
  };

  const outboundFlights = [
    {
      flightName: 'IndiGo 6E123',
      departure: '08:00',
      arrival: '10:00',
      bestDeal: bestDeals[paymentMethods?.[0]] || null
    },
    {
      flightName: 'Air India AI456',
      departure: '12:30',
      arrival: '14:45',
      bestDeal: bestDeals[paymentMethods?.[0]] || null
    }
  ];

  const returnFlights = tripType === 'round-trip' ? [
    {
      flightName: 'SpiceJet SG789',
      departure: '18:00',
      arrival: '20:00',
      bestDeal: bestDeals[paymentMethods?.[0]] || null
    },
    {
      flightName: 'Vistara UK321',
      departure: '21:30',
      arrival: '23:50',
      bestDeal: bestDeals[paymentMethods?.[0]] || null
    }
  ] : [];

  res.json({ outboundFlights, returnFlights });
});

// ----------------------
// Amadeus: Auth + Flight Search
// ----------------------

let amadeusAccessToken = null;
let tokenExpiry = null;

async function getAmadeusAccessToken() {
  if (amadeusAccessToken && tokenExpiry && Date.now() < tokenExpiry) {
    return amadeusAccessToken;
  }

  const data = qs.stringify({
    grant_type: 'client_credentials',
    client_id: process.env.AMADEUS_CLIENT_ID,
    client_secret: process.env.AMADEUS_CLIENT_SECRET
  });

  try {
    const response = await axios.post('https://test.api.amadeus.com/v1/security/oauth2/token', data, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    amadeusAccessToken = response.data.access_token;
    tokenExpiry = Date.now() + response.data.expires_in * 1000;
    return amadeusAccessToken;
  } catch (error) {
    console.error('❌ Failed to get Amadeus token:', error.response?.data || error.message);
    throw new Error('Amadeus authentication failed');
  }
}

app.post('/search', async (req, res) => {
  try {
    const { from, to, departureDate, returnDate, passengers, travelClass, tripType } = req.body;

    const token = await getAmadeusAccessToken();

    const response = await axios.get('https://test.api.amadeus.com/v2/shopping/flight-offers', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        originLocationCode: from,
        destinationLocationCode: to,
        departureDate,
        returnDate: tripType === 'round-trip' ? returnDate : undefined,
        adults: passengers,
        travelClass,
        currencyCode: 'INR',
        max: 10
      }
    });

    const offers = response.data.data || [];

    const outboundFlights = offers.map(offer => {
      const segment = offer.itineraries[0].segments[0];
      return {
        flightName: `${segment.carrierCode} ${segment.number}`,
        departure: segment.departure.at.slice(11, 16),
        arrival: segment.arrival.at.slice(11, 16),
        price: parseInt(offer.price.total)
      };
    });

    const returnFlights = (tripType === 'round-trip')
      ? offers.map(offer => {
          const returnSeg = offer.itineraries[1]?.segments[0];
          return returnSeg ? {
            flightName: `${returnSeg.carrierCode} ${returnSeg.number}`,
            departure: returnSeg.departure.at.slice(11, 16),
            arrival: returnSeg.arrival.at.slice(11, 16),
            price: parseInt(offer.price.total)
          } : null;
        }).filter(Boolean)
      : [];

    res.json({ outboundFlights, returnFlights });

  } catch (err) {
    console.error('❌ Error in /search:', err.message || err);
    res.status(500).json({ error: 'Failed to fetch flights' });
  }
});

// ----------------------
// Start Server
// ----------------------
app.listen(PORT, () => {
  console.log(`✅ SkyDeal backend running on port ${PORT}`);
});
