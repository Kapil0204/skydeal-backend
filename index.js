import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({
  origin: 'https://skydeal-frontend.vercel.app'
}));
app.use(express.json());

// ----------------------
// Get Amadeus Token
// ----------------------
let accessToken = null;

async function getAmadeusToken() {
  const { AMADEUS_CLIENT_ID, AMADEUS_CLIENT_SECRET } = process.env;
  const response = await axios.post(
  'https://test.api.amadeus.com/v1/security/oauth2/token',
  new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: AMADEUS_CLIENT_ID,
    client_secret: AMADEUS_CLIENT_SECRET
  }).toString(),
  {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  }
);

  accessToken = response.data.access_token;
}

// ----------------------
// POST /search → real price + 5 OTA simulated prices
// ----------------------
app.post('/search', async (req, res) => {
  const { from, to, departureDate, returnDate, passengers, travelClass, tripType } = req.body;

  try {
    if (!accessToken) await getAmadeusToken();

    const params = {
      originLocationCode: from,
      destinationLocationCode: to,
      departureDate,
      adults: passengers,
      travelClass: travelClass.toUpperCase(),
      currencyCode: 'INR'
    };

    if (tripType === 'round-trip' && returnDate) {
      params.returnDate = returnDate;
    }

    const response = await axios.get('https://test.api.amadeus.com/v2/shopping/flight-offers', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      params
    });

    const results = response.data?.data || [];
    const flights = results.map((flight) => {
      const itinerary = flight.itineraries[0];
      const segment = itinerary.segments[0]; // First leg

      return {
        airline: segment.carrierCode || 'N/A',
        flightNumber: segment.number || 'N/A',
        departure: segment.departure.at,
        arrival: segment.arrival.at,
        basePrice: parseFloat(flight.price.total),
        currency: flight.price.currency
      };
    });

    res.json(flights);
  } catch (error) {
    console.error('Error fetching from Amadeus:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch flight data' });
  }
});


// ----------------------
app.get('/', (req, res) => {
  res.send('SkyDeal backend live');
});

app.listen(PORT, () => {
  console.log(`✅ SkyDeal backend running on port ${PORT}`);
});
