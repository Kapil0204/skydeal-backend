import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- GET AMADEUS ACCESS TOKEN ---
async function getAmadeusAccessToken() {
  const response = await axios.post('https://test.api.amadeus.com/v1/security/oauth2/token', new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.AMADEUS_API_KEY,
    client_secret: process.env.AMADEUS_API_SECRET
  }), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  return response.data.access_token;
}

// --- /search endpoint ---
app.post('/search', async (req, res) => {
  const { from, to, departureDate, returnDate, passengers, travelClass } = req.body;

  try {
    const token = await getAmadeusAccessToken();

    const amadeusRes = await axios.get('https://test.api.amadeus.com/v2/shopping/flight-offers', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        originLocationCode: from,
        destinationLocationCode: to,
        departureDate,
        ...(returnDate ? { returnDate } : {}),
        adults: passengers,
        travelClass,
        currencyCode: 'INR',
        max: 20
      }
    });

    const flights = amadeusRes.data.data.map((offer) => {
      const segment = offer.itineraries[0].segments[0];
      return {
        airline: segment.carrierCode,
        flightNumber: segment.number,
        departure: segment.departure.at,
        arrival: segment.arrival.at,
        price: offer.price.total
      };
    });

    res.json({ flights });
  } catch (err) {
    console.error('Amadeus error:', err?.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch flight data from Amadeus' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ SkyDeal backend running on port ${PORT}`);
});
