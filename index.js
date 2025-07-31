import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
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
      currencyCode: 'INR',
      max: 1
    };

    if (tripType === 'round-trip' && returnDate) {
      params.returnDate = returnDate;
    }

    const response = await axios.get('https://test.api.amadeus.com/v2/shopping/flight-offers', {
      headers: { Authorization: `Bearer ${accessToken}` },
      params
    });

    const flightData = response.data?.data?.[0];
    if (!flightData) return res.status(404).json({ error: 'No flights found' });

    const basePrice = parseFloat(flightData.price.total);
    const currency = flightData.price.currency;

    const simulatedResults = [
      { ota: 'MakeMyTrip', price: basePrice + 100 },
      { ota: 'Goibibo', price: basePrice + 100 },
      { ota: 'EaseMyTrip', price: basePrice + 100 },
      { ota: 'Yatra', price: basePrice + 100 },
      { ota: 'Cleartrip', price: basePrice + 100 }
    ].map(item => ({
      ...item,
      basePrice,
      currency
    }));

    res.json(simulatedResults);

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
