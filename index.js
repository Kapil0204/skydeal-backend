import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ----------------------
// Simulated Flight Data
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
      bestDeal: bestDeals[paymentMethods[0]] || null
    },
    {
      flightName: 'Air India AI456',
      departure: '12:30',
      arrival: '14:45',
      bestDeal: bestDeals[paymentMethods[0]] || null
    }
  ];

  const returnFlights = tripType === 'round-trip' ? [
    {
      flightName: 'SpiceJet SG789',
      departure: '18:00',
      arrival: '20:00',
      bestDeal: bestDeals[paymentMethods[0]] || null
    },
    {
      flightName: 'Vistara UK321',
      departure: '21:30',
      arrival: '23:50',
      bestDeal: bestDeals[paymentMethods[0]] || null
    }
  ] : [];

  res.json({ outboundFlights, returnFlights });
});

// ----------------------
// Real Flights from Amadeus
// ----------------------
app.post('/search', async (req, res) => {
  const {
    origin,
    destination,
    departureDate,
    returnDate,
    passengers,
    travelClass,
    tripType
  } = req.body;

  try {
    // Step 1: Get access token
    const tokenResponse = await axios.post('https://test.api.amadeus.com/v1/security/oauth2/token', new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.AMADEUS_CLIENT_ID,
      client_secret: process.env.AMADEUS_CLIENT_SECRET
    }));

    const accessToken = tokenResponse.data.access_token;

    // Step 2: Call Amadeus flight API
    const amadeusResponse = await axios.get('https://test.api.amadeus.com/v2/shopping/flight-offers', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      params: {
        originLocationCode: origin,
        destinationLocationCode: destination,
        departureDate,
        returnDate: tripType === 'round-trip' ? returnDate : undefined,
        adults: passengers,
        travelClass,
        currencyCode: 'INR',
        max: 30
      }
    });

    const flights = amadeusResponse.data.data;
    res.json({ flights });
  } catch (error) {
    console.error('❌ Error in /search:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch flights' });
  }
});

// ----------------------
// Start Server
// ----------------------
app.listen(PORT, () => {
  console.log(`✅ SkyDeal backend running at http://localhost:${PORT}`);
});
